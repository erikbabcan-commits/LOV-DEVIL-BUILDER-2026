// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { MistralProvider } from '../../../server/providers/mistral';
import { Hono } from 'hono';
import { dbFromPool, type DbLike } from '../../../server/db/pool';
import { applyMigrations, listMigrations } from '../../../server/db/migrate';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import { InMemoryAgentJobStore, PostgresAgentJobStore, agentRunAbort, jobsRouter, isDurableJobStore } from '../../../server/agent/jobs';
import { AgentWorker } from '../../../server/agent/worker';
import { createApp, makeMockProvider } from '../../../server/index';
import { signToken } from '../../../server/auth/tokens';
import { PostgresQuotaStore } from '../../../server/security/quotaStore';
import { InMemoryAiUsageStore } from '../../../server/usage/store';
import { ProviderRegistry } from '../../../server/providers/registry';
import type { AIProvider } from '../../../server/providers/types';
import {
  AgentJobCreatedSchema, AgentJobDetailSchema, AgentJobReplaySchema, AgentJobViewSchema,
} from '../../../shared/agentJobs';

const secret = 'durable-jobs-test-secret-0123456789012345678';
const input = { projectId: 'project', prompt: 'Build a small dashboard', mode: 'create' };
const noSleep = { sleep: async () => {} };

const pools: Array<{ end(): Promise<void> }> = [];
afterEach(async () => { while (pools.length) await pools.pop()!.end(); });

async function makeDb() {
  const mem = newDb();
  registerProjectByteLength(mem);
  const pool = new (mem.adapters.createPg().Pool)();
  pools.push(pool);
  const db = dbFromPool(pool);
  await applyMigrations(db);
  await db.query(`INSERT INTO users (id, email, password_hash) VALUES ('alice', 'alice@example.test', 'x'), ('bob', 'bob@example.test', 'x')`);
  return db;
}
const registry = (provider: AIProvider = makeMockProvider()) => new ProviderRegistry([{ id: 'default', label: 'test model', provider }]);
const used = async (db: DbLike, user = 'alice') => Number((await db.query('SELECT generations FROM user_quotas WHERE user_id=$1', [user])).rows[0]?.generations ?? 0);
const ledger = async (db: DbLike) => (await db.query('SELECT job_id FROM agent_job_ledger', [])).rows.length;
const worker = (db: DbLike, over: Partial<ConstructorParameters<typeof AgentWorker>[0]> = {}) => {
  const store = new PostgresAgentJobStore(db);
  return { store, w: new AgentWorker({ store, providers: registry(), resilience: noSleep, ...over }) };
};
async function waitFor(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('timeout waiting for ' + what);
}
async function enqueue(store: PostgresAgentJobStore, id: string, key = 'key-' + id, owner = 'alice') {
  return store.create({ id, ownerId: owner, idempotencyKey: key, request: input });
}

describe('migration 024_agent_jobs_ledger', () => {
  it('adds the job columns and the ledger, and is idempotent for re-runs', async () => {
    const db = await makeDb();
    const m = listMigrations().find(x => x.name === '024_agent_jobs_ledger.sql')!;
    expect(m).toBeTruthy();
    const statements = m.sql.replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
    // Every statement is guarded (pg-mem cannot re-run an existing CREATE TABLE IF NOT EXISTS, real Postgres can).
    for (const s of statements) expect(s).toMatch(/IF NOT EXISTS/i);
    for (const s of statements.filter(s => !/^CREATE TABLE/i.test(s))) await db.query(s);
    const cols = await db.query(`INSERT INTO agent_jobs (id, owner_id, idempotency_key, state, request) VALUES ('j','alice','k','queued','{"a":1}'::jsonb) RETURNING attempts, tokens_input, result_patch, error_payload`, []);
    expect(cols.rows[0]).toMatchObject({ attempts: 0, tokens_input: null, result_patch: null, error_payload: null });
    expect(m.sql).not.toMatch(/DROP\s+(TABLE|COLUMN)(?!\s+IF)/i);
    expect(m.sql.replace(/--.*$/gm, '')).not.toMatch(/\b(DROP|TRUNCATE)\b|(?<!ON )\bDELETE\b|\bUPDATE\b/i); // append-only
  });

  it('ledger is keyed by job: a second row for the same job is rejected', async () => {
    const db = await makeDb();
    await enqueue(new PostgresAgentJobStore(db), 'j1');
    await db.query(`INSERT INTO agent_job_ledger (job_id, owner_id, period_start) VALUES ('j1','alice','2026-11-01')`);
    await expect(db.query(`INSERT INTO agent_job_ledger (job_id, owner_id, period_start) VALUES ('j1','alice','2026-11-01')`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO agent_job_ledger (job_id, owner_id, period_start, units) VALUES ('j1','alice','2026-11-01', 5)`)).rejects.toThrow();
  });
});

describe('POST /api/agent/jobs over HTTP', () => {
  async function makeApp(store: PostgresAgentJobStore | InMemoryAgentJobStore, db: DbLike) {
    const app = createApp({}, makeMockProvider(), {
      auth: { db, jwtSecret: secret, quota: new PostgresQuotaStore(db), usage: new InMemoryAiUsageStore() },
      rateLimit: () => true, jobs: store,
      // POST is accepted only with a worker (Bora P1-2); tests drain manually, so no poller.
      agentJobs: { workerEnabled: true, startWorker: false },
    });
    const alice = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
    const bob = await signToken({ sub: 'bob', email: 'bob@example.test', plan: 'free' }, secret);
    return { app, alice, bob };
  }
  const authed = (token: string, extra: Record<string, string> = {}) => ({
    Cookie: 'lov_token=' + token + '; lov_csrf=test', 'X-CSRF-Token': 'test', 'Content-Type': 'application/json', ...extra,
  });
  const post = (app: Hono, token: string, key?: string, body: unknown = input) => app.request(new Request('http://localhost/api/agent/jobs', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: authed(token, key ? { 'Idempotency-Key': key } : {}),
  }));

  it('202 + AgentJobCreated (queued), then 200 AgentJobReplay with Idempotent-Replay and no second job or debit', async () => {
    const db = await makeDb();
    const store = new PostgresAgentJobStore(db);
    const { app, alice } = await makeApp(store, db);
    const first = await post(app, alice, 'key-1');
    expect(first.status).toBe(202);
    const created = AgentJobCreatedSchema.parse(await first.json());
    expect(created.job.state).toBe('queued');
    expect(created.replayed).toBe(false);

    const replay = await post(app, alice, 'key-1');
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
    const again = AgentJobReplaySchema.parse(await replay.json());
    expect(again.job.id).toBe(created.job.id);
    expect(await store.list('alice', 50)).toHaveLength(1);
    expect(await used(db)).toBe(0); // enqueueing never debits
    expect(await ledger(db)).toBe(0);
  });

  it('rejects a missing or malformed Idempotency-Key, bad JSON, invalid body and secrets with typed 400s', async () => {
    const db = await makeDb();
    const { app, alice } = await makeApp(new PostgresAgentJobStore(db), db);
    const missing = await post(app, alice);
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe('invalid_idempotency_key');
    expect((await (await post(app, alice, 'bad key!')).json()).error).toBe('invalid_idempotency_key');
    const badJson = await post(app, alice, 'k-json', '{nope');
    expect(badJson.status).toBe(400);
    expect((await badJson.json()).error).toBe('bad_json');
    const invalid = await post(app, alice, 'k-invalid', { projectId: 'p' });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe('bad_request');
    const secretRes = await post(app, alice, 'k-secret', { ...input, prompt: 'use key sk-live_abcdefghijklmnopqrstuvwx1234567890 please' });
    expect(secretRes.status).toBe(400);
    expect((await secretRes.json()).error).toBe('secret_in_context');
    expect(await new PostgresAgentJobStore(db).list('alice', 50)).toHaveLength(0);
  });

  it('requires authentication and CSRF, and answers 503 when the store is not durable', async () => {
    const db = await makeDb();
    const { app, alice } = await makeApp(new PostgresAgentJobStore(db), db);
    const anon = await app.request(new Request('http://localhost/api/agent/jobs', { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' } }));
    expect(anon.status).toBe(401);
    const noCsrf = await app.request(new Request('http://localhost/api/agent/jobs', {
      method: 'POST', body: JSON.stringify(input), headers: { Cookie: 'lov_token=' + alice, 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' },
    }));
    expect(noCsrf.status).toBe(403);
    const mem = await makeApp(new InMemoryAgentJobStore(), db);
    expect(isDurableJobStore(new InMemoryAgentJobStore())).toBe(false);
    const res = await post(mem.app, mem.alice, 'k1');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('durable_jobs_unavailable');
  });

  it('GET :id keeps the A shape by default and returns AgentJobDetail with ?detail=1; foreign jobs are 404', async () => {
    const db = await makeDb();
    const store = new PostgresAgentJobStore(db);
    const { app, alice, bob } = await makeApp(store, db);
    const { job } = AgentJobCreatedSchema.parse(await (await post(app, alice, 'key-1')).json());
    await new AgentWorker({ store, providers: registry(), resilience: noSleep }).drain();

    const a = await (await app.request(new Request('http://localhost/api/agent/jobs/' + job.id, { headers: { Cookie: 'lov_token=' + alice } }))).json();
    expect(AgentJobViewSchema.parse(a).state).toBe('succeeded'); // strict A shape: no extra keys
    const d = AgentJobDetailSchema.parse(await (await app.request(new Request('http://localhost/api/agent/jobs/' + job.id + '?detail=1', { headers: { Cookie: 'lov_token=' + alice } }))).json());
    expect(d.tokensUsed).toEqual({ input: expect.any(Number), output: expect.any(Number) });
    expect(d.tokensUsed!.input).toBeGreaterThan(0);
    expect(d.resultPatch!.files.length).toBeGreaterThan(0);
    expect(d.errorPayload).toBeNull();
    const foreign = await app.request(new Request('http://localhost/api/agent/jobs/' + job.id + '?detail=1', { headers: { Cookie: 'lov_token=' + bob } }));
    expect(foreign.status).toBe(404);
  });
});

describe('auth guard scope of jobsRouter (acceptance #6)', () => {
  function scoped(allow: () => boolean = () => true, user: { id: string } | null = null) {
    const app = new Hono();
    app.use('*', async (c, next) => { if (user) (c as unknown as { set(k: string, v: unknown): void }).set('authUser', user); await next(); });
    app.route('/', jobsRouter(new InMemoryAgentJobStore(), allow));
    app.get('/api/health', c => c.json({ ok: true }));
    app.get('/api/agent/jobsfoo', c => c.json({ ok: true }));
    app.get('/api/other/after', c => c.json({ ok: true }));
    return app;
  }
  const get = (app: Hono, path: string) => app.request(new Request('http://localhost' + path));

  it('anonymous /api/agent/jobs, /jobs/:id and POST /jobs/:id/cancel are 401; POST /jobs too', async () => {
    const app = scoped();
    expect((await get(app, '/api/agent/jobs')).status).toBe(401);
    expect((await get(app, '/api/agent/jobs/some-id')).status).toBe(401);
    expect((await app.request(new Request('http://localhost/api/agent/jobs/some-id/cancel', { method: 'POST' }))).status).toBe(401);
    expect((await app.request(new Request('http://localhost/api/agent/jobs', { method: 'POST', headers: { 'Idempotency-Key': 'k' }, body: '{}' }))).status).toBe(401);
  });

  it('routes mounted after the router are not guarded: /api/health, /api/agent/jobsfoo (prefix must not over-match) and others stay 200', async () => {
    const app = scoped();
    for (const path of ['/api/health', '/api/agent/jobsfoo', '/api/other/after']) expect((await get(app, path)).status, path).toBe(200);
    // not even the jobs rate limiter applies to them
    const limited = scoped(() => false);
    expect((await get(limited, '/api/health')).status).toBe(200);
    expect((await get(limited, '/api/agent/jobsfoo')).status).toBe(200);
  });

  it('an authenticated user passes the guard but is still rate limited per user on jobs routes only', async () => {
    const ok = scoped(() => true, { id: 'alice' });
    expect((await get(ok, '/api/agent/jobs')).status).toBe(200);
    const limited = scoped(() => false, { id: 'alice' });
    expect((await get(limited, '/api/agent/jobs')).status).toBe(429);
    expect((await get(limited, '/api/agent/jobsfoo')).status).toBe(200);
  });

  it('with auth enabled in createApp, anonymous /api/health is 200 while the jobs routes are 401', async () => {
    const db = await makeDb();
    const app = createApp({}, makeMockProvider(), {
      auth: { db, jwtSecret: secret, quota: new PostgresQuotaStore(db), usage: new InMemoryAiUsageStore() },
      rateLimit: () => true, jobs: new PostgresAgentJobStore(db),
    });
    expect((await get(app, '/api/health')).status).toBe(200);
    expect((await get(app, '/api/agent/jobs')).status).toBe(401);
    expect((await get(app, '/api/agent/jobs/x')).status).toBe(401);
    const alice = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
    // an authenticated request to a non-jobs path is untouched by the jobs guard (plain 404, no jobs headers)
    const other = await app.request(new Request('http://localhost/api/agent/jobsfoo', { headers: { Cookie: 'lov_token=' + alice } }));
    expect(other.status).toBe(404);
  });
});

describe('worker + quota ledger', () => {
  it('runs queued -> running -> succeeded, stores events/result/tokens and debits exactly once', async () => {
    const db = await makeDb();
    const { store, w } = worker(db);
    await enqueue(store, 'job-1');
    expect(await used(db)).toBe(0);
    expect(await w.drain()).toBe(1);
    const job = (await store.get('alice', 'job-1'))!;
    expect(job.state).toBe('succeeded');
    expect(job.events.map(e => e.type)).toEqual(expect.arrayContaining(['run_started', 'stage', 'done']));
    expect(job.resultPatch!.files.length).toBeGreaterThan(0);
    expect(job.tokensUsed!.input).toBeGreaterThan(0);
    expect(job.request).toBeNull(); // stored request dropped once terminal
    expect(await used(db)).toBe(1);
    expect(await ledger(db)).toBe(1);
    expect(await w.drain()).toBe(0); // nothing left, no second run
    expect(await used(db)).toBe(1);
  });

  it('a second completion of the same job neither transitions nor debits again', async () => {
    const db = await makeDb();
    const { store, w } = worker(db);
    await enqueue(store, 'job-1');
    await w.drain();
    const again = await store.completeSucceeded('job-1', { resultPatch: null, tokensUsed: null });
    expect(again).toEqual({ transitioned: false, debited: false });
    expect(await used(db)).toBe(1);
    expect(await ledger(db)).toBe(1);
  });

  it('persists the provider HTTP status without storing the upstream body or charging the job', async () => {
    const db = await makeDb();
    const model = new MistralProvider({ apiKey: 'test', model: 'qa' }, {
      postChat: async () => Response.json({ code: 'private-upstream-detail', message: 'private-upstream-detail' }, { status: 400 }),
    });
    const { store, w } = worker(db, { providers: registry(model) });
    await enqueue(store, 'rejected');
    await w.drain();
    const job = await store.get('alice', 'rejected');
    expect(job).toMatchObject({ state: 'failed', errorPayload: { code: 'provider_request_http_400', retriable: false } });
    expect(JSON.stringify(job)).not.toContain('private-upstream-detail');
    expect(await ledger(db)).toBe(0);
  });

  it('a failed run keeps a structured errorPayload and debits nothing', async () => {
    const db = await makeDb();
    const broken: AIProvider = { ...makeMockProvider(), async complete() { throw new Error('upstream exploded sk-live_abcdefghijklmnopqrstuvwx1234567890'); } };
    const { store, w } = worker(db, { providers: registry(broken) });
    await enqueue(store, 'job-1');
    await w.drain();
    const job = (await store.get('alice', 'job-1'))!;
    expect(job.state).toBe('failed');
    expect(job.errorPayload).toMatchObject({ code: expect.any(String), retriable: expect.any(Boolean) });
    expect(JSON.stringify(job)).not.toContain('sk-live_abcdefghijklmnopqrstuvwx1234567890'); // redacted
    expect(await used(db)).toBe(0);
    expect(await ledger(db)).toBe(0);
  });

  it('fails closed without a debit when AI is disabled, not configured, or the quota is already exhausted', async () => {
    const db = await makeDb();
    const store = new PostgresAgentJobStore(db);
    await enqueue(store, 'off');
    await new AgentWorker({ store, providers: registry(), aiAllowed: () => false }).drain();
    expect((await store.get('alice', 'off'))!.errorPayload).toMatchObject({ code: 'ai_disabled', retriable: false });

    await enqueue(store, 'nocfg');
    await new AgentWorker({ store, providers: new ProviderRegistry([]) }).drain();
    expect((await store.get('alice', 'nocfg'))!.errorPayload?.code).toBe('ai_not_configured');

    await db.query(`INSERT INTO user_quotas (user_id, period_start, generations) VALUES ('alice', $1, 10)`, [new Date().toISOString().slice(0, 8) + '01']);
    await enqueue(store, 'full');
    await new AgentWorker({ store, providers: registry(), quota: new PostgresQuotaStore(db), resilience: noSleep }).drain();
    expect((await store.get('alice', 'full'))!).toMatchObject({ state: 'failed', errorPayload: { code: 'quota_exceeded' } });
    expect(await used(db)).toBe(10);
    expect(await ledger(db)).toBe(0);
  });

  it('cancelling a queued job never runs it and never debits', async () => {
    const db = await makeDb();
    const { store, w } = worker(db);
    await enqueue(store, 'job-1');
    await store.finish('job-1', 'cancelled', 'cancelled by owner');
    expect(await w.drain()).toBe(0);
    expect((await store.get('alice', 'job-1'))!.state).toBe('cancelled');
    expect(await used(db)).toBe(0);
    expect(await ledger(db)).toBe(0);
  });

  it('cancelling a job that is running inside the worker aborts it, ends cancelled and debits nothing', async () => {
    const db = await makeDb();
    const hanging: AIProvider = {
      name: 'hang', model: 'hang-1',
      complete: (_m, o) => new Promise((_, reject) => o?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      async *stream() { /* unused */ },
    };
    const { store, w } = worker(db, { providers: registry(hanging) });
    await enqueue(store, 'job-1');
    const run = w.tick();
    await waitFor(async () => (await store.get('alice', 'job-1'))?.state === 'running' && agentRunAbort.has('job-1'), 'running job');

    const app = createApp({}, makeMockProvider(), {
      auth: { db, jwtSecret: secret, quota: new PostgresQuotaStore(db), usage: new InMemoryAiUsageStore() }, rateLimit: () => true, jobs: store,
    });
    const alice = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
    const res = await app.request(new Request('http://localhost/api/agent/jobs/job-1/cancel', {
      method: 'POST', headers: { Cookie: 'lov_token=' + alice + '; lov_csrf=t', 'X-CSRF-Token': 't' },
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('cancelled');
    await run;
    expect((await store.get('alice', 'job-1'))!.state).toBe('cancelled');
    expect(agentRunAbort.has('job-1')).toBe(false);
    expect(await used(db)).toBe(0);
    expect(await ledger(db)).toBe(0);
  });

  it('a late completion after a cancel does not debit (state guard)', async () => {
    const db = await makeDb();
    const { store } = worker(db);
    await enqueue(store, 'job-1');
    await store.claimNext();
    await store.finish('job-1', 'cancelled', 'cancelled by owner');
    expect(await store.completeSucceeded('job-1', { resultPatch: null, tokensUsed: null })).toEqual({ transitioned: false, debited: false });
    expect(await used(db)).toBe(0);
  });
});

describe('restart recovery (new store + worker over the same pg-mem DB)', () => {
  it('requeues an interrupted running job, completes it on the new worker and debits once', async () => {
    const db = await makeDb();
    const before = new PostgresAgentJobStore(db);
    await enqueue(before, 'job-1');
    const claimed = await before.claimNext();
    expect(claimed).toMatchObject({ state: 'running', attempts: 1 });
    // "crash": the first store/worker is gone. A new one starts over the same DB.
    const after = new PostgresAgentJobStore(db);
    expect(await after.recoverInterrupted(2)).toEqual({ requeued: 1, failed: 0 });
    expect((await after.get('alice', 'job-1'))!.state).toBe('queued');
    await new AgentWorker({ store: after, providers: registry(), resilience: noSleep }).drain();
    const job = (await after.get('alice', 'job-1'))!;
    expect(job).toMatchObject({ state: 'succeeded', attempts: 2 });
    expect(await used(db)).toBe(1);
    expect(await ledger(db)).toBe(1);
  });

  it('marks a job failed with an errorPayload once the attempt limit is reached; no debit', async () => {
    const db = await makeDb();
    const store = new PostgresAgentJobStore(db);
    await enqueue(store, 'job-1');
    await store.claimNext();
    expect(await new PostgresAgentJobStore(db).recoverInterrupted(1)).toEqual({ requeued: 0, failed: 1 });
    const job = (await store.get('alice', 'job-1'))!;
    expect(job.state).toBe('failed');
    expect(job.errorPayload).toMatchObject({ code: 'worker_interrupted', retriable: true });
    expect(await used(db)).toBe(0);
    expect(await ledger(db)).toBe(0);
  });

  it('leaves legacy SSE jobs (no stored request) untouched', async () => {
    const db = await makeDb();
    const store = new PostgresAgentJobStore(db);
    await store.create({ id: 'legacy', ownerId: 'alice', idempotencyKey: 'k-legacy' });
    await store.markRunning('legacy');
    expect(await store.recoverInterrupted(2)).toEqual({ requeued: 0, failed: 0 });
    expect((await store.get('alice', 'legacy'))!.state).toBe('running');
  });

  /* pg-mem does not implement ROLLBACK of a half-done transaction (see tests/helpers/projectMemoryDb.ts), so the
     crash is injected at the first statement of the completion transaction. Mid-transaction atomicity itself is
     the PostgreSQL transaction in completeSucceeded (UPDATE state + ledger INSERT + quota UPDATE in one tx). */
  it('a crash before the completion commits loses no credit and never double-debits after the retry', async () => {
    const db = await makeDb();
    let explode = true;
    const flaky: DbLike = {
      query: db.query,
      transaction: work => db.transaction!(tx => work({
        query: (sql, params) => {
          if (explode && sql.includes("SET state='succeeded'")) return Promise.reject(new Error('simulated crash during debit'));
          return tx.query(sql, params);
        },
      })),
    };
    const store = new PostgresAgentJobStore(flaky);
    await enqueue(store, 'job-1');
    await store.claimNext();
    await expect(store.completeSucceeded('job-1', { resultPatch: null, tokensUsed: null })).rejects.toThrow('simulated crash');
    // nothing of the completion happened
    expect((await store.get('alice', 'job-1'))!.state).toBe('running');
    expect(await used(db)).toBe(0);
    expect(await ledger(db)).toBe(0);

    explode = false; // process restarts, DB is healthy again
    const fresh = new PostgresAgentJobStore(db);
    await fresh.recoverInterrupted(3);
    await new AgentWorker({ store: fresh, providers: registry(), resilience: noSleep }).drain();
    expect((await fresh.get('alice', 'job-1'))!.state).toBe('succeeded');
    expect(await used(db)).toBe(1);
    expect(await ledger(db)).toBe(1);
  });
});
