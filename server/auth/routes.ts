import { Hono } from 'hono';
import { z } from 'zod';
import type { DbLike } from '../db/pool';
import type { QuotaStore, Plan } from '../security/quotaStore';
import { hashPassword, verifyPassword, isValidEmail, isStrongEnoughPassword } from './passwords';
import { signToken, verifyToken, newCsrfToken } from './tokens';
import { cloudBearer, CLOUD_AUTH_HEADER, type CloudAuth } from './cloud';
import { effectivePlan } from './plans';

/* WS-1 Auth routes: /api/auth/register | login | logout | me
   Cookie policy: lov_token = httpOnly JWT; lov_csrf = readable double-submit token.
   verejné sú IBA tieto cesty + /api/health (všetko ostatné chráni middleware). */

export const TOKEN_COOKIE = 'lov_token';
export const CSRF_COOKIE = 'lov_csrf';

export interface AuthDeps {
  db: DbLike;
  jwtSecret: string;
  quota: QuotaStore;
  cloudAuth?: CloudAuth;
}

export interface AuthUser {
  id: string;
  email: string;
  plan: Plan;
}

const CredentialsSchema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(8).max(128)
});

interface UserRow { id: string; email: string; password_hash: string; plan: string; plan_expires_at?: unknown }
type Query = (sql: string, params: unknown[]) => Promise<{ rows: UserRow[] }>;

const ROW = (db: DbLike): Query => (sql, params) => db.query(sql, params) as Promise<{ rows: UserRow[] }>;

function cookieOpts(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: maxAgeSeconds
  };
}

async function logAuth(db: DbLike, userId: string | null, action: 'register' | 'login' | 'login_failed' | 'logout'): Promise<void> {
  try {
    await db.query('INSERT INTO auth_log (id, user_id, action) VALUES ($1, $2, $3)', [crypto.randomUUID(), userId, action]);
  } catch { /* audit log nesmie zablokovať auth flow */ }
}

export function authRouter(deps: AuthDeps) {
  const q = ROW(deps.db);
  const router = new Hono();

  router.post('/api/auth/register', async (c) => {
    const parsed = CredentialsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_credentials_format' }, 400);
    const email = parsed.data.email.trim().toLowerCase();
    if (!isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400);
    if (!isStrongEnoughPassword(parsed.data.password)) return c.json({ error: 'weak_password' }, 400);

    const existing = await q('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return c.json({ error: 'email_taken' }, 409);

    const passwordHash = await hashPassword(parsed.data.password);
    const userId = crypto.randomUUID();
    const inserted = await q(
      'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, plan',
      [userId, email, passwordHash]
    );
    const user = inserted.rows[0];
    await logAuth(deps.db, user.id, 'register');

    const token = await signToken({ sub: user.id, email: user.email, plan: (user.plan as Plan) }, deps.jwtSecret);
    c.res.headers.append('Set-Cookie', serializeCookie(TOKEN_COOKIE, token, cookieOpts(7 * 24 * 3600)));
    c.res.headers.append('Set-Cookie', serializeCookie(CSRF_COOKIE, newCsrfToken(), { ...cookieOpts(7 * 24 * 3600), httpOnly: false }));
    return c.json({ user: { id: user.id, email: user.email, plan: user.plan } });
  });

  router.post('/api/auth/login', async (c) => {
    const parsed = CredentialsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_credentials_format' }, 400);
    const email = parsed.data.email.trim().toLowerCase();

    const found = await q('SELECT id, email, password_hash, plan, plan_expires_at FROM users WHERE email = $1', [email]);
    const user = found.rows[0];
    if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      await logAuth(deps.db, user?.id ?? null, 'login_failed');
      return c.json({ error: 'invalid_credentials' }, 401);
    }
    await logAuth(deps.db, user.id, 'login');

    const plan = effectivePlan(user);
    const token = await signToken({ sub: user.id, email: user.email, plan }, deps.jwtSecret);
    c.res.headers.append('Set-Cookie', serializeCookie(TOKEN_COOKIE, token, cookieOpts(7 * 24 * 3600)));
    c.res.headers.append('Set-Cookie', serializeCookie(CSRF_COOKIE, newCsrfToken(), { ...cookieOpts(7 * 24 * 3600), httpOnly: false }));
    return c.json({ user: { id: user.id, email: user.email, plan } });
  });

  router.post('/api/auth/logout', async (c) => {
    const userId = await currentUserId(c, deps.jwtSecret);
    if (userId) await logAuth(deps.db, userId, 'logout');
    c.res.headers.append('Set-Cookie', serializeCookie(TOKEN_COOKIE, '', { ...cookieOpts(0), maxAge: 0 }));
    c.res.headers.append('Set-Cookie', serializeCookie(CSRF_COOKIE, '', { ...cookieOpts(0), httpOnly: false, maxAge: 0 }));
    return c.json({ ok: true });
  });

  router.get('/api/auth/me', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const bearer = cloudBearer(c.req.header('Authorization'), c.req.header(CLOUD_AUTH_HEADER));
      let user: AuthUser | null;
      if (bearer.token && deps.cloudAuth?.inspect) {
        const identity = await deps.cloudAuth.inspect(bearer.token);
        if (identity.state === 'unlinked')
          return c.json({ error: 'cloud_identity_unlinked' }, 401);
        user = identity.state === 'linked' ? identity.user : null;
      } else {
        user = await currentUser(c, deps.jwtSecret, deps.cloudAuth, deps.db);
      }
      if (!user) return c.json({ error: 'unauthenticated' }, 401);
      const quota = await deps.quota.usage(user.id);
      return c.json({ user, quota });
    } catch { return c.json({ error: 'identity_unavailable' }, 503); }
  });

  return router;
}

export async function currentUser(
  c: { req: { header(name: string): string | undefined } },
  jwtSecret: string,
  cloudAuth?: CloudAuth,
  db?: DbLike
): Promise<AuthUser | null> {
  const bearer = cloudBearer(c.req.header('Authorization'), c.req.header(CLOUD_AUTH_HEADER));
  if (bearer.present) {
    return bearer.token && cloudAuth ? cloudAuth.resolve(bearer.token) : null;
  }
  const cookieHeader = c.req.header('Cookie') ?? '';
  const token = parseCookie(cookieHeader, TOKEN_COOKIE);
  if (!token) return null;
  const claims = await verifyToken(token, jwtSecret);
  if (!claims) return null;
  if (db) {
    const result = await db.query('SELECT id, email, plan, plan_expires_at FROM users WHERE id=$1', [claims.sub]);
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email, plan: effectivePlan(row) } : null;
  }
  throw new Error('identity_database_required');
}

async function currentUserId(c: { req: { header(name: string): string | undefined } }, jwtSecret: string): Promise<string | null> {
  const token = parseCookie(c.req.header('Cookie') ?? '', TOKEN_COOKIE);
  return token ? (await verifyToken(token, jwtSecret))?.sub ?? null : null;
}

/* ---------- cookie helpers (bez.rate závislostí) ---------- */
export function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function serializeCookie(name: string, value: string, opts: { httpOnly: boolean; secure: boolean; sameSite: 'Lax' | 'Strict'; path: string; maxAge: number }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path}`, `SameSite=${opts.sameSite}`];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  return parts.join('; ');
}
