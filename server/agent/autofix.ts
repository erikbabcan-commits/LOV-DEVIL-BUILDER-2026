import type { AIProvider } from '../providers/types';
import { buildProject, SandboxFileSchema } from '../sandbox/builder';
import type { BuildResult, SandboxFile } from '../sandbox/builder';
import { containsPotentialSecret, redactSecrets } from '../security/secrets';

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

function filesContainPotentialSecret(files: SandboxFile[]): boolean {
  return files.some(file => containsPotentialSecret(file.path) || containsPotentialSecret(file.content));
}

async function buildWithRedactedErrors(files: SandboxFile[]): Promise<BuildResult> {
  const started = Date.now();
  try {
    const result = await buildProject(files);
    return {
      ...result,
      errors: result.errors.map(error => ({
        file: redactSecrets(error.file),
        message: redactSecrets(error.message),
      })),
    };
  } catch (error) {
    return {
      ok: false,
      html: null,
      errors: [{ file: '-', message: redactSecrets(String(error)).slice(0, 800) }],
      durationMs: Date.now() - started,
      moduleCount: 0,
    };
  }
}

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

  if (filesContainPotentialSecret(current)) {
    const message = 'autofix: vstup obsahuje potenciálne tajomstvo; build a AI volanie boli zablokované';
    return {
      ok: false,
      attempts: 0,
      finalFiles: [], // Do not echo rejected credentials back through the JSON response.
      buildErrors: [{ file: '-', message, attempt: 0 }],
      patchesApplied: 0,
      history: [{ attempt: 0, phase: 'build', message }],
    };
  }

  history.push({ attempt: 0, phase: 'build', message: 'počiatočný build' });
  let result = await buildWithRedactedErrors(current);

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

      if (containsPotentialSecret(text)) throw new Error('autofix: výstup AI obsahuje potenciálne tajomstvo');
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      const payload = (fence ? fence[1] : text).trim();
      const start = payload.indexOf('{');
      const end = payload.lastIndexOf('}');
      if (start === -1 || end <= start) throw new Error('autofix: nevalidná AI odpoveď');
      const parsed = JSON.parse(payload.slice(start, end + 1)) as { files?: unknown };
      if (!Array.isArray(parsed.files) || !parsed.files.length) throw new Error('autofix: AI nevrátil žiadne súbory');
      const validatedFiles = SandboxFileSchema.array().safeParse(parsed.files);
      if (!validatedFiles.success) throw new Error('autofix: nevalidná schéma súborov AI');
      const patchFiles = validatedFiles.data;
      // Scan decoded JSON too: a credential may use escaped characters in the raw response.
      if (filesContainPotentialSecret(patchFiles)) throw new Error('autofix: výstup AI obsahuje potenciálne tajomstvo');

      /* apply patch — len existujúce alebo bezpečné cesty; ostatné súbory ostávajú */
      const patchMap = new Map(patchFiles.map(f => [f.path, f.content]));
      current = current.map(f => patchMap.has(f.path) ? { ...f, content: patchMap.get(f.path)! } : f);
      /* nové súbory z patchu (bezpečné cesty) */
      for (const [p, c] of patchMap) if (!current.some(f => f.path === p) && /^[a-zA-Z0-9_/.-]+$/.test(p) && !p.includes('..')) {
        current.push({ path: p, content: c });
      }
      patchesApplied += patchFiles.length;
      history.push({ attempt: attempts, phase: 'patch', message: `AI patch: ${patchFiles.length} súborov` });
    } catch (e) {
      history.push({ attempt: attempts, phase: 'patch', message: 'AI patch zlyhal: ' + redactSecrets(String(e)).slice(0, 120) });
      break;
    }

    /* REBUILD + VERIFY */
    result = await buildWithRedactedErrors(current);
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
