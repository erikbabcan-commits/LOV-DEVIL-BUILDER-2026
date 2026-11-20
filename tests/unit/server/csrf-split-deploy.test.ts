// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { createApp, makeMockProvider } from '../../../server/index';
import { dbFromPool } from '../../../server/db/pool';
import { applyMigrations } from '../../../server/db/migrate';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import { signToken } from '../../../server/auth/tokens';
import { InMemoryQuotaStore } from '../../../server/security/quotaStore';
import { InMemoryAiUsageStore } from '../../../server/usage/store';

/* TIC TAC P2: SameSite/CSRF for a split deploy (frontend and API on different origins).
   The API authenticates the browser with an ambient cookie (lov_token, HttpOnly, Secure, SameSite=Lax)
   and CORS allows credentials only for the trusted frontend origins. Defenses on state-changing routes:
   double-submit token (lov_csrf cookie + X-CSRF-Token header), Origin allow-list, and (new) a Referer /
   Sec-Fetch-Site check when Origin is missing. A cookie alone never authorizes a mutation. */
const secret = 'csrf-split-deploy-secret-0123456789012345678901';
const TRUSTED = 'http://localhost:5173';
const pools: Array<{ end(): Promise<void> }> = [];
afterEach(async () => { while (pools.length) await pools.pop()!.end(); });

async function setup() {
  const mem = newDb(); registerProjectByteLength(mem);
  const pool = new (mem.adapters.createPg().Pool)(); pools.push(pool);
  const db = dbFromPool(pool); await applyMigrations(db);
  await db.query(`INSERT INTO users (id, email, password_hash) VALUES ('alice', 'alice@example.test', 'x')`);
  const app = createApp({}, makeMockProvider(), { rateLimit: () => true,
    auth: { db, jwtSecret: secret, quota: new InMemoryQuotaStore(), usage: new InMemoryAiUsageStore() }, agentJobs: { workerEnabled: false, startWorker: false } });
  const token = await signToken({ sub: 'alice', email: 'alice@example.test', plan: 'free' }, secret);
  /** A state-changing, auth-protected route that answers 200 when admitted. */
  const mutate = (headers: Record<string, string>) => app.request(new Request('http://localhost/api/ai-router/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ prompt: 'x' }) }));
  const session = { Cookie: `lov_token=${token}; lov_csrf=tok` };
  const full = { ...session, 'X-CSRF-Token': 'tok' };
  return { app, mutate, session, full };
}
const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;

describe('session cookies (split deploy)', () => {
  it('lov_token is HttpOnly + Secure + SameSite=Lax and lov_csrf is SameSite=Lax; never SameSite=None', async () => {
    const mem = newDb(); registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)(); pools.push(pool);
    const db = dbFromPool(pool); await applyMigrations(db);
    const app = createApp({}, makeMockProvider(), { rateLimit: () => true, auth: { db, jwtSecret: secret, quota: new InMemoryQuotaStore() } });
    const res = await app.request(new Request('http://localhost/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: TRUSTED },
      body: JSON.stringify({ email: 'new@example.test', password: 'heslo12345' }) }));
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    const session = cookies.find(c => c.startsWith('lov_token='))!, csrf = cookies.find(c => c.startsWith('lov_csrf='))!;
    expect(session).toMatch(/HttpOnly/i); expect(session).toMatch(/Secure/i); expect(session).toMatch(/SameSite=Lax/i);
    expect(csrf).toMatch(/SameSite=Lax/i); expect(csrf).not.toMatch(/HttpOnly/i);
    for (const c of cookies) expect(c).not.toMatch(/SameSite=None/i);
  });
});

describe('a cookie alone never authorizes a state change', () => {
  it('session cookie without X-CSRF-Token: 403 csrf_required (also from a trusted origin)', async () => {
    const t = await setup();
    const variants: Array<Record<string, string>> = [{}, { Origin: TRUSTED }];
    for (const extra of variants) {
      const res = await t.mutate({ ...t.session, ...extra });
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe('csrf_required');
    }
  });
  it('mismatched double-submit token: 403', async () => {
    const t = await setup();
    expect((await t.mutate({ ...t.session, 'X-CSRF-Token': 'other' })).status).toBe(403);
  });
});

describe('cross-site requests are refused even with a matching token', () => {
  it.each([
    ['untrusted Origin', { Origin: 'https://evil.example' }],
    ['opaque Origin null', { Origin: 'null' }],
    ['sibling subdomain Origin', { Origin: 'https://evil.localhost:5173' }],
    ['no Origin, untrusted Referer', { Referer: 'https://evil.example/page' }],
    ['no Origin, invalid Referer', { Referer: 'not a url' }],
    ['no Origin, Sec-Fetch-Site cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['no Origin, Sec-Fetch-Site same-site (sibling subdomain)', { 'Sec-Fetch-Site': 'same-site' }],
  ])('%s → 403 origin_not_allowed', async (_name, headers) => {
    const t = await setup();
    const res = await t.mutate({ ...t.full, ...headers });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('origin_not_allowed');
  });

  it('login is protected the same way (no login CSRF from another site)', async () => {
    const t = await setup();
    const attacks: Array<Record<string, string>> = [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Referer: 'https://evil.example/' }];
    for (const headers of attacks) {
      const res = await t.app.request(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ email: 'alice@example.test', password: 'whatever1' }) }));
      expect(res.status).toBe(403);
    }
  });
});

describe('legitimate requests still work', () => {
  it.each([
    ['trusted Origin', { Origin: TRUSTED }],
    ['no Origin, trusted Referer', { Referer: TRUSTED + '/editor' }],
    ['same-origin fetch metadata', { 'Sec-Fetch-Site': 'same-origin' }],
    ['non-browser client (no Origin/Referer/Sec-Fetch-Site)', {}],
  ])('%s + matching double-submit token → 200', async (_name, headers) => {
    const t = await setup();
    expect((await t.mutate({ ...t.full, ...headers })).status).toBe(200);
  });

  it('safe methods are not affected by Referer / Sec-Fetch-Site', async () => {
    const t = await setup();
    const res = await t.app.request(new Request('http://localhost/api/health', { headers: { Referer: 'https://evil.example/', 'Sec-Fetch-Site': 'cross-site' } }));
    expect(res.status).toBe(200);
  });
});

describe('CORS is not weakened', () => {
  it('credentials are allowed only for a trusted origin; an untrusted preflight gets no CORS grant', async () => {
    const t = await setup();
    const ok = await t.app.request('/api/ai-router/preview', { method: 'OPTIONS', headers: { Origin: TRUSTED, 'Access-Control-Request-Method': 'POST' } });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(TRUSTED);
    expect(ok.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    const bad = await t.app.request('/api/ai-router/preview', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(bad.headers.get('Access-Control-Allow-Credentials')).not.toBe('true');
  });
});
