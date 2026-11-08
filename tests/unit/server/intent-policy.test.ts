// @vitest-environment node
import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTENT_PROMPT_VERSION, INTENT_VARIANT_VERSION, intentSystem, type IntentPromptVersion } from '../../../server/agent/intent';
import { readIntentPolicyPath, selectIntentPrompt } from '../../../server/agent/intentPolicy';
import { signToken } from '../../../server/auth/tokens';
import { createApp, makeMockProvider } from '../../../server/index';
import { InMemoryQuotaStore } from '../../../server/security/quotaStore';
import { InMemoryAiUsageStore } from '../../../server/usage/store';

describe('intent prompt rollout', () => {
  let directory: string;
  let file: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'forge-intent-policy-'));
    file = join(directory, 'policy.json');
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  async function replacePolicy(variantBasisPoints: number) {
    const next = join(directory, 'next.json');
    await writeFile(next, JSON.stringify({
      schemaVersion: 1, experimentId: 'intent-router-v2', variantBasisPoints,
    }));
    await rename(next, file);
  }

  it('uses stable, nested account cohorts as the rollout percentage grows', async () => {
    const accounts = Array.from({ length: 128 }, (_, i) => `user-${i}`);
    const snapshot = () => Promise.all(accounts.map((account) => selectIntentPrompt(file, account)));
    await replacePolicy(2500);
    const narrow = await snapshot();
    expect(await snapshot()).toEqual(narrow);
    expect(new Set(narrow)).toEqual(new Set([INTENT_PROMPT_VERSION, INTENT_VARIANT_VERSION]));
    await replacePolicy(7500);
    const wide = await snapshot();
    expect(wide.filter(v => v === INTENT_VARIANT_VERSION).length)
      .toBeGreaterThan(narrow.filter(v => v === INTENT_VARIANT_VERSION).length);
    expect(narrow.every((v, i) => v !== INTENT_VARIANT_VERSION || wide[i] === v)).toBe(true);
  });

  it('defaults to control for missing, invalid, oversized and symlink policies', async () => {
    expect(readIntentPolicyPath({})).toBeUndefined();
    expect(readIntentPolicyPath({ FORGE_INTENT_POLICY_FILE: file })).toBe(file);
    expect(() => readIntentPolicyPath({ FORGE_INTENT_POLICY_FILE: 'relative.json' })).toThrow();
    const select = () => selectIntentPrompt(file, 'alice');
    expect(await select()).toBe(INTENT_PROMPT_VERSION);
    for (const text of ['{', ' '.repeat(2049), '{"schemaVersion":1,"experimentId":"a","variantBasisPoints":10001}']) {
      await writeFile(file, text);
      expect(await select()).toBe(INTENT_PROMPT_VERSION);
    }
    await replacePolicy(10000);
    const link = join(directory, 'link.json');
    await symlink(file, link);
    expect(await selectIntentPrompt(link, 'alice')).toBe(INTENT_PROMPT_VERSION);
    expect(await selectIntentPrompt(directory, 'alice')).toBe(INTENT_PROMPT_VERSION);
  });

  it('changes prompt and rolls back on the same authenticated Hono app without extra calls', async () => {
    const secret = 'fixture-jwt-secret-012345678901234567890123';
    const token = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
    const user = { id: 'alice', email: 'alice@example.test', plan: 'free', plan_expires_at: null };
    const db = { query: async () => ({ rows: [user], rowCount: 1 }) };
    const provider = makeMockProvider();
    const complete = vi.spyOn(provider, 'complete').mockResolvedValue({
      text: '{"intent":"explain"}', usage: { promptTokens: 2, completionTokens: 1 },
    });
    const app = createApp({ intentPolicyFile: file }, provider, {
      rateLimit: () => true,
      auth: { db, jwtSecret: secret, quota: new InMemoryQuotaStore(), usage: new InMemoryAiUsageStore() },
    });
    const request = (mode: 'auto' | 'explain', authenticated = true) => app.request('/api/agent/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { Cookie: `lov_token=${token}; lov_csrf=fixture`, 'X-CSRF-Token': 'fixture' } : {}),
      },
      body: JSON.stringify({ projectId: 'sample', prompt: 'Explain the result', mode, intentPromptVersion: INTENT_VARIANT_VERSION }),
    });
    const check = async (version: IntentPromptVersion) => {
      const response = await request('auto');
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`"intentPromptVersion":"${version}"`);
      expect(complete.mock.lastCall?.[0]).toEqual([
        { role: 'system', content: intentSystem(version) },
        { role: 'user', content: '{"prompt":"Explain the result","hasProject":false}' },
      ]);
    };
    await replacePolicy(0);
    await check(INTENT_PROMPT_VERSION);
    await replacePolicy(10000);
    await check(INTENT_VARIANT_VERSION);
    expect((await request('auto', false)).status).toBe(401);
    expect(await (await request('explain')).text()).not.toContain('intentPromptVersion');
    await replacePolicy(0);
    await check(INTENT_PROMPT_VERSION);
    expect(complete).toHaveBeenCalledTimes(3);
  });
});
