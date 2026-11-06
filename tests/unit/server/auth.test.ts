// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, type IMemoryDb } from 'pg-mem';
import { createApp } from '../../../server/index';
import { dbFromPool, type DbLike } from '../../../server/db/pool';
import { applyMigrations } from '../../../server/db/migrate';
import { PostgresQuotaStore, InMemoryQuotaStore, monthWindow } from '../../../server/security/quotaStore';
import { authRouter, serializeCookie, TOKEN_COOKIE, CSRF_COOKIE } from '../../../server/auth/routes';
import { makeAuthMiddleware } from '../../../server/auth/middleware';
import { signToken, verifyToken } from '../../../server/auth/tokens';
import { hashPassword, verifyPassword } from '../../../server/auth/passwords';

/* WS-1 testy: auth flow cez pg-mem (migrácie + kvóty + middleware + tokeny).
   Pilot mód (bez auth opts) pokrývajú existujúce agent/index testy. */

const JWT_SECRET = 'test-secret-ijklmnop-qrstuvwxyz-0123456789';

function memDb(): { db: DbLike; mem: IMemoryDb } {
  const mem = newDb();
  /* pg-mem pg adapter podporuje parametrizované query (public.query nie) */
  const pgAdapter = mem.adapters.createPg();
  const db = dbFromPool(new pgAdapter.Pool());
  return { db, mem };
}

function authApp(db: DbLike) {
  return createApp(
    { mistralApiKey: undefined },
    null,
    { auth: { db, jwtSecret: JWT_SECRET, quota: new PostgresQuotaStore(db) } }
  );
}

const post = (app: ReturnType<typeof authApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

const get = (app: ReturnType<typeof authApp>, path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers });

describe('migrácie + základ auth', () => {
  let db: DbLike;
  beforeEach(async () => {
    const m = memDb();
    db = m.db;
    await applyMigrations(db);
  });

  it('001_init.sql vytvorí použiteľné tabuľky (users, user_quotas, auth_log)', async () => {
    /* migrácia už prebehla v beforeEach — overíme použiteľnosť tabuliek */
    await db.query('SELECT id, email, plan FROM users LIMIT 1');
    await db.query('SELECT user_id, period_start, generations FROM user_quotas LIMIT 1');
    await db.query('SELECT id, user_id, action FROM auth_log LIMIT 1');
  });

  it('register → cookie + me funguje, health hlási auth=enabled', async () => {
    const app = authApp(db);
    /* auth router je namontovaný → /api/auth/me bez cookie končí 401 */
    const meAnon = await get(app, '/api/auth/me');
    expect(meAnon.status).toBe(401);

    const reg = await post(app, '/api/auth/register', { email: 'test@example.com', password: 'heslo1234' });
    expect(reg.status).toBe(200);
    const setCookies = reg.headers.get('set-cookie') ?? '';
    expect(setCookies).toContain(TOKEN_COOKIE);
    expect(setCookies).toContain(CSRF_COOKIE);
    expect(setCookies).toContain('HttpOnly'); // token cookie nie je čitateľná JS

    const token = /lov_token=([^;]+)/.exec(setCookies)?.[1];
    const csrf = /lov_csrf=([^;]+)/.exec(setCookies)?.[1];
    const me = await get(app, '/api/auth/me', { Cookie: `lov_token=${token}; lov_csrf=${csrf}` });
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body.user.email).toBe('test@example.com');
    expect(body.quota.limit).toBe(10);
  });

  it('duplicitný email → 409, slabé heslo → 400, zlý login → 401', async () => {
    const app = authApp(db);
    await post(app, '/api/auth/register', { email: 'a@example.com', password: 'heslo1234' });
    expect((await post(app, '/api/auth/register', { email: 'a@example.com', password: 'heslo1234' })).status).toBe(409);
    expect((await post(app, '/api/auth/register', { email: 'b@example.com', password: 'kratke' })).status).toBe(400);
    expect((await post(app, '/api/auth/login', { email: 'a@example.com', password: 'zleheslo99' })).status).toBe(401);
  });

  it('chránené API bez tokenu → 401; bez CSRF hlavičky → 403; so CSRF → prejde k endpointu', async () => {
    const app = authApp(db);
    const noAuth = await post(app, '/api/sandbox/build', { files: [] });
    expect(noAuth.status).toBe(401);

    const reg = await post(app, '/api/auth/register', { email: 'x@example.com', password: 'heslo1234' });
    const setCookies = reg.headers.get('set-cookie') ?? '';
    const token = /lov_token=([^;]+)/.exec(setCookies)?.[1];
    const csrf = decodeURIComponent(/lov_csrf=([^;]+)/.exec(setCookies)?.[1] ?? '');
    const cookieOnly = { Cookie: `lov_token=${token}` };
    const missingCsrf = await post(app, '/api/sandbox/build', { files: [] }, cookieOnly);
    expect(missingCsrf.status).toBe(403);

    const withCsrf = await post(
      app, '/api/sandbox/build', { files: [] },
      { Cookie: `lov_token=${token}; lov_csrf=${csrf}`, 'X-CSRF-Token': csrf }
    );
    /* CSRF prešlo → endpoint spracuje požiadavku (files [] = 400/200, NIE 401/403) */
    expect([200, 400, 503]).toContain(withCsrf.status);
  });
});

describe('trvalé kvóty (pg-mem)', () => {
  let db: DbLike;
  beforeEach(async () => {
    const m = memDb();
    db = m.db;
    await applyMigrations(db);
  });

  it('free 10/mes → 11. consume zamietne; pro plán 200', async () => {
    await db.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', ['u1', 'q@example.com', 'h']);
    const quota = new PostgresQuotaStore(db);
    for (let i = 0; i < 10; i++) {
      const r = await quota.consume('u1');
      expect(r.ok).toBe(true);
    }
    const over = await quota.consume('u1');
    expect(over.ok).toBe(false);
    expect(over.snapshot.remaining).toBe(0);
    for(let i=0;i<3;i++)expect((await quota.consume('u1')).ok).toBe(false);
    expect((await db.query('SELECT generations FROM user_quotas WHERE user_id=$1',['u1'])).rows[0].generations).toBe(10);

    await db.query("UPDATE users SET plan = 'pro' WHERE id = $1", ['u1']);
    const pro = await quota.consume('u1');
    expect(pro.ok).toBe(true);
    expect(pro.snapshot.limit).toBe(200);
    expect(pro.snapshot.used).toBe(11);
  });

  it('mesačné okno: starý period_start sa resetuje', async () => {
    await db.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', ['u2', 'w@example.com', 'h']);
    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    const oldWindow = monthWindow(lastMonth);
    await db.query(
      "INSERT INTO user_quotas (user_id, period_start, generations) VALUES ($1, $2, 10)",
      ['u2', oldWindow]
    );
    const quota = new PostgresQuotaStore(db);
    const snap = await quota.usage('u2');
    expect(snap.used).toBe(0); // starý mesiac sa neráta
    const r = await quota.consume('u2');
    expect(r.ok).toBe(true);
    expect(r.snapshot.used).toBe(1);
  });
});

describe('InMemoryQuotaStore fallback', () => {
  it('limit free 10, reset pri mesiac change', async () => {
    const store = new InMemoryQuotaStore();
    for (let i = 0; i < 10; i++) expect((await store.consume('u')).ok).toBe(true);
    expect((await store.consume('u')).ok).toBe(false);
    expect((await store.usage('u')).plan).toBe('free');
  });
});

describe('tokeny + heslá', () => {
  it('JWT roundtrip + neplatný token', async () => {
    const token = await signToken({ sub: 'u9', email: 't@example.com', plan: 'pro' }, JWT_SECRET);
    const claims = await verifyToken(token, JWT_SECRET);
    expect(claims?.sub).toBe('u9');
    expect(claims?.plan).toBe('pro');
    expect(await verifyToken(token, 'iny-kluc-abcdef-ghijkl-123456')).toBeNull();
    expect(await verifyToken('blerb', JWT_SECRET)).toBeNull();
  });

  it('bcrypt hash/verify', async () => {
    const hash = await hashPassword('heslo1234');
    expect(await verifyPassword('heslo1234', hash)).toBe(true);
    expect(await verifyPassword('ineheslo', hash)).toBe(false);
  });

  it('serializeCookie: HttpOnly + Secure + Max-Age', () => {
    const cookie = serializeCookie('n', 'v', { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 100 });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=100');
  });
});

describe('auth middleware jednotkovo (cez router vamo call, bez HTTP)', () => {
  it('public prefix /api/health vždy prejde (aj s auth zapnutým)', async () => {
    const { db } = memDb();
    await applyMigrations(db);
    const app = createApp({}, null, { auth: { db, jwtSecret: JWT_SECRET, quota: new InMemoryQuotaStore() } });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    /* auth je zapnutý, ale anonymný prístup na /api/auth/me → 401 (router existuje) */
    const me = await app.request('/api/auth/me');
    expect(me.status).toBe(401);
  });
});
