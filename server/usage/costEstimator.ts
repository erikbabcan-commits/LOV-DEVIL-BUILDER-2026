/* Agent 8: odhad ceny behu v USD (podľa pricing.ts) a EUR cez konfigurovateľný kurz.
   Žiadne live FX API: kurz je konštanta alebo env `AI_USD_EUR_RATE`. Všetko v celých
   mikro-jednotkách (BigInt), zaokrúhľuje sa nahor raz na výpočet, rovnako ako quoteUsage. */
import { quoteUsage, type PricePolicy, type UnpricedReason } from './pricing';

/** Predvolený kurz (1 USD = 0,92 EUR). Prevádzka ho prepíše cez AI_USD_EUR_RATE. */
export const DEFAULT_USD_EUR_RATE = '0.92';
const MICRO = 1_000_000n;
/** Router ids → presný model reportovaný Mistralom (pozri runtime.ts MISTRAL_CHOICES). */
export const MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'mistral-small': 'mistral-small-latest',
  codestral: 'codestral-latest',
  'mistral-large': 'mistral-large-latest',
});
const RATE_PATTERN = /^(0|[1-9][0-9]{0,2})(\.[0-9]{1,6})?$/;
const MAX_TOKENS = 1_000_000_000;

/** Kurz v mikro-EUR za 1 USD, alebo null pri neplatnej konfigurácii (EUR potom „neznáma“). */
export function parseFxRate(value: string | undefined | null): bigint | null {
  const raw = (value ?? DEFAULT_USD_EUR_RATE).trim() || DEFAULT_USD_EUR_RATE;
  if (!RATE_PATTERN.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const micros = BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0'));
  return micros > 0n && micros <= 100n * MICRO ? micros : null;
}
export function readUsdEurRate(env: Readonly<Record<string, string | undefined>>): bigint | null {
  return parseFxRate(env.AI_USD_EUR_RATE);
}
/** micro-USD × kurz → micro-EUR, zaokrúhlené nahor (odhad nikdy nepodhodnotí). */
export function usdMicrosToEurMicros(usdMicros: bigint, fxRateMicros: bigint): bigint {
  if (usdMicros < 0n || fxRateMicros <= 0n) throw new Error('invalid_cost');
  return (usdMicros * fxRateMicros + MICRO - 1n) / MICRO;
}
/** Zobrazenie: pod 1 jednotkou 4 desatinné miesta, inak 2; half-up. */
export function formatMicros(micros: bigint): string {
  if (micros < 0n) throw new Error('invalid_cost');
  const decimals = micros < MICRO ? 4 : 2, step = 10n ** BigInt(6 - decimals);
  const rounded = (micros + step / 2n) / step, scale = 10n ** BigInt(decimals);
  return (rounded / scale).toString() + '.' + (rounded % scale).toString().padStart(decimals, '0');
}

export interface CostInput { model: string; inputTokens: number; outputTokens: number; provider?: string; at?: Date }
export type CostEstimate =
  | { status: 'priced'; model: string; usdMicros: string; eurMicros: string | null; usd: string; eur: string | null; reason: null | 'invalid_fx_rate' }
  | { status: 'unpriced'; model: string; usdMicros: null; eurMicros: null; usd: null; eur: null; reason: UnpricedReason | 'invalid_tokens' };

export function estimateCost(input: CostInput, policy: PricePolicy | null, fxRateMicros: bigint | null = parseFxRate(undefined)): CostEstimate {
  const model = typeof input?.model === 'string' ? input.model : '';
  const unpriced = (reason: UnpricedReason | 'invalid_tokens'): CostEstimate => ({ status: 'unpriced', model, usdMicros: null, eurMicros: null, usd: null, eur: null, reason });
  const tokens = [input?.inputTokens, input?.outputTokens];
  if (!tokens.every(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_TOKENS)) return unpriced('invalid_tokens');
  const usage = { promptTokens: input.inputTokens, completionTokens: input.outputTokens };
  const provider = input.provider ?? 'mistral', at = input.at ?? new Date();
  let quote = quoteUsage(policy, provider, model || null, at, usage);
  if (quote.status === 'unpriced' && quote.reason === 'no_effective_rate' && MODEL_ALIASES[model])
    quote = quoteUsage(policy, provider, MODEL_ALIASES[model], at, usage);
  if (quote.status === 'unpriced') return unpriced(quote.reason);
  const usd = BigInt(quote.estimatedCostMicrousd);
  const eur = fxRateMicros === null ? null : usdMicrosToEurMicros(usd, fxRateMicros);
  return { status: 'priced', model, usdMicros: usd.toString(), eurMicros: eur?.toString() ?? null, usd: formatMicros(usd), eur: eur === null ? null : formatMicros(eur), reason: eur === null ? 'invalid_fx_rate' : null };
}

export interface SessionCost { runs: number; pricedRuns: number; unknownRuns: number; usdMicros: string; eurMicros: string | null; usd: string; eur: string | null; complete: boolean }
/** Súčet session: neznáme behy sa nikdy nepočítajú ako 0 – súčet je potom označený ako neúplný. */
export function sumSession(estimates: readonly CostEstimate[]): SessionCost {
  let usd = 0n, eur: bigint | null = 0n, priced = 0;
  for (const e of estimates) {
    if (e.status !== 'priced') continue;
    priced++; usd += BigInt(e.usdMicros);
    eur = eur === null || e.eurMicros === null ? null : eur + BigInt(e.eurMicros);
  }
  return { runs: estimates.length, pricedRuns: priced, unknownRuns: estimates.length - priced, usdMicros: usd.toString(), eurMicros: eur?.toString() ?? null,
    usd: formatMicros(usd), eur: eur === null ? null : formatMicros(eur), complete: priced === estimates.length };
}
