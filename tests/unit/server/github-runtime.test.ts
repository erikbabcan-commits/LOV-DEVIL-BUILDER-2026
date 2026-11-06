// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { CloudGitHubConfigurationError, makeCloudGitHubWiring, readCloudGitHubConfig } from '../../../server/integrations/githubRuntime';
import { probeCloudGitHubSchema } from '../../../server/integrations/githubSchema';

const env = () => ({ AUTH_ENABLED: '1', DATABASE_URL: 'postgresql://synthetic:private-value@127.0.0.1:1/test', JWT_SECRET: 'synthetic-jwt-secret-01234567890123456789',
  CLOUD_AUTH_ISSUER: 'https://cloud.test/auth/v1', GITHUB_CLOUD_ENABLED: '1', GITHUB_CLOUD_CLIENT_ID: 'fixture-client', GITHUB_CLOUD_CLIENT_SECRET: 'synthetic-client-secret',
  GITHUB_CLOUD_CALLBACK_URL: 'https://frontend.test/github/callback', GITHUB_CLOUD_ALLOWED_ORIGIN: 'https://frontend.test', GITHUB_CLOUD_ENCRYPTION_KEY: 'ab'.repeat(32), GITHUB_BRIDGE_SECRET: 'cd'.repeat(32) });
it('stays disabled with absent/off flags even if unused credentials are present', () => {
  expect(readCloudGitHubConfig({})).toBeUndefined();
  expect(readCloudGitHubConfig({ ...env(), GITHUB_CLOUD_ENABLED: '0' })).toBeUndefined();
  const db = { query: vi.fn() }, provider = vi.fn();
  expect(makeCloudGitHubWiring(db, undefined, provider)).toBeUndefined();
  expect(db.query).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
});
it('enables OAuth and export separately, with no DB/provider work during wiring', () => {
  const db = { query: vi.fn() }, provider = vi.fn();
  const oauth = makeCloudGitHubWiring(db, readCloudGitHubConfig(env()), provider);
  expect(oauth?.service).toBeDefined(); expect(oauth?.exporter).toBeUndefined();
  expect(makeCloudGitHubWiring(db, readCloudGitHubConfig({ ...env(), GITHUB_CLOUD_EXPORT_ENABLED: '1' }), provider)?.exporter).toBeDefined();
  expect(db.query).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
});
it.each([
  { GITHUB_CLOUD_ENABLED: 'true' }, { GITHUB_CLOUD_EXPORT_ENABLED: 'yes' },
  { GITHUB_CLOUD_ENABLED: '0', GITHUB_CLOUD_EXPORT_ENABLED: '1' }, { AUTH_ENABLED: '0' }, { NODE_ENV: 'production' },
  { CLOUD_AUTH_ISSUER: 'https://cloud.test/auth/v1?secret=private-value' }, { DATABASE_URL: '' }, { JWT_SECRET: 'short' },
  { GITHUB_CLOUD_CLIENT_ID: '' }, { GITHUB_CLOUD_CLIENT_SECRET: '' }, { GITHUB_BRIDGE_SECRET: 'not-hex' },
])('refuses inconsistent/missing prerequisites without disclosing values: %j', patch => {
  expect(() => readCloudGitHubConfig({ ...env(), ...patch })).toThrow(CloudGitHubConfigurationError);
  try { readCloudGitHubConfig({ ...env(), ...patch }); } catch (error) {
    expect(String(error)).not.toContain('private-value'); expect(String(error)).not.toContain(env().GITHUB_CLOUD_CLIENT_SECRET);
  }
});
it.each([
  'http://frontend.test/github/callback', 'https://attacker.test/github/callback',
  'https://frontend.test/github/callback?code=private-value', 'https://frontend.test/github/callback#secret',
  'https://user:private-value@frontend.test/github/callback', 'https://frontend.test/other',
])('rejects an unsafe or mismatched callback: %s', callback => {
  expect(() => readCloudGitHubConfig({ ...env(), GITHUB_CLOUD_CALLBACK_URL: callback })).toThrow('GITHUB_CLOUD_CALLBACK_URL');
});
it('requires canonical origin/issuer and independent encryption/transport secrets', () => {
  expect(() => readCloudGitHubConfig({ ...env(), GITHUB_CLOUD_ALLOWED_ORIGIN: 'https://frontend.test/' })).toThrow('GITHUB_CLOUD_ALLOWED_ORIGIN');
  expect(() => readCloudGitHubConfig({ ...env(), CLOUD_AUTH_ISSUER: 'https://cloud.test/auth/v1/' })).toThrow('CLOUD_AUTH_ISSUER');
  expect(() => readCloudGitHubConfig({ ...env(), GITHUB_BRIDGE_SECRET: env().GITHUB_CLOUD_ENCRYPTION_KEY.toUpperCase() })).toThrow('GITHUB_BRIDGE_SECRET');
  for (const name of ['JWT_SECRET', 'GITHUB_SESSION_SECRET', 'SANDBOX_RUNNER_TOKEN'])
    expect(() => readCloudGitHubConfig({ ...env(), [name]: env().GITHUB_CLOUD_ENCRYPTION_KEY })).toThrow('GITHUB_CLOUD_ENCRYPTION_KEY');
});
it('reports fixed schema issue names and never DB exception contents', async () => {
  const db = { query: vi.fn().mockRejectedValue(new Error('private-db-password')) };
  const result = await probeCloudGitHubSchema(db, true);
  expect(result.ready).toBe(false); expect(result.issues).toContain('export_columns');
  expect(JSON.stringify(result)).not.toContain('private-db-password');
  expect(db.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
});
