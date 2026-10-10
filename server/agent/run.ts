import { z } from 'zod';
import { GenerateRequestSchema, PlanSchema, GeneratedFileSchema, ValidationResultSchema, AgentEventSchema } from './schemas';
import type { AgentEvent, GeneratedFile, ValidationResult } from './schemas';
import type { AIProvider } from '../providers/types';
import { requestPlan, requestFiles } from './prompts';
import { isSafePath, withinSizeLimits } from '../security/pathGuard';

/* Agent run: orchestruje lifecycle a vydáva reálne SSE eventy.
   Žiadne timery — každý event zodpovedá skutočnému kroku (plan call, file call, validácia). */

export interface RunOptions {
  runId: string;
  provider: AIProvider;
  signal?: AbortSignal;
  maxFiles: number;
}

export async function* runAgent(req: unknown, opts: RunOptions): AsyncGenerator<AgentEvent> {
  const parsed = GenerateRequestSchema.safeParse(req);
  if (!parsed.success) {
    yield { type: 'error', code: 'bad_request', message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 400), retriable: false };
    return;
  }
  const request = parsed.data;

  if (opts.signal?.aborted) { yield { type: 'cancelled', runId: opts.runId }; return; }

  yield { type: 'run_started', runId: opts.runId, model: opts.provider.model };

  try {
    /* PLAN — reálna inference */
    const plan = await requestPlan(opts.provider, request, opts.signal);
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
    yield { type: 'error', code: retriable ? 'provider_error' : 'generation_failed', message: msg.slice(0, 400), retriable };
  }
}

export function validateFiles(files: unknown[], maxFiles: number): ValidationResult {
  const errors: ValidationResult['errors'] = [];
  if (files.length === 0) errors.push({ path: '-', message: 'model nevrátil žiadne súbory', code: 'empty' });
  if (files.length > maxFiles) errors.push({ path: '-', message: `priveľa súborov (${files.length} > ${maxFiles})`, code: 'schema' });

  const seen = new Set<string>();
  let parsedCount = 0;
  for (const f of files) {
    const r = GeneratedFileSchema.safeParse(f);
    if (!r.success) { errors.push({ path: '?', message: 'nevalidná schéma súboru', code: 'schema' }); continue; }
    parsedCount++;
    const { path, content } = r.data;
    if (!isSafePath(path)) errors.push({ path, message: 'zakázaná cesta (mimo whitelist / traversal)', code: 'invalid_path' });
    if (seen.has(path)) errors.push({ path, message: 'duplicitná cesta vo výstupe', code: 'schema' });
    seen.add(path);
    if (content.length === 0) errors.push({ path, message: 'prázdny obsah', code: 'empty' });
  }
  const size = withinSizeLimits(files.filter((f): f is GeneratedFile => GeneratedFileSchema.safeParse(f).success));
  if (!size.ok) errors.push({ path: '-', message: size.reason ?? 'veľkostný limit prekročený', code: 'too_large' });

  return ValidationResultSchema.parse({ ok: errors.length === 0, errors });
}
