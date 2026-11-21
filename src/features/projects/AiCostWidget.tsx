import { useEffect, useState } from 'react';
import { apiUrl } from '../../lib/api';
import { apiHeaders } from '../../lib/csrf';

/** Odhad ceny jedného behu tak, ako ho vracia POST /api/ai-cost/estimate (mikro-jednotky ako string). */
export interface AiRunCost { status: 'priced' | 'unpriced'; usdMicros: string | null; eurMicros: string | null }
export interface AiRunUsage { model: string; inputTokens: number; outputTokens: number }

const MICRO = 1_000_000n;
const DIGITS = /^(0|[1-9][0-9]*)$/;
/** Rovnaké pravidlo ako server/usage/costEstimator.formatMicros (pod 1 → 4 desatinné, inak 2; half-up). */
function format(micros: bigint, symbol: string): string {
  const decimals = micros < MICRO ? 4 : 2, step = 10n ** BigInt(6 - decimals);
  const rounded = (micros + step / 2n) / step, scale = 10n ** BigInt(decimals);
  return (rounded / scale).toString() + ',' + (rounded % scale).toString().padStart(decimals, '0') + ' ' + symbol;
}
const micros = (value: string | null) => value !== null && DIGITS.test(value) ? BigInt(value) : null;

/** Prezentačný widget: cena posledného behu + súčet za session v USD/EUR.
 * Chýbajúci pricing sa nikdy nezobrazí ako 0 – ukáže sa „neznáma cena“. */
export function AiCostWidget({ runs }: { runs: readonly AiRunCost[] }) {
  const last = runs.length ? runs[runs.length - 1] : null;
  const lastUsd = last?.status === 'priced' ? micros(last.usdMicros) : null;
  const lastEur = last?.status === 'priced' ? micros(last.eurMicros) : null;
  let usd = 0n, eur: bigint | null = 0n, unknown = 0;
  for (const run of runs) {
    const u = run.status === 'priced' ? micros(run.usdMicros) : null;
    if (u === null) { unknown++; continue; }
    usd += u; const e = micros(run.eurMicros); eur = eur === null || e === null ? null : eur + e;
  }
  const priced = runs.length - unknown;
  const describe = (u: bigint | null, e: bigint | null) => u === null ? 'neznáma cena' : format(u, 'USD') + ' / ' + (e === null ? 'EUR neznáme' : format(e, '€'));
  const lastText = last === null ? 'zatiaľ žiadny beh' : describe(lastUsd, lastEur);
  const sessionText = runs.length === 0 ? 'zatiaľ žiadny beh' : priced === 0 ? 'neznáma cena' : describe(usd, eur);
  return <section className="project-storage" aria-label="Odhad ceny AI behov">
    <p aria-label={'Cena posledného behu: ' + lastText}><b>Posledný beh</b> · {lastText}</p>
    <p aria-label={'Súčet za session: ' + sessionText}><b>Session</b> · {sessionText}</p>
    {unknown > 0 && runs.length > 0 && <p role="status">Pre {unknown} z {runs.length} behov chýba cenník alebo spotreba. {priced > 0 ? 'Súčet je preto neúplný.' : ''}</p>}
    <small>Odhad z nahlásených tokenov podľa cenníka v USD; EUR podľa nastaveného kurzu. Nie je to faktúra.</small>
  </section>;
}

/** Napojená verzia: pošle tokeny behov na server (cenník je len na serveri) a vykreslí AiCostWidget. */
export function AiCostWidgetLive({ usages }: { usages: readonly AiRunUsage[] }) {
  const [runs, setRuns] = useState<AiRunCost[]>([]);
  const key = JSON.stringify(usages.slice(-50));
  useEffect(() => {
    const list = JSON.parse(key) as AiRunUsage[];
    if (!list.length) { setRuns([]); return; }
    const controller = new AbortController();
    fetch(apiUrl('/api/ai-cost/estimate'), { method: 'POST', credentials: 'include', cache: 'no-store', signal: controller.signal,
      headers: apiHeaders(), body: JSON.stringify({ runs: list }) })
      .then(async response => {
        if (!response.ok) throw new Error('unavailable');
        const data = await response.json() as { runs?: unknown };
        if (!Array.isArray(data.runs) || data.runs.length !== list.length) throw new Error('invalid');
        return data.runs.map((run): AiRunCost => {
          const r = (run ?? {}) as Record<string, unknown>;
          const usd = typeof r.usdMicros === 'string' ? r.usdMicros : null, eur = typeof r.eurMicros === 'string' ? r.eurMicros : null;
          return r.status === 'priced' && usd !== null ? { status: 'priced', usdMicros: usd, eurMicros: eur } : { status: 'unpriced', usdMicros: null, eurMicros: null };
        });
      })
      .then(next => { if (!controller.signal.aborted) setRuns(next); })
      .catch(() => { if (!controller.signal.aborted) setRuns(list.map(() => ({ status: 'unpriced', usdMicros: null, eurMicros: null }))); });
    return () => controller.abort();
  }, [key]);
  return <AiCostWidget runs={runs} />;
}
