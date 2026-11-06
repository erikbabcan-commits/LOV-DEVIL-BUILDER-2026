import { SignJWT, jwtVerify } from 'jose';

/* WS-1 tokeny — HS256 JWT s mierne dlhou expiráciou; uložené výhradne v
   httpOnly cookie (server nastavuje), CSRF cez dvojitý token (cookie + header). */

export interface AuthClaims {
  sub: string;        // user id
  email: string;
  plan: 'free' | 'pro';
}

const ISSUER = 'lov-devil-forge';
const TOKEN_TTL = '7d';

function secretKey(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret);
}

export async function signToken(claims: AuthClaims, jwtSecret: string): Promise<string> {
  return new SignJWT({ email: claims.email, plan: claims.plan })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secretKey(jwtSecret));
}

export async function verifyToken(token: string, jwtSecret: string): Promise<AuthClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(jwtSecret), { issuer: ISSUER });
    if (!payload.sub || typeof payload.email !== 'string') return null;
    const plan = payload.plan === 'pro' ? 'pro' : 'free';
    return { sub: payload.sub, email: payload.email, plan };
  } catch {
    return null;
  }
}

/** CSRF dvojitý token — náhodný hex viazaný na session cookie (nepodpisovaný,
    porovnáva sa priPOST/PUT/DELETE). */
export function newCsrfToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
