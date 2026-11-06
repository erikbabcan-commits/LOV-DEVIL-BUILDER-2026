// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newDb } from 'pg-mem';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../../../server/index';
import { applyMigrations } from '../../../server/db/migrate';
import { makeCloudAuth } from '../../../server/auth/cloud';
import { signToken } from '../../../server/auth/tokens';
import { InMemoryQuotaStore } from '../../../server/security/quotaStore';
import { githubCloud } from '../../../server/integrations/githubCloud';
import { makeGitHubBff } from '../../../server/integrations/githubBff';
import { GITHUB_BRIDGE_HEADER } from '../../../server/routes/githubCloud';
import type { DbLike } from '../../../server/db/pool';
import { randomUUID } from 'node:crypto';
import { githubExporter } from '../../../server/integrations/githubExporter';
import { writeGitHubRepository } from '../../../server/integrations/githubWriter';
import { verifyGitHubExport } from '../../../server/integrations/githubRecovery';
import { githubExportProvider } from '../../helpers/githubExportProvider';

const issuer = 'https://github-route.supabase.co/auth/v1';
const jwtSecret = 'github-cloud-route-test-cookie-secret-0123456789';
const bridgeSecret = 'ab'.repeat(32), nonce = 'cd'.repeat(32);
const pair = await generateKeyPair('ES256'), jwk = await exportJWK(pair.publicKey);
const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'route-test', alg: 'ES256' }] });

describe('mounted Cloud GitHub API', () => {
  let db: DbLike, app: ReturnType<typeof createApp>, alice: string, bob: string;
  let auth: NonNullable<Parameters<typeof createApp>[2]>['auth'];
  let api: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(async () => {
    const pool = new (newDb().adapters.createPg().Pool)();
    db = { query: async (sql, params) => { const r = await pool.query(sql, params); return { rows: r.rows, rowCount: r.rowCount }; } };
    await applyMigrations(db);
    for (const id of ['alice', 'bob']) {
      await db.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', [id, id + '@example.com', 'unused']);
      await db.query('INSERT INTO identity_links (issuer,subject,user_id) VALUES ($1,$2,$3)', [issuer, id, id]);
    }
    const token = (id: string) => new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'route-test' }).setIssuer(issuer).setAudience('authenticated').setSubject(id).setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    alice = await token('alice'); bob = await token('bob');
    api = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'server-only-token', scope: 'public_repo', token_type: 'bearer' }))
      .mockResolvedValueOnce(Response.json({ id: 42, login: 'fixture-user' }));
    const service = githubCloud(db, { clientId: 'fixture-client', clientSecret: 'fixture-secret', encryptionKey: 'ef'.repeat(32), callbackUrl: 'https://lovable.test/github/callback', allowedOrigin: 'https://lovable.test', fetch: api });
    auth = { db, jwtSecret, quota: new InMemoryQuotaStore(), cloudAuth: makeCloudAuth(db, issuer, keys), cloudGitHub: { service, bridgeSecret } };
    app = createApp({}, null, { rateLimit: () => true, auth });
  });
  const request = (action: string, body?: unknown, token = alice, secret = bridgeSecret) => app.request('/api/cloud-github/' + action, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, [GITHUB_BRIDGE_HEADER]: secret, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  async function start() {
    const response = await request('start', { browserNonce: nonce });
    expect(response.status).toBe(200);
    return new URL((await response.json()).authorizationUrl).searchParams.get('state')!;
  }
  it('runs signed Cloud identity → real Hono → OAuth service → encrypted DB → status/disconnect', async () => {
    const state = await start();
    expect((await request('finish', { browserNonce: nonce, state, code: 'fixture-code' })).status).toBe(200);
    const status = await request('status');
    expect(status.headers.get('Cache-Control')).toBe('no-store');
    expect(await status.json()).toEqual({ connected: true, username: 'fixture-user', githubId: 42, scopes: ['public_repo'] });
    expect(await (await request('status', undefined, bob)).json()).toEqual({ connected: false });
    expect((await request('disconnect', {})).status).toBe(200);
    expect(await (await request('status')).json()).toEqual({ connected: false });
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('rejects another owner’s callback without consuming the valid state', async () => {
    const state = await start(), payload = { browserNonce: nonce, state, code: 'code' };
    expect((await request('finish', payload, bob)).status).toBe(409);
    expect(api).not.toHaveBeenCalled();
    expect((await request('finish', payload)).status).toBe(200);
  });
  it('requires the server bridge key and Cloud auth, never a valid local cookie', async () => {
    expect((await request('start', { browserNonce: nonce }, alice, '')).status).toBe(403);
    expect((await request('status', undefined, 'forged')).status).toBe(401);
    const cookie = await signToken({ sub: 'alice', email: 'alice@example.com', plan: 'free' }, jwtSecret);
    expect((await app.request('/api/cloud-github/status', { headers: { Cookie: 'lov_token=' + cookie, [GITHUB_BRIDGE_HEADER]: bridgeSecret } })).status).toBe(403);
    expect(api).not.toHaveBeenCalled();
    expect((await db.query('SELECT owner_id FROM github_pending')).rows).toHaveLength(0);
  });
  it('rejects owner/callback injection, query parameters and oversized bodies', async () => {
    expect((await request('start', { browserNonce: nonce, ownerId: 'bob' })).status).toBe(400);
    expect((await request('start', { browserNonce: nonce, callbackUrl: 'https://attacker.test' })).status).toBe(400);
    expect((await request('status?owner=bob')).status).toBe(400);
    expect((await request('start', { browserNonce: 'x'.repeat(3000) })).status).toBe(413);
    expect((await request('unknown')).status).toBe(403);
    expect(api).not.toHaveBeenCalled();
  });
  it('keeps the feature disabled by default and refuses configuration without Cloud validation', async () => {
    const disabled = createApp({}, null, { auth: { ...auth!, cloudGitHub: undefined } });
    expect((await disabled.request('/api/cloud-github/status', { headers: { Authorization: 'Bearer ' + alice, [GITHUB_BRIDGE_HEADER]: bridgeSecret } })).status).toBe(403);
    expect(() => createApp({}, null, { auth: { ...auth!, cloudAuth: undefined } })).toThrow('Cloud GitHub requires Cloud authentication');
    expect((await app.request('/api/github/auth', { headers: { Authorization: 'Bearer ' + alice, [GITHUB_BRIDGE_HEADER]: bridgeSecret } })).status).toBe(403);
  });
  it('returns generic storage errors and enforces its per-owner rate limit', async () => {
    app = createApp({}, null, { auth, rateLimit: () => false });
    expect((await request('status')).status).toBe(429);
    app = createApp({}, null, { auth, rateLimit: () => true });
    await db.query('DROP TABLE github_pending');
    const response = await request('status');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'github_connection_unavailable' });
  });
  function bff() {
    const upstream = vi.fn<typeof fetch>(async (url, init) => app.fetch(new Request(url, init)));
    const handler = makeGitHubBff({ baseUrl: 'https://hono.test', callbackUrl: 'https://lovable.test/github/callback', clientId: 'fixture-client', bridgeSecret,
      basicAuth: 'pilot:synthetic-password', verifyToken: async token => !!(await auth!.cloudAuth!.resolve(token)), fetch: upstream });
    const call = (action: string, body?: unknown, cookie = '', token = alice, origin = 'https://lovable.test') => handler(new Request('https://lovable.test/api/github-connect/' + action, {
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    return { call, upstream };
  }
  it('runs browser → BFF with private nonce cookie → Basic/Cloud Hono → GitHub → encrypted DB', async () => {
    const { call, upstream } = bff();
    const started = await call('start', {});
    expect(started.status).toBe(200);
    const cookie = started.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Lax');
    const state = new URL((await started.json()).authorizationUrl).searchParams.get('state');
    const payload = { state, code: 'code' };
    expect((await call('finish', payload, cookie.split(';')[0], bob)).status).toBe(409);
    expect(api).not.toHaveBeenCalled();
    expect((await call('finish', payload, cookie.split(';')[0])).status).toBe(200);
    const response = await call('status');
    expect(await response.json()).toEqual({ connected: true, username: 'fixture-user', githubId: 42, scopes: ['public_repo'] });
    expect(response.headers.get('Set-Cookie')).toBeNull();
    const outgoing = upstream.mock.calls[0][1]!.headers as Record<string, string>;
    expect(outgoing.Authorization).toMatch(/^Basic /);
    expect(outgoing['X-LOV-Cloud-Authorization']).toBe('Bearer ' + alice);
    expect(outgoing.Cookie).toBeUndefined();
    expect((await call('disconnect', {})).headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await (await call('status')).json()).toEqual({ connected: false });
  });
  it('rejects cross-site requests and browser nonce injection before upstream', async () => {
    const { call, upstream } = bff();
    expect((await call('start', {}, '', alice, 'https://attacker.test')).status).toBe(403);
    expect((await call('start', { browserNonce: nonce })).status).toBe(400);
    expect((await call('finish', { state: nonce, code: 'code' })).status).toBe(409);
    expect((await call('status?owner=bob')).status).toBe(404);
    expect((await call('status', undefined, '', 'forged')).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('never forwards unexpected upstream cookies, headers or JSON secrets', async () => {
    const handler = makeGitHubBff({ baseUrl: 'https://hono.test', callbackUrl: 'https://lovable.test/github/callback', clientId: 'fixture-client', bridgeSecret,
      verifyToken: async () => true, fetch: async () => Response.json({ connected: false, token: 'private', bridgeSecret }, { headers: { 'Set-Cookie': 'upstream=secret', 'X-Debug': 'private' } }) });
    const response = await handler(new Request('https://lovable.test/api/github-connect/status', { headers: { Authorization: 'Bearer fixture' } }));
    expect(await response.json()).toEqual({ connected: false });
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('X-Debug')).toBeNull();
  });
  it('reviews server snapshot files and publishes once through authenticated BFF export endpoints', async () => {
    const state = await start();
    expect((await request('finish', { browserNonce: nonce, state, code: 'code' })).status).toBe(200);
    const workspace = { title: 'Export', isPublic: false, liveId: 's1', snapshots: [{ id: 's1', v: 1, prompt: '', kind: 'manual', time: '', html: '<main>Exact</main>' }], files: [] };
    await db.query('INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,$4,$5::jsonb)', ['alice', 'p1', 'Export', 1, JSON.stringify(workspace)]);
    const writer = vi.fn<typeof writeGitHubRepository>().mockResolvedValue({ ok: true, repositoryId: 99, repoFullName: 'fixture-user/export', repoUrl: 'https://github.com/fixture-user/export', commitSha: 'a'.repeat(40), filesUploaded: 1 });
    auth!.cloudGitHub!.exporter = githubExporter(db, auth!.cloudGitHub!.service, writer);
    app = createApp({}, null, { auth, rateLimit: () => true });
    const { call } = bff(), requestId = randomUUID();
    const prepared = await call('export/prepare', { requestId, repoName: 'export', selection: { projectId: 'p1', snapshotId: 's1', expectedRevision: 1 } });
    expect(prepared.status).toBe(200);
    const review = await prepared.json();
    expect(review).toMatchObject({ status: 'prepared', visibility: 'public', username: 'fixture-user', files: [{ path: 'index.html', bytes: 18 }] });
    expect(JSON.stringify(review)).not.toContain('server-only-token');
    expect(writer).not.toHaveBeenCalled();
    expect(await (await call('export/review', { requestId })).json()).toEqual(review);
    expect((await call('export/review', { requestId }, '', bob)).status).toBe(404);
    expect((await call('export/review', { requestId, ownerId: 'alice' })).status).toBe(400);
    const consent = { requestId, fingerprint: review.fingerprint, publicConfirmed: true };
    expect((await call('export/confirm', { ...consent, publicConfirmed: false })).status).toBe(400);
    expect((await call('export/confirm', consent, '', bob)).status).toBe(404);
    const result = await call('export/confirm', consent); expect(result.status).toBe(200);
    const completed = await result.json(); expect(completed).toMatchObject({ status: 'succeeded', result: { ok: true } });
    expect(await (await call('export/confirm', consent)).json()).toEqual(completed);
    expect(await (await call('export/status', { requestId })).json()).toEqual(completed);
    expect(writer).toHaveBeenCalledOnce();
    expect((await call('export/cancel', { requestId, fingerprint: review.fingerprint })).status).toBe(409);
    expect((await call('export/prepare', { requestId: randomUUID(), repoName: 'other', selection: { projectId: 'p1', snapshotId: 's1', expectedRevision: 1 }, files: [] })).status).toBe(400);
  });
  it('cancels a proposal through the BFF, releases its name, and never re-arms old consent', async () => {
    const state = await start();
    expect((await request('finish', { browserNonce: nonce, state, code: 'code' })).status).toBe(200);
    const workspace = { title: 'Export', isPublic: false, liveId: 's1', snapshots: [{ id: 's1', v: 1, prompt: '', kind: 'manual', time: '', html: '<main>Exact</main>' }], files: [] };
    await db.query('INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,$4,$5::jsonb)', ['alice', 'p1', 'Export', 1, JSON.stringify(workspace)]);
    const writer = vi.fn<typeof writeGitHubRepository>();
    auth!.cloudGitHub!.exporter = githubExporter(db, auth!.cloudGitHub!.service, writer);
    app = createApp({}, null, { auth, rateLimit: () => true });
    const { call, upstream } = bff(), requestId = randomUUID();
    const input = { requestId, repoName: 'export', selection: { projectId: 'p1', snapshotId: 's1', expectedRevision: 1 } };
    const review = await (await call('export/prepare', input)).json();
    const cancel = { requestId, fingerprint: review.fingerprint };
    expect((await call('export/cancel', cancel, '', bob)).status).toBe(404);
    expect((await call('export/cancel', { ...cancel, ownerId: 'bob' })).status).toBe(400);
    const cancelled = await call('export/cancel', cancel);
    expect(cancelled.status).toBe(200);
    expect(cancelled.headers.get('Cache-Control')).toBe('no-store');
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled', result: null });
    expect(await (await call('export/confirm', { ...cancel, publicConfirmed: true })).json()).toMatchObject({ status: 'cancelled' });
    expect(await (await call('export/review', { requestId })).json()).toEqual({ error: 'export_not_prepared' });
    expect(await (await call('export/prepare', { ...input, requestId: randomUUID() })).json()).toMatchObject({ status: 'prepared' });
    expect(writer).not.toHaveBeenCalled();
    expect(upstream.mock.calls.every(([, init]) => !(init!.headers as Record<string, string>).Cookie)).toBe(true);
  });
  it('uses Web API UTF-8 Basic encoding without relying on a Worker Buffer global', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ connected: false }));
    const handler = makeGitHubBff({ baseUrl: 'https://hono.test', callbackUrl: 'https://lovable.test/github/callback', clientId: 'fixture-client', bridgeSecret,
      basicAuth: 'pilot:žlté-🔒', verifyToken: async () => true, fetch: fetcher });
    expect((await handler(new Request('https://lovable.test/api/github-connect/status', { headers: { Authorization: 'Bearer fixture' } }))).status).toBe(200);
    const headers = fetcher.mock.calls[0][1]!.headers as Record<string, string>;
    expect(Buffer.from(headers.Authorization.slice(6), 'base64').toString('utf8')).toBe('pilot:žlté-🔒');
  });
  it('accepts a bounded review with 40 long Unicode paths', async () => {
    const requestId = randomUUID();
    const review = { requestId, username: 'fixture', repoName: 'export', fingerprint: 'ab'.repeat(32), status: 'prepared', result: null, visibility: 'public', title: 'Export', version: 1, selection: { projectId: 'p1', snapshotId: 's1', expectedRevision: 1 },
      files: Array.from({ length: 40 }, (_, i) => ({ path: 'src/' + '界'.repeat(185) + i + '.tsx', bytes: 1 })) };
    const handler = makeGitHubBff({ baseUrl: 'https://hono.test', callbackUrl: 'https://lovable.test/github/callback', clientId: 'fixture-client', bridgeSecret,
      verifyToken: async () => true, fetch: async () => Response.json(review) });
    const response = await handler(new Request('https://lovable.test/api/github-connect/export/prepare', { method: 'POST',
      headers: { Authorization: 'Bearer fixture', Origin: 'https://lovable.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, repoName: 'export', selection: { projectId: 'p1', snapshotId: 's1', expectedRevision: 1 } }) }));
    expect(response.status).toBe(200);
    expect((await response.json()).files).toHaveLength(40);
  });
  it('reconciles a lost publication response through the BFF without any new GitHub writes', async () => {
    const state = await start();
    expect((await request('finish', { browserNonce: nonce, state, code: 'code' })).status).toBe(200);
    const workspace = { title: 'Export', isPublic: false, liveId: 's1', snapshots: [{ id: 's1', v: 1, prompt: '', kind: 'manual', time: '', html: '<main>Exact</main>' }], files: [] };
    await db.query('INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,$4,$5::jsonb)', ['alice', 'p1', 'Export', 1, JSON.stringify(workspace)]);
    const remote = githubExportProvider([{ path: 'index.html', content: '<main>Exact</main>' }], true);
    auth!.cloudGitHub!.exporter = githubExporter(db, auth!.cloudGitHub!.service, args => writeGitHubRepository({ ...args, fetch: remote.api }), args => verifyGitHubExport({ ...args, fetch: remote.api }));
    app = createApp({}, null, { auth, rateLimit: () => true });
    const { call } = bff(), requestId = randomUUID();
    const review = await (await call('export/prepare', { requestId, repoName: 'export', selection: { projectId: 'p1', snapshotId: 's1', expectedRevision: 1 } })).json();
    expect(await (await call('export/confirm', { requestId, fingerprint: review.fingerprint, publicConfirmed: true })).json()).toMatchObject({ status: 'failed' });
    const before = remote.api.mock.calls.length;
    expect((await call('export/reconcile', { requestId }, '', bob)).status).toBe(404);
    expect((await call('export/reconcile', { requestId, checkpoint: {} })).status).toBe(400);
    expect((await call('export/reconcile', { requestId }, '', alice, 'https://attacker.test')).status).toBe(403);
    expect(remote.api.mock.calls).toHaveLength(before);
    const checked = await call('export/reconcile', { requestId });
    expect(checked.status).toBe(200);
    expect(checked.headers.get('Cache-Control')).toBe('no-store');
    const result = await checked.json();
    expect(result).toMatchObject({ status: 'succeeded', result: { ok: true, repositoryId: 99, commitSha: remote.commit } });
    expect(result).not.toHaveProperty('checkpoint');
    expect(JSON.stringify(result)).not.toContain('server-only-token');
    expect(remote.api.mock.calls.slice(before).every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(await (await call('export/reconcile', { requestId })).json()).toEqual(result);
    expect(remote.api.mock.calls).toHaveLength(before + 5);
  });
});
