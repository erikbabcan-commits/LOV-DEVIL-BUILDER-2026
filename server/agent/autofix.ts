import type { AIProvider } from '../providers/types';
import { validateFiles } from '../sandbox/policy';
import type { BuildResult, SandboxFile } from '../sandbox/builder';
import { getSandboxExecutor, type SandboxExecutor } from '../sandbox/executor';
import { asSandboxError } from '../sandbox/errors';
import { containsPotentialSecret, redactSecrets } from '../security/secrets';
import { patchBase,PatchError,requestBuildPatch } from './patches';
import {ContextBudgetError} from '../providers/contextBudget';
import {UsageLedgerError} from '../usage/store';

/* Step 4: AUTOFIX — bounded repair loop: BUILD → COLLECT REAL ERRORS → AI PATCH → REBUILD → VERIFY.
   Max 2 automatické opravy. Snapshot pred zmenami (apply robí klient), žiadne deštruktívne prepisy —
   Presné source-bound edits sa materializujú iba v pracovnej kópii; klient ich
   musí osobitne schváliť. Žiadne orezanie zdrojov alebo full-file fallback. */

export interface AutofixResult {
  ok: boolean;
  attempts: number;
  finalFiles: SandboxFile[];
  buildErrors: Array<{ file: string; message: string; attempt: number }>;
  patchesApplied: number;
  summary?: string;
  history: Array<{ attempt: number; phase: 'build' | 'patch' | 'done'; message: string }>;
}

const MAX_ATTEMPTS = 2;

function filesContainPotentialSecret(files: SandboxFile[]): boolean {
  return files.some(file => containsPotentialSecret(file.path) || containsPotentialSecret(file.content));
}

async function buildWithRedactedErrors(files: SandboxFile[], executor: SandboxExecutor, signal?: AbortSignal): Promise<BuildResult> {
  try {
    const result = await executor.execute(files, signal);
    return {
      ...result,
      errors: result.errors.map(error => ({
        file: redactSecrets(error.file),
        message: redactSecrets(error.message),
      })),
    };
  } catch (error) {
    // Only returned compiler diagnostics are repairable. Thrown failures belong
    // to infrastructure and must never trigger a paid AI attempt or leak details.
    throw asSandboxError(error);
  }
}

export async function autofixLoop(
  provider: AIProvider,
  files: SandboxFile[],
  opts?: { signal?: AbortSignal; executor?: SandboxExecutor; beforeAi?: () => Promise<void> },
): Promise<AutofixResult> {
  const history: AutofixResult['history'] = [];
  const buildErrors: AutofixResult['buildErrors'] = [];
  let current = files.map(file=>({...file}));
  let attempts = 0;
  let patchesApplied = 0;
  let summary:string|undefined;

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

  // Invalid paths/duplicates/size/dependencies are policy failures, not compiler repairs.
  const invalid=validateFiles(current);
  try{patchBase(current);}catch{if(!invalid.length)invalid.push({file:'-',message:'Neplatné alebo prázdne podklady pre opravu.'});}
  if(invalid.length)return{ok:false,attempts:0,finalFiles:[],buildErrors:invalid.map(error=>({...error,attempt:0})),patchesApplied:0,history:[{attempt:0,phase:'build',message:'Neplatné podklady; build a AI oprava sa nespustili.'}]};

  history.push({ attempt: 0, phase: 'build', message: 'počiatočný build' });
  const executor = opts?.executor ?? getSandboxExecutor();
  let result = await buildWithRedactedErrors(current, executor, opts?.signal);

  while (!result.ok && attempts < MAX_ATTEMPTS) {
    attempts++;
    for (const e of result.errors) buildErrors.push({ ...e, attempt: attempts });
    history.push({ attempt: attempts, phase: 'build', message: `build zlyhal: ${result.errors.length} chýb` });

    if (opts?.signal?.aborted) break;

    /* AI PATCH — reálna inference s kontextom chýb */
    // Admission failures must reach HTTP; they are not failed model patches.
    history.push({ attempt: attempts, phase: 'patch', message: 'AI patch generovanie' });
    let admissionFailed=false;
    try {
      const patch=await requestBuildPatch(provider,current,result.errors,{signal:opts?.signal,beforeAi:async()=>{try{await opts?.beforeAi?.();}catch(error){admissionFailed=true;throw error;}}});
      const candidate=new Map(current.map(file=>[file.path,{...file}]));
      for(const file of patch.files){if(file.action==='delete')candidate.delete(file.path);else candidate.set(file.path,{path:file.path,content:file.content});}
      const next=[...candidate.values()];if(validateFiles(next).length)throw new PatchError();
      current=next;summary=patch.summary;patchesApplied+=patch.files.length;
      history.push({ attempt: attempts, phase: 'patch', message: `AI patch: ${patch.files.length} súborov` });
    } catch (e) {
      // Admission failures must reach HTTP; they are not failed model patches.
      if(admissionFailed||e instanceof ContextBudgetError||e instanceof UsageLedgerError)throw e;
      history.push({ attempt: attempts, phase: 'patch', message: 'AI patch zlyhal: ' + redactSecrets(String(e)).slice(0, 120) });
      break;
    }

    /* REBUILD + VERIFY */
    result = await buildWithRedactedErrors(current, executor, opts?.signal);
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
    ...(summary?{summary}:{}),
    history,
  };
}
