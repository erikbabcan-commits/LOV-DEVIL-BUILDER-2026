// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { dbFromPool } from '../../../server/db/pool';
import { applyMigrations } from '../../../server/db/migrate';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import { PostgresAgentJobStore } from '../../../server/agent/jobs';
import { AGENT_JOBS_RATE_LIMIT_PER_MIN, createApp, makeMockProvider } from '../../../server/index';
import { signToken } from '../../../server/auth/tokens';
import { PostgresQuotaStore } from '../../../server/security/quotaStore';
import { InMemoryAiUsageStore } from '../../../server/usage/store';
import { jobClientConfig } from '../../../src/services/ai/streamRecovery';

/* Bora P3: the jobs rate limit must cover the client's polling interval. */
const secret = 'jobs-poll-rate-test-secret-0123456789012345';
const pools: Array<{ end(): Promise<void> }> = [];
afterEach(async () => { while (pools.length) await pools.pop()!.end(); });

describe('jobs polling vs rate limit (Bora P3)', () => {
  it('the default jobs budget is at least 1.5x the polls per minute', () => {
    expect(AGENT_JOBS_RATE_LIMIT_PER_MIN).toBeGreaterThanOrEqual(1.5 * (60_000 / jobClientConfig.pollIntervalMs));
  });

  it('a client polling for a full minute is never 429 with the default (10/min generic) config', async () => {
    const mem = newDb();
    registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)();
    pools.push(pool);
    const db = dbFromPool(pool);
    await applyMigrations(db);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ('alice', 'alice@example.test', 'x')`);
    const store = new PostgresAgentJobStore(db);
    await store.create({ id: 'job-1', ownerId: 'alice', idempotencyKey: 'key-job-1', request: { projectId: 'p', prompt: 'x', mode: 'create' } });
    const app = createApp({}, makeMockProvider(), {
      auth: { db, jwtSecret: secret, quota: new PostgresQuotaStore(db), usage: new InMemoryAiUsageStore() },
      jobs: store, agentJobs: { workerEnabled: true, startWorker: false },
    });
    const alice = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
    const polls = Math.ceil(60_000 / jobClientConfig.pollIntervalMs);
    for (let i = 0; i < polls; i++) {
      const res = await app.request(new Request('http://localhost/api/agent/jobs/job-1?detail=1', { headers: { Cookie: 'lov_token=' + alice } }));
      expect(res.status, 'poll ' + (i + 1)).toBe(200);
    }
  });
});
