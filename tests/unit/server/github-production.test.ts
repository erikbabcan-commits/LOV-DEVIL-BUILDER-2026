// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedSessionStore } from '../../../server/security/sessionStore';

let directory: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it('rejects persisted legacy sessions without an explicit owner, including in the pilot', async () => {
  directory = mkdtempSync(join(tmpdir(), 'lov-github-legacy-'));
  const secret = 'cd'.repeat(32);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('AUTH_ENABLED', '0');
  vi.stubEnv('GITHUB_SESSION_DIR', directory);
  vi.stubEnv('GITHUB_SESSION_SECRET', secret);
  vi.stubEnv('GITHUB_CLIENT_ID', 'fixture-client');
  vi.stubEnv('GITHUB_CLIENT_SECRET', 'fixture-secret');
  vi.stubEnv('GITHUB_ALLOWED_ORIGINS', 'https://fixture.invalid');
  vi.stubEnv('GITHUB_CALLBACK_URL', 'https://fixture.invalid/api/github/auth/callback');
  vi.stubEnv('LOV_APP_URL', 'https://fixture.invalid/');
  const id = 'ef'.repeat(32);
  const store = new EncryptedSessionStore(directory, secret);
  const legacySession = {
    kind: 'authenticated', githubToken: 'legacy-server-token', githubScopes: ['repo'],
    githubUsername: 'legacy-user', csrfToken: 'legacy-csrf', expiresAt: Date.now() + 60_000
  };
  store.set(id, legacySession);
  vi.resetModules();
  const { githubRouter } = await import('../../../server/routes/githubSecure');
  const auth = await githubRouter.request('https://fixture.invalid/api/github/auth', { headers: { Cookie: 'github_session_id=' + id } });
  expect(await auth.json()).toMatchObject({ authenticated: false });
  expect(auth.headers.get('Cache-Control')).toBe('no-store');
  expect(auth.headers.get('set-cookie')).toContain('Max-Age=0');
});

it('persists the mounted GitHub router session encrypted across module restarts', async () => {
  directory = mkdtempSync(join(tmpdir(), 'lov-github-production-'));
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('GITHUB_SESSION_DIR', directory);
  vi.stubEnv('GITHUB_SESSION_SECRET', 'ab'.repeat(32));
  vi.stubEnv('GITHUB_CLIENT_ID', 'fixture-client');
  vi.stubEnv('GITHUB_CLIENT_SECRET', 'fixture-secret');
  vi.stubEnv('GITHUB_ALLOWED_ORIGINS', 'https://fixture.invalid');
  vi.stubEnv('GITHUB_CALLBACK_URL', 'https://fixture.invalid/api/github/auth/callback');
  vi.stubEnv('LOV_APP_URL', 'https://fixture.invalid/');
  vi.resetModules();
  const { githubRouter } = await import('../../../server/routes/githubSecure');
  const start = await githubRouter.request('https://fixture.invalid/api/github/auth/start');
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  expect(state).toMatch(/^[a-f0-9]{64}$/);
  const pendingFiles = readdirSync(directory);
  expect(pendingFiles).toHaveLength(1);
  expect(readFileSync(join(directory, pendingFiles[0]), 'utf8')).not.toContain(state);

  vi.resetModules();
  const { githubRouter: restartedRouter } = await import('../../../server/routes/githubSecure');
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ access_token: 'private-github-token', scope: 'repo' }))
    .mockResolvedValueOnce(Response.json({ id: 42, login: 'fixture-user' })));
  const callback = await restartedRouter.request(`https://fixture.invalid/api/github/auth/callback?code=fixture-code&state=${state}`, { headers: { Cookie: cookie } });
  expect(callback.headers.get('location')).toBe('https://fixture.invalid/?github=connected');
  const authenticatedCookie = callback.headers.get('set-cookie')!.split(';')[0];
  expect(authenticatedCookie).not.toBe(cookie);
  const files = readdirSync(directory);
  expect(files).toHaveLength(1);
  expect(readFileSync(join(directory, files[0]), 'utf8')).not.toContain('private-github-token');
  const auth = await restartedRouter.request('https://fixture.invalid/api/github/auth', { headers: { Cookie: authenticatedCookie } });
  expect(await auth.json()).toMatchObject({ authenticated: true, username: 'fixture-user' });
});
