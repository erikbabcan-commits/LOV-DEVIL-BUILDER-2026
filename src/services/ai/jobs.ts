import { AgentJobListSchema, AgentJobViewSchema } from '../../../shared/agentJobs';
import { apiHeaders } from '../../lib/csrf';
import { AI_API_BASE } from './client';

/* Durable agent jobs client (#75 step 3): the job row on the server is the
   source of truth; SSE is only a live view. Used to poll/resume after reload
   and to cancel a run. Cookie auth is required (credentials: 'include'). */

export class AgentJobError extends Error {
  constructor(readonly code: string) { super(code); }
}

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

export function getAgentJob(id: string, signal?: AbortSignal) {
  return call('/api/agent/jobs/' + encodeURIComponent(id), signal ?? AbortSignal.timeout(15_000))
    .then(data => AgentJobViewSchema.parse(data));
}

export function listAgentJobs(signal?: AbortSignal) {
  return call('/api/agent/jobs', signal ?? AbortSignal.timeout(15_000))
    .then(data => AgentJobListSchema.parse(data));
}

export function cancelAgentJob(id: string, signal?: AbortSignal) {
  return call('/api/agent/jobs/' + encodeURIComponent(id) + '/cancel', signal ?? AbortSignal.timeout(15_000), {})
    .then(data => AgentJobViewSchema.parse(data));
}
