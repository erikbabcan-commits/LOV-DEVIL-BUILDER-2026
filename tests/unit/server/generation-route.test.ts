// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { createApp, makeMockProvider } from '../../../server/index';
import { ProviderRegistry } from '../../../server/providers/registry';
import { selectGenerationRoute, withRouteDecision } from '../../../server/providers/generationRoute';
import { PostgresAgentJobStore } from '../../../server/agent/jobs';
import { AgentWorker } from '../../../server/agent/worker';
import { dbFromPool } from '../../../server/db/pool';
import { applyMigrations } from '../../../server/db/migrate';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import type { AIProvider } from '../../../server/providers/types';

/* Wave-3 glue: smart router in /api/agent/generate and the durable worker.
   Explicit modelId wins; a default-only registry behaves exactly as before. */
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
const base = { prompt: 'Pridaj tlačidlo', mode: 'create' as const, fileCount: 0 };

describe('selectGenerationRoute (wave-3 glue)', () => {
  it('without modelId picks by router rules and builds the router cascade', () => {
    const { registry } = smartRegistry();
    const short = selectGenerationRoute(registry, base);
    expect(short.decision).toEqual({ model: 'mistral-small', reason: 'short_prompt' });
    expect(short.entries.map(e => e.id)).toEqual(['mistral-small', 'codestral', 'mistral-large']);
    const arch = selectGenerationRoute(registry, { ...base, prompt: 'Navrhni architektúru multi-tenant aplikácie' });
    expect(arch.decision).toEqual({ model: 'mistral-large', reason: 'architecture_keywords' });
    const fix = selectGenerationRoute(registry, { ...base, prompt: 'Oprav chybu v App.tsx', mode: 'fix', fileCount: 2 });
    expect(fix.decision.model).toBe('mistral-small');
  });

  it('when the router picks the registry default, the previous route (with UI fallbacks) is kept unchanged', () => {
    const { registry } = smartRegistry();
    const long = 'x'.repeat(500);
    const selected = selectGenerationRoute(registry, { ...base, prompt: long, fileCount: 5 });
    expect(selected.decision).toEqual({ model: 'codestral', reason: 'code_generation' });
    expect(selected.entries).toEqual(registry.route(undefined));
  });

  it('an explicit modelId is used exactly, without router cascade', () => {
    const { registry } = smartRegistry();
    const selected = selectGenerationRoute(registry, { ...base, modelId: 'mistral-large', prompt: 'krátko' });
    expect(selected.decision).toEqual({ model: 'mistral-large', reason: 'explicit_user_choice' });
    expect(selected.entries).toEqual(registry.route('mistral-large'));
    expect(selected.entries).toHaveLength(1);
    expect(() => selectGenerationRoute(registry, { ...base, modelId: 'unknown' })).toThrow('invalid_model');
  });

  it('a default-only registry behaves exactly as before (same entries, also with configured fallbacks)', () => {
    const only = new ProviderRegistry([{ id: 'default', label: 'AI', provider: makeMockProvider() }]);
    const a = selectGenerationRoute(only, base);
    expect(a.entries).toEqual(only.route(undefined));
    expect(a.decision.model).toBe('default');
    const withFallback = new ProviderRegistry([
      { id: 'default', label: 'AI', provider: makeMockProvider() },
      { id: 'backup', label: 'Backup', provider: makeMockProvider() },
    ], ['backup']);
    const b = selectGenerationRoute(withFallback, { ...base, allowFallback: true, fallbackIds: ['backup'] });
    expect(b.entries.map(e => e.id)).toEqual(withFallback.route(undefined, true, ['backup']).map(e => e.id));
    expect(() => selectGenerationRoute(withFallback, { ...base, allowFallback: true, fallbackIds: [] })).toThrow('invalid_model');
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

describe('/api/agent/generate uses the smart router only without modelId', () => {
  it('no modelId: routed to mistral-small, run_started carries route', async () => {
    const { registry, small, code } = smartRegistry();
    const app = createApp({}, null, { providers: registry, rateLimit: () => true });
    const events = await sse(await generate(app, {}));
    expect(events.find(e => e.type === 'run_started')?.route).toEqual({ model: 'mistral-small', reason: 'short_prompt' });
    expect(small.calls.n).toBeGreaterThan(0);
    expect(code.calls.n).toBe(0);
  });

  it('explicit modelId: exactly that model', async () => {
    const { registry, small, code } = smartRegistry();
    const app = createApp({}, null, { providers: registry, rateLimit: () => true });
    const events = await sse(await generate(app, { modelId: 'codestral' }));
    expect(events.find(e => e.type === 'run_started')?.route).toEqual({ model: 'codestral', reason: 'explicit_user_choice' });
    expect(code.calls.n).toBeGreaterThan(0);
    expect(small.calls.n).toBe(0);
  });

  it('unknown modelId is still 400 invalid_model', async () => {
    const { registry } = smartRegistry();
    const app = createApp({}, null, { providers: registry, rateLimit: () => true });
    const res = await generate(app, { modelId: 'nope' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_model');
  });
});

describe('durable worker uses the same model choice', () => {
  const pools: Array<{ end(): Promise<void> }> = [];
  afterEach(async () => { while (pools.length) await pools.pop()!.end(); });

  it('a job without modelId runs on the routed model and stores route in run_started', async () => {
    const mem = newDb();
    registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)();
    pools.push(pool);
    const db = dbFromPool(pool);
    await applyMigrations(db);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ('alice', 'alice@example.test', 'x')`);
    const store = new PostgresAgentJobStore(db);
    const { registry, small, code } = smartRegistry();
    await store.create({ id: 'job-1', ownerId: 'alice', idempotencyKey: 'k1', request: { projectId: 'p1', prompt: 'Pridaj tlačidlo', mode: 'create' } });
    await new AgentWorker({ store, providers: registry, resilience: { sleep: async () => {} } }).drain();
    const job = await store.get('alice', 'job-1');
    expect(job!.state).toBe('succeeded');
    const started = job!.events.find(e => (e as { type: string }).type === 'run_started') as { route?: unknown };
    expect(started.route).toEqual({ model: 'mistral-small', reason: 'short_prompt' });
    expect(small.calls.n).toBeGreaterThan(0);
    expect(code.calls.n).toBe(0);
  });
});
