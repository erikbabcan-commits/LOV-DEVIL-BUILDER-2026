// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newDb } from 'pg-mem';
import { dbFromPool, type DbLike } from '../../../server/db/pool';
import { applyMigrations } from '../../../server/db/migrate';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import { PostgresAgentJobStore, type AgentJobStore } from '../../../server/agent/jobs';
import { createApp, makeMockProvider } from '../../../server/index';
import { signToken } from '../../../server/auth/tokens';
import { InMemoryQuotaStore } from '../../../server/security/quotaStore';
import { InMemoryAiUsageStore } from '../../../server/usage/store';
import { LocalBudgetGuard } from '../../../server/security/budget';
import { ProviderRegistry } from '../../../server/providers/registry';

/* TIC TAC P2s in the durable path of POST /api/agent/generate (Idempotency-Key + auth):
   a failing jobStore.create must not leak the budget slot, and a create that returns no row
   must end the request instead of falling through into an unrecorded paid run. */
const secret = 'generate-job-create-secret-0123456789012345678';
const pools: Array<{ end(): Promise<void> }> = [];
afterEach(async () => { while (pools.length) await pools.pop()!.end(); });
async function makeDb(): Promise<DbLike> {
  const mem = newDb(); registerProjectByteLength(mem);
  const pool = new (mem.adapters.createPg().Pool)(); pools.push(pool);
  const db = dbFromPool(pool); await applyMigrations(db);
  await db.query(`INSERT INTO users (id, email, password_hash) VALUES ('alice', 'alice@example.test', 'x')`);
  return db;
}
/** Real Postgres store with one method replaced (the rest stays the real implementation). */
function storeWith(db: DbLike, override: Partial<AgentJobStore>): AgentJobStore {
  const real = new PostgresAgentJobStore(db);
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, override) as AgentJobStore;
}
async function setup(override: Partial<AgentJobStore>) {
  const db = await makeDb();
  const provider = makeMockProvider();
  const complete = vi.spyOn(provider, 'complete');
  const stream = vi.spyOn(provider, 'stream');
  const quota = new InMemoryQuotaStore();
  const budget = new LocalBudgetGuard({ maxConcurrent: 1, maxRunsPerDay: 5 });
  const jobs = storeWith(db, override);
  const app = createApp({}, null, { providers: new ProviderRegistry([{ id: 'default', label: 'AI', provider }]), rateLimit: () => true, budget, jobs,
    auth: { db, jwtSecret: secret, quota, usage: new InMemoryAiUsageStore() }, agentJobs: { workerEnabled: false, startWorker: false } });
  const tok = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
  const generate = (key?: string) => app.request(new Request('http://localhost/api/agent/generate', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `lov_token=${tok}; lov_csrf=t`, 'X-CSRF-Token': 't', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify({ projectId: 'p1', prompt: 'Pridaj tlačidlo', mode: 'create' }) }));
  return { db, quota, budget, generate, aiCalls: () => complete.mock.calls.length + stream.mock.calls.length };
}

describe('TIC TAC P2: slot leak when jobStore.create fails', () => {
  it('a throwing create returns 503 job_create_failed and releases the budget slot (concurrency and daily count)', async () => {
    const t = await setup({ create: async () => { throw new Error('injected: connection reset'); } });
    for (let i = 0; i < 3; i++) {
      const res = await t.generate('key-fail-' + i);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('job_create_failed');
      // maxConcurrent is 1: a leaked slot would turn the next request into 429 BUDGET_EXCEEDED.
      expect(t.budget.getStats()).toEqual({ active: 0, admittedToday: 0 });
    }
    expect(t.aiCalls()).toBe(0);
    expect((await t.quota.usage('alice')).used).toBe(0);
    // Nothing orphaned: no job row was written.
    expect((await t.db.query('SELECT id FROM agent_jobs', [])).rows).toHaveLength(0);
    // The non-durable path still works with the same budget.
    const ok = await t.generate();
    expect(ok.status).toBe(200);
    await ok.text();
    expect(t.budget.getStats().active).toBe(0);
  });
});

describe('TIC TAC P2: discard fall-through when create returns no row', () => {
  it('no row and no existing job: 503 job_create_failed, no AI call, no quota, slot returned', async () => {
    const t = await setup({ create: async () => null });
    const res = await t.generate('key-null');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('job_create_failed');
    expect(t.aiCalls()).toBe(0);
    expect((await t.quota.usage('alice')).used).toBe(0);
    expect(t.budget.getStats()).toEqual({ active: 0, admittedToday: 0 });
  });

  it('no row and the lookup also throws: still 503, never falls into the run', async () => {
    const t = await setup({ create: async () => null, findByIdempotency: (() => {
      let first = true; // the pre-check before create sees "no job"; the lookup after create fails
      return async () => { if (first) { first = false; return null; } throw new Error('injected'); };
    })() });
    const res = await t.generate('key-null-2');
    expect(res.status).toBe(503);
    expect(t.aiCalls()).toBe(0);
    expect(t.budget.getStats().active).toBe(0);
  });

  it('a concurrent winner (create lost the race) is replayed, not re-run', async () => {
    const db = await makeDb();
    const real = new PostgresAgentJobStore(db);
    await real.create({ id: '00000000-0000-4000-8000-000000000001', ownerId: 'alice', idempotencyKey: 'key-race' });
    let lookups = 0;
    // Race simulated: the pre-check misses the winner, create returns null, the second lookup finds it.
    const raced = await setup({
      create: async () => null,
      findByIdempotency: async (owner: string, key: string) => (++lookups === 1 ? null : real.findByIdempotency(owner, key)),
    });
    const res = await raced.generate('key-race');
    expect(res.status).toBe(200);
    expect(res.headers.get('Idempotent-Replay')).toBe('true');
    expect(raced.aiCalls()).toBe(0);
    expect(raced.budget.getStats()).toEqual({ active: 0, admittedToday: 0 });
  });
});
