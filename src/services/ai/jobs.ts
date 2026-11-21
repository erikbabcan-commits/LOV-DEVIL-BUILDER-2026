import { z } from 'zod';
import {
  AgentJobDetailSchema, AgentJobErrorCode, AgentJobId, AgentJobViewSchema, IDEMPOTENCY_HEADER, IdempotencyKey,
  type AgentJobCreateRequest,
} from '../../../shared/agentJobs';
import { apiHeaders } from '../../lib/csrf';
import { AI_API_BASE } from './client';

/* Durable agent jobs client (#75 step 3): the job row on the server is the
   source of truth; SSE is only a live view. Used to poll/resume after reload
   and to cancel a run. Cookie auth is required (credentials: 'include'). */

/** Contract codes (shared/agentJobs.ts) plus client-side codes such as `network` or `login_required`. */
export type AgentJobClientErrorCode = AgentJobErrorCode | 'network' | 'login_required' | 'unavailable' | (string & {});

export class AgentJobError extends Error {
  constructor(readonly code: AgentJobClientErrorCode) { super(code); }
}

/** A typed contract code from the server body wins over the generic status mapping (e.g. 429 too_many_active_jobs ≠ rate_limit). */
function contractCode(data: unknown): AgentJobErrorCode | null {
  const raw = data && typeof data === 'object' && 'error' in data ? (data as { error: unknown }).error : null;
  const parsed = AgentJobErrorCode.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Accepts today's A-shape view and Agent 1's future B-shape detail (frozen contract). */
export const AnyAgentJobSchema = z.union([AgentJobDetailSchema, AgentJobViewSchema]);
export type AnyAgentJob = z.infer<typeof AnyAgentJobSchema>;
const AnyJobListSchema = z.object({ jobs: z.array(AnyAgentJobSchema).max(50) }).strict();
/* 202 AgentJobCreatedSchema / 200 AgentJobReplaySchema, with either job shape. */
const AnyJobCreatedSchema = z.object({ job: AnyAgentJobSchema, replayed: z.boolean() }).strict();

async function call(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(AI_API_BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include',
      cache: 'no-store',
      signal,
      ...(body === undefined ? {} : { headers: apiHeaders(), body: JSON.stringify(body) }),
    });
  } catch {
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    throw new AgentJobError('network');
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
      ? (data as { error: string }).error
      : 'unavailable';
    throw new AgentJobError(res.status === 401 ? 'login_required' : res.status === 404 ? 'job_not_found' : res.status === 429 ? 'rate_limit' : code);
  }
  return data;
}

/** `detail` asks Agent 1's server for the B shape (`?detail=1`); A servers ignore it. */
export function getAgentJob(id: string, signal?: AbortSignal, detail = false) {
  return call('/api/agent/jobs/' + encodeURIComponent(id) + (detail ? '?detail=1' : ''), signal ?? AbortSignal.timeout(15_000))
    .then(data => AnyAgentJobSchema.parse(data));
}

export function listAgentJobs(signal?: AbortSignal) {
  return call('/api/agent/jobs', signal ?? AbortSignal.timeout(15_000))
    .then(data => AnyJobListSchema.parse(data));
}

export function cancelAgentJob(id: string, signal?: AbortSignal) {
  return call('/api/agent/jobs/' + encodeURIComponent(id) + '/cancel', signal ?? AbortSignal.timeout(15_000), {})
    .then(data => AnyAgentJobSchema.parse(data));
}

/**
 * POST /api/agent/jobs (contract section B, Agent 1). Feature detection:
 * resolves `null` when the endpoint does not exist yet (404/405), so the caller
 * falls back to today's SSE `POST /api/agent/generate`. Other failures throw.
 */
export async function createAgentJob(
  input: AgentJobCreateRequest,
  idempotencyKey: string,
  signal: AbortSignal,
): Promise<{ job: AnyAgentJob; replayed: boolean } | null> {
  const key = IdempotencyKey.parse(idempotencyKey);
  let res: Response;
  try {
    res = await fetch(AI_API_BASE + '/api/agent/jobs', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      signal,
      headers: apiHeaders({ [IDEMPOTENCY_HEADER]: key }),
      body: JSON.stringify(input),
    });
  } catch {
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    throw new AgentJobError('network');
  }
  if (res.status === 404 || res.status === 405) return null;
  // 200 + `Idempotent-Replay: true` = the same key already created this job: success, no second run.
  const data: unknown = await res.json().catch(() => null);
  if (res.status !== 200 && res.status !== 202) {
    const code = data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
      ? (data as { error: string }).error
      : 'unavailable';
    throw new AgentJobError(res.status === 401 ? 'login_required' : contractCode(data) ?? (res.status === 429 ? 'rate_limit' : code));
  }
  const parsed = AnyJobCreatedSchema.safeParse(data);
  if (!parsed.success) return null;
  AgentJobId.parse(parsed.data.job.id);
  return parsed.data;
}
