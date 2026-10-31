import { GenerateRequestSchema, GeneratedFileSchema, ValidationResultSchema } from './schemas';
import type { AgentEvent, GeneratedFile, ValidationResult } from './schemas';
import type { AIProvider } from '../providers/types';
import { requestPlan, requestFiles } from './prompts';
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

export async function* runAgent(req: unknown, opts: RunOptions): AsyncGenerator<AgentEvent> {
  const parsed = GenerateRequestSchema.safeParse(req);
  if (!parsed.success) {
    yield { type: 'error', code: 'bad_request', message: redactSecrets(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')).slice(0, 400), retriable: false };
    return;
  }
  const request = parsed.data;

  if (containsSecretText(request)) {
    yield { type: 'error', code: 'secret_in_context', message: 'Požiadavka obsahuje potenciálne prihlasovacie údaje; AI volanie bolo zablokované.', retriable: false };
    return;
  }

  if (opts.signal?.aborted) { yield { type: 'cancelled', runId: opts.runId }; return; }

  yield { type: 'run_started', runId: opts.runId, model: opts.provider.model };

  try {
    /* PLAN — reálna inference */
    const plan = await requestPlan(opts.provider, request, opts.signal);
    if (containsSecretText(plan)) {
      yield { type: 'error', code: 'secret_in_output', message: 'Plán obsahuje potenciálne prihlasovacie údaje; ďalšie AI volanie bolo zablokované.', retriable: false };
      return;
    }
    yield { type: 'plan', plan };
    for (const s of plan.steps) {
      yield { type: 'plan_step', stepId: s.id, state: 'running' };
    }

    if (opts.signal?.aborted) { yield { type: 'cancelled', runId: opts.runId }; return; }

    /* GENERATE — reálna inference, súbory z modelu */
    const rawFiles = await requestFiles(opts.provider, request, plan, opts.signal);

    /* VALIDATE — cesty, veľkosti, schéma */
    const validation = validateFiles(rawFiles, opts.maxFiles);
    yield { type: 'validation', result: validation };

    if (!validation.ok) {
      yield { type: 'error', code: 'validation_failed', message: validation.errors.map(e => `${e.path}: ${e.message}`).join('; ').slice(0, 400), retriable: true };
      return;
    }

    /* STAGE — súbory pripravené na review/apply (klient ich aplikuje cez VFS) */
    const safeFiles = rawFiles.filter(f => isSafePath(f.path)).slice(0, opts.maxFiles);
    for (const f of safeFiles) {
      yield { type: 'file_started', path: f.path, action: f.action };
    }
    yield { type: 'stage', files: safeFiles };
    for (const f of safeFiles) {
      yield { type: 'file_done', path: f.path, bytes: Buffer.byteLength(f.content, 'utf8'), action: f.action };
    }

    yield { type: 'done', runId: opts.runId, summary: `Dokončené: ${safeFiles.length} súborov podľa plánu (${plan.steps.length} krokov).` };
  } catch (err) {
    if (opts.signal?.aborted) { yield { type: 'cancelled', runId: opts.runId }; return; }
    const msg = err instanceof Error ? err.message : String(err);
    const retriable = /timeout|HTTP 5\d\d|network|ECONN/i.test(msg);
    yield { type: 'error', code: retriable ? 'provider_error' : 'generation_failed', message: redactSecrets(msg).slice(0, 400), retriable };
  }
}

export function validateFiles(files: unknown[], maxFiles: number): ValidationResult {
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
    if (!isSafePath(path)) errors.push({ path: diagnosticPath, message: 'zakázaná cesta (mimo whitelist / traversal)', code: 'invalid_path' });
    if (seen.has(path)) errors.push({ path: diagnosticPath, message: 'duplicitná cesta vo výstupe', code: 'schema' });
    seen.add(path);
    if (content.length === 0) errors.push({ path: diagnosticPath, message: 'prázdny obsah', code: 'empty' });
    if (containsPotentialSecret(content)) errors.push({ path: diagnosticPath, message: 'výstup obsahuje potenciálne tajomstvo', code: 'schema' });
  }
  const size = withinSizeLimits(files.filter((f): f is GeneratedFile => GeneratedFileSchema.safeParse(f).success));
  if (!size.ok) errors.push({ path: '-', message: redactSecrets(size.reason ?? 'veľkostný limit prekročený'), code: 'too_large' });

  return ValidationResultSchema.parse({ ok: errors.length === 0, errors });
}
