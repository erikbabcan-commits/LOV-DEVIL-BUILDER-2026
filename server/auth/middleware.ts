import type { Context, Next } from 'hono';
import type { DbLike } from '../db/pool';
import type { QuotaStore } from '../security/quotaStore';
import { currentUser, parseCookie, CSRF_COOKIE } from './routes';

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

export function makeAuthMiddleware(jwtSecret: string) {
  return async (c: Context, next: Next) => {
    const path = c.req.path;
    if (PUBLIC_PREFIXES.some(p => path.startsWith(p))) return next();

    const user = await currentUser(c, jwtSecret);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);

    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !CSRF_EXEMPT_PREFIXES.some(p => path.startsWith(p))) {
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
}
