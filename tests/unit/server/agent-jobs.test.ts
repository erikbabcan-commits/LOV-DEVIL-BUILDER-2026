// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { Hono } from 'hono';
import { dbFromPool } from '../../../server/db/pool';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import { applyMigrations } from '../../../server/db/migrate';
import { InMemoryAgentJobStore, PostgresAgentJobStore, agentRunAbort, jobsRouter } from '../../../server/agent/jobs';
import type { AgentEvent } from '../../../server/agent/schemas';
import { createApp, makeMockProvider } from '../../../server/index';
import { signToken } from '../../../server/auth/tokens';
import { InMemoryQuotaStore } from '../../../server/security/quotaStore';
import { InMemoryAiUsageStore } from '../../../server/usage/store';

const ev = (type: string, extra: Record<string, unknown> = {}): AgentEvent => ({ type, ...extra } as AgentEvent);

describe('InMemoryAgentJobStore', () => {
  it('creates, dedupes by idempotency key, appends and finishes', async () => {
    const store = new InMemoryAgentJobStore();
    const created = await store.create({ id: 'job-1', ownerId: 'alice', idempotencyKey: 'key-1' });
    expect(created?.state).toBe('queued');
    expect(await store.create({ id: 'job-2', ownerId: 'alice', idempotencyKey: 'key-1' })).toBeNull();
    expect((await store.findByIdempotency('alice', 'key-1'))?.id).toBe('job-1');
    await store.markRunning('job-1');
    await store.appendEvents('job-1', [ev('run_started', { runId: 'job-1', model: 'm' })]);
    await store.finish('job-1', 'succeeded');
    const got = await store.get('alice', 'job-1');
    expect(got?.state).toBe('succeeded');
    expect(got?.events).toHaveLength(1);
    expect(await store.get('bob', 'job-1')).toBeNull(); // owner isolation
    expect((await store.list('alice', 10)).map(j => j.id)).toEqual(['job-1']);
  });

  it('caps stored events', async () => {
    const store = new InMemoryAgentJobStore();
    await store.create({ id: 'j', ownerId: 'a', idempotencyKey: 'k' });
    const many = Array.from({ length: 2100 }, (_, i) => ev('text_delta', { delta: 'x' + i }));
    await store.appendEvents('j', many);
    expect((await store.get('a', 'j'))!.events).toHaveLength(2000);
  });
});

describe('PostgresAgentJobStore (pg-mem + migrations)', () => {
  it('persists jobs with idempotency conflict and owner scoping', async () => {
    const mem = newDb();
    registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)();
    const db = dbFromPool(pool);
    try {
      await applyMigrations(db);
      await db.query(`INSERT INTO users (id, email, password_hash) VALUES ('alice', 'a@b.c', 'x'), ('bob', 'b@b.c', 'x')`);
      const store = new PostgresAgentJobStore(db);
      expect(await store.create({ id: 'job-1', ownerId: 'alice', idempotencyKey: 'key-1' })).toMatchObject({ state: 'queued' });
      expect(await store.create({ id: 'job-2', ownerId: 'alice', idempotencyKey: 'key-1' })).toBeNull();
      expect((await store.findByIdempotency('alice', 'key-1'))?.id).toBe('job-1');
      await store.markRunning('job-1');
      await store.appendEvents('job-1', [ev('run_started', { runId: 'job-1', model: 'm' }), ev('text_delta', { delta: 'ahoj' })]);
      await store.finish('job-1', 'succeeded');
      const got = await store.get('alice', 'job-1');
      expect(got?.state).toBe('succeeded');
      expect(got?.events.map(e => e.type)).toEqual(['run_started', 'text_delta']);
      expect(await store.get('bob', 'job-1')).toBeNull();
      expect((await store.list('alice', 50))).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });
});

describe('durable /api/agent/generate + jobs API over HTTP', () => {
  const secret = 'agent-jobs-test-secret-01234567890123456789';
  const input = { projectId: 'project', prompt: 'Build a small dashboard', mode: 'create' };
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      const owner = params?.[0];
      if (sql === 'SELECT id, email, plan, plan_expires_at FROM users WHERE id=$1' && (owner === 'alice' || owner === 'bob'))
        return { rows: [{ id: owner, email: owner + '@example.test', plan: 'free', plan_expires_at: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };

  async function makeApp(store: InMemoryAgentJobStore, quota: InMemoryQuotaStore, token: string) {
    const app = createApp({}, makeMockProvider(), {
      auth: { db, jwtSecret: secret, quota, usage: new InMemoryAiUsageStore() },
      rateLimit: () => true,
      jobs: store,
    });
    return { app, token };
  }
  const authed = (token: string, extra: Record<string, string> = {}) => ({
    Cookie: 'lov_token=' + token + '; lov_csrf=test',
    'X-CSRF-Token': 'test',
    'Content-Type': 'application/json',
    ...extra,
  });
  const post = (app: Hono, token: string, key?: string) => app.request(new Request('http://localhost/api/agent/generate', {
    method: 'POST', body: JSON.stringify(input),
    headers: authed(token, key ? { 'Idempotency-Key': key } : {}),
  }));

  it('persists the run as a succeeded job and replays an idempotent request without re-consuming quota', async () => {
    const store = new InMemoryAgentJobStore();
    const quota = new InMemoryQuotaStore();
    const token = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
    const { app } = await makeApp(store, quota, token);

    const first = await post(app, token, 'key-1');
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    const sse = await first.text();
    expect(sse).toContain('"type":"done"');

    const jobs = await store.list('alice', 10);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe('succeeded');
    expect(jobs[0].events.map(e => e.type)).toEqual(expect.arrayContaining(['run_started', 'stage', 'done']));

    const replay = await post(app, token, 'key-1');
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
    const body = await replay.json() as { job: { id: string; state: string }; replayed: boolean };
    expect(body.replayed).toBe(true);
    expect(body.job.id).toBe(jobs[0].id);
    expect(body.job.state).toBe('succeeded');
    expect((await quota.usage('alice')).used).toBe(1); // quota consumed exactly once
  });

  it('rejects an invalid Idempotency-Key', async () => {
    const store = new InMemoryAgentJobStore();
    const quota = new InMemoryQuotaStore();
    const token = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
    const { app } = await makeApp(store, quota, token);
    const res = await post(app, token, 'bad key!');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_idempotency_key');
  });

  it('serves owner-scoped job reads and cancels a running job', async () => {
    const store = new InMemoryAgentJobStore();
    const quota = new InMemoryQuotaStore();
    const alice = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
    const bob = await signToken({ sub: 'bob', email: 'bob@example.test', plan: 'free' }, secret);
    const { app } = await makeApp(store, quota, alice);

    // finish one run so a job exists
    await (await post(app, alice, 'key-1')).text();
    const [job] = await store.list('alice', 10);

    const read = await app.request(new Request('http://localhost/api/agent/jobs/' + job.id, { headers: { Cookie: 'lov_token=' + alice } }));
    expect(read.status).toBe(200);
    expect((await read.json()).state).toBe('succeeded');

    const foreign = await app.request(new Request('http://localhost/api/agent/jobs/' + job.id, { headers: { Cookie: 'lov_token=' + bob } }));
    expect(foreign.status).toBe(404); // indistinguishable from missing

    const list = await app.request(new Request('http://localhost/api/agent/jobs', { headers: { Cookie: 'lov_token=' + alice } }));
    expect((await list.json()).jobs).toHaveLength(1);

    // cancelling a finished job is a 409
    const cancelDone = await app.request(new Request('http://localhost/api/agent/jobs/' + job.id + '/cancel', {
      method: 'POST', headers: authed(alice),
    }));
    expect(cancelDone.status).toBe(409);

    // cancelling a running job aborts the live controller and persists 'cancelled'
    await store.create({ id: 'job-live', ownerId: 'alice', idempotencyKey: 'key-live' });
    await store.markRunning('job-live');
    const ctl = new AbortController();
    agentRunAbort.set('job-live', ctl);
    try {
      const cancel = await app.request(new Request('http://localhost/api/agent/jobs/job-live/cancel', {
        method: 'POST', headers: authed(alice),
      }));
      expect(cancel.status).toBe(200);
      expect((await cancel.json()).state).toBe('cancelled');
      expect(ctl.signal.aborted).toBe(true);
    } finally {
      agentRunAbort.delete('job-live');
    }
  });
});
