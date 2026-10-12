import type { AIProvider } from '../providers/types';
import { buildProject, SandboxFile } from '../sandbox/builder';

/* Step 4: AUTOFIX — bounded repair loop: BUILD → COLLECT REAL ERRORS → AI PATCH → REBUILD → VERIFY.
   Max 2 automatické opravy. Snapshot pred zmenami (apply robí klient), žiadne deštruktívne prepisy —
   patch vždy obsahuje CELÉ súbory (nie diffy), takže sa dá kedykoľvek vrátiť na snapshot. */

export interface AutofixResult {
  ok: boolean;
  attempts: number;
  finalFiles: SandboxFile[];
  buildErrors: Array<{ file: string; message: string; attempt: number }>;
  patchesApplied: number;
  history: Array<{ attempt: number; phase: 'build' | 'patch' | 'done'; message: string }>;
}

const MAX_ATTEMPTS = 2;

const SYSTEM_AUTOFIX = `Si Forge Agent — opravuješ build chyby v React/TypeScript projekte.
Dostaneš zoznam súborov a build chyby. Oprav IBA príčiny chýb — minimálne zmeny.
Odpovedaj VÝHRADNE JSON (žiadny markdown): {"files": [{"path": string, "content": string}]}
Vráť CELÉ opravené súbory (len tie, ktoré meníš).`;

export async function autofixLoop(
  provider: AIProvider,
  files: SandboxFile[],
  opts?: { signal?: AbortSignal },
): Promise<AutofixResult> {
  const history: AutofixResult['history'] = [];
  const buildErrors: AutofixResult['buildErrors'] = [];
  let current = [...files];
  let attempts = 0;
  let patchesApplied = 0;

  history.push({ attempt: 0, phase: 'build', message: 'počiatočný build' });
  let result = await buildProject(current);

  while (!result.ok && attempts < MAX_ATTEMPTS) {
    attempts++;
    for (const e of result.errors) buildErrors.push({ ...e, attempt: attempts });
    history.push({ attempt: attempts, phase: 'build', message: `build zlyhal: ${result.errors.length} chýb` });

    if (opts?.signal?.aborted) break;

    /* AI PATCH — reálna inference s kontextom chýb */
    history.push({ attempt: attempts, phase: 'patch', message: 'AI patch generovanie' });
    try {
      const filesBlock = current.map(f => `--- ${f.path} ---\n${f.content.slice(0, 4000)}`).join('\n');
      const errorsBlock = result.errors.map(e => `${e.file}: ${e.message.slice(0, 500)}`).join('\n');
      const { text } = await provider.complete([
        { role: 'system', content: SYSTEM_AUTOFIX },
        { role: 'user', content: `Build chyby:\n${errorsBlock}\n\nSúbory:\n${filesBlock}` },
      ], { maxTokens: 12_000, temperature: 0.1, signal: opts?.signal });

      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      let payload = (fence ? fence[1] : text).trim();
      const start = payload.indexOf('{');
      const end = payload.lastIndexOf('}');
      if (start === -1 || end <= start) throw new Error('autofix: nevalidná AI odpoveď');
      const parsed = JSON.parse(payload.slice(start, end + 1)) as { files?: Array<{ path: string; content: string }> };
      if (!parsed.files?.length) throw new Error('autofix: AI nevrátil žiadne súbory');

      /* apply patch — len existujúce alebo bezpečné cesty; ostatné súbory ostávajú */
      const patchMap = new Map(parsed.files.map(f => [f.path, f.content]));
      current = current.map(f => patchMap.has(f.path) ? { ...f, content: patchMap.get(f.path)! } : f);
      /* nové súbory z patchu (bezpečné cesty) */
      for (const [p, c] of patchMap) if (!current.some(f => f.path === p) && /^[a-zA-Z0-9_\-\/.]+$/.test(p) && !p.includes('..')) {
        current.push({ path: p, content: c });
      }
      patchesApplied += parsed.files.length;
      history.push({ attempt: attempts, phase: 'patch', message: `AI patch: ${parsed.files.length} súborov` });
    } catch (e) {
      history.push({ attempt: attempts, phase: 'patch', message: 'AI patch zlyhal: ' + String(e).slice(0, 120) });
      break;
    }

    /* REBUILD + VERIFY */
    result = await buildProject(current);
    if (result.ok) {
      history.push({ attempt: attempts, phase: 'done', message: 'build úspešný po oprave' });
    }
  }

  return {
    ok: result.ok,
    attempts,
    finalFiles: current,
    buildErrors,
    patchesApplied,
    history,
  };
}
