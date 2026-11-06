import type { Context, Next } from 'hono';
import type { DbLike } from '../db/pool';
import type { QuotaStore } from '../security/quotaStore';
import { currentUser, CSRF_COOKIE } from './routes';
import { cloudBearer, CLOUD_AUTH_HEADER, type CloudAuth } from './cloud';
import { isCloudApiRoute } from '../../shared/honoBridge';

/* WS-1 auth middleware — ochraňuje všetko pod /api okrem:
   /api/health, /api/auth/*.
   Mutujúce metódy (POST/PUT/DELETE) navyše vyžadujú dvojitý CSRF token (cookie + header).
   Používa sa IBA keď je auth zapnutý (AUTH_ENABLED=1). */

export interface RequestUser {
  id: string;
  email: string;
  plan: 'free' | 'pro';
}

declare module 'hono' {
  interface ContextVariables {
    authUser: RequestUser;
  }
}

const PUBLIC_PREFIXES = ['/api/health', '/api/auth/'];
/* GitHub routes majú vlastný CSRF + OAuth session mechanizmus — dvojitý token
   tu nekontrolujeme (auth sa však vyžaduje aj pre ne). */
const CSRF_EXEMPT_PREFIXES = ['/api/github/'];

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function makeAuthMiddleware(jwtSecret: string, cloudAuth?: CloudAuth, extraCloudRoute: (method: string, path: string) => boolean = () => false, db?: DbLike) {
  return async (c: Context, next: Next) => {
    const path = c.req.path;
    if (PUBLIC_PREFIXES.some(p => path.startsWith(p))) return next();

    let user: RequestUser | null;
    try { user = await currentUser(c, jwtSecret, cloudAuth, db); }
    catch { return c.json({ error: 'identity_unavailable' }, 503); }
    if (!user) return c.json({ error: 'unauthenticated' }, 401);

    const bearer = cloudBearer(c.req.header('Authorization'), c.req.header(CLOUD_AUTH_HEADER)).present;
    // Cookie-bound OAuth/export flows must not mix Cloud and local identities.
    if (bearer && !isCloudApiRoute(c.req.method, path) && !extraCloudRoute(c.req.method, path)) return c.json({ error: 'cloud_route_unavailable' }, 403);

    const method = c.req.method.toUpperCase();
    if (!bearer && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !CSRF_EXEMPT_PREFIXES.some(p => path.startsWith(p))) {
      const cookieToken = parseCookies(c.req.header('Cookie'))[CSRF_COOKIE];
      const headerToken = c.req.header('X-CSRF-Token');
      if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        return c.json({ error: 'csrf_required' }, 403);
      }
    }
    (c as Context & { set: (k: 'authUser', v: RequestUser) => void }).set('authUser', user);
    return next();
  };
}

/** Helper na čítanie usera v rute (null keď auth vypnutý). */
export function getUserFromContext(c: Context): RequestUser | null {
  try {
    return (c as Context & { get: (k: 'authUser') => RequestUser }).get?.('authUser') ?? null;
  } catch {
    return null;
  }
}

export interface AuthWiring {
  db: DbLike;
  jwtSecret: string;
  quota: QuotaStore;
  cloudAuth?: CloudAuth;
}
