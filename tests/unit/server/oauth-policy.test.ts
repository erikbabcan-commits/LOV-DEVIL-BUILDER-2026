// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedOrigins, validCallback } from '../../../server/security/oauthPolicy';
import { EncryptedSessionStore } from '../../../server/security/sessionStore';
import { buildProject } from '../../../server/sandbox/builder';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('requires exact production origins and callback path', () => {
  expect(() => allowedOrigins('http://example.invalid', true)).toThrow();
  expect(() => allowedOrigins('https://example.invalid/extra', true)).toThrow();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('GITHUB_ALLOWED_ORIGINS', 'https://example.invalid');
  expect(validCallback('https://example.invalid/api/github/auth/callback')).toBe(true);
  expect(validCallback('https://example.invalid.attacker.invalid/api/github/auth/callback')).toBe(false);
  expect(validCallback('https://example.invalid/api/github/auth/callback?next=evil')).toBe(false);
});
it('encrypts persistent sessions, rejects tampering, expires and isolates IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-session-'));
  const secret = 'ab'.repeat(32), id = 'cd'.repeat(32), other = 'ef'.repeat(32);
  try {
    const store = new EncryptedSessionStore<{expiresAt: number; token: string}>(dir, secret);
    store.set(id, {expiresAt: Date.now() + 60000, token: 'synthetic-token-value'});
    expect(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')).not.toContain('synthetic-token-value');
    const restarted = new EncryptedSessionStore<{expiresAt: number; token: string}>(dir, secret);
    expect(restarted.get(id)?.token).toBe('synthetic-token-value');
    expect(restarted.get(other)).toBeUndefined();
    expect(restarted.get('../escape')).toBeUndefined();
    store.set(other, {expiresAt: 0, token: 'expired'});
    expect(store.get(other)).toBeUndefined();
    writeFileSync(join(dir, id + '.json'), '{}');
    expect(store.get(id)).toBeUndefined();
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
it.each(['node:fs', '/etc/passwd', 'unapproved-package'])('denies host/package import %s without executing code', async specifier => {
  const result = await buildProject([{path: 'src/main.tsx', content: `import x from ${JSON.stringify(specifier)}; console.log(x);`}]);
  expect(result.ok).toBe(false);
});


it('consumes OAuth state once through the actual router without a live provider', async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('GITHUB_CLIENT_ID', 'synthetic-client');
  vi.stubEnv('GITHUB_CLIENT_SECRET', 'synthetic-client-secret');
  vi.stubEnv('GITHUB_CALLBACK_URL', 'http://localhost:5173/api/github/auth/callback');
  vi.stubEnv('GITHUB_ALLOWED_ORIGINS', 'http://localhost:5173');
  const { githubRouter } = await import('../../../server/routes/github');
  const start = await githubRouter.request('http://localhost/api/github/auth/start');
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  const pending = await githubRouter.request('http://localhost/api/github/auth', {headers: {Cookie: cookie}});
  expect((await pending.json()).authenticated).toBe(false);
  const upstream = vi.fn()
    .mockResolvedValueOnce(Response.json({access_token: 'synthetic-token', token_type: 'bearer', scope: 'repo'}))
    .mockResolvedValueOnce(Response.json({id: 123, login: 'synthetic-user'}));
  vi.stubGlobal('fetch', upstream);
  const callback = `http://localhost/api/github/auth/callback?code=fixture&state=${state}`;
  const accepted = await githubRouter.request(callback, {headers: {Cookie: cookie}});
  expect(accepted.status).toBe(302);
  expect(accepted.headers.get('location')).toBe('http://localhost:5173/?github_auth=success');
  const replay = await githubRouter.request(callback, {headers: {Cookie: cookie}});
  expect((await replay.json()).ok).toBe(false);
  expect(upstream).toHaveBeenCalledTimes(2);
});
