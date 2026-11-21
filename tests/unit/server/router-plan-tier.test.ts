// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { createApp, makeMockProvider } from '../../../server/index';
import { ProviderRegistry } from '../../../server/providers/registry';
import { selectGenerationRoute } from '../../../server/providers/generationRoute';
import { isPremiumModel, route as smartRoute } from '../../../server/providers/smartRouter';
import { PostgresAgentJobStore } from '../../../server/agent/jobs';
import { AgentWorker } from '../../../server/agent/worker';
import { dbFromPool } from '../../../server/db/pool';
import { applyMigrations } from '../../../server/db/migrate';
import { signToken } from '../../../server/auth/tokens';
import { InMemoryQuotaStore } from '../../../server/security/quotaStore';
import { InMemoryAiUsageStore } from '../../../server/usage/store';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import type { AIProvider } from '../../../server/providers/types';

/* Bora W3 P3-2: the smart router respects the plan tier. Free (and unknown) users never get a
   premium model (mistral-large) from the router; they are clamped to the best non-premium model.
   An explicit modelId is a user choice and stays exact. */
const counted = (model: string) => {
  const base = makeMockProvider();
  const calls = { n: 0 };
  const provider: AIProvider = { ...base, name: 'mistral', model, complete: (m, o) => { calls.n++; return base.complete(m, o); } };
  return { provider, calls };
};
function prodRegistry(fallbacks: string[] = ['codestral']) {
  const d = counted('mistral-agent'), small = counted('mistral-small-latest'), code = counted('codestral-latest'), large = counted('mistral-large-latest');
  const registry = new ProviderRegistry([
    { id: 'mistral', label: 'Default', provider: d.provider },
    { id: 'codestral', label: 'Codestral', provider: code.provider },
    { id: 'mistral-small', label: 'Mistral Small', provider: small.provider },
    { id: 'mistral-large', label: 'Mistral Large', provider: large.provider },
  ], fallbacks);
  return { registry, d, small, code, large };
}
const ARCH = 'Navrhni architektúru databázy pre multi-tenant aplikáciu';
const on = { prompt: ARCH, mode: 'create' as const, fileCount: 0, smartRouter: true };

describe('smartRouter.route with allowPremium=false', () => {
  it('mistral-large is marked premium', () => { expect(isPremiumModel('mistral-large')).toBe(true); expect(isPremiumModel('codestral')).toBe(false); });
  it('every premium rule (architecture, large context, long prompt) is clamped to the best non-premium model', () => {
    for (const [prompt, files] of [[ARCH, 0], ['x', 12], ['y'.repeat(4001), 0]] as const) {
      const d = smartRoute(prompt, 'generate', { fileCount: files, allowPremium: false });
      expect(d.model).toBe('codestral');
      expect(d.reason).toBe('plan_tier_clamp');
      expect(isPremiumModel(d.model)).toBe(false);
    }
    expect(smartRoute(ARCH, 'generate', { allowPremium: false, availableModels: ['mistral-small', 'mistral-large'] }).model).toBe('mistral-small');
    expect(() => smartRoute(ARCH, 'generate', { allowPremium: false, availableModels: ['mistral-large'] })).toThrow('invalid_model');
  });
  it('explicit choice is unaffected; allowPremium undefined keeps the old preview behavior', () => {
    expect(smartRoute(ARCH, 'generate', { allowPremium: false, explicitModel: 'mistral-large' }).model).toBe('mistral-large');
    expect(smartRoute(ARCH, 'generate', {}).model).toBe('mistral-large');
  });
});

describe('selectGenerationRoute respects plan tier (flag ON)', () => {
  it('free and unknown plans never get a premium model, also not as a configured fallback', () => {
    const { registry } = prodRegistry(['mistral-large']);
    for (const plan of ['free', undefined] as const) {
      for (const [prompt, fileCount] of [[ARCH, 0], ['x', 12], ['y'.repeat(4001), 0], ['krátko', 0]] as const) {
        const selected = selectGenerationRoute(registry, { ...on, prompt, fileCount, plan });
        expect(selected.entries.map(e => e.id).filter(isPremiumModel)).toEqual([]);
      }
    }
    const free = selectGenerationRoute(registry, { ...on, plan: 'free' });
    expect(free.decision).toEqual({ model: 'codestral', reason: 'plan_tier_clamp' });
  });
  it('pro gets mistral-large with AI_FALLBACK_MODELS after it', () => {
    const { registry } = prodRegistry(['codestral']);
    const pro = selectGenerationRoute(registry, { ...on, plan: 'pro' });
    expect(pro.decision).toEqual({ model: 'mistral-large', reason: 'architecture_keywords' });
    expect(pro.entries.map(e => e.id)).toEqual(['mistral-large', 'codestral']);
  });
  it('an explicit premium modelId is never re-routed: exact without plan enforcement, refused for free with it (GBBB-3)', () => {
    const { registry } = prodRegistry();
    expect(selectGenerationRoute(registry, { ...on, plan: 'free', modelId: 'mistral-large' }).entries.map(e => e.id)).toEqual(['mistral-large']);
    expect(() => selectGenerationRoute(registry, { ...on, plan: 'free', modelId: 'mistral-large', enforcePlan: true })).toThrow('Pro');
  });
});

describe('HTTP + worker: plan comes from the server-side user row', () => {
  const pools: Array<{ end(): Promise<void> }> = [];
  afterEach(async () => { while (pools.length) await pools.pop()!.end(); });
  const secret = 'router-plan-tier-secret-0123456789012345678901';
  async function mkdb() {
    const mem = newDb(); registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)(); pools.push(pool);
    const db = dbFromPool(pool); await applyMigrations(db);
    await db.query(`INSERT INTO users (id,email,password_hash) VALUES ('alice','alice@example.test','x')`);
    await db.query(`INSERT INTO users (id,email,password_hash,plan) VALUES ('paul','paul@example.test','x','pro')`);
    return db;
  }
  async function sse(res: Response) { return (await res.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)) as { type: string; route?: unknown }); }

  it('free user: architecture prompt is clamped, mistral-large gets 0 calls; pro user gets mistral-large', async () => {
    const db = await mkdb(); const r = prodRegistry();
    const app = createApp({}, null, { providers: r.registry, rateLimit: () => true, smartRouter: true,
      auth: { db, jwtSecret: secret, quota: new InMemoryQuotaStore(), usage: new InMemoryAiUsageStore() }, agentJobs: { workerEnabled: false, startWorker: false } });
    const call = async (sub: string, plan: 'free' | 'pro') => {
      // The token claims 'pro' for alice too: the server must trust the DB row, not the claim.
      const tok = await signToken({ sub, email: `${sub}@example.test`, plan }, secret);
      return sse(await app.request(new Request('http://localhost/api/agent/generate', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `lov_token=${tok}; lov_csrf=t`, 'X-CSRF-Token': 't' },
        body: JSON.stringify({ projectId: 'p1', prompt: ARCH, mode: 'create' }) })));
    };
    const free = await call('alice', 'pro');
    expect(free.find(e => e.type === 'run_started')?.route).toEqual({ model: 'codestral', reason: 'plan_tier_clamp' });
    expect(r.large.calls.n).toBe(0);
    expect(r.code.calls.n).toBeGreaterThan(0);
    const pro = await call('paul', 'pro');
    expect(pro.find(e => e.type === 'run_started')?.route).toEqual({ model: 'mistral-large', reason: 'architecture_keywords' });
    expect(r.large.calls.n).toBeGreaterThan(0);
  });

  it('worker: free owner is clamped via planFor, a failing plan lookup is treated as free', async () => {
    const db = await mkdb(); const store = new PostgresAgentJobStore(db); const r = prodRegistry();
    await store.create({ id: 'j1', ownerId: 'alice', idempotencyKey: 'k1', request: { projectId: 'p1', prompt: ARCH, mode: 'create' } });
    await new AgentWorker({ store, providers: r.registry, smartRouter: true, planFor: async () => 'free', resilience: { sleep: async () => {} } }).drain();
    await store.create({ id: 'j2', ownerId: 'alice', idempotencyKey: 'k2', request: { projectId: 'p1', prompt: ARCH, mode: 'create' } });
    await new AgentWorker({ store, providers: r.registry, smartRouter: true, planFor: async () => { throw new Error('db down'); }, resilience: { sleep: async () => {} } }).drain();
    for (const id of ['j1', 'j2']) {
      const job = await store.get('alice', id);
      expect(job!.state).toBe('succeeded');
      expect((job!.events.find(e => (e as { type: string }).type === 'run_started') as { route?: unknown }).route).toEqual({ model: 'codestral', reason: 'plan_tier_clamp' });
    }
    expect(r.large.calls.n).toBe(0);
    await store.create({ id: 'j3', ownerId: 'paul', idempotencyKey: 'k3', request: { projectId: 'p1', prompt: ARCH, mode: 'create' } });
    await new AgentWorker({ store, providers: r.registry, smartRouter: true, planFor: async () => 'pro', resilience: { sleep: async () => {} } }).drain();
    expect(r.large.calls.n).toBeGreaterThan(0);
  });
});
