// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { dbFromPool, type DbLike } from '../../../server/db/pool';
import { applyMigrations } from '../../../server/db/migrate';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import { PostgresAgentJobStore, visibleJobEvents } from '../../../server/agent/jobs';
import { createApp, makeMockProvider } from '../../../server/index';
import { signToken } from '../../../server/auth/tokens';
import { PostgresQuotaStore } from '../../../server/security/quotaStore';
import { InMemoryAiUsageStore } from '../../../server/usage/store';
import { AgentJobDetailSchema, AgentJobViewSchema } from '../../../shared/agentJobs';
import type { AgentEvent } from '../../../server/agent/schemas';

/** Bora P2-1: cancelling after the stage must not hand out the generated files for free. */
const secret = 'jobs-visibility-test-secret-0123456789012345';
const SECRET_CONTENT = 'export const paidOutput = 42;';
const input = { projectId: 'project', prompt: 'Build a small dashboard', mode: 'create' };
const pools: Array<{ end(): Promise<void> }> = [];
afterEach(async () => { while (pools.length) await pools.pop()!.end(); });

async function setup() {
  const mem = newDb();
  registerProjectByteLength(mem);
  const pool = new (mem.adapters.createPg().Pool)();
  pools.push(pool);
  const db: DbLike = dbFromPool(pool);
  await applyMigrations(db);
  await db.query(`INSERT INTO users (id, email, password_hash) VALUES ('alice', 'alice@example.test', 'x')`);
  const store = new PostgresAgentJobStore(db);
  const app = createApp({}, makeMockProvider(), {
    auth: { db, jwtSecret: secret, quota: new PostgresQuotaStore(db), usage: new InMemoryAiUsageStore() },
    rateLimit: () => true, jobs: store, agentJobs: { workerEnabled: true, startWorker: false },
  });
  const alice = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
  const cookie = 'lov_token=' + alice + '; lov_csrf=t';
  const get = async (id: string, detail = false) =>
    (await app.request(new Request('http://localhost/api/agent/jobs/' + id + (detail ? '?detail=1' : ''), { headers: { Cookie: cookie } }))).json();
  const cancel = (id: string) => app.request(new Request('http://localhost/api/agent/jobs/' + id + '/cancel', {
    method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': 't' },
  }));
  const used = async () => Number((await db.query('SELECT generations FROM user_quotas WHERE user_id=$1', ['alice'])).rows[0]?.generations ?? 0);
  return { store, get, cancel, used };
}

const before: AgentEvent[] = [
  { type: 'run_started', runId: 'r1', model: 'm' },
  { type: 'file_started', path: 'src/App.tsx', action: 'create' },
];
const stage: AgentEvent = { type: 'stage', files: [{ path: 'src/App.tsx', content: SECRET_CONTENT, action: 'create' }] };
const after: AgentEvent[] = [{ type: 'validation', result: { ok: true, errors: [] } }];

describe('paid job output is only visible after succeeded (Bora P2-1)', () => {
  it('cuts the event list before the first stage/text_delta unless succeeded (prefix keeps indices stable)', () => {
    const events = [...before, stage, ...after];
    expect(visibleJobEvents({ state: 'running', events })).toEqual(before);
    expect(visibleJobEvents({ state: 'cancelled', events })).toEqual(before);
    expect(visibleJobEvents({ state: 'failed', events })).toEqual(before);
    expect(visibleJobEvents({ state: 'succeeded', events })).toEqual(events);
    const explain: AgentEvent[] = [before[0], { type: 'text_delta', delta: 'paid explanation' }];
    expect(visibleJobEvents({ state: 'cancelled', events: explain })).toEqual([before[0]]);
  });

  it('a job cancelled after its stage was persisted exposes no files and debits nothing', async () => {
    const { store, get, cancel, used } = await setup();
    await store.create({ id: 'job-1', ownerId: 'alice', idempotencyKey: 'key-job-1', request: input });
    await store.claimNext();
    await store.appendEvents('job-1', [...before, stage, ...after]);

    const running = AgentJobDetailSchema.parse(await get('job-1', true));
    expect(running.state).toBe('running');
    expect(running.events.map(e => (e as { type: string }).type)).toEqual(['run_started', 'file_started']);
    expect(JSON.stringify(running)).not.toContain(SECRET_CONTENT);

    expect((await cancel('job-1')).status).toBe(200);
    const view = AgentJobViewSchema.parse(await get('job-1'));
    const detail = AgentJobDetailSchema.parse(await get('job-1', true));
    expect(view.state).toBe('cancelled');
    expect(JSON.stringify(view)).not.toContain(SECRET_CONTENT);
    expect(JSON.stringify(detail)).not.toContain(SECRET_CONTENT);
    expect(detail.resultPatch).toBeNull();
    expect(await used()).toBe(0);
  });

  it('a succeeded job shows the stage and the result patch', async () => {
    const { store, get } = await setup();
    await store.create({ id: 'job-2', ownerId: 'alice', idempotencyKey: 'key-job-2', request: input });
    await store.claimNext();
    await store.appendEvents('job-2', [...before, stage, ...after]);
    await store.completeSucceeded('job-2', { resultPatch: { files: stage.type === 'stage' ? stage.files : [] }, tokensUsed: { input: 1, output: 1 } });
    const detail = AgentJobDetailSchema.parse(await get('job-2', true));
    expect(detail.state).toBe('succeeded');
    expect(JSON.stringify(detail.events)).toContain(SECRET_CONTENT);
    expect(detail.resultPatch!.files[0].content).toBe(SECRET_CONTENT);
  });
});
