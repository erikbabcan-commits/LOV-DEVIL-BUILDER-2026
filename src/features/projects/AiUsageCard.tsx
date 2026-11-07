import { useEffect, useState } from 'react';
import { AiUsageSchema, type AiUsage } from '../../../shared/aiUsage';
import { AI_QUOTA_CHANGED } from '../../services/ai/usage';

/** Mounted only inside the account-keyed project dialog. Never replace missing
 * consumption with zero; background refresh errors hide the stale snapshot. */
export function AiUsageCard() {
  const [report, setReport] = useState<AiUsage | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true, pending: AbortController | null = null;
    const refresh = async () => {
      pending?.abort(); const controller = new AbortController(); pending = controller;
      try {
        const response = await fetch('/api/ai-usage', { credentials: 'same-origin', signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('unavailable');
        const parsed = AiUsageSchema.parse(await response.json());
        if (active && !controller.signal.aborted) { setReport(parsed); setError(false); }
      } catch { if (active && !controller.signal.aborted) { setReport(null); setError(true); } }
    };
    const update = () => { void refresh(); };
    update(); const timer = window.setInterval(update, 15_000);
    window.addEventListener(AI_QUOTA_CHANGED, update);
    return () => { active = false; pending?.abort(); clearInterval(timer); window.removeEventListener(AI_QUOTA_CHANGED, update); };
  }, [revision]);
  return <section className="project-storage" aria-label="Spotreba AI tokenov">
    <p><b>Tokeny tento mesiac</b>{report ? ' · ' + (report.promptTokens + report.completionTokens).toLocaleString('sk-SK') + ' nahlásených' : ''}</p>
    {report ? <>
      <p>{report.promptTokens.toLocaleString('sk-SK')} vstupných · {report.completionTokens.toLocaleString('sk-SK')} výstupných</p>
      <small>Provider nahlásil spotrebu pre {report.reportedCalls} z {report.calls} AI volaní. Jedna úloha môže zahŕňať viac volaní. Obdobie {report.periodStart} – {report.periodEnd} (UTC). Zobrazuje iba volania od zapnutia merania. Obnovuje sa každých 15 sekúnd.</small>
      <p>Úspešné publikovania: {report.publishedDeployments?.toLocaleString('sk-SK') ?? 'údaj nie je dostupný'}</p>
      {report.unknownCalls > 0 && <p role="status">Počet volaní bez údajov o spotrebe: {report.unknownCalls}{report.pendingCalls ? `; na výsledok čaká: ${report.pendingCalls}` : ''}. Súčet je preto neúplný.</p>}
    </> : <p role="status">{error ? 'Spotrebu tokenov sa nepodarilo načítať. Projekty môžeš ďalej upravovať.' : 'Načítavam spotrebu tokenov…'}</p>}
    <button onClick={() => setRevision(value => value + 1)}>Obnoviť spotrebu</button>
  </section>;
}
