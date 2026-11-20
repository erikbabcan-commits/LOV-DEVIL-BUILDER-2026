// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createApp, makeMockProvider } from '../../../server/index';

/* Bora P1-1 (wave 1 @ 2e479d4): the client sends Idempotency-Key on every
   generate/jobs request, so a cross-origin preflight must allow it. */
describe('CORS preflight allows Idempotency-Key (P1-1)', () => {
  it.each(['/api/agent/generate', '/api/agent/jobs'])('allows idempotency-key for %s', async path => {
    const app = createApp({}, makeMockProvider());
    const res = await app.request(path, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-csrf-token,idempotency-key',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    const allowed = (res.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase().split(',').map(h => h.trim());
    expect(allowed).toEqual(expect.arrayContaining(['content-type', 'x-csrf-token', 'idempotency-key']));
  });

  it('exposes Idempotent-Replay to the browser on actual responses', async () => {
    const app = createApp({}, makeMockProvider());
    const res = await app.request('/api/health', { headers: { Origin: 'http://localhost:5173' } });
    expect((res.headers.get('Access-Control-Expose-Headers') ?? '').toLowerCase()).toContain('idempotent-replay');
  });
});
