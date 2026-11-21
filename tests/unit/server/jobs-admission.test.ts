// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { dbFromPool, type DbLike } from '../../../server/db/pool';
import { applyMigrations } from '../../../server/db/migrate';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import { PostgresAgentJobStore } from '../../../server/agent/jobs';
import { createApp, makeMockProvider } from '../../../server/index';
import { signToken } from '../../../server/auth/tokens';
import { PostgresQuotaStore, type QuotaStore } from '../../../server/security/quotaStore';
import { InMemoryAiUsageStore } from '../../../server/usage/store';

/* Bora wave-1 review @ 2e479d4: P1-2 (POST without worker, per-owner cap) and P2-2
   (contract B errors before enqueueing instead of a later failed job). */
const secret = 'jobs-admission-test-secret-0123456789012345';
const input = { projectId: 'project', prompt: 'Build a small dashboard', mode: 'create' };
const pools: Array<{ end(): Promise<void> }> = [];
afterEach(async () => { while (pools.length) await pools.pop()!.end(); });

async function makeDb() {
  const mem = newDb();
  registerProjectByteLength(mem);
  const pool = new (mem.adapters.createPg().Pool)();
  pools.push(pool);
  const db = dbFromPool(pool);
  await applyMigrations(db);
  await db.query(`INSERT INTO users (id, email, password_hash) VALUES ('alice', 'alice@example.test', 'x')`);
  return db;
}
const jobsCount = async (db: DbLike) => Number((await db.query('SELECT COUNT(*)::int AS n FROM agent_jobs', [])).rows[0].n);

async function setup(over: { workerEnabled?: boolean; maxActivePerOwner?: number; quota?: (db: DbLike) => QuotaStore; provider?: 'none'; aiDisabled?: boolean } = {}) {
  const db = await makeDb();
  const app = createApp(over.aiDisabled ? { aiGenerationEnabled: false } : {}, over.provider === 'none' ? null : makeMockProvider(), {
    auth: { db, jwtSecret: secret, quota: over.quota ? over.quota(db) : new PostgresQuotaStore(db), usage: new InMemoryAiUsageStore() },
    rateLimit: () => true, jobs: new PostgresAgentJobStore(db),
    agentJobs: { workerEnabled: over.workerEnabled ?? true, startWorker: false, ...(over.maxActivePerOwner ? { maxActivePerOwner: over.maxActivePerOwner } : {}) },
  });
  const alice = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
  const post = (key: string, body: unknown = input) => app.request(new Request('http://localhost/api/agent/jobs', {
    method: 'POST', body: JSON.stringify(body),
    headers: { Cookie: 'lov_token=' + alice + '; lov_csrf=t', 'X-CSRF-Token': 't', 'Content-Type': 'application/json', 'Idempotency-Key': key },
  }));
  return { db, post };
}

describe('POST /api/agent/jobs admission (Bora P1-2, P2-2)', () => {
  it('P1-2: returns 503 agent_jobs_disabled and stores nothing when no worker runs', async () => {
    const { db, post } = await setup({ workerEnabled: false });
    const res = await post('k1');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('agent_jobs_disabled');
    expect(await jobsCount(db)).toBe(0);
  });

  it('P1-2: default createApp without AGENT_JOBS_WORKER rejects POST with 503', async () => {
    const db = await makeDb();
    const prev = process.env.AGENT_JOBS_WORKER;
    delete process.env.AGENT_JOBS_WORKER;
    try {
      const app = createApp({}, makeMockProvider(), { auth: { db, jwtSecret: secret, quota: new PostgresQuotaStore(db), usage: new InMemoryAiUsageStore() }, rateLimit: () => true, jobs: new PostgresAgentJobStore(db) });
      const alice = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
      const res = await app.request(new Request('http://localhost/api/agent/jobs', { method: 'POST', body: JSON.stringify(input), headers: { Cookie: 'lov_token=' + alice + '; lov_csrf=t', 'X-CSRF-Token': 't', 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' } }));
      expect(res.status).toBe(503);
      expect(await jobsCount(db)).toBe(0);
    } finally { if (prev !== undefined) process.env.AGENT_JOBS_WORKER = prev; }
  });

  it('P1-2: caps queued + running jobs per owner; the (N+1)-th POST is 429 and a replay of an existing key still works', async () => {
    const { db, post } = await setup({ maxActivePerOwner: 2 });
    expect((await post('a')).status).toBe(202);
    expect((await post('b')).status).toBe(202);
    const third = await post('c');
    expect(third.status).toBe(429);
    expect((await third.json()).error).toBe('too_many_active_jobs');
    expect(await jobsCount(db)).toBe(2);
    expect((await post('a')).status).toBe(200); // idempotent replay is not blocked by the cap
    await db.query(`UPDATE agent_jobs SET state='succeeded' WHERE idempotency_key='a'`);
    expect((await post('c')).status).toBe(202); // a finished job frees a slot
  });

  it('P2-2: exhausted quota returns 429 quota_exceeded before enqueueing', async () => {
    const exhausted = (): QuotaStore => ({
      usage: async () => ({ used: 10, limit: 10, remaining: 0, plan: 'free' }),
      consume: async () => ({ ok: false, snapshot: { used: 10, limit: 10, remaining: 0, plan: 'free' } }),
    });
    const { db, post } = await setup({ quota: exhausted });
    const res = await post('k1');
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('quota_exceeded');
    expect(await jobsCount(db)).toBe(0);
  });

  it('P2-2: unverifiable quota returns 503 quota_unavailable', async () => {
    const broken = (): QuotaStore => ({ usage: async () => { throw new Error('db down'); }, consume: async () => { throw new Error('db down'); } });
    const { db, post } = await setup({ quota: broken });
    const res = await post('k1');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('quota_unavailable');
    expect(await jobsCount(db)).toBe(0);
  });

  it('P2-2: AI not configured returns 503 ai_not_configured; AI disabled returns 503 ai_disabled', async () => {
    const none = await setup({ provider: 'none' });
    const r1 = await none.post('k1');
    expect(r1.status).toBe(503);
    expect((await r1.json()).error).toBe('ai_not_configured');
    expect(await jobsCount(none.db)).toBe(0);
    const off = await setup({ aiDisabled: true });
    const r2 = await off.post('k1');
    expect(r2.status).toBe(503);
    expect((await r2.json()).error).toBe('ai_disabled');
  });
  it('P3: the same Idempotency-Key with a different body is 409; the same body (any key order) still replays', async () => {
    const { db, post } = await setup();
    expect((await post('k-body')).status).toBe(202);
    const reordered = { mode: input.mode, prompt: input.prompt, projectId: input.projectId };
    const replay = await post('k-body', reordered);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
    const reused = await post('k-body', { ...input, prompt: 'Something else entirely' });
    expect(reused.status).toBe(409);
    expect((await reused.json()).error).toBe('idempotency_key_reused');
    expect((await post('k-body', 'not an object')).status).toBe(409);
    expect(await jobsCount(db)).toBe(1);
  });

  it('Task C: 8 concurrent POST requests create at most 3 jobs and the rest get 429 too_many_active_jobs', async () => {
    const { db, post } = await setup({ maxActivePerOwner: 3 });
    const keys = Array.from({ length: 8 }, (_, i) => `concurrent-key-${i}`);
    const results = await Promise.all(keys.map(k => post(k)));
    const statuses = results.map(r => r.status);
    const accepted = statuses.filter(s => s === 202);
    const rejected = statuses.filter(s => s === 429);
    expect(accepted.length).toBe(3);
    expect(rejected.length).toBe(5);
    expect(await jobsCount(db)).toBe(3);
  });
});
