# WS-1 — User auth + trvalé kvóty

## Stav: IMPLEMENTOVANÉ (server + UI gate), auth default VYPNUTÝ (pilot mód zachovaný)

## Čo pribudlo

### Server
| Súbor | Obsah |
|---|---|
| `server/migrations/001_init.sql` | `users` (id TEXT, email UNIQUE, bcrypt hash, plan free/pro), `user_quotas` (mesačné okno, atomic UPSERT), `auth_log` (register/login/failed/logout audit) |
| `server/db/pool.ts` | pg Pool (lazy, OPTIONAL — bez `DATABASE_URL` sa nevytvára) |
| `server/db/migrate.ts` | `npm run db:migrate` CLI + auto-apply pri štarte s `AUTH_ENABLED=1` (idempotentné) |
| `server/auth/passwords.ts` | bcrypt cost 10, email/format validácia |
| `server/auth/tokens.ts` | jose HS256 JWT (7d), CSRF token generátor |
| `server/auth/routes.ts` | `POST /api/auth/register`, `login`, `logout`, `GET /api/auth/me` (user + quota) |
| `server/auth/middleware.ts` | auth middleware: chráni všetko pod `/api` okrem health + auth; mutácie vyžadujú dvojitý CSRF cookie+header; `/api/github/*` má vlastný CSRF → exempt |
| `server/security/quotaStore.ts` | `PostgresQuotaStore` (atomic `INSERT ... ON CONFLICT DO UPDATE`, mesačne okno; Free 10/mes, Pro 200/mes, limit kontrola na RETURNING hodnote) + `InMemoryQuotaStore` fallback |
| `server/security/rateLimit.ts` | async per-user limiter: Redis (ioredis, fail-open) keď `REDIS_URL`, inak in-memory |

### Wiring (`server/index.ts`)
- `AUTH_ENABLED=1` → fail-fast: vyžaduje `DATABASE_URL` + `JWT_SECRET` (≥32 znakov); migrácie sa aplkujú pri štarte
- bez `AUTH_ENABLED` → **žiadna zmena správania** (všetky pôvodné testy prešly bez úprav — okrem 2 assert fixes)
- `/api/agent/generate` + `/api/sandbox/autofix`: per-user rate limit + trvalá kvóta (429 `quota_exceeded` s JSON snapshotom)
- Budget guard (concurrency) zostáva ako DÝ dodatočná ochrana

### UI
- `src/components/LoginScreen.tsx` — responzívny login/register, a11y (role=alert, autocomplete, aria-busy), SK texty
- `src/app/AppShell.tsx` — auth gate: `/api/auth/me` → 401 = LoginScreen, 404 = pilot mód (bez zmeny), 200 = app
- `src/lib/csrf.ts` — `apiHeaders()` pridáva `X-CSRF-Token` do všetkých mutujúcich volaní (ai/client.ts + useAppStore sandbox/build)

## Konfigurácia
```
AUTH_ENABLED=1
DATABASE_URL=postgresql://...
JWT_SECRET=$(openssl rand -hex 32)
REDIS_URL=redis://...         # optional — inak per-user memory limiter
```

## Bezpečnostné rozhodnutia
- Token cookie: `HttpOnly; Secure; SameSite=Lax` (7d)
- CSRF: double-submit cookie (`lov_csrf` readable + `X-CSRF-Token` header), GitHub routes exempt (majú vlastný)
- Kvóty: jediný UPSERT = atomic; limit sa kontroluje na vrátenej hodnote (INCR+check pattern — race maximálne navyší čítač, nikdy nepustí cez limit)
- `auth_log`: minimálny GDPR audit (bez IP)

## Testy (`tests/unit/server/auth.test.ts`, 11 ks — pg-mem)
Migrácie+tabuľky · register/login/409/400/401 · chránené API 401/403/prehесплатné · kvóta Free 10→11 reject · Pro 200 · mesačný reset okna · InMemory fallback · JWT roundtrip · bcrypt · cookie serializácia · public health s auth ON

**Suite: 390 testov zelených, typecheck zelený, build zelený.**

## TODO (WS-1 Stage B — navazujúce)
- [ ] projekty/snapshoty do Postgres (IndexedDB zostáva ako offline cache)
- [ ] password reset (magic link)
- [ ] e-mail notifikácie pri 90 % kvóty
- [ ] `logout_all` (token revocation list)
- [ ] Stripe enforcement plánov (WS-5 napojí plan do kvót — stĺpec `users.plan` už existuje)
