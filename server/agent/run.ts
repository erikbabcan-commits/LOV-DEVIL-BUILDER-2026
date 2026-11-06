import {requestPatch,patchBase,isPatchPath,PatchError} from './patches';
import {resolveIntent} from './intent';
import {explainProject} from './explain';
import {prepareContext,preflightContext} from './context';
import {contextGuardedProvider,ContextBudgetError} from '../providers/contextBudget';
import { ProviderError } from '../providers/errors';
import { GenerateRequestSchema, GeneratedFileSchema, ValidationResultSchema } from './schemas';
import type { AgentEvent, GeneratedFile, ValidationResult } from './schemas';
import type { AIProvider } from '../providers/types';
import { requestPlan, requestFilesBatched } from './prompts';
import { isSafePath, withinSizeLimits } from '../security/pathGuard';
import { containsPotentialSecret, redactSecrets } from '../security/secrets';

/* Agent run: orchestruje lifecycle a vydáva reálne SSE eventy.
   Žiadne timery — každý event zodpovedá skutočnému kroku (plan call, file call, validácia). */

export interface RunOptions {
  runId: string;
  provider: AIProvider;
  signal?: AbortSignal;
  maxFiles: number;
}

/* Only inspect schema-validated, bounded JSON data. Keep the original strings
   intact for scanning: serializing first can change escaped credential text. */
function containsSecretText(value: unknown): boolean {
  if (typeof value === 'string') return containsPotentialSecret(value);
  if (Array.isArray(value)) return value.some(containsSecretText);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsSecretText);
  }
  return false;
}

export function parseAgentRequest(req: unknown) {
  const parsed = GenerateRequestSchema.safeParse(req);
  if (!parsed.success) return { ok: false as const, error: { code: 'bad_request', message: redactSecrets(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')).slice(0, 400), retriable: false } };
  if (containsSecretText(parsed.data)) return { ok: false as const, error: { code: 'secret_in_context', message: 'Požiadavka obsahuje potenciálne prihlasovacie údaje; AI volanie bolo zablokované.', retriable: false } };
  if(new Set(parsed.data.context.files.map(file=>file.path)).size!==parsed.data.context.files.length)return{ok:false as const,error:{code:'bad_request',message:'Kontext obsahuje duplicitné cesty súborov.',retriable:false}};
  return { ok: true as const, request: parsed.data };
}

function interrupted(opts: RunOptions): AgentEvent {
  if (opts.signal?.reason instanceof ProviderError && opts.signal.reason.kind==='timeout') return {type:'error',code:'provider_timeout',message:opts.signal.reason.message,retriable:true};
  return {type:'cancelled',runId:opts.runId};
}

export async function* runAgent(req: unknown, opts: RunOptions): AsyncGenerator<AgentEvent> {
  const input = parseAgentRequest(req);
  if (!input.ok) { yield { type: 'error', ...input.error }; return; }
  let request = input.request;

  if (opts.signal?.aborted) { yield interrupted(opts); return; }

  yield { type: 'run_started', runId: opts.runId, model: opts.provider.model };
  if (opts.signal?.aborted) { yield interrupted(opts); return; }

  try {
    preflightContext(request,opts.provider);
    const provider=contextGuardedProvider(opts.provider);
    let intent=await resolveIntent(request,provider,opts.signal);
    // A missing project cannot be fixed/edited safely by inventing replacement files.
    if(!request.context.files.length&&(intent==='fix'||intent==='iterate'))intent='explain';
    request={...request,mode:intent};preflightContext(request,provider);
    const editing=intent==='iterate'||intent==='fix';if(editing)patchBase(request.context.files);
    yield{type:'intent_selected',intent};
    if((request.context.conversation?.length??0)>8)yield{type:'context_update',state:'summarizing',summarizedTurns:request.context.conversation!.length-8,summaryCalls:0};
    const prepared=await prepareContext(request,provider,opts.signal);
    request=prepared.request;
    if(prepared.summarizedTurns)yield{type:'context_update',state:'ready',summarizedTurns:prepared.summarizedTurns,summaryCalls:prepared.summaryCalls};
    if(intent==='explain'){
      for await(const delta of explainProject(provider,request,opts.signal))yield{type:'text_delta',delta};
      yield{type:'done',runId:opts.runId,summary:'Odpoveď dokončená. Súbory sa nemenili.'};return;
    }
    /* PLAN — reálna inference */
    const plan = await requestPlan(provider, request, opts.signal);
    if (containsSecretText(plan)) {
      yield { type: 'error', code: 'secret_in_output', message: 'Plán obsahuje potenciálne prihlasovacie údaje; ďalšie AI volanie bolo zablokované.', retriable: false };
      return;
    }
    yield { type: 'plan', plan };
    for (const s of plan.steps) {
      yield { type: 'plan_step', stepId: s.id, state: 'running' };
    }

    if (opts.signal?.aborted) { yield interrupted(opts); return; }

    /* GENERATE — reálna inference po batchoch; súbory z modelu,
       konzistencia cez accumulated context medzi batchmi. */
    const patch=editing?await requestPatch(provider,request,plan,opts.signal):null;
    const rawFiles=patch?.files??await requestFilesBatched(provider,request,plan,{maxFiles:opts.maxFiles,signal:opts.signal});

    /* VALIDATE — cesty, veľkosti, schéma */
    const validation = validateFiles(rawFiles, opts.maxFiles,editing);
    yield { type: 'validation', result: validation };

    if (!validation.ok) {
      yield { type: 'error', code: 'validation_failed', message: validation.errors.map(e => `${e.path}: ${e.message}`).join('; ').slice(0, 400), retriable: true };
      return;
    }

    /* STAGE — súbory pripravené na review/apply (klient ich aplikuje cez VFS) */
    const safeFiles = rawFiles.filter(f => editing?isPatchPath(f.path):isSafePath(f.path)).slice(0, opts.maxFiles);
    for (const f of safeFiles) {
      yield { type: 'file_started', path: f.path, action: f.action };
    }
    yield { type: 'stage', files: safeFiles,...(patch?{editMode:'patch' as const,summary:patch.summary}:{}) };
    for (const f of safeFiles) {
      yield { type: 'file_done', path: f.path, bytes: Buffer.byteLength(f.content, 'utf8'), action: f.action };
    }

    yield { type: 'done', runId: opts.runId, summary: `Dokončené: ${safeFiles.length} súborov podľa plánu (${plan.steps.length} krokov).` };
  } catch (err) {
    if (opts.signal?.aborted) { yield interrupted(opts); return; }
    if(err instanceof PatchError){yield{type:'error',code:err.code,message:err.message,retriable:false};return;}
    if(err instanceof ContextBudgetError){yield{type:'error',code:'context_limit',message:err.message,retriable:false};return;}
    const msg = err instanceof Error ? err.message : String(err);
    const retriable = err instanceof ProviderError ? err.retryable : /timeout|HTTP 5\d\d|network|ECONN/i.test(msg);
    yield { type: 'error', code: retriable ? 'provider_error' : 'generation_failed', message: redactSecrets(msg).slice(0, 400), retriable };
  }
}

export function validateFiles(files: unknown[], maxFiles: number,patch=false): ValidationResult {
  const errors: ValidationResult['errors'] = [];
  if (files.length === 0) errors.push({ path: '-', message: 'model nevrátil žiadne súbory', code: 'empty' });
  if (files.length > maxFiles) errors.push({ path: '-', message: `priveľa súborov (${files.length} > ${maxFiles})`, code: 'schema' });

  const seen = new Set<string>();
  for (const f of files) {
    const r = GeneratedFileSchema.safeParse(f);
    if (!r.success) { errors.push({ path: '?', message: 'nevalidná schéma súboru', code: 'schema' }); continue; }
    const { path, content } = r.data;
    const diagnosticPath = redactSecrets(path);
    if (containsPotentialSecret(path)) errors.push({ path: diagnosticPath, message: 'cesta obsahuje potenciálne tajomstvo', code: 'schema' });
    if (!(patch?isPatchPath(path):isSafePath(path))) errors.push({ path: diagnosticPath, message: 'zakázaná cesta (mimo whitelist / traversal)', code: 'invalid_path' });
    if (seen.has(path)) errors.push({ path: diagnosticPath, message: 'duplicitná cesta vo výstupe', code: 'schema' });
    seen.add(path);
    if (!patch&&(content.length === 0||r.data.action==='delete')) errors.push({ path: diagnosticPath, message: 'prázdny obsah', code: 'empty' });
    if (containsPotentialSecret(content)) errors.push({ path: diagnosticPath, message: 'výstup obsahuje potenciálne tajomstvo', code: 'schema' });
  }
  const size = withinSizeLimits(files.filter((f): f is GeneratedFile => GeneratedFileSchema.safeParse(f).success));
  if (!size.ok) errors.push({ path: '-', message: redactSecrets(size.reason ?? 'veľkostný limit prekročený'), code: 'too_large' });

  return ValidationResultSchema.parse({ ok: errors.length === 0, errors });
}
