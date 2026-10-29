import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';

let directory: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (directory) rmSync(directory, { recursive: true, force: true });
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
