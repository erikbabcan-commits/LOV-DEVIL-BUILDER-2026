import { TERMINAL_JOB_STATES } from '../../../shared/agentJobs';
import { AgentJobError, getAgentJob, type AnyAgentJob } from './jobs';
import type { AgentEvent } from './types';

/* Agent 2: transport state machine for one durable agent job.
   idle → streaming (SSE) → reconnecting (backoff) → polling → idle on a terminal job;
   background = polling a job that has no live SSE view (POST /api/agent/jobs or reload);
   failed = gave up after the backoff limit (the job keeps running on the server). */
export type JobTransport = 'idle' | 'streaming' | 'reconnecting' | 'polling' | 'background' | 'failed';

export const jobClientConfig = {
  /** First retry delay; doubles per failed attempt up to `maxDelayMs`. */
  baseDelayMs: 400,
  maxDelayMs: 8_000,
  /** Consecutive failed polls before the transport becomes `failed`. */
  maxRetries: 3,
  /** Interval between successful polls of a still running job. */
  pollIntervalMs: 2_000,
  /** Hard cap on polls per attempt (~20 min at the default interval). */
  maxPolls: 600,
};

/** Exponential backoff with a cap: attempt 1 → base, 2 → 2×base, … ≤ maxDelayMs. */
export function backoffDelay(attempt: number, config = jobClientConfig): number {
  return Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

export class JobRecoveryError extends Error {
  constructor(readonly code: 'unrecoverable' | 'retries_exhausted' | 'timeout', readonly cause?: unknown) {
    super('job_recovery_' + code);
  }
}

const isTerminalState = (job: AnyAgentJob) => (TERMINAL_JOB_STATES as readonly string[]).includes(job.state);
const hasEvent = (events: AgentEvent[], type: AgentEvent['type']) => events.some(event => event.type === type);

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Terminal job without a terminal event (A rows store only `error`): synthesize one so
 *  consumers never hang on a finished job. Succeeded jobs still need their own events
 *  (stage/validation/done) for review — nothing is applied from here. */
function closingEvents(job: AnyAgentJob, events: AgentEvent[]): AgentEvent[] {
  if (job.state === 'failed' && !hasEvent(events, 'error')) {
    const payload = 'errorPayload' in job ? job.errorPayload : null;
    return [{ type: 'error', code: (payload?.code ?? 'job_failed').slice(0, 40), message: (payload?.message ?? job.error ?? 'AI úloha zlyhala.').slice(0, 400), retriable: payload?.retriable ?? false }];
  }
  if (job.state === 'cancelled' && !hasEvent(events, 'cancelled')) return [{ type: 'cancelled', runId: job.id }];
  return [];
}

export interface PollOptions {
  jobId: string;
  /** Number of server events already consumed (never re-emitted). */
  seen: number;
  signal: AbortSignal;
  /** Transport to report while the job runs: `polling` after an SSE drop, `background` otherwise. */
  mode: 'polling' | 'background';
  onTransport: (transport: JobTransport) => void;
  /** Called after every consumed event with the new `seen` index. */
  onSeen?: (seen: number, event: AgentEvent) => void;
}

/** Polls GET /api/agent/jobs/:id?detail=1 until the job is terminal, yielding only new events. */
export async function* pollJobEvents(options: PollOptions): AsyncGenerator<AgentEvent> {
  const { jobId, signal, mode, onTransport } = options;
  let seen = options.seen, failures = 0;
  const emitted: AgentEvent[] = [];
  for (let poll = 0; ; poll++) {
    if (signal.aborted) return;
    if (poll >= jobClientConfig.maxPolls) { onTransport('failed'); throw new JobRecoveryError('timeout'); }
    let job: AnyAgentJob;
    try {
      job = await getAgentJob(jobId, signal, true);
    } catch (error) {
      if (signal.aborted) return;
      const code = error instanceof AgentJobError ? error.code : 'invalid_response';
      if (code === 'job_not_found' || code === 'login_required' || code === 'invalid_job_id' || code === 'invalid_response') {
        onTransport('failed');
        throw new JobRecoveryError('unrecoverable', error);
      }
      failures++;
      if (failures > jobClientConfig.maxRetries) { onTransport('failed'); throw new JobRecoveryError('retries_exhausted', error); }
      onTransport('reconnecting');
      await sleep(backoffDelay(failures), signal);
      continue;
    }
    failures = 0;
    for (const event of job.events.slice(seen) as AgentEvent[]) {
      if (signal.aborted) return;
      seen++;
      emitted.push(event);
      options.onSeen?.(seen, event);
      yield event;
    }
    if (isTerminalState(job)) {
      for (const event of closingEvents(job, emitted)) yield event;
      onTransport('idle');
      return;
    }
    onTransport(mode);
    await sleep(jobClientConfig.pollIntervalMs, signal);
  }
}
