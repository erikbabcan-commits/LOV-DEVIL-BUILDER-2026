import { createSandboxExecutor, IsolatedExecutor } from './sandbox/executor';
import { allowedOrigins } from './security/oauthPolicy';

/* Production runtime profile for the STANDALONE Hono backend.
   The frontend (Lovable / Vercel static) never runs this process; Vercel Functions
   are not used for AI generation or Docker compilation. This process is the
   long-lived API behind a reverse proxy, with managed PostgreSQL and the isolated
   sandbox runner as separate services.

   NODE_ENV=production is allowed ONLY when every fail-closed prerequisite below
   passes. The gate is never bypassed by deleting the check — it is replaced by an
   explicit, testable checklist (see tests/unit/server/production-runtime.test.ts). */

export function productionRuntimeViolations(env: Readonly<Record<string, string | undefined>>): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const violations: string[] = [];
  const need = (ok: boolean, name: string, detail: string) => { if (!ok) violations.push(`${name}: ${detail}`); };

  /* Durable auth + quotas: no anonymous loopback pilot in production. */
  need(env.AUTH_ENABLED === '1', 'AUTH_ENABLED', 'production requires AUTH_ENABLED=1');
  need(typeof env.DATABASE_URL === 'string' && /^postgres(ql)?:\/\/\S+$/.test(env.DATABASE_URL), 'DATABASE_URL', 'managed PostgreSQL URL required');
  need(typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.length >= 32, 'JWT_SECRET', 'min 32 characters');
  /* Pinned schema: startup verifies instead of running DDL from every instance. */
  need(typeof env.DATABASE_SCHEMA_SHA256 === 'string' && /^[a-f0-9]{64}$/.test(env.DATABASE_SCHEMA_SHA256), 'DATABASE_SCHEMA_SHA256', 'lowercase SHA-256 pin required in production (no uncontrolled migrations at boot)');

  /* Bind/port: explicit, behind the reverse proxy. */
  need(env.BIND === '0.0.0.0', 'BIND', 'production must bind 0.0.0.0 behind the reverse proxy');
  need(typeof env.PORT === 'string' && /^[1-9]\d{0,4}$/.test(env.PORT) && Number(env.PORT) <= 65535, 'PORT', 'explicit listen port required');

  need(env.MOCK_AI !== '1', 'MOCK_AI', 'mock AI provider is not allowed in production');

  /* Explicit HTTPS origin allowlist for CORS and OAuth callbacks. */
  const rawOrigins = (env.GITHUB_ALLOWED_ORIGINS ?? '').trim();
  let origins = new Set<string>();
  if (!rawOrigins) violations.push('GITHUB_ALLOWED_ORIGINS: explicit HTTPS origins required in production');
  else {
    try { origins = allowedOrigins(rawOrigins, true); }
    catch { violations.push('GITHUB_ALLOWED_ORIGINS: entries must be exact HTTPS origins in production'); }
  }
  try {
    const appUrl = new URL(env.LOV_APP_URL ?? '');
    if (appUrl.protocol !== 'https:' || appUrl.username || appUrl.password || appUrl.search || appUrl.hash)
      violations.push('LOV_APP_URL: HTTPS origin required in production');
  } catch { violations.push('LOV_APP_URL: HTTPS origin required in production'); }

  /* GitHub OAuth routes are always mounted, so the encrypted session store is
     required in production even when the OAuth client itself is not configured. */
  need(typeof env.GITHUB_SESSION_DIR === 'string' && env.GITHUB_SESSION_DIR.startsWith('/'), 'GITHUB_SESSION_DIR', 'absolute private directory required in production');
  need(typeof env.GITHUB_SESSION_SECRET === 'string' && /^[a-fA-F0-9]{64}$/.test(env.GITHUB_SESSION_SECRET), 'GITHUB_SESSION_SECRET', '32-byte hex key required in production');
  if (env.GITHUB_CLIENT_ID || env.GITHUB_CLIENT_SECRET) {
    try {
      const cb = new URL(env.GITHUB_CALLBACK_URL ?? '');
      if (cb.protocol !== 'https:' || !origins.has(cb.origin) || cb.pathname !== '/api/github/auth/callback' ||
          cb.search || cb.hash || cb.username || cb.password)
        violations.push('GITHUB_CALLBACK_URL: must be HTTPS, inside GITHUB_ALLOWED_ORIGINS, exact /api/github/auth/callback path');
    } catch { violations.push('GITHUB_CALLBACK_URL: invalid URL'); }
  }

  /* Untrusted code must compile only in the isolated runner — host mode runs in
     the API process and is dev-only. */
  need(env.SANDBOX_MODE !== 'host', 'SANDBOX_MODE', 'host mode is dev-only; production requires the isolated runner');
  need(createSandboxExecutor({ ...env }) instanceof IsolatedExecutor,
    'SANDBOX_RUNNER_URL/SANDBOX_RUNNER_TOKEN', 'valid isolated runner configuration required in production');

  /* Billing and public publish stay OFF until separately verified in production. */
  need(env.BILLING_ENABLED !== '1', 'BILLING_ENABLED', 'stays off until Stripe webhook idempotency and test/live separation are verified');
  need(env.PUBLICPUBLISH_ENABLED !== '1', 'PUBLICPUBLISH_ENABLED', 'stays off until artifact isolation, CSP and withdrawal are verified');

  /* AI generation (if enabled) needs at least one real server-side provider key. */
  if (env.AI_GENERATION_ENABLED !== '0') {
    const hasProvider = Boolean(env.MISTRAL_API_KEY) ||
      (env.AI_OPENAI_ENABLED === '1' && Boolean(env.OPENAI_API_KEY) && Boolean(env.OPENAI_MODEL)) ||
      (env.AI_ANTHROPIC_ENABLED === '1' && Boolean(env.ANTHROPIC_API_KEY) && Boolean(env.ANTHROPIC_MODEL));
    need(hasProvider, 'AI provider key', 'at least one of MISTRAL_API_KEY / OPENAI_API_KEY+OPENAI_MODEL / ANTHROPIC_API_KEY+ANTHROPIC_MODEL');
  }
  return violations;
}

export function assertProductionRuntime(env: Readonly<Record<string, string | undefined>>): void {
  const violations = productionRuntimeViolations(env);
  if (violations.length)
    throw new Error('Production runtime prerequisites missing:\n - ' + violations.join('\n - '));
}
