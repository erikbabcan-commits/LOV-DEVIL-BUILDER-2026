import type { AIProvider } from '../providers/types';
import { validateFiles } from '../sandbox/policy';
import type { BuildResult, SandboxFile } from '../sandbox/builder';
import { getSandboxExecutor, type SandboxExecutor } from '../sandbox/executor';
import { asSandboxError } from '../sandbox/errors';
import { containsPotentialSecret, redactSecrets } from '../security/secrets';
import { patchBase,PatchError,requestBuildPatch } from './patches';
import {ContextBudgetError} from '../providers/contextBudget';
import {UsageLedgerError} from '../usage/store';
import { QuotaAdmissionError } from '../security/generationQuota';
import { MAX_ATTEMPTS } from './autofixLimits';

/* Step 4: AUTOFIX — bounded repair loop: BUILD → COLLECT REAL ERRORS → AI PATCH → REBUILD → VERIFY.
   Max 3 automatické opravy (Agent 9, schválené Erikom). Bezpečnostné nálezy AST guardu
   sa nikdy neposielajú AI: sú blokujúce, nie opraviteľné. Snapshot pred zmenami (apply robí klient), žiadne deštruktívne prepisy —
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
  /** Štruktúrovaný priebeh po pokusoch pre klientsky RepairStatus (bez voľného textu). */
  progress: AutofixProgressStep[];
  /** 'security' = build zablokoval AST guard; AI oprava sa nespustila. */
  blocked?: 'security';
  /** 'quota_exceeded' = kvóta sa minula uprostred slučky (Bora W3 P3-3): ďalší platený pokus sa
   *  nespustil, `attempts`/`progress` obsahujú len zaplatené pokusy, súbory sú posledný funkčný stav. */
  stopped?: 'quota_exceeded';
}

export interface AutofixProgressStep { attempt: number; step: 'build' | 'patch' | 'rebuild'; status: 'ok' | 'failed' }

/** Najviac 3 platené AI pokusy na jedno volanie. Každý platený pokus stojí 1 jednotku kvóty:
 *  `beforeAi` sa volá PRED každým AI volaním a pri vyčerpanej kvóte slučka skončí (Bora W3 P3-3). */
export { LEGACY_CLIENT_MAX_ATTEMPTS, MAX_ATTEMPTS } from './autofixLimits';

/** Prefix diagnostík AST guardu agenta 4 (`[sandbox_policy_blocked:<rule>]`); len čítame formát. */
const GUARD_PREFIX = '[sandbox_policy_blocked:';
/** Bezpečnostný (alebo parser) nález guardu – nikdy ho neopravuje AI. Syntax chyby guard odkladá do esbuildu. */
export function isSecurityBlock(errors: ReadonlyArray<{ message: string }>): boolean {
  return errors.some(error => error.message.includes(GUARD_PREFIX));
}

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
  opts?: { signal?: AbortSignal; executor?: SandboxExecutor; beforeAi?: () => Promise<void>; maxAttempts?: number },
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
      progress: [],
    };
  }

  // Invalid paths/duplicates/size/dependencies are policy failures, not compiler repairs.
  const invalid=validateFiles(current);
  try{patchBase(current);}catch{if(!invalid.length)invalid.push({file:'-',message:'Neplatné alebo prázdne podklady pre opravu.'});}
  if(invalid.length)return{ok:false,attempts:0,finalFiles:[],buildErrors:invalid.map(error=>({...error,attempt:0})),patchesApplied:0,history:[{attempt:0,phase:'build',message:'Neplatné podklady; build a AI oprava sa nespustili.'}],progress:[]};

  history.push({ attempt: 0, phase: 'build', message: 'počiatočný build' });
  const executor = opts?.executor ?? getSandboxExecutor();
  const progress: AutofixProgressStep[] = [];
  let blocked: AutofixResult['blocked'];
  let stopped: AutofixResult['stopped'];
  let result = await buildWithRedactedErrors(current, executor, opts?.signal);

  const maxAttempts = Math.min(MAX_ATTEMPTS, Math.max(1, Math.trunc(opts?.maxAttempts ?? MAX_ATTEMPTS) || MAX_ATTEMPTS));
  while (!result.ok && attempts < maxAttempts) {
    if (isSecurityBlock(result.errors)) {
      // Security findings are blocking. They are never sent to the model, so no paid attempt starts.
      // A guard finding introduced by an AI patch also ends the loop; the candidate is discarded below.
      blocked = 'security';
      for (const e of result.errors) buildErrors.push({ ...e, attempt: attempts });
      history.push({ attempt: attempts, phase: 'build', message: 'bezpečnostný nález AST guardu; AI oprava sa nespustí' });
      break;
    }
    attempts++;
    for (const e of result.errors) buildErrors.push({ ...e, attempt: attempts });
    history.push({ attempt: attempts, phase: 'build', message: `build zlyhal: ${result.errors.length} chýb` });
    progress.push({ attempt: attempts, step: 'build', status: 'failed' });

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
      progress.push({ attempt: attempts, step: 'patch', status: 'ok' });
    } catch (e) {
      // Quota exhausted after at least one paid attempt: stop without a free extra attempt and
      // return the partial result. Before the first paid attempt it still reaches HTTP (429).
      if(admissionFailed&&attempts>1&&e instanceof QuotaAdmissionError&&e.code==='quota_exceeded'){
        attempts--;progress.pop();stopped='quota_exceeded';
        history.push({ attempt: attempts, phase: 'patch', message: 'kvóta AI vyčerpaná; ďalší pokus sa nespustil' });
        break;
      }
      // Admission failures must reach HTTP; they are not failed model patches.
      if(admissionFailed||e instanceof ContextBudgetError||e instanceof UsageLedgerError)throw e;
      history.push({ attempt: attempts, phase: 'patch', message: 'AI patch zlyhal: ' + redactSecrets(String(e)).slice(0, 120) });
      progress.push({ attempt: attempts, step: 'patch', status: 'failed' });
      break;
    }

    /* REBUILD + VERIFY */
    result = await buildWithRedactedErrors(current, executor, opts?.signal);
    progress.push({ attempt: attempts, step: 'rebuild', status: result.ok ? 'ok' : 'failed' });
    if (result.ok) {
      history.push({ attempt: attempts, phase: 'done', message: 'build úspešný po oprave' });
    }
  }

  if (!result.ok && !blocked && attempts > 0 && isSecurityBlock(result.errors)) {
    blocked = 'security';
    history.push({ attempt: attempts, phase: 'build', message: 'AI návrh vytvoril bezpečnostný nález; zahodený' });
  }
  // Safe return: a candidate that introduced a guard finding is never handed back as a proposal.
  // Any unverified candidate is discarded too: the client keeps the last working state.
  if (!result.ok) current = files.map(file => ({ ...file }));
  return {
    ok: result.ok,
    attempts,
    finalFiles: current,
    buildErrors,
    patchesApplied,
    ...(summary&&!blocked?{summary}:{}),
    history,
    progress,
    ...(blocked ? { blocked } : {}),
    ...(stopped ? { stopped } : {}),
  };
}
