// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { createApp, makeMockProvider } from '../../../server/index';
import { ProviderRegistry } from '../../../server/providers/registry';
import { PostgresAgentJobStore } from '../../../server/agent/jobs';
import { AgentWorker } from '../../../server/agent/worker';
import { planLookup } from '../../../server/auth/planLookup';
import { dbFromPool } from '../../../server/db/pool';
import { applyMigrations } from '../../../server/db/migrate';
import { signToken } from '../../../server/auth/tokens';
import { InMemoryQuotaStore } from '../../../server/security/quotaStore';
import { InMemoryAiUsageStore } from '../../../server/usage/store';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import type { AIProvider } from '../../../server/providers/types';

/* GBBB-3 (Erik t670u): a non-pro plan (from the DB row) cannot explicitly pick a premium model. */
const secret = 'plan-model-block-secret-01234567890123456789';
const counted = (model: string) => { const base = makeMockProvider(); const calls = { n: 0 };
  const provider: AIProvider = { ...base, name: 'mistral', model, complete: (m, o) => { calls.n++; return base.complete(m, o); } }; return { provider, calls }; };
const pools: Array<{ end(): Promise<void> }> = [];
afterEach(async () => { while (pools.length) await pools.pop()!.end(); });
async function setup() {
  const mem = newDb(); registerProjectByteLength(mem);
  const pool = new (mem.adapters.createPg().Pool)(); pools.push(pool);
  const db = dbFromPool(pool); await applyMigrations(db);
  await db.query(`INSERT INTO users (id,email,password_hash) VALUES ('alice','alice@example.test','x')`);
  await db.query(`INSERT INTO users (id,email,password_hash,plan) VALUES ('paul','paul@example.test','x','pro')`);
  await db.query(`INSERT INTO users (id,email,password_hash,plan,plan_expires_at) VALUES ('uma','uma@example.test','x','pro','2000-01-01T00:00:00Z')`);
  const d = counted('d'), large = counted('l');
  const registry = new ProviderRegistry([{ id: 'mistral', label: 'D', provider: d.provider }, { id: 'mistral-large', label: 'L', provider: large.provider }]);
  const quota = new InMemoryQuotaStore();
  const app = createApp({}, null, { providers: registry, rateLimit: () => true, auth: { db, jwtSecret: secret, quota, usage: new InMemoryAiUsageStore() }, agentJobs: { workerEnabled: false, startWorker: false } });
  const req = async (sub: string, path: string, body: unknown) => {
    const tok = await signToken({ sub, email: sub + '@example.test', plan: 'pro' }, secret); // claim says pro: the DB row decides
    return app.request(new Request('http://localhost' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `lov_token=${tok}; lov_csrf=t`, 'X-CSRF-Token': 't' }, body: JSON.stringify(body) }));
  };
  return { db, app, quota, registry, d, large, req };
}
const gen = { projectId: 'p1', prompt: 'x', mode: 'create', modelId: 'mistral-large' };

describe('premium model block for non-pro plans', () => {
  it.each(['alice', 'uma'])('generate: %s (free / expired pro) gets 403 plan_upgrade_required, 0 AI calls, 0 quota', async user => {
    const t = await setup();
    const res = await t.req(user, '/api/agent/generate', gen);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'plan_upgrade_required', model: 'mistral-large', requiredPlan: 'pro', plan: 'free' });
    expect(t.large.calls.n + t.d.calls.n).toBe(0);
    expect((await t.quota.usage(user)).used).toBe(0);
  });
  it('generate: pro is unchanged', async () => {
    const t = await setup();
    const res = await t.req('paul', '/api/agent/generate', gen);
    expect(res.status).toBe(200); await res.text();
    expect(t.large.calls.n).toBeGreaterThan(0);
  });
  it('autofix: free gets 403 before quota and AI', async () => {
    const t = await setup();
    const res = await t.req('alice', '/api/sandbox/autofix', { files: [{ path: 'src/main.tsx', content: 'export {};' }], modelId: 'mistral-large', maxAttempts: 3 });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('plan_upgrade_required');
    expect(t.large.calls.n + t.d.calls.n).toBe(0);
    expect((await t.quota.usage('alice')).used).toBe(0);
  });
  it('worker: free job fails plan_upgrade_required with 0 AI calls; pro job succeeds', async () => {
    const t = await setup(); const store = new PostgresAgentJobStore(t.db);
    await store.create({ id: 'j1', ownerId: 'alice', idempotencyKey: 'k1', request: gen });
    await store.create({ id: 'j2', ownerId: 'paul', idempotencyKey: 'k2', request: gen });
    await new AgentWorker({ store, providers: t.registry, planFor: planLookup(t.db), resilience: { sleep: async () => {} } }).drain();
    const j1 = await store.get('alice', 'j1'), j2 = await store.get('paul', 'j2');
    expect(j1!.state).toBe('failed');
    expect(JSON.stringify(j1)).toContain('plan_upgrade_required');
    expect(j2!.state).toBe('succeeded');
  });
  it('/api/ai-models: premium locked for free, unlocked for pro', async () => {
    const t = await setup();
    const get = async (sub: string) => { const tok = await signToken({ sub, email: sub + '@example.test', plan: 'pro' }, secret);
      return (await (await t.app.request(new Request('http://localhost/api/ai-models', { headers: { Cookie: `lov_token=${tok}` } }))).json()) as { models: Array<{ id: string; locked?: boolean; requiredPlan?: string }> }; };
    expect((await get('alice')).models.find(m => m.id === 'mistral-large')).toMatchObject({ locked: true, requiredPlan: 'pro' });
    expect((await get('paul')).models.find(m => m.id === 'mistral-large')?.locked).toBeUndefined();
  });
});

describe('planLookup', () => {
  it('a missing user row (unknown plan) counts as free', async () => {
    const t = await setup();
    expect(await planLookup(t.db)('nobody')).toBe('free');
    expect(await planLookup(t.db)('paul')).toBe('pro');
  });
});
