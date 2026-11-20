// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbFromPool } from '../../../server/db/pool';
import { applyMigrations } from '../../../server/db/migrate';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import { PostgresAgentJobStore } from '../../../server/agent/jobs';
import { AgentWorker } from '../../../server/agent/worker';
import { makeMockProvider } from '../../../server/index';
import { ProviderRegistry } from '../../../server/providers/registry';
import { INTENT_VARIANT_VERSION } from '../../../server/agent/intent';
import type { AIProvider } from '../../../server/providers/types';

/* Task C item 1: the worker resolves intentPromptVersion exactly like POST /api/agent/generate
   (selectIntentPrompt with FORGE_INTENT_POLICY_FILE for mode 'auto'). */
const pools: Array<{ end(): Promise<void> }> = [];
afterEach(async () => { while (pools.length) await pools.pop()!.end(); });

describe('AgentWorker intent prompt version', () => {
  it('passes the policy-selected intentPromptVersion to runAgent (run_started + intent system prompt)', async () => {
    const mem = newDb(); registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)(); pools.push(pool);
    const db = dbFromPool(pool); await applyMigrations(db);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ('alice', 'alice@example.test', 'x')`);
    const dir = mkdtempSync(join(tmpdir(), 'intent-policy-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, experimentId: 'task-c', variantBasisPoints: 10_000 }));
    const base = makeMockProvider();
    const systems: string[] = [];
    const provider: AIProvider = { ...base, async complete(messages, opts) {
      systems.push(String(messages[0]?.content ?? ''));
      if (String(messages[0]?.content ?? '').includes('Forge Intent Router')) return { text: JSON.stringify({ intent: 'create' }), model: base.model, usage: { promptTokens: 1, completionTokens: 1 } };
      return base.complete(messages, opts);
    } };
    const store = new PostgresAgentJobStore(db);
    const worker = new AgentWorker({ store, providers: new ProviderRegistry([{ id: 'default', label: 't', provider }]), resilience: { sleep: async () => {} }, intentPolicyFile: file });
    await store.create({ id: 'job-1', ownerId: 'alice', idempotencyKey: 'k1', request: { projectId: 'p', prompt: 'Postav CRM', mode: 'auto' } });
    await worker.drain();
    const job = await store.get('alice', 'job-1');
    const started = job!.events.find(e => e.type === 'run_started');
    expect(started).toMatchObject({ type: 'run_started', intentPromptVersion: INTENT_VARIANT_VERSION });
    expect(systems.some(s => s.includes(INTENT_VARIANT_VERSION))).toBe(true);
  });
});
