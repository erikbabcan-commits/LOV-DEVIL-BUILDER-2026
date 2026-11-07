// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newDb } from 'pg-mem';
import { dbFromPool } from '../../../server/db/pool';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { makeHonoProxy, type HonoProxyOptions } from '../../../server/integrations/honoProxy';
import { createApp } from '../../../server/index';
import { makeCloudAuth } from '../../../server/auth/cloud';
import { applyMigrations } from '../../../server/db/migrate';
import { InMemoryQuotaStore } from '../../../server/security/quotaStore';

const origin = 'https://lovable.example.test';
const baseUrl = 'https://hono.example.test';
const session = async () => ({ accessToken: 'verified.user.token' });
const request = (path = '/projects', body?: unknown, headers: Record<string, string> = {}) => new Request(origin + '/api/hono' + path, {
  ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
});
function setup(overrides: Partial<HonoProxyOptions> = {}) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  return { proxy: makeHonoProxy({ baseUrl, authenticate: session, fetch: fetcher, ...overrides }), fetcher };
}
afterEach(() => vi.useRealTimers());

describe('server-only Lovable → Hono proxy', () => {
  it('allows only authenticated publish preparation and status with a 4KiB body limit', async () => {
    const {proxy,fetcher}=setup();
    const id='dd4ec3fc-a77b-4af7-baa5-f25ac7228221';
    const version='/publish/project/demo-project/2/snapshot_one';
    for (const [path,body] of [['/publish',undefined],['/publish',{}],['/publish/'+id,undefined],[version,undefined]] as const) {
      expect((await proxy(request(path,body))).status).toBe(200);
      expect(fetcher.mock.calls.at(-1)?.[0]).toBe(baseUrl+'/api'+path);
    }
    fetcher.mockClear();
    for (const path of ['/publish?url=https://evil.test','/publish/not-a-uuid','/publish/'+id+'/artifact','/published/'+id+'/index.html']) expect((await proxy(request(path))).status).toBe(404);
    expect((await proxy(request('/publish/'+id,{}))).status).toBe(404);
    expect((await proxy(request(version,{}))).status).toBe(404);
    expect((await proxy(request(version+'?owner=bob'))).status).toBe(404);
    expect((await proxy(new Request(origin+'/api/hono/publish',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:' '.repeat(4097)}))).status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('maps only owner-authenticated billing GET/checkout/portal with no webhook/query surface', async () => {
    const {proxy,fetcher}=setup();
    for(const [path,body] of [['/billing',undefined],['/billing/checkout',{interval:'month',requestId:'fixture'}],['/billing/portal',{requestId:'fixture'}]] as const) {
      expect((await proxy(request(path,body))).status).toBe(200);
      expect(fetcher.mock.calls.at(-1)?.[0]).toBe(baseUrl+'/api'+path);
      expect(new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).get('Authorization')).toBe('Bearer verified.user.token');
    }
    fetcher.mockClear();
    for(const path of ['/billing?owner=bob','/billing/webhook','/billing/invoices','/billing/customers'])expect((await proxy(request(path))).status).toBe(404);
    expect((await proxy(request('/billing',{}))).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects oversized billing JSON and foreign origins before provider requests', async () => {
    const {proxy,fetcher}=setup();
    expect((await proxy(new Request(origin+'/api/hono/billing/checkout',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:' '.repeat(8193)}))).status).toBe(413);
    expect((await proxy(request('/billing/portal',{}, {Origin:'https://evil.test'}))).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps only fixed GET model catalog without query overrides', async () => {
    const {proxy,fetcher}=setup();expect((await proxy(request('/ai-models'))).status).toBe(200);expect(fetcher.mock.calls[0]?.[0]).toBe(baseUrl+'/api/ai-models');
    fetcher.mockClear();expect((await proxy(request('/ai-models?url=https://other.test'))).status).toBe(404);expect((await proxy(request('/ai-models',{}))).status).toBe(404);expect(fetcher).not.toHaveBeenCalled();
  });
  it('maps usage to a fixed owner-authenticated GET with no query or write overrides', async () => {
    const { proxy, fetcher } = setup();
    expect((await proxy(request('/ai-usage'))).status).toBe(200);
    expect(fetcher.mock.calls[0]?.[0]).toBe(baseUrl + '/api/ai-usage');
    fetcher.mockClear();
    expect((await proxy(request('/ai-usage?owner=bob'))).status).toBe(404);
    expect((await proxy(request('/ai-usage', {}))).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('maps read-only account capacity without caller-supplied ownership', async () => {
    const { proxy, fetcher } = setup();
    expect((await proxy(request('/project-storage'))).status).toBe(200);
    expect(fetcher.mock.calls[0]?.[0]).toBe(baseUrl + '/api/project-storage');
    fetcher.mockClear();
    expect((await proxy(request('/project-storage?owner=bob'))).status).toBe(404);
    expect((await proxy(request('/project-storage', {}))).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('maps only allowed routes and validated listing query to a fixed origin', async () => {
    const { proxy, fetcher } = setup();
    expect(await (await proxy(request('/projects?deleted=1&cursor=abc_12'))).json()).toEqual({ ok: true });
    expect(fetcher.mock.calls[0]?.[0]).toBe(baseUrl + '/api/projects?deleted=1&cursor=abc_12');
    const options = fetcher.mock.calls[0]?.[1];
    expect(options).toMatchObject({ redirect: 'manual', cache: 'no-store', credentials: 'omit', method: 'GET' });
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer verified.user.token');
  });
  it('rejects arbitrary URLs, methods, encoded paths and duplicate/unknown query parameters', async () => {
    const { proxy, fetcher } = setup();
    for (const path of ['/https://evil.test', '/projects/a/snapshots', '/github/status', '/projects?deleted=1&deleted=0', '/projects?url=https://evil.test', '/projects?cursor=%2Fsecret', '/auth/me?deleted=0', '/projects/%61']) {
      expect((await proxy(request(path))).status).toBe(404);
    }
    expect((await proxy(new Request(origin + '/api/hono/projects/a', { method: 'PUT' }))).status).toBe(404);
    expect((await proxy(request('/projects', {}))).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires server-verified auth and never forwards browser cookies or supplied authorization', async () => {
    const { proxy, fetcher } = setup();
    await (await proxy(request('/auth/me', undefined, { Cookie: 'private=secret', Authorization: 'Bearer unverified', 'X-Proxy-Authorization': 'private', 'X-Forwarded-For': '1.2.3.4' }))).text();
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect([...headers.keys()].sort()).toEqual(['accept', 'authorization']);
    expect(headers.get('Authorization')).toBe('Bearer verified.user.token');
    const anonymous = setup({ authenticate: async () => null });
    expect((await anonymous.proxy(request())).status).toBe(401);
    expect(anonymous.fetcher).not.toHaveBeenCalled();
    const unavailable = setup({ authenticate: async () => { throw new Error('private error detail'); } });
    const response = await unavailable.proxy(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private');
  });
  it('protects mutation routes from cross-site and non-JSON requests', async () => {
    const { proxy, fetcher } = setup();
    expect((await proxy(request('/projects/a', {}, { Origin: 'https://evil.test' }))).status).toBe(403);
    const noOrigin = request('/projects/a', {}); noOrigin.headers.delete('Origin');
    expect((await proxy(noOrigin)).status).toBe(403);
    expect((await proxy(request('/projects/a', {}, { 'Sec-Fetch-Site': 'cross-site' }))).status).toBe(403);
    expect((await proxy(request('/projects/a', {}, { 'Content-Type': 'text/plain' }))).status).toBe(415);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('enforces declared and streamed body size before reaching Hono', async () => {
    const { proxy, fetcher } = setup();
    expect((await proxy(request('/projects/a', {}, { 'Content-Length': '8000001' }))).status).toBe(413);
    expect((await proxy(request('/projects/a', {}, { 'Content-Length': '-1' }))).status).toBe(400);
    const bytes = new Uint8Array(8_000_001);
    const streamed = new Request(origin + '/api/hono/projects/a', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: bytes });
    expect((await proxy(streamed)).status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not follow redirects or expose HTML/Set-Cookie/internal response headers', async () => {
    const redirect = setup({ fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }) });
    expect((await redirect.proxy(request())).status).toBe(502);
    const html = setup({ fetch: async () => new Response('<script>private</script>', { headers: { 'Content-Type': 'text/html' } }) });
    expect((await html.proxy(request())).status).toBe(502);
    const forwarded = setup({ fetch: async () => Response.json({ error: 'conflict' }, { status: 409, headers: { 'Set-Cookie': 'secret', 'X-Internal': 'private', 'Access-Control-Allow-Origin': '*', 'Retry-After': '60' } }) });
    const response = await forwarded.proxy(request());
    expect(response.status).toBe(409);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    for (const key of ['Set-Cookie', 'X-Internal', 'Access-Control-Allow-Origin']) expect(response.headers.has(key)).toBe(false);
    expect(await response.json()).toEqual({ error: 'conflict' });
  });
  it('streams SSE chunks before completion and keeps the total deadline active', async () => {
    vi.useFakeTimers();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn();
    const encoder = new TextEncoder();
    const { proxy } = setup({ fetch: async () => new Response(new ReadableStream({ start(c) { upstream = c; c.enqueue(encoder.encode('data: first\n\n')); }, cancel: cancelled }), { headers: { 'Content-Type': 'text/event-stream' } }) });
    const response = await proxy(request('/agent/generate', { prompt: 'test' }));
    expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
    upstream.enqueue(encoder.encode('data: second\n\n'));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: second\n\n');
    const pending = reader.read().catch(error => error);
    await vi.advanceTimersByTimeAsync(130_000);
    expect((await pending).name).toBe('TimeoutError');
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('bounds authentication and response-header waits, with no raw errors', async () => {
    vi.useFakeTimers();
    const auth = setup({ authenticate: async () => new Promise(() => {}) });
    const waitingAuth = auth.proxy(request());
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await waitingAuth).status).toBe(504);
    expect(auth.fetcher).not.toHaveBeenCalled();
    const network = setup({ fetch: async () => new Promise(() => {}) });
    const waitingNetwork = network.proxy(request());
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await waitingNetwork).status).toBe(504);
    const failed = setup({ fetch: async () => { throw new Error('credential detail'); } });
    const response = await failed.proxy(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('credential');
  });
  it('includes a stalled request body in the total deadline and cancels its stream', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([123])); }, cancel: cancelled });
    const init = { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body, duplex: 'half' };
    const { proxy, fetcher } = setup();
    const pending = proxy(new Request(origin + '/api/hono/projects/a', init));
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await pending).status).toBe(504);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('propagates disconnect and consumer cancellation to upstream and releases deadlines', async () => {
    const disconnect = new AbortController();
    let upstreamSignal!: AbortSignal;
    const cancelled = vi.fn();
    const { proxy } = setup({ fetch: async (_url, init) => {
      upstreamSignal = init!.signal!;
      return new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'Content-Type': 'application/json' } });
    } });
    const response = await proxy(new Request(origin + '/api/hono/projects', { signal: disconnect.signal }));
    const body = response.text().catch(error => error);
    disconnect.abort();
    expect((await body).name).toBe('AbortError');
    expect(upstreamSignal.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
    const second = await proxy(request());
    await second.body!.cancel();
    expect(upstreamSignal.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledTimes(2);
  });
  it('rejects a response stream exceeding its bounded output budget', async () => {
    const { proxy } = setup({ fetch: async () => new Response(new Uint8Array(16_000_001), { headers: { 'Content-Type': 'application/json' } }) });
    const response = await proxy(request());
    await expect(response.text()).rejects.toThrow('Response limit exceeded');
  });
  it('rejects unsafe upstream configuration before handling requests', () => {
    for (const value of ['http://host', 'https://user:pass@host', 'https://host/path', 'https://host?secret=value']) expect(() => makeHonoProxy({ baseUrl: value, authenticate: session })).toThrow();
    for (const basicAuth of ['', 'missing-colon', 'user:password\r\nX-Injected: yes']) expect(() => makeHonoProxy({ baseUrl, authenticate: session, basicAuth })).toThrow();
  });
  it('keeps existing Basic Auth and the user identity in fixed separate headers', async () => {
    const { proxy, fetcher } = setup({ basicAuth: 'pilot:synthetic-test-password' });
    await (await proxy(request('/auth/me', undefined, { 'X-LOV-Cloud-Authorization': 'Bearer forged' }))).text();
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Authorization')).toBe('Basic ' + btoa('pilot:synthetic-test-password'));
    expect(headers.get('X-LOV-Cloud-Authorization')).toBe('Bearer verified.user.token');
    expect([...headers.keys()].sort()).toEqual(['accept', 'authorization', 'x-lov-cloud-authorization']);
  });
  it('round-trips a signed Cloud identity through proxy → real Hono → DB with CAS and isolation', async () => {
    const mem = newDb(); registerProjectByteLength(mem); const pool = new (mem.adapters.createPg().Pool)();
    const db = dbFromPool(pool);
    await applyMigrations(db);
    for (const id of ['alice', 'bob']) await db.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', [id, id + '@example.com', 'unused-test-hash']);
    const issuer = 'https://bridge-test.supabase.co/auth/v1';
    const pair = await generateKeyPair('ES256');
    const key = await exportJWK(pair.publicKey);
    const keys = createLocalJWKSet({ keys: [{ ...key, kid: 'bridge', alg: 'ES256' }] });
    for (const id of ['alice', 'bob']) await db.query('INSERT INTO identity_links (issuer,subject,user_id) VALUES ($1,$2,$3)', [issuer, 'cloud-' + id, id]);
    const cloudAuth = makeCloudAuth(db, issuer, keys);
    const app = createApp({}, null, { rateLimit: () => true, auth: { db, jwtSecret: 'bridge-cookie-secret-01234567890123456789', quota: new InMemoryQuotaStore(), cloudAuth } });
    const signed = (id: string) => new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'bridge' }).setIssuer(issuer).setAudience('authenticated').setSubject('cloud-' + id).setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    const upstreamFetch: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
    const aliceToken = await signed('alice'), bobToken = await signed('bob');
    const authenticated = (accessToken: string) => makeHonoProxy({ baseUrl, basicAuth: 'pilot:synthetic-test-password', authenticate: async () => ({ accessToken }), fetch: upstreamFetch });
    const alice = authenticated(aliceToken), bob = authenticated(bobToken);
    expect((await (await alice(request('/auth/me'))).json()).user.id).toBe('alice');
    const payload = { expectedRevision: 0, workspace: { title: 'Private', isPublic: false, liveId: null, snapshots: [], files: [] } };
    expect((await (await alice(request('/projects/p1', payload))).json()).revision).toBe(1);
    const conflict = await alice(request('/projects/p1', payload));
    expect(conflict.status).toBe(409); await conflict.text();
    const privateRead = await bob(request('/projects/p1'));
    expect(privateRead.status).toBe(404); await privateRead.text();
    expect((await (await alice(request('/projects/p1'))).json()).workspace.title).toBe('Private');
    await pool.end();
  });
});
