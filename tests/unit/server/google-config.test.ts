// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { googleAuthRouter } from '../../../server/auth/google';

const callback = 'https://builder.example.test/api/auth/google/callback';
const clientId = '123456-qa.apps.googleusercontent.com';
const deps = { db: { query: vi.fn() }, jwtSecret: 'qa-only' };

describe('Google Web OAuth configuration', () => {
  it.each([
    ['', 'some-test-value'],
    ['project-placeholder.apps.googleusercontent.com', 'some-test-value'],
    [clientId, 'your_client_secret'],
  ])('keeps incomplete configuration out of the login flow', async (id, secret) => {
    const app = googleAuthRouter(deps, { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret });
    const status = await app.request('/api/auth/google/status');
    expect(await status.json()).toEqual({ configured: false, clientId: null });
    expect((await app.request('/api/auth/google')).status).toBe(503);
    expect((await app.request('/api/auth/google/credential', { method: 'POST' })).status).toBe(503);
  });

  it('redirects a configured client to Google with the registered callback', async () => {
    const app = googleAuthRouter(deps, { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: 'qa-value', GOOGLE_CALLBACK_URL: callback });
    const start = await app.request('/api/auth/google');
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('location')!);
    expect(location.hostname).toBe('accounts.google.com');
    expect(location.searchParams.get('redirect_uri')).toBe(callback);
  });
});
