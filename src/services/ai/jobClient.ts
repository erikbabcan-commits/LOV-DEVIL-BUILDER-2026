import { AiRequestError, NetworkError, isTerminal, streamAgentEvents, type GenerateInput } from './client';
import { createAgentJob } from './jobs';
import { pollJobEvents, type JobTransport } from './streamRecovery';
import type { AgentEvent } from './types';
import { deleteJobCache, loadJobCaches, loadMeta, saveJobCache, type StoredJobCache } from '../persistence/db';

export { backoffDelay, jobClientConfig, JobRecoveryError, type JobTransport } from './streamRecovery';

/* Agent 2: resilient job client. The server job row is the source of truth; SSE is
   only a live view. Every IndexedDB write is fire-and-forget with `.catch` so a
   missing/locked IndexedDB never produces an unhandled rejection. */

export interface JobHooks {
  onTransport?: (transport: JobTransport, jobId: string | null) => void;
  /** Chat message that renders this job (stored so a reload continues it, no duplicates). */
  messageId?: string | null;
}

/** Cached jobs older than this are not resumed (and are dropped). */
export const JOB_CACHE_TTL_MS = 30 * 60_000;
let jobsEndpoint: 'unknown' | 'missing' = 'unknown';
/** Test hook: forget the POST /api/agent/jobs feature detection result. */
export function resetJobClientForTests() { jobsEndpoint = 'unknown'; }

const newKey = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^A-Za-z0-9_-]/g, '');

/** Serialised cache writer: at most one write in flight, the latest state wins. */
function cacheWriter(record: StoredJobCache) {
  let busy = false, dirty = false, closed = false;
  const flush = () => {
    if (busy || closed) return;
    busy = true; dirty = false;
    void saveJobCache({ ...record, events: [...record.events], updatedAt: Date.now() })
      .catch(() => {})
      .finally(() => { busy = false; if (dirty) flush(); });
  };
  return {
    record,
    push(event: AgentEvent, seen: number) { record.events.push(event); record.seen = seen; dirty = true; flush(); },
    save() { dirty = true; flush(); },
    /** Terminal / user abort: stop writing and drop the cache entry. */
    clear() { closed = true; void deleteJobCache(record.jobId).catch(() => {}); },
    /** Transport failed: keep the last written state so a reload can resume. */
    close() { if (!closed && dirty && !busy) flush(); closed = true; },
  };
}

function recoverable(error: unknown) {
  return error instanceof NetworkError || (error instanceof AiRequestError && error.code === 'stream_interrupted');
}

/**
 * Runs one agent job and yields its events exactly once, in order:
 * 1. POST /api/agent/jobs (contract B, Idempotency-Key) → poll in `background`;
 * 2. feature detection: 404/405 or no B response → today's SSE /api/agent/generate (`streaming`);
 * 3. SSE error / close without a terminal event → `reconnecting` → poll GET /api/agent/jobs/:id.
 * If recovery fails the original SSE error is rethrown (callers keep today's messages).
 */
export async function* runAgentJob(input: GenerateInput, signal: AbortSignal, hooks: JobHooks = {}): AsyncGenerator<AgentEvent> {
  const state: { transport: JobTransport } = { transport: 'idle' };
  let jobId: string | null = null;
  const report = (next: JobTransport) => { state.transport = next; hooks.onTransport?.(next, next === 'idle' ? null : jobId); };
  const record: StoredJobCache = { jobId: '', projectId: input.projectId, prompt: input.prompt, messageId: hooks.messageId ?? null, events: [], seen: 0, updatedAt: Date.now() };
  let cache: ReturnType<typeof cacheWriter> | null = null;
  const track = (id: string) => {
    jobId = id; record.jobId = id;
    cache = cacheWriter(record);
    cache.save();
  };
  void deleteJobCache(null).catch(() => {}); // one active run: drop stale recoveries
  // Prepare the SSE fallback now, in call order with other runs. An async generator does
  // no I/O until iterated, so this costs nothing when the B endpoint answers.
  const sse = streamAgentEvents(input, signal);
  let finished = false, usedSse = false;
  try {
    let created: Awaited<ReturnType<typeof createAgentJob>> = null;
    if (jobsEndpoint !== 'missing') {
      try {
        created = await createAgentJob(input, newKey(), signal);
        if (!created) jobsEndpoint = 'missing';
      } catch (error) {
        if (signal.aborted) return;
        created = null; // network/other failure: fall back to the SSE path (today's behaviour)
        void error;
      }
    }
    if (signal.aborted) return;
    if (created) {
      track(created.job.id);
      report('background');
      for await (const event of pollJobEvents({ jobId: created.job.id, seen: 0, signal, mode: 'background', onTransport: report, onSeen: (seen, ev) => cache?.push(ev, seen) })) {
        yield event;
        if (isTerminal(event)) finished = true;
      }
      finished = true;
      return;
    }
    report('streaming');
    let streamError: unknown = new AiRequestError('stream_interrupted', true);
    try {
      usedSse = true;
      for await (const event of sse) {
        if (event.type === 'run_started' && !jobId) track(event.runId);
        if (cache) (cache as ReturnType<typeof cacheWriter>).push(event, record.seen + 1);
        yield event;
        if (isTerminal(event)) { finished = true; return; }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (!recoverable(error)) throw error;
      streamError = error;
    }
    if (signal.aborted) return;
    if (!jobId) throw streamError;
    report('reconnecting');
    try {
      for await (const event of pollJobEvents({ jobId, seen: record.seen, signal, mode: 'polling', onTransport: report, onSeen: (seen, ev) => cache?.push(ev, seen) })) {
        yield event;
        if (isTerminal(event)) finished = true;
      }
      finished = true;
    } catch {
      if (signal.aborted) return;
      throw streamError;
    }
  } finally {
    if (!usedSse) void sse.return(undefined).catch(() => {});
    const c = cache as ReturnType<typeof cacheWriter> | null;
    if (finished || signal.aborted) c?.clear(); else c?.close();
    if (state.transport !== 'failed') report('idle');
  }
}

export interface JobResume {
  id: string;
  prompt: string;
  messageId: string | null;
  /** Events already rendered before the reload. */
  events: AgentEvent[];
  seen: number;
}

/** Newest resumable job of the current account scope: forge_job_cache first, then #77's meta. */
export async function loadJobResume(now = Date.now()): Promise<JobResume | null> {
  const records = await loadJobCaches().catch(() => [] as StoredJobCache[]);
  const fresh = records.filter(r => r.jobId && now - r.updatedAt <= JOB_CACHE_TTL_MS).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const stale of records.filter(r => !fresh.includes(r))) void deleteJobCache(stale.jobId).catch(() => {});
  const latest = fresh[0];
  if (latest) return { id: latest.jobId, prompt: latest.prompt, messageId: latest.messageId, events: latest.events as AgentEvent[], seen: latest.seen };
  const meta = await loadMeta<{ id: string; prompt: string }>('activeAgentJob').catch(() => null);
  return meta?.id ? { id: meta.id, prompt: meta.prompt ?? '', messageId: null, events: [], seen: 0 } : null;
}

/** Continues a job after reload in `background`, yielding only events after `resume.seen`. */
export async function* resumeJobEvents(resume: JobResume, signal: AbortSignal, hooks: JobHooks = {}, projectId = ''): AsyncGenerator<AgentEvent> {
  const state: { transport: JobTransport } = { transport: 'background' };
  const report = (next: JobTransport) => { state.transport = next; hooks.onTransport?.(next, next === 'idle' ? null : resume.id); };
  const cache = cacheWriter({ jobId: resume.id, projectId, prompt: resume.prompt, messageId: resume.messageId, events: [...resume.events], seen: resume.seen, updatedAt: Date.now() });
  let finished = false;
  report('background');
  try {
    for await (const event of pollJobEvents({ jobId: resume.id, seen: resume.seen, signal, mode: 'background', onTransport: report, onSeen: (seen, ev) => cache.push(ev, seen) })) yield event;
    finished = true;
  } finally {
    if (finished || signal.aborted) cache.clear(); else cache.close();
    if (state.transport !== 'failed') report('idle');
  }
}

/** Text already shown for the cached events (answer deltas). */
export function answerFromEvents(events: AgentEvent[]): string {
  return events.map(event => (event.type === 'text_delta' ? event.delta : '')).join('');
}
