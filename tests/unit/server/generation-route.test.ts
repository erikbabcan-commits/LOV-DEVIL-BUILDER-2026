// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { createApp, makeMockProvider } from '../../../server/index';
import { ProviderRegistry } from '../../../server/providers/registry';
import { selectGenerationRoute, smartRouterEnabled, withRouteDecision } from '../../../server/providers/generationRoute';
import { PostgresAgentJobStore } from '../../../server/agent/jobs';
import { AgentWorker } from '../../../server/agent/worker';
import { dbFromPool } from '../../../server/db/pool';
import { applyMigrations } from '../../../server/db/migrate';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import { signToken } from '../../../server/auth/tokens';
import { InMemoryQuotaStore } from '../../../server/security/quotaStore';
import { InMemoryAiUsageStore } from '../../../server/usage/store';
import type { AIProvider } from '../../../server/providers/types';

/* Wave-3 glue + Bora W3 P3-1: the smart router runs only with AI_SMART_ROUTER=1 (default OFF).
   OFF = exactly the previous route (AI_DEFAULT_MODEL / Mistral Agent default + AI_FALLBACK_MODELS).
   ON = router picks from registered models, followed by the configured AI_FALLBACK_MODELS.
   An explicit modelId always wins. */
const counted = (model: string) => {
  const base = makeMockProvider();
  const calls = { n: 0 };
  const provider: AIProvider = {
    ...base, name: 'mistral', model,
    complete: (messages, options) => { calls.n++; return base.complete(messages, options); },
  };
  return { provider, calls };
};
function smartRegistry() {
  const small = counted('mistral-small-latest'), code = counted('codestral-latest'), large = counted('mistral-large-latest');
  const registry = new ProviderRegistry([
    { id: 'codestral', label: 'Codestral', provider: code.provider },
    { id: 'mistral-small', label: 'Mistral Small', provider: small.provider },
    { id: 'mistral-large', label: 'Mistral Large', provider: large.provider },
  ]);
  return { registry, small, code, large };
}
/** Production-like registry (Bora probe R1): default id "mistral" (AI_DEFAULT_MODEL / Mistral Agent),
 *  catalog extras, AI_FALLBACK_MODELS = codestral. */
function prodRegistry() {
  const d = counted('mistral-agent'), small = counted('mistral-small-latest'), code = counted('codestral-latest'), large = counted('mistral-large-latest');
  const registry = new ProviderRegistry([
    { id: 'mistral', label: 'Default', provider: d.provider },
    { id: 'codestral', label: 'Codestral', provider: code.provider },
    { id: 'mistral-small', label: 'Mistral Small', provider: small.provider },
    { id: 'mistral-large', label: 'Mistral Large', provider: large.provider },
  ], ['codestral']);
  return { registry, d, small, code, large };
}
const base = { prompt: 'Pridaj tlačidlo', mode: 'create' as const, fileCount: 0 };
const on = { ...base, smartRouter: true };

describe('AI_SMART_ROUTER flag parsing', () => {
  it('is ON only for the exact value 1', () => {
    expect(smartRouterEnabled({})).toBe(false);
    expect(smartRouterEnabled({ AI_SMART_ROUTER: '0' })).toBe(false);
    expect(smartRouterEnabled({ AI_SMART_ROUTER: 'true' })).toBe(false);
    expect(smartRouterEnabled({ AI_SMART_ROUTER: '1' })).toBe(true);
  });
});

describe('selectGenerationRoute, flag OFF (default)', () => {
  it('no modelId: exactly providers.route(...) with no decision, for every prompt', () => {
    const { registry } = prodRegistry();
    for (const prompt of ['x', 'Navrhni architektúru databázy', 'y'.repeat(5000)]) {
      const selected = selectGenerationRoute(registry, { ...base, prompt });
      expect(selected.decision).toBeNull();
      expect(selected.entries).toEqual(registry.route(undefined));
      expect(selected.entries[0].id).toBe('mistral');
    }
    const withUi = selectGenerationRoute(registry, { ...base, allowFallback: true, fallbackIds: ['codestral'] });
    expect(withUi.entries.map(e => e.id)).toEqual(['mistral', 'codestral']);
    expect(() => selectGenerationRoute(registry, { ...base, allowFallback: true, fallbackIds: ['mistral-small'] })).toThrow('invalid_model');
  });
  it('explicit modelId: exactly that model, unknown throws', () => {
    const { registry } = prodRegistry();
    expect(selectGenerationRoute(registry, { ...base, modelId: 'mistral-large' }).entries).toEqual(registry.route('mistral-large'));
    expect(() => selectGenerationRoute(registry, { ...base, modelId: 'gpt-9' })).toThrow('invalid_model');
  });
  it('withRouteDecision(null) never changes an event', () => {
    const started = { type: 'run_started', runId: 'r', model: 'm' };
    expect(withRouteDecision(started, null)).toBe(started);
  });
});

describe('selectGenerationRoute, flag ON', () => {
  it('without modelId picks by router rules; no configured fallbacks means no router-only cascade', () => {
    const { registry } = smartRegistry();
    const short = selectGenerationRoute(registry, on);
    expect(short.decision).toEqual({ model: 'mistral-small', reason: 'short_prompt' });
    expect(short.entries.map(e => e.id)).toEqual(['mistral-small']);
    const arch = selectGenerationRoute(registry, { ...on, plan: 'pro', prompt: 'Navrhni architektúru multi-tenant aplikácie' });
    expect(arch.decision).toEqual({ model: 'mistral-large', reason: 'architecture_keywords' });
    const fix = selectGenerationRoute(registry, { ...on, prompt: 'Oprav chybu v App.tsx', mode: 'fix', fileCount: 2 });
    expect(fix.decision?.model).toBe('mistral-small');
  });

  it('keeps AI_FALLBACK_MODELS as the fallback after the router pick', () => {
    const { registry } = prodRegistry();
    const short = selectGenerationRoute(registry, on);
    expect(short.decision?.model).toBe('mistral-small');
    expect(short.entries.map(e => e.id)).toEqual(['mistral-small', 'codestral']);
    const code = selectGenerationRoute(registry, { ...on, prompt: 'x'.repeat(500), fileCount: 5 });
    expect(code.decision?.model).toBe('codestral');
    expect(code.entries.map(e => e.id)).toEqual(['codestral']);
  });

  it('drops AI_FALLBACK_MODELS when allowFallback is false even with smart router ON (Bora P2)', () => {
    const { registry } = prodRegistry();
    const short = selectGenerationRoute(registry, { ...on, allowFallback: false });
    expect(short.decision?.model).toBe('mistral-small');
    expect(short.entries.map(e => e.id)).toEqual(['mistral-small']);
  });

  it('only picks registered (allowed) models', () => {
    const { registry } = prodRegistry();
    const ids = registry.ids();
    for (const prompt of ['x', 'Navrhni architektúru', 'y'.repeat(3000)]) {
      const selected = selectGenerationRoute(registry, { ...on, prompt });
      for (const entry of selected.entries) expect(ids).toContain(entry.id);
    }
  });

  it('when the router picks the registry default, the previous route (with UI fallbacks) is kept unchanged', () => {
    const { registry } = smartRegistry();
    const selected = selectGenerationRoute(registry, { ...on, prompt: 'x'.repeat(500), fileCount: 5 });
    expect(selected.decision).toEqual({ model: 'codestral', reason: 'code_generation' });
    expect(selected.entries).toEqual(registry.route(undefined));
  });

  it('an explicit modelId is used exactly, without router cascade', () => {
    const { registry } = smartRegistry();
    const selected = selectGenerationRoute(registry, { ...on, modelId: 'mistral-large', prompt: 'krátko' });
    expect(selected.decision).toEqual({ model: 'mistral-large', reason: 'explicit_user_choice' });
    expect(selected.entries).toEqual(registry.route('mistral-large'));
    expect(selected.entries).toHaveLength(1);
    expect(() => selectGenerationRoute(registry, { ...on, modelId: 'unknown' })).toThrow('invalid_model');
  });

  it('a default-only registry behaves exactly as before (same entries, also with configured fallbacks)', () => {
    const only = new ProviderRegistry([{ id: 'default', label: 'AI', provider: makeMockProvider() }]);
    const a = selectGenerationRoute(only, on);
    expect(a.entries).toEqual(only.route(undefined));
    expect(a.decision?.model).toBe('default');
    const withFallback = new ProviderRegistry([
      { id: 'default', label: 'AI', provider: makeMockProvider() },
      { id: 'backup', label: 'Backup', provider: makeMockProvider() },
    ], ['backup']);
    const b = selectGenerationRoute(withFallback, { ...on, allowFallback: true, fallbackIds: ['backup'] });
    expect(b.entries.map(e => e.id)).toEqual(withFallback.route(undefined, true, ['backup']).map(e => e.id));
    expect(() => selectGenerationRoute(withFallback, { ...on, allowFallback: true, fallbackIds: [] })).toThrow('invalid_model');
  });

  it('withRouteDecision only enriches run_started', () => {
    const decision = { model: 'mistral-small', reason: 'short_prompt' as const };
    expect(withRouteDecision({ type: 'run_started', runId: 'r', model: 'm' }, decision)).toEqual({ type: 'run_started', runId: 'r', model: 'm', route: decision });
    const done = { type: 'done', runId: 'r', summary: 's' };
    expect(withRouteDecision(done, decision)).toBe(done);
  });
});

async function sse(res: Response) {
  const text = await res.text();
  return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as { type: string; route?: unknown });
}
const generate = (app: ReturnType<typeof createApp>, body: Record<string, unknown>) => app.request(new Request('http://localhost/api/agent/generate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: 'p1', prompt: 'Pridaj tlačidlo', mode: 'create', ...body }),
}));

describe('/api/agent/generate, flag OFF (default): previous behavior (Bora probe R1)', () => {
  it('no modelId: AI_DEFAULT_MODEL gets the calls, no route field, router models untouched', async () => {
    const r = prodRegistry();
    const app = createApp({}, null, { providers: r.registry, rateLimit: () => true });
    const events = await sse(await generate(app, { prompt: 'Navrhni architektúru' }));
    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(events.find(e => e.type === 'run_started')).not.toHaveProperty('route');
    expect(r.d.calls.n).toBeGreaterThan(0);
    expect(r.small.calls.n + r.code.calls.n + r.large.calls.n).toBe(0);
  });
  it('the env flag defaults OFF when the option is not given', async () => {
    const before = process.env.AI_SMART_ROUTER;
    delete process.env.AI_SMART_ROUTER;
    try {
      const r = prodRegistry();
      const app = createApp({}, null, { providers: r.registry, rateLimit: () => true });
      await sse(await generate(app, {}));
      expect(r.d.calls.n).toBeGreaterThan(0);
      expect(r.small.calls.n).toBe(0);
    } finally { if (before !== undefined) process.env.AI_SMART_ROUTER = before; }
  });
});

describe('/api/agent/generate, flag ON: smart router only without modelId', () => {
  it('no modelId: routed to mistral-small, run_started carries route', async () => {
    const { registry, small, code } = smartRegistry();
    const app = createApp({}, null, { providers: registry, rateLimit: () => true, smartRouter: true });
    const events = await sse(await generate(app, {}));
    expect(events.find(e => e.type === 'run_started')?.route).toEqual({ model: 'mistral-small', reason: 'short_prompt' });
    expect(small.calls.n).toBeGreaterThan(0);
    expect(code.calls.n).toBe(0);
  });

  it('explicit modelId: exactly that model', async () => {
    const { registry, small, code } = smartRegistry();
    const app = createApp({}, null, { providers: registry, rateLimit: () => true, smartRouter: true });
    const events = await sse(await generate(app, { modelId: 'codestral' }));
    expect(events.find(e => e.type === 'run_started')?.route).toEqual({ model: 'codestral', reason: 'explicit_user_choice' });
    expect(code.calls.n).toBeGreaterThan(0);
    expect(small.calls.n).toBe(0);
  });

  it('unknown modelId is still 400 invalid_model', async () => {
    const { registry } = smartRegistry();
    const app = createApp({}, null, { providers: registry, rateLimit: () => true, smartRouter: true });
    const res = await generate(app, { modelId: 'nope' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_model');
  });
});

describe('durable worker uses the same model choice', () => {
  const pools: Array<{ end(): Promise<void> }> = [];
  afterEach(async () => { while (pools.length) await pools.pop()!.end(); });
  async function storeWithAlice() {
    const mem = newDb();
    registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)();
    pools.push(pool);
    const db = dbFromPool(pool);
    await applyMigrations(db);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ('alice', 'alice@example.test', 'x')`);
    return new PostgresAgentJobStore(db);
  }

  it('flag ON: a job without modelId runs on the routed model and stores route in run_started', async () => {
    const store = await storeWithAlice();
    const { registry, small, code } = smartRegistry();
    await store.create({ id: 'job-1', ownerId: 'alice', idempotencyKey: 'k1', request: { projectId: 'p1', prompt: 'Pridaj tlačidlo', mode: 'create' } });
    await new AgentWorker({ store, providers: registry, smartRouter: true, resilience: { sleep: async () => {} } }).drain();
    const job = await store.get('alice', 'job-1');
    expect(job!.state).toBe('succeeded');
    const started = job!.events.find(e => (e as { type: string }).type === 'run_started') as { route?: unknown };
    expect(started.route).toEqual({ model: 'mistral-small', reason: 'short_prompt' });
    expect(small.calls.n).toBeGreaterThan(0);
    expect(code.calls.n).toBe(0);
  });

  it('flag OFF (default): a job without modelId runs on the configured default, no route field', async () => {
    const store = await storeWithAlice();
    const r = prodRegistry();
    await store.create({ id: 'job-2', ownerId: 'alice', idempotencyKey: 'k2', request: { projectId: 'p1', prompt: 'Navrhni architektúru', mode: 'create' } });
    await new AgentWorker({ store, providers: r.registry, resilience: { sleep: async () => {} } }).drain();
    const job = await store.get('alice', 'job-2');
    expect(job!.state).toBe('succeeded');
    const started = job!.events.find(e => (e as { type: string }).type === 'run_started');
    expect(started).not.toHaveProperty('route');
    expect(r.d.calls.n).toBeGreaterThan(0);
    expect(r.small.calls.n + r.code.calls.n + r.large.calls.n).toBe(0);
  });
});

describe('Bora W3 P3-5 regressions (probes R2 and Q1)', () => {
  const pools: Array<{ end(): Promise<void> }> = [];
  afterEach(async () => { while (pools.length) await pools.pop()!.end(); });
  async function mkdb() {
    const mem = newDb(); registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)(); pools.push(pool);
    const db = dbFromPool(pool); await applyMigrations(db);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ('alice', 'alice@example.test', 'x')`);
    return db;
  }

  it.each([false, true])('worker (router %s): explicit modelId runs exactly that model, unknown modelId fails invalid_model', async smartRouter => {
    const store = new PostgresAgentJobStore(await mkdb());
    const r = prodRegistry();
    await store.create({ id: 'j1', ownerId: 'alice', idempotencyKey: 'k1', request: { projectId: 'p1', prompt: 'x', mode: 'create', modelId: 'mistral-large' } });
    await store.create({ id: 'j2', ownerId: 'alice', idempotencyKey: 'k2', request: { projectId: 'p1', prompt: 'x', mode: 'create', modelId: 'gpt-9' } });
    // A pro owner: explicit premium models need the pro plan since GBBB-3 (free is covered in plan-model-block.test.ts).
    await new AgentWorker({ store, providers: r.registry, smartRouter, planFor: async () => 'pro', resilience: { sleep: async () => {} } }).drain();
    const j1 = await store.get('alice', 'j1'), j2 = await store.get('alice', 'j2');
    expect(j1!.state).toBe('succeeded');
    const started = j1!.events.find(e => (e as { type: string }).type === 'run_started') as { route?: unknown };
    if (smartRouter) expect(started.route).toEqual({ model: 'mistral-large', reason: 'explicit_user_choice' });
    else expect(started).not.toHaveProperty('route');
    expect(r.large.calls.n).toBeGreaterThan(0);
    expect(r.d.calls.n + r.small.calls.n + r.code.calls.n).toBe(0);
    expect(j2!.state).toBe('failed');
    expect((j2 as { errorPayload?: { code: string } | null }).errorPayload?.code ?? j2!.error).toContain('invalid_model');
  });

  it('generate on the router path (flag ON, no modelId) with exhausted quota: 429 quota_exceeded and 0 AI calls', async () => {
    const db = await mkdb(); const secret = 'generation-route-q1-secret-0123456789012345678';
    const quota = new InMemoryQuotaStore();
    while ((await quota.consume('alice')).ok) { /* exhaust */ }
    const r = prodRegistry();
    const app = createApp({}, null, { providers: r.registry, rateLimit: () => true, smartRouter: true,
      auth: { db, jwtSecret: secret, quota, usage: new InMemoryAiUsageStore() }, agentJobs: { workerEnabled: false, startWorker: false } });
    const tok = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
    const res = await app.request(new Request('http://localhost/api/agent/generate', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `lov_token=${tok}; lov_csrf=t`, 'X-CSRF-Token': 't' },
      body: JSON.stringify({ projectId: 'p1', prompt: 'Navrhni architektúru', mode: 'create' }) }));
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('quota_exceeded');
    expect(r.d.calls.n + r.small.calls.n + r.code.calls.n + r.large.calls.n).toBe(0);
  });
});
