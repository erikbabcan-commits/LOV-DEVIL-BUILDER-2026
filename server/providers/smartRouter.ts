/* Agent 8: deterministický smart router modelov + kaskádový fallback.
   `route` je čistá funkcia (bez I/O, času a náhody). Fallback ide výhradne cez
   existujúci `resilientProvider` (resilience.ts), takže platí jeho politika:
   partial stream sa nikdy neopakuje a 429 bez Retry-After nie je transient. */
import type { AIProvider } from './types';
import { ProviderError, type ProviderFailure } from './errors';
import { resilientProvider, type ProviderUpdate, type ResilienceOptions } from './resilience';

export type SmartModelId = 'mistral-small' | 'codestral' | 'mistral-large';
export type RouteMode = 'generate' | 'fix' | 'explain' | 'chat';
export type RouteReason =
  | 'explicit_user_choice'
  | 'architecture_keywords'
  | 'large_context'
  | 'long_prompt'
  | 'short_fix_or_explain'
  | 'short_prompt'
  | 'code_generation'
  | 'unavailable_substitute';
export interface RouteContext {
  /** Počet súborov poslaných modelu ako kontext. */
  fileCount?: number;
  /** Explicitná voľba používateľa; má vždy prednosť pred pravidlami. */
  explicitModel?: string | null;
  /** Ak je zadané, router vyberá len z dostupných modelov (registry ids). */
  availableModels?: readonly string[];
}
export interface RouteDecision { model: string; reason: RouteReason; rule: RouteReason }

/** Prahy sú exportované, aby ich testy a dokumentácia mali jeden zdroj pravdy. */
export const ROUTER_THRESHOLDS = Object.freeze({
  shortPromptChars: 280,
  fixExplainMaxChars: 1200,
  fixExplainMaxFiles: 3,
  longPromptChars: 4000,
  largeContextFiles: 12,
});
export const CASCADE: Readonly<Record<SmartModelId, readonly SmartModelId[]>> = Object.freeze({
  'mistral-small': Object.freeze(['mistral-small', 'codestral', 'mistral-large'] as const),
  codestral: Object.freeze(['codestral', 'mistral-large', 'mistral-small'] as const),
  'mistral-large': Object.freeze(['mistral-large', 'codestral', 'mistral-small'] as const),
});
const ARCHITECTURE = [
  /\barchitekt/i, /\barchitect/i, /\bmicroservic/i, /\bmikroslu[zž]/i, /\bmulti-?tenant/i, /\bschema\b/i, /\bsch[eé]m/i,
  /\bdatab[aá]z/i, /\bdatabase\b/i, /\bmigr[aá]c/i, /\bmigration/i, /\brefaktor/i, /\brefactor/i, /\bscalab/i, /\b[sš]k[aá]lovat/i,
  /\bdesign system\b/i, /\bevent[- ]driven\b/i, /\bauth(?:entication|orization)?\b/i, /\bautentifik/i, /\bautoriz/i,
];
const isSmartModel = (value: string): value is SmartModelId => value in CASCADE;

function ruleFor(prompt: string, mode: RouteMode, files: number): { model: SmartModelId; rule: RouteReason } {
  const t = ROUTER_THRESHOLDS, length = prompt.trim().length;
  if (ARCHITECTURE.some(pattern => pattern.test(prompt))) return { model: 'mistral-large', rule: 'architecture_keywords' };
  if (files >= t.largeContextFiles) return { model: 'mistral-large', rule: 'large_context' };
  if (length > t.longPromptChars) return { model: 'mistral-large', rule: 'long_prompt' };
  if ((mode === 'fix' || mode === 'explain') && length <= t.fixExplainMaxChars && files <= t.fixExplainMaxFiles)
    return { model: 'mistral-small', rule: 'short_fix_or_explain' };
  if (length <= t.shortPromptChars && files <= t.fixExplainMaxFiles) return { model: 'mistral-small', rule: 'short_prompt' };
  return { model: 'codestral', rule: 'code_generation' };
}

/** Čistá, deterministická funkcia: rovnaký vstup → rovnaký výstup. */
export function route(prompt: string, mode: RouteMode = 'generate', context: RouteContext = {}): RouteDecision {
  const available = context.availableModels;
  const explicit = typeof context.explicitModel === 'string' ? context.explicitModel.trim() : '';
  if (explicit && (!available || available.includes(explicit)))
    return { model: explicit, reason: 'explicit_user_choice', rule: 'explicit_user_choice' };
  const files = Number.isSafeInteger(context.fileCount) && (context.fileCount as number) > 0 ? (context.fileCount as number) : 0;
  const { model, rule } = ruleFor(typeof prompt === 'string' ? prompt : '', mode, files);
  if (!available) return { model, reason: rule, rule };
  const substitute = CASCADE[model].find(id => available.includes(id));
  if (substitute === model) return { model, reason: rule, rule };
  if (substitute) return { model: substitute, reason: 'unavailable_substitute', rule };
  if (!available.length) throw new Error('invalid_model');
  return { model: available[0], reason: 'unavailable_substitute', rule };
}

/** Kaskáda pre vybraný model (max 3, limit resilience.ts). Neznámy model nemá fallback. */
export function cascadeFor(model: string, available?: readonly string[]): string[] {
  const chain = isSmartModel(model) ? [...CASCADE[model]] : [model];
  return (available ? chain.filter(id => id === model || available.includes(id)) : chain).slice(0, 3);
}

export interface FallbackRecord { from: string; to: string; reason: ProviderUpdate['reason']; cause: ProviderFailure | null; attempt: number }
export interface SmartRun { provider: AIProvider; decision: RouteDecision; chain: string[]; fallbacks: FallbackRecord[] }

/** Zostaví resilientný provider pre rozhodnutie routera. `resolve` mapuje
 * registry id → provider (napr. `ProviderRegistry.find(id)?.provider`). Explicitná
 * voľba používateľa sa nekaskáduje, pokiaľ to volajúci výslovne nepovolí. */
export function smartProvider(
  decision: RouteDecision,
  resolve: (id: string) => AIProvider | undefined,
  options: ResilienceOptions & { allowExplicitFallback?: boolean } = {},
): SmartRun {
  const ids = decision.reason === 'explicit_user_choice' && !options.allowExplicitFallback ? [decision.model] : cascadeFor(decision.model);
  const resolved = ids.flatMap(id => { const provider = resolve(id); return provider ? [{ id, provider }] : []; });
  if (!resolved.length || resolved[0].id !== decision.model) throw new Error('invalid_model');
  const fallbacks: FallbackRecord[] = [];
  let current = resolved[0].id, lastCause: ProviderFailure | null = null;
  const note = (error: unknown) => { lastCause = error instanceof ProviderError ? error.kind : null; return error; };
  // Tenký obal len zaznamená druh chyby (429/503) pre audit dôvodu fallbacku; správanie nemení.
  const observed = resolved.map(({ provider: inner }): AIProvider => ({
    name: inner.name, model: inner.model, contextWindowTokens: inner.contextWindowTokens,
    complete: async (messages, opts) => { try { return await inner.complete(messages, opts); } catch (error) { throw note(error); } },
    stream: async function* (messages, opts) { try { yield* inner.stream(messages, opts); } catch (error) { throw note(error); } },
  }));
  const provider = resilientProvider(observed, {
    sleep: options.sleep, random: options.random,
    onUpdate: event => {
      if (event.reason === 'fallback') {
        const next = resolved.find(entry => entry.provider.name === event.provider && entry.provider.model === event.model && entry.id !== current);
        if (next) { fallbacks.push({ from: current, to: next.id, reason: event.reason, cause: lastCause, attempt: event.attempt }); current = next.id; }
      }
      options.onUpdate?.(event);
    },
  });
  return { provider, decision, chain: resolved.map(entry => entry.id), fallbacks };
}
