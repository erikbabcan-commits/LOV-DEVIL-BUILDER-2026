import { Hono } from 'hono';
import { getUserFromContext } from '../auth/middleware';
import type { DbLike } from '../db/pool';
import { AgentEventSchema, type AgentEvent } from './schemas';
import { AgentJobId, AgentJobViewSchema, MAX_JOB_EVENTS, type AgentJobState, type AgentJobView } from '../../shared/agentJobs';

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
}

export interface AgentJobStore {
  findByIdempotency(ownerId: string, key: string): Promise<AgentJobRecord | null>;
  /** Returns null when the (owner, key) pair already exists — caller re-reads and replays. */
  create(job: { id: string; ownerId: string; idempotencyKey: string }): Promise<AgentJobRecord | null>;
  markRunning(id: string): Promise<void>;
  appendEvents(id: string, events: AgentEvent[]): Promise<void>;
  finish(id: string, state: Exclude<AgentJobState, 'queued' | 'running'>, error?: string | null): Promise<void>;
  get(ownerId: string, id: string): Promise<AgentJobRecord | null>;
  list(ownerId: string, limit: number): Promise<AgentJobRecord[]>;
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
  };
}

export function toAgentJobView(record: AgentJobRecord): AgentJobView {
  return AgentJobViewSchema.parse({
    id: record.id, state: record.state, events: record.events,
    error: record.error, createdAt: record.createdAt, updatedAt: record.updatedAt,
  });
}

export class PostgresAgentJobStore implements AgentJobStore {
  constructor(private readonly db: DbLike) {}
  private async one(sql: string, params: unknown[]): Promise<AgentJobRecord | null> {
    const res = await this.db.query(sql, params);
    return res.rows[0] ? toRecord(res.rows[0] as JobRow) : null;
  }
  async findByIdempotency(ownerId: string, key: string) {
    return this.one('SELECT * FROM agent_jobs WHERE owner_id=$1 AND idempotency_key=$2', [ownerId, key]);
  }
  async create(job: { id: string; ownerId: string; idempotencyKey: string }) {
    // Do not rely on RETURNING after ON CONFLICT DO NOTHING: re-read and compare ids,
    // so a racing duplicate (different run id, same key) is detected on every engine.
    await this.db.query(
      `INSERT INTO agent_jobs (id, owner_id, idempotency_key, state) VALUES ($1, $2, $3, 'queued')
       ON CONFLICT (owner_id, idempotency_key) DO NOTHING`,
      [job.id, job.ownerId, job.idempotencyKey]);
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
    await this.db.query(
      `UPDATE agent_jobs SET state=$2, error=$3, updated_at=now() WHERE id=$1 AND state IN ('queued','running')`,
      [id, state, error]);
  }
  async get(ownerId: string, id: string) {
    return this.one('SELECT * FROM agent_jobs WHERE owner_id=$1 AND id=$2', [ownerId, id]);
  }
  async list(ownerId: string, limit: number) {
    const res = await this.db.query('SELECT * FROM agent_jobs WHERE owner_id=$1 ORDER BY created_at DESC LIMIT $2', [ownerId, limit]);
    return (res.rows as JobRow[]).map(toRecord);
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
  async create(job: { id: string; ownerId: string; idempotencyKey: string }) {
    const k = this.key(job.ownerId, job.idempotencyKey);
    if (this.byKey.has(k)) return null;
    const now = new Date().toISOString();
    const rec: AgentJobRecord = { ...job, state: 'queued', events: [], error: null, createdAt: now, updatedAt: now };
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
    return c.json(toAgentJobView(record));
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
    return c.json(toAgentJobView(after ?? record));
  });
  return router;
}
