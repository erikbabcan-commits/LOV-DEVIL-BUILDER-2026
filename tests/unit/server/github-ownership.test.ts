// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newDb } from 'pg-mem';
import { createApp } from '../../../server/index';
import { applyMigrations } from '../../../server/db/migrate';
import { InMemoryQuotaStore } from '../../../server/security/quotaStore';
import { signToken } from '../../../server/auth/tokens';

const secret = 'github-ownership-test-secret-01234567890123456789';
function cookie(response: Response) {
  const value = response.headers.get('set-cookie');
  if (!value) throw new Error('Expected OAuth cookie');
  return value.split(';')[0];
}

describe('GitHub connector account isolation', () => {
  let app: ReturnType<typeof createApp>;
  let alice: string;
  let bob: string;
  beforeEach(async () => {
    for (const [key, value] of Object.entries({
      GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-secret',
      GITHUB_CALLBACK_URL: 'http://localhost:8787/api/github/auth/callback',
      GITHUB_ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:8787',
      LOV_APP_URL: 'http://localhost:5173/', GITHUB_OAUTH_SCOPE: 'public_repo'
    })) vi.stubEnv(key, value);
    const pool = new (newDb().adapters.createPg().Pool)();
    const db = { query: async (sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount };
    } };
    await applyMigrations(db);
    for (const id of ['alice', 'bob']) await db.query(
      'INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)',
      [id, id + '@example.com', 'unused-test-hash']
    );
    app = createApp({}, null, { rateLimit: () => true, auth: { db, jwtSecret: secret, quota: new InMemoryQuotaStore() } });
    alice = await signToken({ sub: 'alice', email: 'alice@example.com', plan: 'free' }, secret);
    bob = await signToken({ sub: 'bob', email: 'bob@example.com', plan: 'free' }, secret);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  const headers = (token: string, github = '') => ({ Cookie: `lov_token=${token}; ${github}` });
  async function start(token = alice, instance = app) {
    const response = await instance.request('/api/github/auth/start', { headers: headers(token) });
    return { pending: cookie(response), state: new URL(response.headers.get('location')!).searchParams.get('state')! };
  }
  function mockExchange(scope: string | undefined = 'public_repo') {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'fixture-server-only-token', scope }))
      .mockResolvedValueOnce(Response.json({ id: 42, login: 'fixture-github-user' }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  async function connect(scope?: string) {
    const flow = await start();
    const fetchMock = mockExchange(scope);
    const response = await app.request(`/api/github/auth/callback?code=fixture-code&state=${flow.state}`, { headers: headers(alice, flow.pending) });
    const github = cookie(response);
    const auth = await app.request('/api/github/auth', { headers: headers(alice, github) });
    return { github, fetchMock, auth: await auth.json() };
  }
  const body = (isPrivate: boolean) => JSON.stringify({ repoName: 'fixture-export', isPrivate, confirmed: true, files: [{ path: 'README.md', content: '# Safe' }] });

  it('hides another account’s metadata and rejects its export and disconnect without GitHub I/O', async () => {
    const flow = await connect();
    expect(flow.auth).toMatchObject({ authenticated: true, username: 'fixture-github-user' });
    const foreign = await app.request('/api/github/auth', { headers: headers(bob, flow.github) });
    expect(foreign.headers.get('Cache-Control')).toBe('no-store');
    expect(await foreign.json()).toMatchObject({ authenticated: false });
    for (const path of ['/api/github/export', '/api/github/auth/revoke']) {
      expect((await app.request(path, { method: 'POST', headers: {
        ...headers(bob, flow.github), Origin: 'http://localhost:5173',
        'Content-Type': 'application/json', 'X-CSRF-Token': flow.auth.csrfToken
      }, body: body(false) })).status).toBe(401);
    }
    expect(flow.fetchMock).toHaveBeenCalledTimes(2);
    const own = await app.request('/api/github/auth', { headers: headers(alice, flow.github) });
    expect(await own.json()).toMatchObject({ authenticated: true });
  });

  it('rejects an OAuth callback after switching accounts without consuming the owner’s state', async () => {
    const flow = await start();
    const fetchMock = mockExchange();
    const url = `/api/github/auth/callback?code=fixture-code&state=${flow.state}`;
    const foreign = await app.request(url, { headers: headers(bob, flow.pending) });
    expect(foreign.headers.get('location')).toContain('github=error');
    expect(fetchMock).not.toHaveBeenCalled();
    const own = await app.request(url, { headers: headers(alice, flow.pending) });
    expect(own.headers.get('location')).toContain('github=connected');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never promotes an anonymous pilot connection into a signed-in account', async () => {
    vi.stubEnv('AUTH_ENABLED', '0');
    const pilot = createApp({}, null);
    const flow = await start('', pilot);
    const fetchMock = mockExchange();
    const callback = await pilot.request(`/api/github/auth/callback?code=fixture-code&state=${flow.state}`, { headers: { Cookie: flow.pending } });
    const github = cookie(callback);
    const auth = await app.request('/api/github/auth', { headers: headers(alice, github) });
    expect(await auth.json()).toMatchObject({ authenticated: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('applies the public-only configuration ceiling even to a previously broader grant', async () => {
    const flow = await connect('repo');
    expect(flow.auth.scopes).toEqual(['public_repo']);
    const response = await app.request('/api/github/export', { method: 'POST', headers: {
      ...headers(alice, flow.github), Origin: 'http://localhost:5173',
      'Content-Type': 'application/json', 'X-CSRF-Token': flow.auth.csrfToken
    }, body: body(true) });
    expect(response.status).toBe(403);
    expect(flow.fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['', 'read:user'])('does not infer a repository grant from the requested scope: %j', async scope => {
    const flow = await connect(scope);
    expect(flow.auth.scopes).toEqual([]);
    const response = await app.request('/api/github/export', { method: 'POST', headers: {
      ...headers(alice, flow.github), Origin: 'http://localhost:5173',
      'Content-Type': 'application/json', 'X-CSRF-Token': flow.auth.csrfToken
    }, body: body(false) });
    expect(response.status).toBe(403);
    expect(flow.fetchMock).toHaveBeenCalledTimes(2);
  });
});
