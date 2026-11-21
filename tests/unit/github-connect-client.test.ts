import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureGitHubCallback, getGitHubConnection, probeBridgeConfigured, GitHubConnectError } from '../../src/services/githubConnect';

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeBridgeConfigured', () => {
  it('fallback mount ({configured:false}) → false', async () => {
    mockFetch(() => Response.json({ connected: false, configured: false }));
    await expect(probeBridgeConfigured()).resolves.toBe(false);
  });

  it('skutočný BFF status → true', async () => {
    mockFetch(() => Response.json({ connected: false }));
    await expect(probeBridgeConfigured()).resolves.toBe(true);
  });

  it('sieťová chyba → false (žiadny throw)', async () => {
    mockFetch(() => { throw new Error('down'); });
    await expect(probeBridgeConfigured()).resolves.toBe(false);
  });
});

describe('captureGitHubCallback', () => {
  it('platný code+state', () => {
    const state = 'a'.repeat(64);
    const code = 'AbC-123_xyz';
    expect(captureGitHubCallback(`https://ui.example.com/github/callback?code=${code}&state=${state}`))
      .toEqual({ state, code });
  });

  it('error param alebo chýbajúci/duplicitný code → null', () => {
    expect(captureGitHubCallback('https://ui.example.com/github/callback?error=access_denied&state=' + 'a'.repeat(64))).toBeNull();
    expect(captureGitHubCallback('https://ui.example.com/github/callback?code=x&state=' + 'a'.repeat(64) + '&code=y')).toBeNull();
    expect(captureGitHubCallback('https://ui.example.com/github/callback?code=x')).toBeNull();
    expect(captureGitHubCallback('https://ui.example.com/github/callback?code=' + 'x'.repeat(600) + '&state=' + 'a'.repeat(64))).toBeNull();
  });
});

describe('getGitHubConnection', () => {
  it('lokálny režim: zlúči /api/github-connect/status fallback + /api/github/status + /api/github/auth', async () => {
    mockFetch((url) => {
      if (url.includes('/api/github-connect/status')) return Response.json({ connected: false, configured: false });
      if (url.includes('/api/github/status')) return Response.json({ available: true, configured: true, message: 'ok', blocked: false });
      if (url.includes('/api/github/auth')) return Response.json({ authenticated: true, configured: true, username: 'octo', scopes: ['public_repo'], csrfToken: 'csrf', blocked: false });
      return new Response('not found', { status: 404 });
    });
    const conn = await getGitHubConnection();
    expect(conn).toMatchObject({ mode: 'local', available: true, configured: true, authenticated: true, username: 'octo', csrfToken: 'csrf' });
  });

  it('bridge režim: namapuje BFF status', async () => {
    mockFetch((url) => {
      if (url.includes('/api/github-connect/status')) return Response.json({ connected: true, username: 'octo', githubId: 7, scopes: ['public_repo'] });
      return new Response('not found', { status: 404 });
    });
    const conn = await getGitHubConnection();
    expect(conn).toMatchObject({ mode: 'bridge', configured: true, authenticated: true, username: 'octo' });
  });

  it('lokálny režim bez konfigurácie: configured=false, blocked z /api/github/status', async () => {
    mockFetch((url) => {
      if (url.includes('/api/github-connect/status')) return Response.json({ connected: false, configured: false });
      if (url.includes('/api/github/status')) return Response.json({ available: false, configured: false, blocked: true, blockReason: 'GitHub OAuth environment is incomplete or invalid' });
      if (url.includes('/api/github/auth')) return Response.json({ authenticated: false, configured: false, blocked: true });
      return new Response('not found', { status: 404 });
    });
    const conn = await getGitHubConnection();
    expect(conn).toMatchObject({ mode: 'local', available: false, configured: false, authenticated: false, blocked: true });
  });
});

describe('bridgeRequest error mapping', () => {
  it('409 → slovenská hláška o vypršaní/prepojení iného účtu', async () => {
    mockFetch((url) => {
      if (url.includes('/api/github-connect/status')) return Response.json({ connected: false });
      return Response.json({ error: 'github_nonce_required' }, { status: 409 });
    });
    await expect(probeBridgeConfigured()).resolves.toBe(true);
    const { disconnectGitHub } = await import('../../src/services/githubConnect');
    await expect(disconnectGitHub()).rejects.toMatchObject({ code: 'github_nonce_required' });
    await expect(disconnectGitHub()).rejects.toBeInstanceOf(GitHubConnectError);
    await expect(disconnectGitHub()).rejects.toThrow('Prepojenie vypršalo alebo patrí inému účtu. Začni znova.');
  });
});
