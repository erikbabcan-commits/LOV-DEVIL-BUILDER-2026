// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { githubConnectRouter, readGitHubBridgeEnv } from '../../../server/routes/githubConnect';
import { signToken } from '../../../server/auth/tokens';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789';
const BRIDGE_SECRET = 'a'.repeat(64);
const CALLBACK = 'https://ui.example.com/github/callback';
const BASE = 'https://hono.example.com';

function bridgeEnv() {
  return {
    HONO_BASE_URL: BASE,
    GITHUB_CLOUD_CALLBACK_URL: CALLBACK,
    GITHUB_CLOUD_CLIENT_ID: 'client-id',
    GITHUB_BRIDGE_SECRET: BRIDGE_SECRET,
  };
}

function makeApp(opts: Parameters<typeof githubConnectRouter>[0]) {
  const app = new Hono();
  app.route('/', githubConnectRouter(opts));
  return app;
}

describe('readGitHubBridgeEnv', () => {
  it('returns undefined when any required var is missing', () => {
    expect(readGitHubBridgeEnv({})).toBeUndefined();
    expect(readGitHubBridgeEnv({ HONO_BASE_URL: BASE })).toBeUndefined();
    expect(readGitHubBridgeEnv({ ...bridgeEnv(), HONO_BASIC_AUTH: 'u:p' })?.basicAuth).toBe('u:p');
    expect(readGitHubBridgeEnv(bridgeEnv())?.bridgeSecret).toBe(BRIDGE_SECRET);
  });
});

describe('githubConnectRouter fallback (bez bridge env)', () => {
  const app = makeApp({ jwtSecret: JWT_SECRET, env: {} });

  it('GET status vracia 200 JSON {connected:false, configured:false} — nikdy 503', async () => {
    const res = await app.request('/api/github-connect/status');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    await expect(res.json()).resolves.toEqual({ connected: false, configured: false });
  });

  it('POST start vracia JSON 404, nie 503 ani HTML', async () => {
    const res = await app.request('/api/github-connect/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toEqual({ error: 'github_route_unavailable' });
  });

  it('neznáma akcia pod /api/github-connect/* je JSON 404', async () => {
    const res = await app.request('/api/github-connect/export/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
  });
});

describe('githubConnectRouter bridge (s env konfiguráciou)', () => {
  const upstream = vi.fn<typeof fetch>(async () => Response.json({ connected: true, username: 'octo', githubId: 7, scopes: ['public_repo'] }));
  const app = makeApp({
    jwtSecret: JWT_SECRET,
    env: bridgeEnv(),
    fetch: upstream as unknown as typeof fetch,
  });

  it('bez identity vracia 401 cloud_identity_required (nie 503)', async () => {
    const res = await app.request('/api/github-connect/status');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'cloud_identity_required' });
  });

  it('platný Bearer JWT prebehne až na bridge a vráti status', async () => {
    const token = await signToken({ sub: 'u1', email: 'a@b.c', plan: 'free' }, JWT_SECRET);
    const res = await app.request('/api/github-connect/status', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ connected: true, username: 'octo' });
    expect(upstream).toHaveBeenCalledOnce();
    const calledUrl = String((upstream.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toBe(`${BASE}/api/cloud-github/status`);
    const calledHeaders = (upstream.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((calledHeaders.headers as Record<string, string>)['X-LOV-GitHub-Bridge']).toBe(BRIDGE_SECRET);
  });

  it('platný lov_token cookie sa interne premapuje na Bearer (klient JWT nepozná)', async () => {
    const token = await signToken({ sub: 'u2', email: 'd@e.f', plan: 'pro' }, JWT_SECRET);
    const res = await app.request('/api/github-connect/status', {
      headers: { Cookie: `lov_token=${token}` },
    });
    expect(res.status).toBe(200);
    const calledHeaders = (upstream.mock.calls.at(-1) as unknown[])[1] as RequestInit;
    expect((calledHeaders.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${token}`);
  });

  it('neplatný token → 401', async () => {
    const res = await app.request('/api/github-connect/status', {
      headers: { Authorization: 'Bearer not-a-jwt' },
    });
    expect(res.status).toBe(401);
  });

  it('POST bez správneho Origin header → 403 origin_not_allowed', async () => {
    const token = await signToken({ sub: 'u3', email: 'g@h.i', plan: 'free' }, JWT_SECRET);
    const res = await app.request('/api/github-connect/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'origin_not_allowed' });
  });

  it('neplatná bridge konfigurácia (http base) → tichý fallback, žiadny 503', async () => {
    const bad = makeApp({
      jwtSecret: JWT_SECRET,
      env: { ...bridgeEnv(), HONO_BASE_URL: 'http://insecure.example.com' },
      fetch: upstream as unknown as typeof fetch,
    });
    const res = await bad.request('/api/github-connect/status');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ connected: false, configured: false });
  });
});
