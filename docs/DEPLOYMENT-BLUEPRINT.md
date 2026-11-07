# 🚢 DEPLOYMENT BLUEPRINT — VPS / Railway / Render

> WS-4 (5. 11. 2026): pre izolovanú kompiláciu platí aktuálny postup v
> `docs/WS-4-SANDBOX.md` a voliteľný `deploy/compose.sandbox.yaml`.
> Tento starší blueprint nepopisuje aktuálne produkčné nginx/`lov-net` zapojenie.
> Produkcia sa pri WS-4 nemenila; existujúci `vps-redeploy.sh` nové zapojenie nerieši.

> Kompletný návrh hostingu full backendu pre LOV-DEVIL BUILDER 2026.
> Vygenerované súbory: `deploy/Dockerfile`, `deploy/Dockerfile.web`,
> `deploy/Caddyfile`, `deploy/Caddyfile.managed`, `deploy/compose.yaml`,
> `deploy/.env.example`, `render.yaml`, `railway.json`, `.dockerignore`.

---

## 1. Audit — čo už máme a čo NEz minulosti

| Čo som hľadal | Výsledok |
|---|---|
| `vercel.json` / hostingová adresa | ❌ neexistuje nikde |
| Staré deploy env (história gitu) | ❌ žiadne — história obsahuje jedine šablónu `server/.env.example` (žiadne reálne kľúče neboli nikdy commited) |
| Dockerfile / docker-compose | ❌ neexistoval → **vygenerované** |
| Deploy CI (workflows) | ❌ `.github/workflows/ci.yml` spúšťa len testy |
| `docs/RELEASE-PREFLIGHT.md` | preflight check nenašiel žiadny naviazaný Vercel projekt / produkčnú URL |

**Záver:** projekt nikdy nebol nasadený — deployment infraštruktúru generujeme od nuly.

## 2. Kľúčové technické obmedzenia (poznaj ich pred deployom)

1. **Server binduje `127.0.0.1`** → v Dockeri musí bindnúť `0.0.0.0`.
   ✅ Riešené: `server/index.ts` číta `BIND` env (patch: `bind: process.env.BIND ?? '127.0.0.1'`; lokálne správanie bez zmeny).
2. **Production guard:** `server/index.ts` zámerne **vyhodí chybu pri `NODE_ENV=production`**
   (`Public deployment blocked: auth and durable quotas not configured`) a navyše
   `aiAllowed()` vypína AI generovanie pri `publicDeployment=true`.
   ➡️ **Pravidlo: na deploy NIKDY nenastavuj `NODE_ENV=production`**, kým sa nedokrúti
   auth + trvanlivé kvóty (roadmap nižšie). Suit sa nasadzuje ako „privátny pilot".
3. **SSE streaming** (`/api/agent/generate`) → potrebný long-running proces,
   **serverless (Vercel/Cloudflare Workers) nespĺňa** → preto VPS/Railway/Render.
4. **UI volá relatívne `/api`** (`VITE_API_API_BASE` default prázdne) → najčistejšie
   je **same-origin**: UI a `/api` za jedným reverse proxom (Caddy) — bez CORS boja.
5. **Rate limit a budget guard sú in-memory** (10 req/min, 2 concurrent, 30 runov/deň)
   → pri reboote sa resetnú. Pre multi-replica nestačí (neplánuj).
6. **GitHub session súbory** (`GITHUB_SESSION_DIR`) → ephemeral disk ich zje pri
   redeployi → potrebný **volume** (VPS compose / Railway volume / Render disk).

## 3. Cieľová architektúra (rovnaká pre všetky tri platformy)

```
                Internet (HTTPS)
                       │
          ┌────────────▼─────────────┐
          │  Caddy (web)             │  TLS terminácia, auto Let's Encrypt
          │  • servuje React dist     │  (alebo platform TLS: Railway/Render)
          │  • /api/* → app:8787     │  ← same-origin, žiadne CORS
          └────────────┬─────────────┘
                       │ (interný sieť, 0.0.0.0:8787)
          ┌────────────▼─────────────┐
          │  Hono API (app)          │  tsx runtime, SSE streaming
          │  • /api/agent/generate   │──→ Mistral API (reálny kľúč)
          │  • /api/sandbox/build    │
          │  • /api/github/* (OAuth) │──→ GitHub OAuth
          │  • /api/health           │
          │  • sessionStore → volume │
          └─────────────────────────┘
```

## 4. Kompletná env matica

| Premenná | Povinná | Dev (lokál) | Prod (deploy) | Poznámka |
|---|---|---|---|---|
| `MISTRAL_API_KEY` | ✅ (pre AI) | v `.env` | platform secrets / root `.env` | nikdy do klienta |
| `MISTRAL_MODEL` | – | `mistral-large-latest` | `mistral-large-latest` | |
| `MISTRAL_BASE_URL` | – | default | default | |
| `PORT` | – | `8787` | `8787` /Railway injectne | |
| `BIND` | ✅ v Dockeri | `127.0.0.1` (default) | `0.0.0.0` | baked v `deploy/Dockerfile` |
| `LOV_SERVER` | – | `1` v npm scripts | netreba — `tsx server/index.ts` vykoná priamo startup blok (argv check) | |
| `MOCK_AI` | – | `1` pre mock | **nechaj nezadané** | |
| `NODE_ENV` | ❌ | – | **NEnastavuj na `production`!** | guard pozri §2 |
| `AI_GENERATION_ENABLED` | – | `1` | `1` | |
| `GITHUB_CLIENT_ID` | ✅ pre OAuth | – | platform secrets | GitHub OAuth App settings |
| `GITHUB_CLIENT_SECRET` | ✅ pre OAuth | – | platform secrets | |
| `GITHUB_CALLBACK_URL` | ✅ pre OAuth | `http://localhost:8787/...` | `https://<doména>/api/github/auth/callback` | |
| `LOV_APP_URL` | ✅ pre OAuth | `http://localhost:5173/` | `https://<doména>/` | redirect po login |
| `GITHUB_OAUTH_SCOPE` | – | `public_repo` | `public_repo` | `repo` iba po výslovnom schválení širších práv |
| `GITHUB_ALLOWED_ORIGINS` | ✅ prod | `http://localhost:5173` | `https://<doména>` (bez lomky!) | CORS/CSRF allowlist |
| `GITHUB_SESSION_SECRET` | ✅ prod | – | 32+ B random | AES-256-GCM šifrovanie sessions |
| `GITHUB_SESSION_DIR` | – | `.sessions` | `/data/sessions` (volume) | |
| `SITE_ADDRESS` | ✅ VPS | – | `app.<doména>` | Caddy auto-SSL |
| `APP_UPSTREAM` | – (managed) | – | `http://<api-host>:8787` | Render/Railway interné DNS |
| `VITE_API_PROXY_TARGET` | – | `http://127.0.0.1:8787` | netreba | len dev proxy |

## 5. Ktoré súbory boli vygenerované

```
source/
├── .dockerignore          # čistý build kontext
├── railway.json           # Railway service config (app)
├── render.yaml            # Render blueprint (api + web)
└── deploy/
    ├── Dockerfile         # app: node:26-alpine + tsx + BIND=0.0.0.0 + healthcheck
    ├── Dockerfile.web     # web: vite build → caddy:2-alpine
    ├── Caddyfile          # VPS variant: auto-SSL + SPA + /api proxy
    ├── Caddyfile.managed  # Railway/Render variant: plain HTTP za TLS terminálom
    ├── compose.yaml       # VPS: app + web + volumes
    └── .env.example       # vzor pre compose premenné
```

## 6. Porovnanie platforiem (odporúčanie)

| | 🥇 Hetzner VPS | 🥈 Railway | 🥉 Render |
|---|---|---|---|
| Cena | **~€3,8–5/mes** (CX22, 2 vCPU/4 GB) + doména | usage-based, hobby od ~$5/mes | $7 × 2 služby = **$14/mes** |
| Deploy úsilie | viac (VPS setup, DNS, SSH) | **najmenej** (git push) | málo (blueprint) |
| TLS/SSL | Caddy auto Let's Encrypt | platform TLS | platform TLS |
| SSE streaming | ✅ plná kontrola | ✅ | ✅ |
| Persistent volume | ✅ (disk na VPS) | ✅ volume | ✅ disk (+$1/GB) |
| Škálovanie CCU | manuál, lacné repliky | vertikálne z CLI | vertikálne |
| Pre kedy | **keď pilot má dlho bežať (najnižšie ročné náklady)** | rýchly štart / demo pre zákazníka | čistý YAML IaC tím mladších devov |

**Odporúčanie:** Pilot/validácia → **Railway** (najrýchlejší štart, platíš len čo beží).
Pre trvalú prevádzku po prvých klientoch → **Hetzner VPS** (najlacnejšia, plná kontrola).
Render ak chceš deklaratívny `render.yaml` a tím GitHub workflow.

## 7. Runbook A — Hetzner VPS (najlacnejší trvalý)

**Požiadavky:** VPS s Dockerom (`curl -fsSL https://get.docker.com | sh`), doména s DNS A záznamom na VPS IP.

```bash
# 1. Priprav .env na serveri
cd /opt && git clone <repo> && cd LOV-DEVIL-RELEASE/source
nano .env          # doplň MISTRAL_API_KEY, GITHUB_*, GITHUB_SESSION_SECRET (openssl rand -hex 32),
                   # GITHUB_ALLOWED_ORIGINS=https://app.tvojadomena.sk,
                   # GITHUB_CALLBACK_URL=https://app.tvojadomena.sk/api/github/auth/callback,
                   # LOV_APP_URL=https://app.tvojadomena.sk/

# 2. Compose premenné
cd deploy && cp .env.example .env && nano .env    # SITE_ADDRESS=app.tvojadomena.sk

# 3. Štart
docker compose up -d --build

# 4. Over
curl https://app.tvojadomena.sk/api/health    # → {"ok":true,"ai":"mistral"}
```

**GitHub OAuth App** (github.com/developer/settings → OAuth Apps):
- Homepage URL: `https://app.tvojadomena.sk/`
- Callback URL: `https://app.tvojadomena.sk/api/github/auth/callback`
- Client ID/Secret dpiš do `.env` a `docker compose up -d` (watch mode v `server:dev` tu neplatí).

## 8. Runbook B — Railway

```bash
# 1. Nový projekt v Railway dashboarde, pripoj GitHub repo
# 2. Služba "app":
#      Settings → Build: Dockerfile path: deploy/Dockerfile
#      Variables: BIND=0.0.0.0, MISTRAL_API_KEY=..., GITHUB_* (matica §4)
#      (! NODE_ENV produkc. nechaj prázdne !)
#     Volumes → New Volume → mount: /data/sessions  →  GITHUB_SESSION_DIR=/data/sessions
#      Networking → public doména vypni (verejný vstup ide cez web)
# 3. Služba "web":
#      Settings → Build: Dockerfile path: deploy/Dockerfile.web
#      Variables: APP_UPSTREAM=http://<app-internal-host>:8787
#      Networking → Generate Domain (verejná HTTPS adresa)
# 4. Healthcheck: /api/health (nastavené v railway.json)
```
Poznámka k `railway.json`: Railway ho číta na root **service workspace** — ak máš
monorepo config s viacerými službami, cestu k Dockerfile over/dup ju v dashboarde (§2 krok 2).

## 9. Runbook C — Render

```bash
# 1. Render dashboard → New → Blueprint → vyber repo (render.yaml na rootu)
# 2. Pri sprievodcovi doplň secrets (sync:false položky): MISTRAL_API_KEY,
#    GITHUB_CLIENT_ID/SECRET, GITHUB_CALLBACK_URL, LOV_APP_URL,
#    GITHUB_ALLOWED_ORIGINS, GITHUB_SESSION_SECRET
# 3. Po deployi: curl https://lov-devil-web.onrender.com/api/health
# 4. Cena: každá služba $7/mes Starter (api aj web) — plan starter v render.yaml
```
Pozn.: `APP_UPSTREAM` sa naplní sám cez `fromService` (interná `host:port` adresa).
Ak Render vynúti iný interný port (10000 default pre docker), nastav `PORT` na 8787 v env api služby.

## 10. Bezpečnosť — čo tento pilot NIE je (pravdivé obavy)

- ❌ **Auth pre návštevníkov** — backend je single-user pilot. Každý kto vedie URL, môže generácie spaľovať *tvoj* Mistral kredit (limit: 30 generácií/deň in-memory, reset pri reboote).
- ❌ **Izolovaný sandbox** — `/api/sandbox/build` priamo v host procese (esbuild compile-only).
- ❌ **Durabilné kvóty** — rate limit je v pamäti.
- ⚠️ **Kým toto nedáš: nedávaj verejne inzerovanú URL**, alebo použi privátny prístup:
  - Railway: verejnú doménu web vypni, prístup cez Railway network / VPN
  - Render: služby v privátnom režime + vlastný auth proxy
  - VPS: Caddy `basic_auth` blok pre `handle` / alebo `forward_auth`

**Roadmap M1 hardening (pred skutočným public launch):**
1. Real user auth (session/JWT) + `GITHUB_ALLOWED_ORIGINS` tight allow
2. Rate limit do Redis / Postgres (durable, naprieč replikami)
3. Sandbox izolácia (Firecracker/gVisor alebo aspoň Docker-in-Docker bez siete)
4. Až potom: module `NODE_ENV=production` guard odstránit/upravit
5. Monitoring: `/api/health` → uptime probe (UptimeRobot/Uptime Kuma, oboje free)

## 11. Go-live kontrolný zoznam

- [ ] `.env` / platform secrets doplnené (matica §4), žiaden kľúč commitu
- [ ] `NODE_ENV` nie je `production`
- [ ] `GITHUB_ALLOWED_ORIGINS` = finalná https doména (bez lomky)
- [ ] GitHub OAuth App callback = `https://<doména>/api/github/auth/callback`
- [ ] Volume mountnutý na `GITHUB_SESSION_DIR`
- [ ] `curl https://<doména>/api/health` → `{"ok":true,"ai":"mistral"}`
- [ ] Test generácie cez UI (streaming beží, SSE nepadá na proxy timeoute — Caddy default OK, Railway/Render: 100s edge timeout pozor)
- [ ] GitHub OAuth login round-trip test
- [ ] Uptime monitor na `/api/health`
- [ ] Backup: VPS snapshots / Railway volume backups zapnuté

### Retencia auditu Hono

`auth_log` eviduje registráciu, prihlásenie, neúspešné prihlásenie a odhlásenie
v lokálnom Hono auth. Záznam obsahuje ID udalosti, akciu, čas a pri známom účte
interné ID používateľa. Audit Lovable Cloud má samostatný životný cyklus.

Po migrácii `016_auth_log_retention.sql` a určení prevádzkovej lehoty nastav
`DATABASE_URL` pre správnu databázu a spusti `npm run auth:log-retention -- --days N`,
kde `N` je schválená lehota v dňoch. Predvolený beh číta v read-only transakcii
a vráti počet záznamov v jednej dávke bez identifikátorov. `--limit` mení veľkosť
dávky (predvolene 1 000, najviac 10 000).

Až beh s `--apply` odstráni jednu dávku starších záznamov. Riadky presne na hranici
ostávajú. Zámky na jednotlivých záznamoch sa pri aplikácii preskočia. Po spracovaní
dávok over zostávajúce záznamy znovu v read-only režime.

### Export údajov účtu

Prihlásený a prepojený účet môže v paneli účtu stiahnuť údaje Hono ako
verziované JSON súbory. Panel ponúka profil, projekty vrátane koša, históriu
Hono prihlásení, spotrebu AI, publikácie, GitHub exporty a billing udalosti.
Pri väčšom objeme pokračuje tlačidlo ďalšou časťou tej istej sekcie.

Každé čítanie vychádza z aktuálnej relácie. Pri zmene projektov počas sťahovania
možno export sekcie zopakovať. Súbory nepokrývajú logy Cloud služieb, Stripe
faktúry, repozitáre na GitHube ani neuložené lokálne koncepty.

### Žiadosť o zrušenie účtu

Po migrácii `017_account_closure.sql` môže prepojený účet podať alebo odvolať
žiadosť. Ochranná lehota trvá 30 dní. Žiadosť je súčasťou exportu a počas
čakania ostávajú prístup, predplatné, projekty a publikácie dostupné.

Po migrácii `018_publish_withdrawal.sql` môže operátor v súkromnej relácii
nastaviť `DATABASE_URL` a použiť
`npm run account:closure-queue -- --limit 100`. Príkaz iba číta žiadosti po
ochrannej lehote a vypíše ich interné identifikátory a príznaky závislostí.
Ak výstup obsahuje `nextCursor`, použi ho v ďalšom behu cez `--cursor`.
Rozpracovaný Stripe Checkout má vlastný príznak aj bez otvoreného predplatného.
Výpis rozlišuje živé odkazy a uložené artefakty vrátane odvolaných publikácií.
Výsledok je momentka. Pred spracovaním znovu over žiadosť a pri účte so
Stripe over priamo u poskytovateľa stav predplatného aj rozpracovaného Checkout.

Samotné podanie ani uplynutie lehoty nič automaticky nemaže. Spracovanie
musí riešiť Cloud identitu, Stripe, rozbehnuté úlohy, publikácie aj kópie
u externých služieb. Verejné artefakty už vydané s ročnou cache môžu
zostať uložené v klientoch po zrušení prístupu na pôvodnej adrese.
