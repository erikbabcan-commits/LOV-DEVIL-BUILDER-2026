import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { newDb } from 'pg-mem';
import { webcrypto } from 'node:crypto';
import { TextEncoder as NodeTextEncoder } from 'node:util';
import { PATCH_PROJECT_FILES, patchFixtureProvider } from '../fixtures/patchProject';
import { createApp } from '../../server/index';
import { applyMigrations } from '../../server/db/migrate';
import { dbFromPool, type DbLike } from '../../server/db/pool';
import { registerProjectByteLength } from '../helpers/projectMemoryDb';
import { signToken } from '../../server/auth/tokens';
import { InMemoryQuotaStore } from '../../server/security/quotaStore';
import { InMemoryAiUsageStore } from '../../server/usage/store';
import { PostgresAgentJobStore } from '../../server/agent/jobs';
import { AgentWorker } from '../../server/agent/worker';
import { ProviderRegistry } from '../../server/providers/registry';
import { useStore } from '../../src/stores/useAppStore';
import { selectPersistenceScope } from '../../src/services/persistence/projectStore';
import { jobClientConfig, resetJobClientForTests } from '../../src/services/ai/jobClient';
import { changedFiles } from '../../src/lib/projectDiff';

/* Task C acceptance (wave1/REVIEW.md "Odložená úloha C" bod 3): the colour-patch run goes
   through POST /api/agent/jobs + worker + ?detail=1 polling with BOTH flags on, and ends
   as a pendingReview exactly like the SSE path — never auto-applied. */
describe('durable jobs path with AGENT_JOBS_WORKER=1 and VITE_AGENT_JOBS_CLIENT=1', () => {
  const secret = 'durable-review-local-test-secret-01234567';
  let db: DbLike, pool: { end(): Promise<void> }, timer: ReturnType<typeof setInterval> | undefined;
  const pollMs = jobClientConfig.pollIntervalMs;
  const requests: string[] = [];
  beforeEach(async () => {
    vi.stubGlobal('Uint8Array', new NodeTextEncoder().encode('').constructor);
    vi.stubGlobal('crypto', webcrypto);
    vi.stubEnv('VITE_AGENT_JOBS_CLIENT', '1');
    resetJobClientForTests();
    jobClientConfig.pollIntervalMs = 10;
    const mem = newDb(); registerProjectByteLength(mem);
    const Pool = mem.adapters.createPg().Pool; pool = new Pool();
    db = dbFromPool(pool as never); await applyMigrations(db);
    await db.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', ['alice', 'alice@example.com', 'test']);
    requests.length = 0;
  }, 30000);
  afterEach(async () => {
    if (timer) clearInterval(timer); timer = undefined;
    jobClientConfig.pollIntervalMs = pollMs;
    vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetJobClientForTests();
    selectPersistenceScope({ kind: 'pilot' }); useStore.getState().newProject();
    await pool.end();
  });

  it('applies the worker result as pendingReview (same review flow as SSE), nothing is applied before approval', async () => {
    const provider = patchFixtureProvider();
    const store = new PostgresAgentJobStore(db);
    const app = createApp({}, provider, { rateLimit: () => true, jobs: store, agentJobs: { workerEnabled: true, startWorker: false },
      auth: { db, jwtSecret: secret, quota: new InMemoryQuotaStore(), usage: new InMemoryAiUsageStore() } });
    const worker = new AgentWorker({ store, providers: new ProviderRegistry([{ id: 'default', label: 'test', provider }]), resilience: { sleep: async () => {} } });
    timer = setInterval(() => { void worker.tick().catch(() => {}); }, 5);
    const token = await signToken({ sub: 'alice', email: 'alice@example.com', plan: 'free' }, secret);
    document.cookie = 'lov_csrf=sync-csrf; path=/';
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: RequestInit = {}) => {
      requests.push((init.method ?? 'GET') + ' ' + new URL(url, 'http://localhost').pathname);
      return app.request(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Cookie: `lov_token=${token}; lov_csrf=sync-csrf` } });
    }));
    selectPersistenceScope({ kind: 'account', userId: 'durable-review-' + crypto.randomUUID() });
    useStore.getState().newProject();
    const files = PATCH_PROJECT_FILES.map(f => ({ name: f.path, content: f.content, modified: false }));
    const snapshot = useStore.getState().createSnapshot('ai', 'Colour fixture', '<main>Colour fixture</main>');
    useStore.setState({ liveId: snapshot.id, snapshots: [{ ...snapshot, sourceFiles: JSON.stringify(files) }], vfs: { [snapshot.id]: files }, projectTitle: 'Colour fixture' });

    await useStore.getState().generateWithAi('Zmeň farbu hlavného tlačidla na červenú.', 'auto');

    expect(requests).toContain('POST /api/agent/jobs');
    expect(requests).not.toContain('POST /api/agent/generate');
    expect(useStore.getState().pendingReview).toMatchObject({ source: 'patch', files: [{ path: 'src/index.css', action: 'modify' }] });
    // Never auto-applied: no new snapshot, VFS unchanged until the owner approves.
    expect(useStore.getState().snapshots).toHaveLength(1);
    expect(useStore.getState().vfs[snapshot.id]).toEqual(files);
    expect(useStore.getState().approveStagedRun()).toBe(true);
    expect(changedFiles(files, useStore.getState().vfs[useStore.getState().liveId!]).map(f => f.path)).toEqual(['src/index.css']);
  });
});
