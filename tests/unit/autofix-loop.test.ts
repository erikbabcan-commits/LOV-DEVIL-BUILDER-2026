// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autofixLoop, isSecurityBlock, MAX_ATTEMPTS } from '../../server/agent/autofix';
import { createApp } from '../../server/index';
import { signToken } from '../../server/auth/tokens';
import { InMemoryQuotaStore } from '../../server/security/quotaStore';
import { InMemoryAiUsageStore } from '../../server/usage/store';
import { ProviderRegistry } from '../../server/providers/registry';
import { ProviderError } from '../../server/providers/errors';
import { HostExecutor, type SandboxExecutor } from '../../server/sandbox/executor';
import type { AIProvider } from '../../server/providers/types';

/* Agent 9: 3-pokusová slučka, kvóta za každý platený pokus (Bora W3 P3-3), bezpečný návrat, guard nálezy bez AI, smart router. */
const goodBuild = { ok: true, html: '<main>Built</main>', errors: [], durationMs: 1, moduleCount: 1 };
const badBuild = { ...goodBuild, ok: false, html: null, errors: [{ file: 'src/main.tsx', message: 'Syntax error' }] };
const guardBuild = { ...badBuild, errors: [{ file: 'src/main.tsx', message: '[sandbox_policy_blocked:eval] 1:1 eval je zakázaný' }] };
const files = [{ path: 'src/main.tsx', content: 'export {};' }];
const sandbox = (execute: SandboxExecutor['execute']): SandboxExecutor => ({ execute, ready: async () => ({ ready: true, mode: 'host' }) });
/** Fake provider: každý pokus vráti platný minimálny patch (pridá komentár). */
function patching(name = 'fake', inject = '\n// fix'): AIProvider & { complete: ReturnType<typeof vi.fn> } {
  return {
    name, model: name,
    complete: vi.fn(async (messages: Array<{ content: string }>) => {
      const file = JSON.parse(messages[1].content).files[0];
      return { text: JSON.stringify({ version: 1, summary: 'Fix', changes: [{ path: file.path, action: 'modify', beforeSha256: file.sha256, edits: [{ search: file.content, replace: file.content + inject }] }] }), usage: { promptTokens: 2, completionTokens: 3 } };
    }),
    async *stream() { yield { delta: '' }; },
  } as never;
}
const buildsFailing = (n: number) => { const execute = vi.fn<SandboxExecutor['execute']>(); for (let i = 0; i < n; i++) execute.mockResolvedValueOnce(badBuild); execute.mockResolvedValue(goodBuild); return execute; };

describe('autofix loop – 3 pokusy (Agent 9)', () => {
  it('exportuje MAX_ATTEMPTS = 3', () => { expect(MAX_ATTEMPTS).toBe(3); });

  it.each([1, 2, 3])('opraví build na %i. pokus a complete volá presne toľkokrát', async n => {
    const provider = patching(), execute = buildsFailing(n);
    const result = await autofixLoop(provider, files, { executor: sandbox(execute) });
    expect(result).toMatchObject({ ok: true, attempts: n, patchesApplied: n });
    expect(provider.complete).toHaveBeenCalledTimes(n);
    expect(result.progress.filter(step => step.step === 'rebuild').map(step => step.status)).toEqual([...Array(n - 1).fill('failed'), 'ok']);
    expect(result.finalFiles[0].content).toContain('// fix');
  });

  it('po 3 neúspechoch vráti ok:false, attempts:3, complete 3× a pôvodné zdroje (bezpečný návrat)', async () => {
    const provider = patching(), execute = vi.fn<SandboxExecutor['execute']>().mockResolvedValue(badBuild);
    const result = await autofixLoop(provider, files, { executor: sandbox(execute) });
    expect(result).toMatchObject({ ok: false, attempts: 3, patchesApplied: 3 });
    expect(provider.complete).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(4); // počiatočný build + 3 rebuildy
    expect(result.finalFiles).toEqual(files);
    expect(result.progress).toHaveLength(9);
    expect(result.progress.at(-1)).toEqual({ attempt: 3, step: 'rebuild', status: 'failed' });
  });

  it('beforeAi (odpočet kvóty) sa volá pred každým pokusom, ale route ho môže spotrebovať len raz', async () => {
    const provider = patching(), beforeAi = vi.fn(async () => {});
    await autofixLoop(provider, files, { executor: sandbox(vi.fn<SandboxExecutor['execute']>().mockResolvedValue(badBuild)), beforeAi });
    expect(provider.complete).toHaveBeenCalledTimes(3);
    expect(beforeAi).toHaveBeenCalledTimes(3); // route drží `!autoQuota`, test HTTP nižšie overí 1 jednotku
  });
});

describe('bezpečnostné nálezy AST guardu sa nikdy neposielajú AI', () => {
  it('nález guardu z executora: žiadny AI pokus, blocked=security, pôvodné zdroje', async () => {
    const provider = patching(), beforeAi = vi.fn(async () => {});
    const result = await autofixLoop(provider, files, { executor: sandbox(vi.fn<SandboxExecutor['execute']>().mockResolvedValue(guardBuild)), beforeAi });
    expect(isSecurityBlock(guardBuild.errors)).toBe(true);
    expect(result).toMatchObject({ ok: false, attempts: 0, blocked: 'security', patchesApplied: 0 });
    expect(provider.complete).not.toHaveBeenCalled();
    expect(beforeAi).not.toHaveBeenCalled();
    expect(result.finalFiles).toEqual(files);
  });

  it.each([['eval', 'eval("1")'], ['process.env', 'export const k = process.env.HOME;']])('reálny HostExecutor: %s neopravuje AI', async (_rule, content) => {
    const provider = patching();
    const result = await autofixLoop(provider, [{ path: 'package.json', content: JSON.stringify({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }) }, { path: 'src/main.tsx', content }], { executor: new HostExecutor() });
    expect(result.blocked).toBe('security');
    expect(result.buildErrors[0].message).toContain('[sandbox_policy_blocked:');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('AI patch, ktorý zavedie guard nález, sa zahodí a slučka skončí bez ďalšieho pokusu', async () => {
    const provider = patching('fake', '\neval("x")');
    const execute = vi.fn<SandboxExecutor['execute']>().mockResolvedValueOnce(badBuild).mockResolvedValue(guardBuild);
    const result = await autofixLoop(provider, files, { executor: sandbox(execute) });
    expect(result).toMatchObject({ ok: false, attempts: 1, blocked: 'security' });
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(result.finalFiles).toEqual(files);
    expect(result).not.toHaveProperty('summary');
  });
});

const secret = 'agent9-autofix-test-secret-0123456789012345678';
const db = { query: async (sql: string, params?: unknown[]) => sql === 'SELECT id, email, plan, plan_expires_at FROM users WHERE id=$1' && params?.[0] === 'alice'
  ? { rows: [{ id: 'alice', email: 'alice@example.test', plan: 'free', plan_expires_at: null }], rowCount: 1 } : { rows: [], rowCount: 0 } };
const post = async (app: ReturnType<typeof createApp>, body: unknown, token?: string) => app.request(new Request('http://localhost/api/sandbox/autofix', { method: 'POST',
  headers: { ...(token ? { Cookie: 'lov_token=' + token + '; lov_csrf=test', 'X-CSRF-Token': 'test' } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

describe('HTTP /api/sandbox/autofix: kvóta a meranie', () => {
  let token: string, quota: InMemoryQuotaStore, usage: InMemoryAiUsageStore;
  beforeEach(async () => { token = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret); quota = new InMemoryQuotaStore(); usage = new InMemoryAiUsageStore(); });
  const auth = () => ({ db, jwtSecret: secret, quota, usage });

  it('3 AI pokusy v jednom volaní = 3 jednotky kvóty a všetky 3 volania merané v jednom behu (Bora W3 P3-3)', async () => {
    const provider = patching();
    const app = createApp({}, provider, { auth: auth(), rateLimit: () => true, sandbox: sandbox(buildsFailing(3)) });
    const response = await post(app, { files }, token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, attempts: 3, quotaCharged: 3, quotaUpdate: { userId: 'alice', quota: { used: 3 } } });
    expect(provider.complete).toHaveBeenCalledTimes(3);
    expect(await quota.usage('alice')).toMatchObject({ used: 3 });
    expect(await usage.report('alice')).toMatchObject({ calls: 3, reportedCalls: 3, pendingCalls: 0 }); // 1 beh, 3 merané volania
  });

  it('3 neúspešné pokusy odpočítajú 3 jednotky, žiadny pokus nie je zadarmo', async () => {
    const provider = patching();
    const app = createApp({}, provider, { auth: auth(), rateLimit: () => true, sandbox: sandbox(vi.fn<SandboxExecutor['execute']>().mockResolvedValue(badBuild)) });
    const body = await (await post(app, { files }, token)).json();
    expect(body).toMatchObject({ ok: false, attempts: 3 });
    expect(provider.complete).toHaveBeenCalledTimes(3);
    expect(await quota.usage('alice')).toMatchObject({ used: 3 });
  });

  it('kvóta sa minie uprostred slučky: stop, quota_exceeded s čiastočným výsledkom, AI volaní = jednotiek', async () => {
    const limit = (await quota.usage('alice')).limit;
    for (let i = 0; i < limit - 2; i++) await quota.consume('alice'); // ostávajú 2 jednotky
    const provider = patching();
    const app = createApp({}, provider, { auth: auth(), rateLimit: () => true, sandbox: sandbox(vi.fn<SandboxExecutor['execute']>().mockResolvedValue(badBuild)) });
    const response = await post(app, { files }, token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, attempts: 2, stopped: 'quota_exceeded', quotaCharged: 2, quotaUpdate: { quota: { used: limit, remaining: 0 } } });
    expect(body.progress.every((step: { attempt: number }) => step.attempt <= 2)).toBe(true);
    expect(body.finalFiles).toEqual(files); // posledný funkčný stav, neoverený kandidát sa zahodil
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(await quota.usage('alice')).toMatchObject({ used: limit });
  });

  it('vyčerpaná kvóta pred prvým pokusom: 429 quota_exceeded a 0 AI volaní (Bora probe Q1)', async () => {
    while ((await quota.consume('alice')).ok) { /* vyčerpaj */ }
    const provider = patching();
    const app = createApp({}, provider, { auth: auth(), rateLimit: () => true, sandbox: sandbox(vi.fn<SandboxExecutor['execute']>().mockResolvedValue(badBuild)) });
    const response = await post(app, { files }, token);
    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe('quota_exceeded');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('6 súbežných volaní (Bora probe A3): AI volaní ≤ odpočítaných jednotiek a nikdy nad limit', async () => {
    const limit = (await quota.usage('alice')).limit;
    for (let i = 0; i < limit - 7; i++) await quota.consume('alice'); // ostáva 7 jednotiek na 6×3 = 18 želaných pokusov
    const provider = patching();
    const app = createApp({}, provider, { auth: auth(), rateLimit: () => true, sandbox: sandbox(vi.fn<SandboxExecutor['execute']>().mockResolvedValue(badBuild)) });
    const before = (await quota.usage('alice')).used;
    const responses = await Promise.all(Array.from({ length: 6 }, () => post(app, { files }, token)));
    const bodies = await Promise.all(responses.map(r => r.json()));
    const charged = (await quota.usage('alice')).used - before;
    expect(provider.complete.mock.calls.length).toBeLessThanOrEqual(charged);
    expect(charged).toBeLessThanOrEqual(7);
    expect((await quota.usage('alice')).used).toBeLessThanOrEqual(limit);
    for (const [i, r] of responses.entries()) expect(r.status === 200 || (r.status === 429 && bodies[i].error === 'quota_exceeded')).toBe(true);
    const paidAttempts = bodies.filter((_, i) => responses[i].status === 200).reduce((sum: number, b: { attempts: number }) => sum + b.attempts, 0);
    expect(paidAttempts).toBe(provider.complete.mock.calls.length);
  });

  it('bezpečnostný nález cez HTTP nič neodpočíta a AI nevolá', async () => {
    const provider = patching();
    const app = createApp({}, provider, { auth: auth(), rateLimit: () => true, sandbox: sandbox(vi.fn<SandboxExecutor['execute']>().mockResolvedValue(guardBuild)) });
    expect(await (await post(app, { files }, token)).json()).toMatchObject({ ok: false, attempts: 0, blocked: 'security' });
    expect(provider.complete).not.toHaveBeenCalled();
    expect(await quota.usage('alice')).toMatchObject({ used: 0 });
  });
});

describe('HTTP /api/sandbox/autofix: smart router (fake registry, žiadne live volanie)', () => {
  const registry = () => {
    const small = patching('fake-small'), codestral = patching('fake-codestral'), large = patching('fake-large');
    // AI_FALLBACK_MODELS = codestral: kept as the fallback after the router pick (Bora W3 P3-1).
    return { small, codestral, large, providers: new ProviderRegistry([{ id: 'codestral', label: 'C', provider: codestral }, { id: 'mistral-small', label: 'S', provider: small }, { id: 'mistral-large', label: 'L', provider: large }], ['codestral']) };
  };
  const app = (providers: ProviderRegistry, execute = buildsFailing(1), smartRouter = true) => createApp({}, null, { providers, rateLimit: () => true, resilience: { sleep: async () => {}, random: () => 0 }, sandbox: sandbox(execute), smartRouter });

  it('AI_SMART_ROUTER vypnutý (default): bez modelId ide na nakonfigurovaný default, router sa nepoužije', async () => {
    const r = registry(), many = Array.from({ length: 12 }, (_, i) => ({ path: i ? `src/m${i}.ts` : 'src/main.tsx', content: 'export {};' }));
    const body = await (await post(app(r.providers, buildsFailing(1), false), { files: many })).json();
    expect(body).toMatchObject({ ok: true, route: { model: 'codestral', reason: 'configured_default' } });
    expect(r.codestral.complete).toHaveBeenCalledOnce();
    expect(r.small.complete).not.toHaveBeenCalled();
    expect(r.large.complete).not.toHaveBeenCalled();
  });

  it('bez modelId: krátka oprava s ≤3 súbormi ide na mistral-small (mode fix)', async () => {
    const r = registry();
    const body = await (await post(app(r.providers), { files })).json();
    expect(body).toMatchObject({ ok: true, route: { model: 'mistral-small', reason: 'short_fix_or_explain' } });
    expect(r.small.complete).toHaveBeenCalledOnce();
    expect(r.codestral.complete).not.toHaveBeenCalled();
  });

  it('bez modelId: 12+ súborov by išlo na mistral-large, ale bez pro plánu sa zníži na codestral (Bora W3 P3-2)', async () => {
    const r = registry(), many = Array.from({ length: 12 }, (_, i) => ({ path: i ? `src/m${i}.ts` : 'src/main.tsx', content: 'export {};' }));
    const body = await (await post(app(r.providers), { files: many })).json();
    expect(body.route).toEqual({ model: 'codestral', reason: 'plan_tier_clamp' });
    expect(r.codestral.complete).toHaveBeenCalledOnce();
    expect(r.large.complete).not.toHaveBeenCalled();
  });

  it('s explicitným modelId platí presne zvolený model bez routera', async () => {
    const r = registry();
    const body = await (await post(app(r.providers), { files, modelId: 'mistral-large' })).json();
    expect(body.route).toEqual({ model: 'mistral-large', reason: 'explicit_user_choice' });
    expect(r.large.complete).toHaveBeenCalledOnce();
    expect(r.small.complete).not.toHaveBeenCalled();
  });

  it('pri 503 routerom zvoleného modelu kaskáduje a zaznamená fallback', async () => {
    const r = registry();
    r.small.complete.mockRejectedValue(new ProviderError('unavailable'));
    const body = await (await post(app(r.providers), { files })).json();
    expect(body).toMatchObject({ ok: true, route: { model: 'mistral-small', fallbacks: [{ to: 'codestral' }] } });
    expect(r.codestral.complete).toHaveBeenCalled();
  });

  it('explicitný model sa pri 503 nekaskáduje', async () => {
    const r = registry();
    r.large.complete.mockRejectedValue(new ProviderError('unavailable'));
    const body = await (await post(app(r.providers), { files, modelId: 'mistral-large' })).json();
    expect(body.ok).toBe(false);
    expect(body.route).toEqual({ model: 'mistral-large', reason: 'explicit_user_choice' });
    expect(r.codestral.complete).not.toHaveBeenCalled();
    expect(r.small.complete).not.toHaveBeenCalled();
  });
});
