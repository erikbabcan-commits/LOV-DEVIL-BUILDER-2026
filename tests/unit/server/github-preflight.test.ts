// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../..'), cli = join(repo, 'node_modules/tsx/dist/cli.mjs');
// Each scenario starts up to two real processes, each bounded at 15 seconds.
// This is a CLI test budget; no application/provider/UI timeout is changed.
const cliScenarioTimeout = 35000;
function run(args: string[], environment: Record<string,string> = {}, cwd = repo, entry = 'scripts/check-cloud-github.ts') {
  const result = spawnSync(process.execPath, [cli, join(repo, entry), ...args], { cwd, encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', MISTRAL_API_KEY: '', ...environment } });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
it('prints the disabled report and help without loading a cwd dotenv or calling a provider', () => {
  const temp = mkdtempSync(join(tmpdir(), 'lov-preflight-'));
  try {
    writeFileSync(join(temp,'.env'), 'GITHUB_CLOUD_ENABLED=1\nGITHUB_CLOUD_CLIENT_SECRET=private-file-value\n');
    const result = run([], {}, temp);
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ ok: true, mode: 'disabled', database: 'not_checked', provider: 'not_called' });
    expect(result.stderr).not.toContain('private-file-value');
    expect(run(['--help']).stdout).toContain('--check-db');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, cliScenarioTimeout);
it('never echoes malformed arguments or supplied secret values', () => {
  const result = run(['--private-secret-value']);
  expect(result.code).toBe(1); expect(JSON.parse(result.stdout)).toEqual({ ok: false, issues: ['preflight_failed'] });
  expect(result.stdout + result.stderr).not.toContain('private-secret-value');
  const invalid = run([], { GITHUB_CLOUD_ENABLED: '1', GITHUB_CLOUD_CLIENT_SECRET: 'private-env-value' });
  expect(invalid.code).toBe(1); expect(JSON.parse(invalid.stdout).issues).toContain('CLOUD_AUTH_ISSUER');
  expect(invalid.stdout + invalid.stderr).not.toContain('private-env-value');
}, cliScenarioTimeout);
it('reads only an explicitly selected dotenv file, with process env taking precedence', () => {
  const temp = mkdtempSync(join(tmpdir(), 'lov-preflight-'));
  try {
    const file = join(temp,'private.env'); writeFileSync(file, 'GITHUB_CLOUD_ENABLED=1\nGITHUB_CLOUD_CLIENT_SECRET=private-file-value\n', { mode: 0o600 });
    expect(run(['--env-file', file]).code).toBe(1);
    const disabled = run(['--env-file', file], { GITHUB_CLOUD_ENABLED: '0' });
    expect(disabled.code).toBe(0); expect(JSON.parse(disabled.stdout).mode).toBe('disabled');
    expect(disabled.stdout + disabled.stderr).not.toContain(file); expect(disabled.stdout + disabled.stderr).not.toContain('private-file-value');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, cliScenarioTimeout);
it('rejects bad runtime configuration before attempting DB connection or migrations', () => {
  const temp = mkdtempSync(join(tmpdir(), 'lov-startup-'));
  try {
    const result = run([], { AUTH_ENABLED: '1', DATABASE_URL: 'postgresql://user:private-password@127.0.0.1:1/never-used', JWT_SECRET: 'synthetic-jwt-secret-01234567890123456789',
      CLOUD_AUTH_ISSUER: 'https://cloud.test/auth/v1', GITHUB_CLOUD_ENABLED: '1', GITHUB_BRIDGE_SECRET: 'bad-hex' }, temp, 'server/index.ts');
    expect(result.code).toBe(1); expect(result.stderr).toContain('GITHUB_BRIDGE_SECRET');
    expect(result.stdout).not.toContain('migrácie'); expect(result.stderr).not.toContain('ECONNREFUSED'); expect(result.stderr).not.toContain('private-password');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, cliScenarioTimeout);
