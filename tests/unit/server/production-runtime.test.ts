// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assertProductionRuntime, productionRuntimeViolations } from '../../../server/production';

type Env = Record<string, string | undefined>;

/* Fully valid production profile for the standalone Hono backend. */
const validProduction = (): Env => ({
  NODE_ENV: 'production',
  AUTH_ENABLED: '1',
  DATABASE_URL: 'postgresql://forge:secret@db.internal:5432/forge',
  JWT_SECRET: 'j'.repeat(64),
  DATABASE_SCHEMA_SHA256: 'ab'.repeat(32),
  BIND: '0.0.0.0',
  PORT: '8787',
  GITHUB_ALLOWED_ORIGINS: 'https://app.example.com,https://lovable.example',
  LOV_APP_URL: 'https://app.example.com/',
  GITHUB_SESSION_DIR: '/data/sessions',
  GITHUB_SESSION_SECRET: 'cd'.repeat(32),
  SANDBOX_RUNNER_URL: 'http://sandbox-runner.internal:8790/',
  SANDBOX_RUNNER_TOKEN: 't'.repeat(40),
  MISTRAL_API_KEY: 'mistral-server-key',
});

describe('production runtime profile', () => {
  it('accepts a fully validated production environment', () => {
    expect(productionRuntimeViolations(validProduction())).toEqual([]);
    expect(() => assertProductionRuntime(validProduction())).not.toThrow();
  });

  it('is a no-op outside production (loopback pilot unchanged)', () => {
    expect(productionRuntimeViolations({ NODE_ENV: 'test' })).toEqual([]);
    expect(productionRuntimeViolations({})).toEqual([]);
    expect(() => assertProductionRuntime({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('fails closed with an aggregated list when prerequisites are missing', () => {
    const violations = productionRuntimeViolations({ NODE_ENV: 'production' });
    for (const name of ['AUTH_ENABLED', 'DATABASE_URL', 'JWT_SECRET', 'DATABASE_SCHEMA_SHA256',
      'BIND', 'PORT', 'GITHUB_ALLOWED_ORIGINS', 'GITHUB_SESSION_DIR', 'GITHUB_SESSION_SECRET', 'SANDBOX_RUNNER'])
      expect(violations.some(v => v.startsWith(name)), name).toBe(true);
    expect(() => assertProductionRuntime({ NODE_ENV: 'production' }))
      .toThrow(/Production runtime prerequisites missing/);
  });

  it('rejects host sandbox mode and mock AI in production', () => {
    expect(productionRuntimeViolations({ ...validProduction(), SANDBOX_MODE: 'host' }).some(v => v.includes('SANDBOX_MODE'))).toBe(true);
    expect(productionRuntimeViolations({ ...validProduction(), MOCK_AI: '1' }).some(v => v.includes('MOCK_AI'))).toBe(true);
  });

  it('rejects missing/invalid isolated runner configuration', () => {
    expect(productionRuntimeViolations({ ...validProduction(), SANDBOX_RUNNER_TOKEN: 'short' }).some(v => v.includes('SANDBOX_RUNNER'))).toBe(true);
    expect(productionRuntimeViolations({ ...validProduction(), SANDBOX_RUNNER_URL: 'http://user:pass@runner:8790/' }).some(v => v.includes('SANDBOX_RUNNER'))).toBe(true);
  });

  it('rejects non-HTTPS origins and callbacks in production', () => {
    expect(productionRuntimeViolations({ ...validProduction(), GITHUB_ALLOWED_ORIGINS: 'http://app.example.com' }).some(v => v.includes('GITHUB_ALLOWED_ORIGINS'))).toBe(true);
    expect(productionRuntimeViolations({ ...validProduction(), LOV_APP_URL: 'http://app.example.com/' }).some(v => v.includes('LOV_APP_URL'))).toBe(true);
    const oauth = { ...validProduction(), GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', GITHUB_CALLBACK_URL: 'https://evil.example.com/api/github/auth/callback' };
    expect(productionRuntimeViolations(oauth).some(v => v.includes('GITHUB_CALLBACK_URL'))).toBe(true);
    const ok = { ...oauth, GITHUB_CALLBACK_URL: 'https://app.example.com/api/github/auth/callback' };
    expect(productionRuntimeViolations(ok)).toEqual([]);
  });

  it('keeps billing and public publish off until separately verified', () => {
    expect(productionRuntimeViolations({ ...validProduction(), BILLING_ENABLED: '1' }).some(v => v.includes('BILLING_ENABLED'))).toBe(true);
    expect(productionRuntimeViolations({ ...validProduction(), PUBLICPUBLISH_ENABLED: '1' }).some(v => v.includes('PUBLICPUBLISH_ENABLED'))).toBe(true);
  });

  it('requires a real server-side AI provider key when AI generation is enabled', () => {
    const noKey = { ...validProduction(), MISTRAL_API_KEY: undefined };
    expect(productionRuntimeViolations(noKey).some(v => v.includes('AI provider'))).toBe(true);
    expect(productionRuntimeViolations({ ...noKey, AI_GENERATION_ENABLED: '0' })).toEqual([]);
    expect(productionRuntimeViolations({ ...noKey, AI_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-x' })).toEqual([]);
  });

  it('requires loopback bind to be replaced by an explicit proxy bind', () => {
    expect(productionRuntimeViolations({ ...validProduction(), BIND: '127.0.0.1' }).some(v => v.includes('BIND'))).toBe(true);
    expect(productionRuntimeViolations({ ...validProduction(), BIND: undefined }).some(v => v.includes('BIND'))).toBe(true);
  });
});
