// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, errors } from 'jose';
import { newDb } from 'pg-mem';
import { dbFromPool } from '../../../server/db/pool';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import { makeCloudAuth } from '../../../server/auth/cloud';
import { createApp } from '../../../server/index';
import { applyMigrations } from '../../../server/db/migrate';
import { InMemoryQuotaStore } from '../../../server/security/quotaStore';
import { signToken } from '../../../server/auth/tokens';
import { isCloudApiRoute } from '../../../shared/honoBridge';
import { linkCloudIdentity } from '../../../server/auth/linkIdentity';
import type { DbLike } from '../../../server/db/pool';

const issuer = 'https://cloud-auth-test.supabase.co/auth/v1';
const secret = 'cloud-cookie-test-secret-01234567890123456789';
const pair = await generateKeyPair('ES256');
const publicKey = await exportJWK(pair.publicKey);
const keys = createLocalJWKSet({ keys: [{ ...publicKey, kid: 'test-key', alg: 'ES256' }] });
const workspace = { title: 'Cloud project', isPublic: false, liveId: null, snapshots: [], files: [] };
async function token(claims: Record<string, unknown> = {}, tokenIssuer = issuer) {
  return new SignJWT({ role: 'authenticated', email: 'alice@example.com', user_metadata: { plan: 'pro', id: 'bob' },
    iss: tokenIssuer, aud: 'authenticated', sub: 'cloud-alice', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).sign(pair.privateKey);
}

describe('Lovable Cloud identity bridge', () => {
  let db: DbLike;
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    const mem = newDb();
    registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)();
    db = dbFromPool(pool);
    await applyMigrations(db);
    for (const id of ['alice', 'bob']) await db.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', [id, id + '@example.com', 'unused-test-hash']);
    await db.query('INSERT INTO identity_links (issuer,subject,user_id) VALUES ($1,$2,$3)', [issuer, 'cloud-alice', 'alice']);
    app = createApp({}, null, { rateLimit: () => true, auth: { db, jwtSecret: secret, quota: new InMemoryQuotaStore(), cloudAuth: makeCloudAuth(db, issuer, keys) } });
  });
  it('uses the linked internal account and database plan, without trusting email or metadata', async () => {
    const response = await app.request('/api/auth/me', { headers: { Authorization: 'Bearer ' + await token() } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.json()).user).toEqual({ id: 'alice', email: 'alice@example.com', plan: 'free' });
    await db.query("UPDATE users SET plan='pro' WHERE id='alice'");
    const changed = await app.request('/api/auth/me', { headers: { Authorization: 'Bearer ' + await token() } });
    expect((await changed.json()).user.plan).toBe('pro');
  });
  it('persists through the real Hono API as Alice, preserving owner isolation and CAS', async () => {
    const bearer = await token();
    const save = (revision: number) => app.request('/api/projects/cloud-project', { method: 'POST', headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, workspace }) });
    expect((await save(0)).status).toBe(201);
    expect((await save(0)).status).toBe(409);
    const bob = await signToken({ sub: 'bob', email: 'bob@example.com', plan: 'free' }, secret);
    expect((await app.request('/api/projects/cloud-project', { headers: { Cookie: 'lov_token=' + bob } })).status).toBe(404);
    expect((await app.request('/api/projects/cloud-project', { headers: { Authorization: 'Bearer ' + bearer } })).status).toBe(200);
    // Cookie auth still requires CSRF; verified bearer auth never relies on a cookie.
    expect((await app.request('/api/projects/x', { method: 'POST', headers: { Cookie: 'lov_token=' + bob, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0, workspace }) })).status).toBe(403);
  });
  it('revokes a binding immediately and never links another subject by identical email', async () => {
    await db.query('DELETE FROM identity_links WHERE user_id=$1', ['alice']);
    expect((await app.request('/api/auth/me', { headers: { Authorization: 'Bearer ' + await token() } })).status).toBe(401);
    expect((await db.query('SELECT id FROM users')).rows).toHaveLength(2);
  });
  it('rejects forged, wrong-issuer, wrong-audience, expired, anonymous and service-role tokens', async () => {
    const invalid = [await token({}, 'https://other.supabase.co/auth/v1'), await token({ aud: 'other' }),
      await token({ role: 'service_role' }), await token({ is_anonymous: true }), await token({ exp: 1 }),
      await token({ exp: undefined }), await token({ sub: undefined }), await token({ iat: undefined }),
      await token({ iat: Math.floor(Date.now() / 1000) + 300 }), await token({ sub: 'unlinked', email: 'alice@example.com' })];
    invalid.push(await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer).setAudience('authenticated').setSubject('cloud-alice').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(secret)));
    const forgedKey = await generateKeyPair('ES256');
    invalid.push(await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).setIssuer(issuer).setAudience('authenticated').setSubject('cloud-alice').setIssuedAt().setExpirationTime('5m').sign(forgedKey.privateKey));
    invalid.push('invalid.token.signature');
    // Invalid Bearer must never fall back to a valid cookie.
    const cookie = await signToken({ sub: 'bob', email: 'bob@example.com', plan: 'pro' }, secret);
    for (const value of invalid) expect((await app.request('/api/projects', { headers: { Authorization: 'Bearer ' + value, Cookie: 'lov_token=' + cookie } })).status).toBe(401);
  });
  it('fails closed without Cloud wiring or with missing identity storage', async () => {
    const disabled = createApp({}, null, { auth: { db, jwtSecret: secret, quota: new InMemoryQuotaStore() } });
    const headers = { Authorization: 'Bearer ' + await token() };
    expect((await disabled.request('/api/auth/me', { headers })).status).toBe(401);
    await db.query('DROP TABLE identity_links');
    expect((await app.request('/api/auth/me', { headers })).status).toBe(503);
    expect((await app.request('/api/projects', { headers })).status).toBe(503);
  });
  it('restricts Cloud routes and rejects unsafe trust configuration', async () => {
    const headers = { Authorization: 'Bearer ' + await token() };
    expect((await app.request('/api/github/status', { headers })).status).toBe(403);
    expect(isCloudApiRoute('POST', '/api/projects')).toBe(false);
    expect(isCloudApiRoute('PUT', '/api/projects/a')).toBe(false);
    expect(isCloudApiRoute('GET', '/api/projects/a/snapshots')).toBe(false);
    expect(isCloudApiRoute('POST', '/api/sandbox/autofix')).toBe(true);
    for (const value of ['http://test/auth/v1', issuer + '/', issuer + '?key=bad', 'https://user:pass@test/auth/v1']) expect(() => makeCloudAuth(db, value, keys)).toThrow();
  });
  it('supports the existing Basic Auth transport without weakening JWT or cookie checks', async () => {
    const bearer = await token();
    const basic = 'Basic ' + btoa('pilot:synthetic-test-password');
    const headers = { Authorization: basic, 'X-LOV-Cloud-Authorization': 'Bearer ' + bearer };
    expect((await (await app.request('/api/auth/me', { headers })).json()).user.id).toBe('alice');
    const cookie = await signToken({ sub: 'bob', email: 'bob@example.com', plan: 'pro' }, secret);
    for (const authorization of [undefined, 'Bearer ' + bearer, basic]) {
      const response = await app.request('/api/projects', { headers: { ...(authorization ? { Authorization: authorization } : {}), 'X-LOV-Cloud-Authorization': 'Bearer invalid.token', Cookie: 'lov_token=' + cookie } });
      expect(response.status).toBe(401);
    }
    expect((await app.request('/api/github/status', { headers })).status).toBe(403);
    const saved = await app.request('/api/projects/transport', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0, workspace }) });
    expect(saved.status).toBe(201);
  });
  it('reports key-service outages as unavailable rather than logging out a valid identity', async () => {
    const cloudAuth = makeCloudAuth(db, issuer, async () => { throw new errors.JWKSTimeout(); });
    const unavailable = createApp({}, null, { auth: { db, jwtSecret: secret, quota: new InMemoryQuotaStore(), cloudAuth } });
    for (const path of ['/api/auth/me', '/api/projects']) {
      const response = await unavailable.request(path, { headers: { Authorization: 'Bearer ' + await token() } });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'identity_unavailable' });
    }
  });
  it('prepares explicit operator links read-only and applies them idempotently', async () => {
    const input = { issuer, subject: 'cloud-bob', userId: 'bob' };
    expect(await linkCloudIdentity(db, input)).toBe('would_link');
    expect((await db.query('SELECT user_id FROM identity_links')).rows).toHaveLength(1);
    expect(await linkCloudIdentity(db, input, true)).toBe('created');
    expect(await linkCloudIdentity(db, input, true)).toBe('unchanged');
    expect(await linkCloudIdentity(db, { ...input, userId: 'alice' }, true)).toBe('conflict');
    expect(await linkCloudIdentity(db, { ...input, subject: 'other-bob' }, true)).toBe('conflict');
    expect(await linkCloudIdentity(db, { ...input, userId: 'missing' })).toBe('user_not_found');
    await expect(linkCloudIdentity(db, { ...input, subject: '../bad' }, true)).rejects.toThrow('invalid_identity_id');
  });
});
