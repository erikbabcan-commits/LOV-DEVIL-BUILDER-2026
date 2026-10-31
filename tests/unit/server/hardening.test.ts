// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { LocalBudgetGuard } from '../../../server/security/budget';
import { containsPotentialSecret, redactSecrets } from '../../../server/security/secrets';
import { createApp, makeMockProvider } from '../../../server/index';

const payload = { projectId: 'test', prompt: 'Build a CRM', mode: 'create' };

describe('P0 local cost and security guards', () => {
  it.each(['http://localhost:5173', 'http://127.0.0.1:5173'])('allows the exact local UI origin %s', async origin => {
    const app = createApp({}, makeMockProvider());
    const res = await app.request('/api/agent/generate', {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it.each([
    'http://localhost.attacker.invalid', 'http://127.0.0.1.attacker.invalid',
    'http://localhost:5173@attacker.invalid', 'http://localhost:5174',
    'https://attacker.invalid', 'null', '',
  ])('rejects untrusted Origin %s before any paid work', async origin => {
    const provider = makeMockProvider();
    const complete = vi.spyOn(provider, 'complete');
    const budget = new LocalBudgetGuard({ maxConcurrent: 1, maxRunsPerDay: 1 });
    const app = createApp({}, provider, { budget });
    for (const path of ['/api/agent/generate', '/api/sandbox/build', '/api/sandbox/autofix']) {
      const res = await app.request(path, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('origin_not_allowed');
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    expect(complete).not.toHaveBeenCalled();
    expect(budget.getStats()).toEqual({ active: 0, admittedToday: 0 });
  });

  it('does not reflect an untrusted origin in preflight responses', async () => {
    const app = createApp({}, null);
    const res = await app.request('/api/agent/generate', {
      method: 'OPTIONS', headers: { Origin: 'http://localhost.attacker.invalid', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('retains origin-free health access for the loopback CLI pilot', async () => {
    const app = createApp({}, null);
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ai: 'not-configured' });
  });

  it('blocks over-concurrent and over-daily admissions, with idempotent release', () => {
    const guard = new LocalBudgetGuard({ maxConcurrent: 1, maxRunsPerDay: 2 });
    const first = guard.acquire();
    expect(first.ok).toBe(true);
    expect(guard.acquire()).toEqual({ ok: false, reason: 'concurrency' });
    if (first.ok) { first.release(); first.release(); }
    expect(guard.getStats()).toEqual({ active: 0, admittedToday: 1 });
    const second = guard.acquire();
    expect(second.ok).toBe(true);
    if (second.ok) second.release();
    expect(guard.acquire()).toEqual({ ok: false, reason: 'daily_budget' });
  });

  it('redacts known credential classes without echoing canary data', () => {
    const canary = 'mstrl_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    expect(containsPotentialSecret(`token=${canary}`)).toBe(true);
    expect(redactSecrets(`upstream failed: ${canary}`)).toBe('upstream failed: [REDACTED]');
    expect(containsPotentialSecret('normal React source code')).toBe(false);
  });

  it('public deployment refuses AI and sandbox operations without production auth', async () => {
    const app = createApp({ publicDeployment: true }, makeMockProvider());
    const generate = await app.request('/api/agent/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    expect(generate.status).toBe(503);
    expect((await generate.json()).error).toBe('ai_disabled');
    const build = await app.request('/api/sandbox/build', { method: 'POST', body: JSON.stringify({ files: [] }) });
    expect(build.status).toBe(503);
  });

  it('AI kill switch blocks a request before provider invocation', async () => {
    const app = createApp({ aiGenerationEnabled: false }, makeMockProvider());
    const res = await app.request('/api/agent/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    expect(res.status).toBe(503);
  });

  it('AI request containing a canary secret is blocked before inference', async () => {
    const app = createApp({}, makeMockProvider());
    const res = await app.request('/api/agent/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, prompt: 'Use mstrl_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' }),
    });
    const output = await res.text();
    expect(output).toContain('secret_in_context');
    expect(output).not.toContain('mstrl_ABC');
  });

  it('autofix HTTP responses redact provider exception secrets', async () => {
    const canary = 'mstrl_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const provider = makeMockProvider();
    vi.spyOn(provider, 'complete').mockRejectedValue(new Error('upstream unavailable: ' + canary));
    const app = createApp({}, provider);
    const res = await app.request('/api/sandbox/autofix', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: 'src/main.tsx', content: 'export const invalid = ;' }] }),
    });
    expect(res.status).toBe(200); // Existing contract: a failed repair is an AutofixResult.
    const text = await res.text();
    expect(JSON.parse(text).ok).toBe(false);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(canary);
    expect(text).toContain('upstream unavailable');
  });

  it('autofix rejects secret-bearing file paths before admission or provider use', async () => {
    const provider = makeMockProvider();
    const complete = vi.spyOn(provider, 'complete');
    const budget = new LocalBudgetGuard({ maxConcurrent: 1, maxRunsPerDay: 1 });
    const app = createApp({}, provider, { budget });
    const res = await app.request('/api/sandbox/autofix', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: 'src/mstrl_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456.ts', content: 'export {};' }] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'secret_in_context' });
    expect(complete).not.toHaveBeenCalled();
    expect(budget.getStats()).toEqual({ active: 0, admittedToday: 0 });
  });

  it('daily budget blocks the next AI request after one admitted run', async () => {
    const app = createApp({ maxRunsPerDay: 1 }, makeMockProvider());
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
    const first = await app.request('/api/agent/generate', options);
    expect(first.status).toBe(200);
    await first.text();
    const second = await app.request('/api/agent/generate', options);
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe('BUDGET_EXCEEDED');
  });
});
