import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getUserFromContext } from '../auth/middleware';
import type { DbLike } from '../db/pool';
import { monthWindow } from '../security/quotaStore';
import { AgentEventSchema, type AgentEvent } from './schemas';
import { parseAgentRequest } from './run';
import {
  AgentJobCreatedSchema, AgentJobDetailSchema, AgentJobErrorPayloadSchema, AgentJobId, AgentJobReplaySchema, AgentJobResultPatchSchema,
  AgentJobViewSchema, IDEMPOTENCY_HEADER, IdempotencyKey, MAX_JOB_EVENTS,
  type AgentJobDetail, type AgentJobErrorPayload, type AgentJobResultPatch, type AgentJobState, type AgentJobView,
} from '../../shared/agentJobs';

/* Durable agent jobs (issue #75, step 3): every /api/agent/generate run is a
   row in agent_jobs; SSE stays a convenience stream, the DB row is the source
   of truth for reconnect/poll/cancel. Requires durable auth (owner_id). */

export interface AgentJobRecord {
  id: string;
  ownerId: string;
  idempotencyKey: string;
  state: AgentJobState;
  events: AgentEvent[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** Part B (migration 024). Absent/null on legacy rows and in-memory stores. */
  request?: unknown;
  attempts?: number;
  tokensUsed?: { input: number; output: number } | null;
  resultPatch?: AgentJobResultPatch | null;
  errorPayload?: AgentJobErrorPayload | null;
}

export interface AgentJobStore {
  findByIdempotency(ownerId: string, key: string): Promise<AgentJobRecord | null>;
  /** Returns null when the (owner, key) pair already exists — caller re-reads and replays. */
  create(job: { id: string; ownerId: string; idempotencyKey: string; request?: unknown }): Promise<AgentJobRecord | null>;
  markRunning(id: string): Promise<void>;
  appendEvents(id: string, events: AgentEvent[]): Promise<void>;
  finish(id: string, state: Exclude<AgentJobState, 'queued' | 'running'>, error?: string | null): Promise<void>;
  get(ownerId: string, id: string): Promise<AgentJobRecord | null>;
  list(ownerId: string, limit: number): Promise<AgentJobRecord[]>;
}

/** Durable queue + ledger operations (migration 024). Only the Postgres store has them. */
export interface DurableAgentJobStore extends AgentJobStore {
  /** Claim the oldest queued worker job (queued -> running, attempts+1). Null when none. */
  claimNext(): Promise<AgentJobRecord | null>;
  /** After a restart: requeue `running` worker jobs (attempts < maxAttempts), fail the rest. Returns counts. */
  recoverInterrupted(maxAttempts: number): Promise<{ requeued: number; failed: number }>;
  /** running -> failed with structured payload. False when the job was no longer running (e.g. cancelled). */
  fail(id: string, payload: AgentJobErrorPayload): Promise<boolean>;
  /** running -> succeeded + ledger row + quota increment in ONE transaction. `debited` is true only for the call that made the transition. */
  completeSucceeded(id: string, result: { resultPatch: AgentJobResultPatch | null; tokensUsed: { input: number; output: number } | null }): Promise<{ transitioned: boolean; debited: boolean }>;
}

export function isDurableJobStore(store: AgentJobStore): store is DurableAgentJobStore {
  const s = store as Partial<DurableAgentJobStore>;
  return typeof s.claimNext === 'function' && typeof s.completeSucceeded === 'function'
    && typeof s.recoverInterrupted === 'function' && typeof s.fail === 'function';
}

interface JobRow {
  id: string;
  owner_id: string;
  idempotency_key: string;
  state: AgentJobState;
  events: unknown;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  request?: unknown;
  attempts?: number | string | null;
  tokens_input?: number | string | null;
  tokens_output?: number | string | null;
  result_patch?: unknown;
  error_payload?: unknown;
}

function toRecord(row: JobRow): AgentJobRecord {
  const events = Array.isArray(row.events) ? row.events : [];
  return {
    id: row.id,
    ownerId: row.owner_id,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    // Cap on read: a long explain stream must not blow up the API response.
    events: events.slice(-MAX_JOB_EVENTS).map(e => AgentEventSchema.parse(e)),
    error: row.error ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    request: row.request ?? null,
    attempts: row.attempts == null ? 0 : Number(row.attempts),
    tokensUsed: row.tokens_input == null || row.tokens_output == null ? null
      : { input: Number(row.tokens_input), output: Number(row.tokens_output) },
    resultPatch: row.result_patch == null ? null : AgentJobResultPatchSchema.parse(row.result_patch),
    errorPayload: row.error_payload == null ? null : AgentJobErrorPayloadSchema.parse(row.error_payload),
  };
}

/** Part B view (`GET /api/agent/jobs/:id?detail=1`): A-shape plus tokensUsed/resultPatch/errorPayload. */
export function toAgentJobDetail(record: AgentJobRecord): AgentJobDetail {
  return AgentJobDetailSchema.parse({
    ...toAgentJobView(record),
    tokensUsed: record.tokensUsed ?? null,
    resultPatch: record.resultPatch ?? null,
    errorPayload: record.errorPayload ?? null,
  });
}

export function toAgentJobView(record: AgentJobRecord): AgentJobView {
  return AgentJobViewSchema.parse({
    id: record.id, state: record.state, events: record.events,
    error: record.error, createdAt: record.createdAt, updatedAt: record.updatedAt,
  });
}

export class PostgresAgentJobStore implements DurableAgentJobStore {
  constructor(private readonly db: DbLike, private readonly now: () => Date = () => new Date()) {}
  private async one(sql: string, params: unknown[]): Promise<AgentJobRecord | null> {
    const res = await this.db.query(sql, params);
    return res.rows[0] ? toRecord(res.rows[0] as JobRow) : null;
  }
  async findByIdempotency(ownerId: string, key: string) {
    return this.one('SELECT * FROM agent_jobs WHERE owner_id=$1 AND idempotency_key=$2', [ownerId, key]);
  }
  async create(job: { id: string; ownerId: string; idempotencyKey: string; request?: unknown }) {
    // Do not rely on RETURNING after ON CONFLICT DO NOTHING: re-read and compare ids,
    // so a racing duplicate (different run id, same key) is detected on every engine.
    // Legacy SSE jobs (no request) keep the 023-only statement.
    if (job.request === undefined) {
      await this.db.query(
        `INSERT INTO agent_jobs (id, owner_id, idempotency_key, state) VALUES ($1, $2, $3, 'queued')
         ON CONFLICT (owner_id, idempotency_key) DO NOTHING`,
        [job.id, job.ownerId, job.idempotencyKey]);
    } else {
      await this.db.query(
        `INSERT INTO agent_jobs (id, owner_id, idempotency_key, state, request) VALUES ($1, $2, $3, 'queued', $4::jsonb)
         ON CONFLICT (owner_id, idempotency_key) DO NOTHING`,
        [job.id, job.ownerId, job.idempotencyKey, JSON.stringify(job.request)]);
    }
    const row = await this.findByIdempotency(job.ownerId, job.idempotencyKey);
    return row && row.id === job.id ? row : null;
  }
  async markRunning(id: string) {
    await this.db.query(`UPDATE agent_jobs SET state='running', updated_at=now() WHERE id=$1 AND state='queued'`, [id]);
  }
  async appendEvents(id: string, events: AgentEvent[]) {
    if (!events.length) return;
    // Read-modify-write (single writer per job = its own stream); avoids the jsonb
    // || operator, which pg-mem does not implement.
    const current = await this.one(`SELECT * FROM agent_jobs WHERE id=$1 AND state IN ('queued','running')`, [id]);
    if (!current) return;
    const merged = [...current.events, ...events].slice(-MAX_JOB_EVENTS);
    await this.db.query('UPDATE agent_jobs SET events=$2::jsonb, updated_at=now() WHERE id=$1', [id, JSON.stringify(merged)]);
  }
  async finish(id: string, state: Exclude<AgentJobState, 'queued' | 'running'>, error: string | null = null) {
    // 'failed'/'cancelled' never debit quota; the stored request is dropped once the job is terminal.
    await this.db.query(
      `UPDATE agent_jobs SET state=$2, error=$3, updated_at=now() WHERE id=$1 AND state IN ('queued','running')`,
      [id, state, error]);
    await this.dropRequest(id);
  }
  private async dropRequest(id: string) {
    await this.db.query(`UPDATE agent_jobs SET request=NULL WHERE id=$1 AND state IN ('succeeded','failed','cancelled') AND request IS NOT NULL`, [id])
      .catch(() => { /* pre-024 schema: nothing to drop */ });
  }
  async get(ownerId: string, id: string) {
    return this.one('SELECT * FROM agent_jobs WHERE owner_id=$1 AND id=$2', [ownerId, id]);
  }
  async list(ownerId: string, limit: number) {
    const res = await this.db.query('SELECT * FROM agent_jobs WHERE owner_id=$1 ORDER BY created_at DESC LIMIT $2', [ownerId, limit]);
    return (res.rows as JobRow[]).map(toRecord);
  }

  /* ---- durable queue (migration 024). Single backend instance, like agentRunAbort. ---- */
  async claimNext(): Promise<AgentJobRecord | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = await this.db.query(
        `SELECT id FROM agent_jobs WHERE state='queued' AND request IS NOT NULL ORDER BY created_at, id LIMIT 1`, []);
      const id = next.rows[0]?.id as string | undefined;
      if (!id) return null;
      // The state guard makes the claim atomic: a concurrent claimer gets zero rows and retries.
      const claimed = await this.db.query(
        `UPDATE agent_jobs SET state='running', attempts=attempts+1, updated_at=now()
         WHERE id=$1 AND state='queued' RETURNING *`, [id]);
      if (claimed.rows[0]) return toRecord(claimed.rows[0] as JobRow);
    }
    return null;
  }
  async recoverInterrupted(maxAttempts: number) {
    // Only worker jobs (request present). Legacy SSE jobs have no request and are left alone.
    const stale = await this.db.query(`SELECT id, attempts FROM agent_jobs WHERE state='running' AND request IS NOT NULL`, []);
    let requeued = 0, failed = 0;
    for (const row of stale.rows as Array<{ id: string; attempts: number | string }>) {
      if (Number(row.attempts) < maxAttempts) {
        const res = await this.db.query(`UPDATE agent_jobs SET state='queued', updated_at=now() WHERE id=$1 AND state='running' RETURNING id`, [row.id]);
        if (res.rows.length) requeued++;
      } else if (await this.fail(row.id, { code: 'worker_interrupted', message: 'The server restarted while the job was running and the retry limit was reached.', retriable: true })) failed++;
    }
    return { requeued, failed };
  }
  async fail(id: string, payload: AgentJobErrorPayload) {
    const safe = AgentJobErrorPayloadSchema.parse(payload);
    const res = await this.db.query(
      `UPDATE agent_jobs SET state='failed', error=$2, error_payload=$3::jsonb, updated_at=now()
       WHERE id=$1 AND state='running' RETURNING id`, [id, safe.message.slice(0, 4000), JSON.stringify(safe)]);
    if (!res.rows.length) return false;
    await this.dropRequest(id);
    return true;
  }
  async completeSucceeded(id: string, result: { resultPatch: AgentJobResultPatch | null; tokensUsed: { input: number; output: number } | null }) {
    if (!this.db.transaction) throw new Error('job_transaction_unavailable');
    const period = monthWindow(this.now());
    const outcome = await this.db.transaction(async tx => {
      const done = await tx.query(
        `UPDATE agent_jobs SET state='succeeded', error=NULL, result_patch=$2::jsonb, tokens_input=$3, tokens_output=$4,
           request=NULL, updated_at=now()
         WHERE id=$1 AND state='running' RETURNING owner_id`,
        [id, result.resultPatch ? JSON.stringify(AgentJobResultPatchSchema.parse(result.resultPatch)) : null,
          result.tokensUsed?.input ?? null, result.tokensUsed?.output ?? null]);
      if (!done.rows.length) return { transitioned: false, debited: false }; // cancelled/failed meanwhile: no debit
      const ownerId = done.rows[0].owner_id as string;
      // Same lock the admission path takes, so plan changes / account closure serialize with the debit.
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ownerId]);
      const existing = await tx.query('SELECT job_id FROM agent_job_ledger WHERE job_id=$1', [id]);
      if (existing.rows.length) return { transitioned: true, debited: false };
      await tx.query('INSERT INTO agent_job_ledger (job_id, owner_id, period_start, units) VALUES ($1, $2, $3, 1)', [id, ownerId, period]);
      await tx.query(`INSERT INTO user_quotas(user_id, period_start, generations) VALUES($1, $2, 0) ON CONFLICT(user_id) DO NOTHING`, [ownerId, period]);
      const rolled = await tx.query(
        `UPDATE user_quotas SET generations = CASE WHEN period_start < $2 THEN 1 ELSE generations + 1 END, period_start = $2
         WHERE user_id=$1 AND period_start <= $2 RETURNING generations`, [ownerId, period]);
      if (!rolled.rows.length) {
        // Clock skew: never roll a newer period back; count the unit in the stored period.
        const bumped = await tx.query('UPDATE user_quotas SET generations = generations + 1 WHERE user_id=$1 RETURNING generations', [ownerId]);
        if (!bumped.rows.length) throw new Error('quota_owner_unavailable');
      }
      return { transitioned: true, debited: true };
    });
    return outcome;
  }
}

export class InMemoryAgentJobStore implements AgentJobStore {
  private readonly byId = new Map<string, AgentJobRecord>();
  private readonly byKey = new Map<string, string>();
  private key(ownerId: string, k: string) { return ownerId + ':' + k; }
  async findByIdempotency(ownerId: string, key: string) {
    const id = this.byKey.get(this.key(ownerId, key));
    return id ? this.byId.get(id) ?? null : null;
  }
  async create(job: { id: string; ownerId: string; idempotencyKey: string; request?: unknown }) {
    const k = this.key(job.ownerId, job.idempotencyKey);
    if (this.byKey.has(k)) return null;
    const now = new Date().toISOString();
    const rec: AgentJobRecord = { id: job.id, ownerId: job.ownerId, idempotencyKey: job.idempotencyKey, state: 'queued', events: [], error: null, createdAt: now, updatedAt: now };
    this.byId.set(job.id, rec);
    this.byKey.set(k, job.id);
    return rec;
  }
  async markRunning(id: string) {
    const r = this.byId.get(id);
    if (r && r.state === 'queued') { r.state = 'running'; r.updatedAt = new Date().toISOString(); }
  }
  async appendEvents(id: string, events: AgentEvent[]) {
    const r = this.byId.get(id);
    if (r && (r.state === 'queued' || r.state === 'running')) {
      r.events = [...r.events, ...events].slice(-MAX_JOB_EVENTS);
      r.updatedAt = new Date().toISOString();
    }
  }
  async finish(id: string, state: Exclude<AgentJobState, 'queued' | 'running'>, error: string | null = null) {
    const r = this.byId.get(id);
    if (r && (r.state === 'queued' || r.state === 'running')) { r.state = state; r.error = error; r.updatedAt = new Date().toISOString(); }
  }
  async get(ownerId: string, id: string) {
    const r = this.byId.get(id);
    return r && r.ownerId === ownerId ? r : null;
  }
  async list(ownerId: string, limit: number) {
    return [...this.byId.values()].filter(r => r.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
}

/** Live abort controllers for running jobs. Single backend instance only — the
 * sandbox runner/queue has the same single-writer assumption. */
export const agentRunAbort = new Map<string, AbortController>();

/** `?detail=1` opts in to the part-B AgentJobDetail shape; the default stays the strict A shape existing clients parse. */
const wantsDetail = (c: { req: { query(name: string): string | undefined } }) => c.req.query('detail') === '1';

/** Mounted only with durable auth: every route is owner-scoped. */
export function jobsRouter(store: AgentJobStore, allow: (key: string) => boolean) {
  const router = new Hono();
  /* Scope the guard to the jobs paths only: this router is mounted at '/', so a
     '*' middleware would also intercept every route registered after it. */
  const guard: Parameters<typeof router.use>[1] = async (c, next) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    if (!allow('agent-jobs:' + user.id)) return c.json({ error: 'rate_limit' }, 429);
    c.header('Cache-Control', 'no-store');
    return next();
  };
  router.use('/api/agent/jobs', guard);
  router.use('/api/agent/jobs/*', guard);
  /* POST /api/agent/jobs (contract part B): enqueue only. No quota is consumed here — the
     ledger debit happens once, when the worker moves the job to 'succeeded'. Provider /
     model / quota checks run in the worker (server/agent/worker.ts) and fail the job with a
     typed errorPayload, so enqueueing never needs a provider and never costs anything. */
  router.post('/api/agent/jobs', bodyLimit({ maxSize: 8_000_000, onError: c => c.json({ error: 'agent_input_limit' }, 413) }), async c => {
    const user = getUserFromContext(c)!;
    if (!isDurableJobStore(store)) return c.json({ error: 'durable_jobs_unavailable' }, 503);
    const key = c.req.header(IDEMPOTENCY_HEADER);
    if (key === undefined || !IdempotencyKey.safeParse(key).success) return c.json({ error: 'invalid_idempotency_key' }, 400);
    const replay = async () => {
      const existing = await store.findByIdempotency(user.id, key);
      return existing ? c.json(AgentJobReplaySchema.parse({ job: toAgentJobView(existing), replayed: true }), 200, { 'Idempotent-Replay': 'true' }) : null;
    };
    const first = await replay();
    if (first) return first;
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad_json' }, 400); }
    const input = parseAgentRequest(body);
    if (!input.ok) return c.json({ error: input.error.code, message: input.error.message }, 400);
    const created = await store.create({ id: randomUUID(), ownerId: user.id, idempotencyKey: key, request: input.request });
    if (!created) return (await replay()) ?? c.json({ error: 'job_create_failed' }, 503);
    return c.json(AgentJobCreatedSchema.parse({ job: toAgentJobView(created), replayed: false }), 202);
  });
  router.get('/api/agent/jobs', async c => {
    const user = getUserFromContext(c)!;
    const jobs = (await store.list(user.id, 50)).map(toAgentJobView);
    return c.json({ jobs });
  });
  router.get('/api/agent/jobs/:id', async c => {
    const user = getUserFromContext(c)!;
    const id = c.req.param('id');
    if (!AgentJobId.safeParse(id).success) return c.json({ error: 'invalid_job_id' }, 400);
    const record = await store.get(user.id, id);
    if (!record) return c.json({ error: 'job_not_found' }, 404); // foreign ids are indistinguishable from missing
    return c.json(wantsDetail(c) ? toAgentJobDetail(record) : toAgentJobView(record));
  });
  router.post('/api/agent/jobs/:id/cancel', async c => {
    const user = getUserFromContext(c)!;
    const id = c.req.param('id');
    if (!AgentJobId.safeParse(id).success) return c.json({ error: 'invalid_job_id' }, 400);
    const record = await store.get(user.id, id);
    if (!record) return c.json({ error: 'job_not_found' }, 404);
    if (record.state === 'queued' || record.state === 'running') {
      agentRunAbort.get(id)?.abort(new Error('cancelled via jobs API'));
      await store.finish(id, 'cancelled', 'cancelled by owner');
    } else {
      return c.json({ error: 'job_not_cancellable' }, 409);
    }
    const after = await store.get(user.id, id);
    return c.json(wantsDetail(c) ? toAgentJobDetail(after ?? record) : toAgentJobView(after ?? record));
  });
  return router;
}
