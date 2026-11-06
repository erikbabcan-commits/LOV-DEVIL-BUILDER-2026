import type {ConversationTurn} from '../../../shared/conversation';
import type { AgentEvent, GeneratedFile } from './types';
import { apiHeaders } from '../../lib/csrf';
import { notifyAiQuotaChanged } from './usage';

/* AI klient: volá Hono backend, parsuje SSE eventy, podporuje cancel.
   Ak backend nie je dostupný / AI nie je nakonfigurovaná, UI to jasne hlási —
   nikdy sa tišie neprepne na šablóny. */

export type AgentEventHandler = (ev: AgentEvent) => void;

export interface AgentRunHandle {
  runId: string | null;
  cancel(): void;
  finished: Promise<void>;
}

export const AI_API_BASE: string = import.meta.env?.VITE_AI_API_BASE ?? '';

export class AiNotConfiguredError extends Error {
  constructor() { super('AI engine teraz nie je dostupný. Použi Instant Draft alebo skús neskôr.'); }
}
export class NetworkError extends Error {
  constructor(public retriable: boolean) { super('AI server nie je dostupný.'); }
}

const requestMessages = {
  quota_exceeded: 'Vyčerpal si mesačný limit AI úloh. Lokálna práca, Instant Draft a export zostávajú dostupné.',
  rate_limit: 'Priveľa AI požiadaviek. Počkaj chvíľu a skús to znova.',
  run_budget: 'AI práve spracúva povolený počet úloh alebo dosiahlo denný prevádzkový limit. Skús to neskôr.',
  quota_unavailable: 'Spotrebu AI sa nepodarilo overiť. Skús to znova o chvíľu.',
  ai_disabled: 'AI generovanie je teraz vypnuté. Môžeš pokračovať v Instant Draft režime.',
  login_required: 'Prihlásenie vypršalo. Znovu sa prihlás; lokálna práca zostala zachovaná.',
  access_denied: 'Server odmietol prístup k AI. Over prihlásenie a obnov stránku.',
  secret_in_context: 'Prompt alebo kontext obsahuje možné prihlasovacie údaje. Odstráň ich pred odoslaním AI.',
  invalid_model: 'Vybraný model alebo záložné modely už nie sú dostupné. Obnov ponuku modelov a vyber znova.',
  invalid_request: 'Požiadavku AI sa nepodarilo prijať. Skontroluj prompt a kontext projektu.',
  context_limit: 'Kontext je pre vybraný model príliš veľký. Vyber model s väčším kontextom alebo zmenši projekt. Súbory sa neskrátili.',
  input_limit: 'Projekt alebo požiadavka prekračuje limit AI vstupu. Zmenši kontext a skús to znova.',
  service_unavailable: 'AI služba teraz nie je dostupná. Skús to znova o chvíľu.',
  stream_interrupted: 'AI odpoveď sa prerušila pred dokončením. Návrh sa neaplikoval; skús novú úlohu.',
} as const;
export class AiRequestError extends Error {
  constructor(readonly code: keyof typeof requestMessages, readonly retriable: boolean) { super(requestMessages[code]); }
}

export interface GenerateInput {
  modelId?: string;
  allowFallback?: boolean;
  fallbackIds?: string[];
  projectId: string;
  prompt: string;
  mode: 'create' | 'iterate' | 'fix' | 'explain' | 'auto';
  context: {
    projectTitle?: string;
    conversation?: ConversationTurn[];
    files: Array<{ path: string; content: string }>;
    history: Array<{ v: number; prompt: string }>;
  };
}

export async function* streamAgentEvents(input: GenerateInput, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  let res: Response;
  try {
    res = await fetch(AI_API_BASE + '/api/agent/generate', {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify(input), signal,
    });
  } catch {
    if (signal.aborted) return;
    throw new NetworkError(true);
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const code = body && typeof body === 'object' && 'error' in body ? body.error : null;
    if (res.status === 503 && code === 'ai_not_configured') throw new AiNotConfiguredError();
    if (res.status === 401) throw new AiRequestError('login_required', false);
    if (res.status === 403) throw new AiRequestError('access_denied', false);
    if (res.status === 429) {
      if (code === 'quota_exceeded') { notifyAiQuotaChanged(); throw new AiRequestError('quota_exceeded', false); }
      throw new AiRequestError(code === 'BUDGET_EXCEEDED' ? 'run_budget' : 'rate_limit', true);
    }
    if (code === 'invalid_model') throw new AiRequestError('invalid_model', false);
    if (res.status === 413) throw new AiRequestError(code==='context_limit'?'context_limit':'input_limit', false);
    if (res.status === 400) throw new AiRequestError(code === 'secret_in_context' ? 'secret_in_context' : 'invalid_request', false);
    throw new AiRequestError(code === 'quota_unavailable' ? 'quota_unavailable' : code === 'ai_disabled' ? 'ai_disabled' : 'service_unavailable', code !== 'ai_disabled');
  }
  notifyAiQuotaChanged();
  if (!res.body) throw new AiRequestError('stream_interrupted', true);
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      if (done) throw new AiRequestError('stream_interrupted', true);
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      if (buf.length > 8_000_000) throw new AiRequestError('stream_interrupted', true);
      const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
      for (const part of parts) {
        const data = part.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) continue;
        const event = parsed as AgentEvent;
        yield event;
        if (isTerminal(event)) return;
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    if (error instanceof AiRequestError) throw error;
    throw new NetworkError(true);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/* helpers pre apply do VFS */

export function isTerminal(ev: AgentEvent): boolean {
  return ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled';
}

export function filesFromStage(events: AgentEvent[]): GeneratedFile[] {
  const stage = events.find(e => e.type === 'stage');
  return stage && stage.type === 'stage' ? stage.files : [];
}
