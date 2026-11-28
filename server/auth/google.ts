import { Hono } from 'hono';
import crypto from 'node:crypto';
import type { DbLike } from '../db/pool';
import type { Plan } from '../security/quotaStore';
import { hashPassword } from './passwords';
import { signToken, newCsrfToken } from './tokens';
import { effectivePlan } from './plans';
import { serializeCookie, parseCookie, TOKEN_COOKIE, CSRF_COOKIE } from './routes';

const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const STATE_COOKIE = 'lov_google_oauth_state';

export interface GoogleAuthDeps {
  db: DbLike;
  jwtSecret: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  plan: string;
  plan_expires_at?: unknown;
}

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
  } catch {
    /* Audit log fail-safe */
  }
}

export function googleAuthRouter(deps: GoogleAuthDeps, env: Record<string, string | undefined> = process.env) {
  const router = new Hono();

  const getGoogleConfig = () => {
    const clientId = env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
    const callbackUrl = env.GOOGLE_CALLBACK_URL?.trim() || 'http://localhost:8787/api/auth/google/callback';
    const appUrl = env.LOV_APP_URL?.trim() || '/';
    return {
      clientId,
      clientSecret,
      callbackUrl,
      appUrl,
      configured: Boolean(
        clientId && /^\d+(?:-[\w-]+)?\.apps\.googleusercontent\.com$/.test(clientId) &&
        clientSecret && !/^(?:placeholder|your[_-]|change[_-]?me|example|dummy|replace[_-]|x{3,}$)/i.test(clientSecret)
      )
    };
  };

  router.get('/api/auth/google/status', (c) => {
    const config = getGoogleConfig();
    return c.json({
      configured: config.configured,
      clientId: config.configured ? config.clientId : null
    });
  });

  router.get('/api/auth/google', (c) => {
    const config = getGoogleConfig();
    if (!config.configured || !config.clientId) {
      return c.json({ error: 'google_auth_not_configured' }, 503);
    }

    const state = crypto.randomBytes(32).toString('hex');
    const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', config.callbackUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'online');
    authUrl.searchParams.set('prompt', 'select_account');

    // 10-minute state cookie for CSRF protection
    c.res.headers.append('Set-Cookie', serializeCookie(STATE_COOKIE, state, cookieOpts(600)));
    return c.redirect(authUrl.toString());
  });

  router.get('/api/auth/google/callback', async (c) => {
    const config = getGoogleConfig();
    const code = c.req.query('code');
    const state = c.req.query('state');
    const errorParam = c.req.query('error');

    if (errorParam || !code) {
      return c.redirect(`${config.appUrl}?error=google_auth_denied`);
    }

    const cookieHeader = c.req.header('Cookie') ?? '';
    const storedState = parseCookie(cookieHeader, STATE_COOKIE);

    // Clear state cookie
    c.res.headers.append('Set-Cookie', serializeCookie(STATE_COOKIE, '', { ...cookieOpts(0), maxAge: 0 }));

    if (!storedState || !state || storedState !== state) {
      return c.redirect(`${config.appUrl}?error=invalid_oauth_state`);
    }

    if (!config.configured || !config.clientId || !config.clientSecret) {
      return c.redirect(`${config.appUrl}?error=google_not_configured`);
    }

    // Exchange authorization code for tokens
    const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.callbackUrl,
        grant_type: 'authorization_code'
      }).toString()
    }).catch(() => null);

    if (!tokenRes || !tokenRes.ok) {
      return c.redirect(`${config.appUrl}?error=google_token_exchange_failed`);
    }

    const tokenData = await tokenRes.json().catch(() => null) as { access_token?: string; id_token?: string } | null;
    if (!tokenData?.access_token) {
      return c.redirect(`${config.appUrl}?error=google_token_missing`);
    }

    // Fetch user profile from OpenID Connect userinfo
    const userinfoRes = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    }).catch(() => null);

    if (!userinfoRes || !userinfoRes.ok) {
      return c.redirect(`${config.appUrl}?error=google_profile_fetch_failed`);
    }

    const profile = await userinfoRes.json().catch(() => null) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    } | null;

    if (!profile?.sub || !profile.email || profile.email_verified !== true) {
      return c.redirect(`${config.appUrl}?error=google_email_unverified`);
    }

    const email = profile.email.trim().toLowerCase();
    const subject = profile.sub;

    // 1. Look up user by identity_links (issuer + subject)
    const linkedResult = await deps.db.query(
      `SELECT u.id, u.email, u.password_hash, u.plan, u.plan_expires_at
       FROM identity_links l
       JOIN users u ON u.id = l.user_id
       WHERE l.issuer = $1 AND l.subject = $2`,
      [GOOGLE_ISSUER, subject]
    ) as { rows: UserRow[] };

    let user: UserRow;
    let isNewUser = false;

    if (linkedResult.rows.length > 0) {
      user = linkedResult.rows[0];
    } else {
      // 2. Look up existing user by email
      const emailResult = await deps.db.query(
        'SELECT id, email, password_hash, plan, plan_expires_at FROM users WHERE email = $1',
        [email]
      ) as { rows: UserRow[] };

      if (emailResult.rows.length > 0) {
        user = emailResult.rows[0];
        // Link identity to existing account
        await deps.db.query(
          'INSERT INTO identity_links (issuer, subject, user_id) VALUES ($1, $2, $3) ON CONFLICT (issuer, subject) DO NOTHING',
          [GOOGLE_ISSUER, subject, user.id]
        );
      } else {
        // 3. Create new user and link
        const newUserId = crypto.randomUUID();
        const dummyPasswordHash = await hashPassword(crypto.randomBytes(32).toString('hex'));
        const insertUserResult = await deps.db.query(
          'INSERT INTO users (id, email, password_hash, plan) VALUES ($1, $2, $3, $4) RETURNING id, email, password_hash, plan',
          [newUserId, email, dummyPasswordHash, 'free']
        ) as { rows: UserRow[] };

        user = insertUserResult.rows[0];
        isNewUser = true;

        await deps.db.query(
          'INSERT INTO identity_links (issuer, subject, user_id) VALUES ($1, $2, $3)',
          [GOOGLE_ISSUER, subject, user.id]
        );
      }
    }

    await logAuth(deps.db, user.id, isNewUser ? 'register' : 'login');

    const plan = effectivePlan(user);
    const token = await signToken({ sub: user.id, email: user.email, plan: (plan as Plan) }, deps.jwtSecret);

    c.res.headers.append('Set-Cookie', serializeCookie(TOKEN_COOKIE, token, cookieOpts(7 * 24 * 3600)));
    c.res.headers.append('Set-Cookie', serializeCookie(CSRF_COOKIE, newCsrfToken(), { ...cookieOpts(7 * 24 * 3600), httpOnly: false }));

    return c.redirect(config.appUrl);
  });

  // Direct ID Token / credential exchange (Google Identity Services / One Tap / Firebase)
  router.post('/api/auth/google/credential', async (c) => {
    const config = getGoogleConfig();
    if (!config.configured) return c.json({ error: 'google_auth_not_configured' }, 503);
    const body = await c.req.json().catch(() => null) as { credential?: string; idToken?: string } | null;
    const idToken = body?.credential || body?.idToken;

    if (!idToken) {
      return c.json({ error: 'missing_credential' }, 400);
    }

    // Verify token with Google's tokeninfo endpoint
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`).catch(() => null);
    if (!verifyRes || !verifyRes.ok) {
      return c.json({ error: 'invalid_google_token' }, 401);
    }

    const payload = await verifyRes.json().catch(() => null) as {
      sub?: string;
      email?: string;
      email_verified?: string | boolean;
      aud?: string;
    } | null;

    if (!payload?.sub || !payload.email) {
      return c.json({ error: 'invalid_token_payload' }, 401);
    }

    if (payload.email_verified !== true && payload.email_verified !== 'true') {
      return c.json({ error: 'google_email_unverified' }, 401);
    }
    if (payload.aud !== config.clientId) {
      return c.json({ error: 'audience_mismatch' }, 401);
    }

    const email = payload.email.trim().toLowerCase();
    const subject = payload.sub;

    const linkedResult = await deps.db.query(
      `SELECT u.id, u.email, u.password_hash, u.plan, u.plan_expires_at
       FROM identity_links l
       JOIN users u ON u.id = l.user_id
       WHERE l.issuer = $1 AND l.subject = $2`,
      [GOOGLE_ISSUER, subject]
    ) as { rows: UserRow[] };

    let user: UserRow;
    let isNewUser = false;

    if (linkedResult.rows.length > 0) {
      user = linkedResult.rows[0];
    } else {
      const emailResult = await deps.db.query(
        'SELECT id, email, password_hash, plan, plan_expires_at FROM users WHERE email = $1',
        [email]
      ) as { rows: UserRow[] };

      if (emailResult.rows.length > 0) {
        user = emailResult.rows[0];
        await deps.db.query(
          'INSERT INTO identity_links (issuer, subject, user_id) VALUES ($1, $2, $3) ON CONFLICT (issuer, subject) DO NOTHING',
          [GOOGLE_ISSUER, subject, user.id]
        );
      } else {
        const newUserId = crypto.randomUUID();
        const dummyPasswordHash = await hashPassword(crypto.randomBytes(32).toString('hex'));
        const insertUserResult = await deps.db.query(
          'INSERT INTO users (id, email, password_hash, plan) VALUES ($1, $2, $3, $4) RETURNING id, email, password_hash, plan',
          [newUserId, email, dummyPasswordHash, 'free']
        ) as { rows: UserRow[] };

        user = insertUserResult.rows[0];
        isNewUser = true;

        await deps.db.query(
          'INSERT INTO identity_links (issuer, subject, user_id) VALUES ($1, $2, $3)',
          [GOOGLE_ISSUER, subject, user.id]
        );
      }
    }

    await logAuth(deps.db, user.id, isNewUser ? 'register' : 'login');

    const plan = effectivePlan(user);
    const token = await signToken({ sub: user.id, email: user.email, plan: (plan as Plan) }, deps.jwtSecret);

    c.res.headers.append('Set-Cookie', serializeCookie(TOKEN_COOKIE, token, cookieOpts(7 * 24 * 3600)));
    c.res.headers.append('Set-Cookie', serializeCookie(CSRF_COOKIE, newCsrfToken(), { ...cookieOpts(7 * 24 * 3600), httpOnly: false }));

    return c.json({ user: { id: user.id, email: user.email, plan } });
  });

  return router;
}
