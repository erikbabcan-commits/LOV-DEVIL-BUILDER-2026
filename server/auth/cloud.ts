import { createRemoteJWKSet, jwtVerify, errors, type JWTVerifyGetKey } from 'jose';
import type { DbLike } from '../db/pool';
import type { AuthUser } from './routes';
import { effectivePlan } from './plans';

type CloudIdentity =
  | { state: 'linked'; user: AuthUser }
  | { state: 'invalid' }
  | { state: 'unlinked' };

export interface CloudAuth {
  resolve(token: string): Promise<AuthUser | null>;
  inspect?(token: string): Promise<CloudIdentity>;
}

export const CLOUD_AUTH_HEADER = 'X-LOV-Cloud-Authorization';

export function validateCloudIssuer(issuer: string): void {
  const url = new URL(issuer);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.href !== issuer || !url.pathname.endsWith('/auth/v1')) {
    throw new Error('CLOUD_AUTH_ISSUER must be a canonical HTTPS Auth issuer ending /auth/v1.');
  }
}

/** One operator-configured Cloud tenant. Never discover trust from token claims. */
export function makeCloudAuth(db: DbLike, issuer: string, keys?: JWTVerifyGetKey): CloudAuth {
  validateCloudIssuer(issuer);
  const jwks = keys ?? createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'), {
    timeoutDuration: 5000, cacheMaxAge: 600_000,
  });
  /** Classify only the supplied identity after verifying the configured Cloud tenant. */
  async function inspect(token: string): Promise<CloudIdentity> {
    if (token.length > 16_384) return { state: 'invalid' };
    let subject: string;
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer, audience: 'authenticated', algorithms: ['RS256', 'ES256'],
        requiredClaims: ['exp', 'sub', 'iat', 'role'],
      });
      if (payload.role !== 'authenticated' || payload.is_anonymous === true ||
          typeof payload.iat !== 'number' || payload.iat > Math.floor(Date.now() / 1000) + 30 ||
          typeof payload.sub !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.sub)) return { state: 'invalid' };
      subject = payload.sub;
    } catch (error) {
      if (error instanceof TypeError || error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid ||
          (error instanceof errors.JOSEError && error.code === 'ERR_JOSE_GENERIC')) throw new Error('cloud_identity_unavailable');
      return { state: 'invalid' };
    }
    // Explicit links only. Email and user_metadata never establish identity or a plan.
    // Re-read every request: deleting a link revokes access even before JWT expiry.
    const result = await db.query(`SELECT u.id, u.email, u.plan, u.plan_expires_at FROM identity_links l
      JOIN users u ON u.id = l.user_id WHERE l.issuer = $1 AND l.subject = $2`, [issuer, subject]);
    const row = result.rows[0];
    return row ? { state: 'linked', user: { id: row.id, email: row.email, plan: effectivePlan(row) } }
      : { state: 'unlinked' };
  }
  return {
    inspect,
    async resolve(token) {
      const result = await inspect(token);
      return result.state === 'linked' ? result.user : null;
    },
  };
}

export function bearerToken(header: string | undefined): string | null {
  return header?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1] ?? null;
}

export function hasBearerAuth(header: string | undefined): boolean {
  return /^Bearer(?:\s|$)/i.test(header ?? '');
}

/** Existing Nginx Basic Auth consumes Authorization. A fixed secondary header
 * can carry the independently verified user JWT, only in that transport mode.
 * A malformed/ambiguous Cloud header never falls back to a cookie identity. */
export function cloudBearer(authorization: string | undefined, forwarded: string | undefined): { present: boolean; token: string | null } {
  if (forwarded !== undefined) return {
    present: true,
    token: /^Basic [A-Za-z0-9+/]+=*$/i.test(authorization ?? '') ? bearerToken(forwarded) : null,
  };
  return { present: hasBearerAuth(authorization), token: bearerToken(authorization) };
}
