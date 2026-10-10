import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../server/index';

const envKeys = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_CALLBACK_URL', 'LOV_APP_URL', 'GITHUB_OAUTH_SCOPE'] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(createApp({}, null).request(`http://localhost${path}`, init));
}

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie');
  if (!value) throw new Error('Expected Set-Cookie header');
  return value.split(';', 1)[0];
}

function blobSha(content: string): string {
  const bytes = Buffer.from(content);
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function authenticate() {
  const start = await request('/api/github/auth/start');
  const pendingCookie = cookieFrom(start);
  const authorization = new URL(start.headers.get('location') || '');
  const state = authorization.searchParams.get('state');
  if (!state) throw new Error('Missing OAuth state');

  const fetchMock = vi.fn()
    .mockResolvedValueOnce(json({ access_token: 'server-only-token', token_type: 'bearer', scope: 'repo' }))
    .mockResolvedValueOnce(json({ id: 42, login: 'octocat', avatar_url: 'https://avatars.example/octocat' }));
  vi.stubGlobal('fetch', fetchMock);

  const callback = await request(`/api/github/auth/callback?code=one-time-code&state=${encodeURIComponent(state)}`, {
    headers: { Cookie: pendingCookie },
  });
  const sessionCookie = cookieFrom(callback);
  const auth = await request('/api/github/auth', { headers: { Cookie: sessionCookie } });
  const authBody = await auth.json() as { csrfToken: string };
  return { start, pendingCookie, state, callback, sessionCookie, csrfToken: authBody.csrfToken, fetchMock };
}

describe('GitHub OAuth and export security', () => {
  beforeEach(() => {
    process.env.GITHUB_CLIENT_ID = 'client-id';
    process.env.GITHUB_CLIENT_SECRET = 'client-secret';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:8787/api/github/auth/callback';
    process.env.LOV_APP_URL = 'http://localhost:5173/';
    delete process.env.GITHUB_OAUTH_SCOPE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('sets a local HttpOnly SameSite=Lax cookie without Secure and redirects to GitHub', async () => {
    const response = await request('/api/github/auth/start');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') || '');
    expect(location.origin).toBe('https://github.com');
    expect(location.pathname).toBe('/login/oauth/authorize');
    expect(location.searchParams.get('scope')).toBe('repo');
    expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const cookie = response.headers.get('set-cookie') || '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  it('enables Secure cookies for an HTTPS callback', async () => {
    process.env.GITHUB_CALLBACK_URL = 'https://app.example/api/github/auth/callback';
    const response = await request('/api/github/auth/start');
    expect(response.headers.get('set-cookie')).toMatch(/;\s*Secure/i);
  });

  it('consumes OAuth state once, keeps the token server-side, and returns to the app', async () => {
    const flow = await authenticate();
    expect(flow.callback.status).toBe(302);
    expect(flow.callback.headers.get('location')).toBe('http://localhost:5173/?github=connected');
    expect(flow.callback.headers.get('location')).not.toContain('server-only-token');
    expect(flow.callback.headers.get('set-cookie')).not.toContain('server-only-token');
    expect(flow.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const callsBeforeReplay = flow.fetchMock.mock.calls.length;
    const replay = await request(`/api/github/auth/callback?code=replay&state=${encodeURIComponent(flow.state)}`, {
      headers: { Cookie: flow.pendingCookie },
    });
    expect(replay.status).toBe(302);
    expect(replay.headers.get('location')).toBe('http://localhost:5173/?github=error');
    expect(flow.fetchMock).toHaveBeenCalledTimes(callsBeforeReplay);
  });

  it('rejects export and disconnect without the session CSRF token', async () => {
    const flow = await authenticate();
    const body = JSON.stringify({ repoName: 'safe-repo', isPrivate: true, confirmed: true, files: [{ path: 'README.md', content: '# Safe' }] });
    const exported = await request('/api/github/export', { method: 'POST', headers: { Cookie: flow.sessionCookie, 'Content-Type': 'application/json' }, body });
    const revoked = await request('/api/github/auth/revoke', { method: 'POST', headers: { Cookie: flow.sessionCookie } });
    expect(exported.status).toBe(403);
    expect(revoked.status).toBe(403);
    expect(flow.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses the commit tree SHA, preserves the base tree, and verifies every uploaded blob', async () => {
    const flow = await authenticate();
    const files = [
      { path: 'README.md', content: '# Exported' },
      { path: 'src/main.ts', content: 'export const ok = true;\n' },
    ];
    let refReads = 0;
    const api = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/repos/octocat/safe-repo') && init?.method === 'GET') return json({ message: 'Not Found' }, 404);
      if (url.endsWith('/user/repos') && init?.method === 'POST') return json({ full_name: 'octocat/safe-repo', html_url: 'https://github.com/octocat/safe-repo', default_branch: 'main', owner: { login: 'octocat' } }, 201);
      if (url.endsWith('/git/ref/heads/main') && init?.method === 'GET') {
        refReads += 1;
        return json({ object: { sha: refReads === 1 ? 'commit-parent' : 'commit-new' } });
      }
      if (url.endsWith('/git/commits/commit-parent')) return json({ tree: { sha: 'tree-parent' } });
      if (url.endsWith('/git/trees') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body));
        expect(payload.base_tree).toBe('tree-parent');
        expect(payload.tree).toHaveLength(files.length);
        return json({ sha: 'tree-new' }, 201);
      }
      if (url.endsWith('/git/commits') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body));
        expect(payload.tree).toBe('tree-new');
        expect(payload.parents).toEqual(['commit-parent']);
        return json({ sha: 'commit-new' }, 201);
      }
      if (url.endsWith('/git/refs/heads/main') && init?.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({ sha: 'commit-new', force: false });
        return json({ object: { sha: 'commit-new' } });
      }
      if (url.endsWith('/git/trees/tree-new?recursive=1')) {
        return json({ truncated: false, tree: files.map((file) => ({ path: file.path, type: 'blob', sha: blobSha(file.content) })) });
      }
      throw new Error(`Unexpected GitHub request: ${init?.method} ${url}`);
    });
    vi.stubGlobal('fetch', api);

    const response = await request('/api/github/export', {
      method: 'POST',
      headers: { Cookie: flow.sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': flow.csrfToken },
      body: JSON.stringify({ repoName: 'safe-repo', isPrivate: true, confirmed: true, files }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, commitSha: 'commit-new', filesUploaded: 2 });
  });

  it('does not create a repository when the availability check fails ambiguously', async () => {
    const flow = await authenticate();
    const api = vi.fn().mockResolvedValue(json({ message: 'rate limited' }, 403));
    vi.stubGlobal('fetch', api);
    const response = await request('/api/github/export', {
      method: 'POST',
      headers: { Cookie: flow.sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': flow.csrfToken },
      body: JSON.stringify({ repoName: 'safe-repo', isPrivate: true, confirmed: true, files: [{ path: 'README.md', content: '# Safe' }] }),
    });
    expect(response.status).toBe(502);
    expect(api).toHaveBeenCalledTimes(1);
  });
});
