import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiUrl, getApiBaseUrl } from '../../src/lib/api';
import vercelConfig from '../../vercel.json';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Frontend API URL configuration (VITE_API_BASE_URL)', () => {
  it('returns empty string when VITE_API_BASE_URL is not set', () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    expect(getApiBaseUrl()).toBe('');
  });

  it('preserves relative paths for local development and proxy when unset', () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    expect(apiUrl('/api/auth/me')).toBe('/api/auth/me');
    expect(apiUrl('/api/health')).toBe('/api/health');
    expect(apiUrl('/api/ai-models')).toBe('/api/ai-models');
    expect(apiUrl('/api/projects')).toBe('/api/projects');
    expect(apiUrl('/api/publish')).toBe('/api/publish');
    expect(apiUrl('api/billing/status')).toBe('/api/billing/status');
  });

  it('resolves public base URL without trailing slash when configured', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.lov-devil.sk');
    expect(getApiBaseUrl()).toBe('https://api.lov-devil.sk');
    expect(apiUrl('/api/auth/me')).toBe('https://api.lov-devil.sk/api/auth/me');
    expect(apiUrl('/api/health')).toBe('https://api.lov-devil.sk/api/health');
    expect(apiUrl('/api/github/auth/start')).toBe('https://api.lov-devil.sk/api/github/auth/start');
  });

  it('normalizes trailing slashes and whitespace in VITE_API_BASE_URL', () => {
    vi.stubEnv('VITE_API_BASE_URL', '  https://api.lov-devil.sk///  ');
    expect(getApiBaseUrl()).toBe('https://api.lov-devil.sk');
    expect(apiUrl('/api/auth/me')).toBe('https://api.lov-devil.sk/api/auth/me');
    expect(apiUrl('api/projects')).toBe('https://api.lov-devil.sk/api/projects');
  });
});

describe('Vercel routing rewrite rules (vercel.json)', () => {
  const rewrite = vercelConfig.rewrites.find(r => r.destination === '/index.html');
  if (!rewrite) {
    throw new Error('Expected SPA rewrite to /index.html in vercel.json');
  }
  const regex = new RegExp(`^${rewrite.source}$`);

  it('rewrites client-side routes to /index.html for SPA fallback', () => {
    expect(regex.test('/editor')).toBe(true);
    expect(regex.test('/projects')).toBe(true);
    expect(regex.test('/settings/billing')).toBe(true);
    expect(regex.test('/dashboard')).toBe(true);
    expect(regex.test('/apidocs')).toBe(true);
  });

  it('does NOT rewrite /api or /api/* requests so API calls are never intercepted', () => {
    expect(regex.test('/api')).toBe(false);
    expect(regex.test('/api/')).toBe(false);
    expect(regex.test('/api/health')).toBe(false);
    expect(regex.test('/api/auth/me')).toBe(false);
    expect(regex.test('/api/billing/checkout')).toBe(false);
    expect(regex.test('/api/projects')).toBe(false);
    expect(regex.test('/api/sandbox/build')).toBe(false);
  });

  it('specifies the correct Vite build settings in vercel.json', () => {
    expect(vercelConfig.framework).toBe('vite');
    expect(vercelConfig.buildCommand).toBe('npm run build');
    expect(vercelConfig.outputDirectory).toBe('dist');
  });
});
