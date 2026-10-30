# 🔥 LOV-DEVIL BUILDER 2026

> Verejný zdrojový repozitár pre AI builder pilot: React/Vite UI, lokálny Hono
> backend, generovanie s Mistral a GitHub OAuth integrácia. **Nie je to
> produkčne izolovaná multi-user platforma ani hotová predplatiteľská služba.**

![status](https://img.shields.io/badge/stav-loopback%20pilot-2563eb) ![UI](https://img.shields.io/badge/UI-SK%2FEN-101b33) ![repo](https://img.shields.io/badge/repozitár-verejný-64748b)

*Interný kódový názov prototypu: **Forge** (tak sa volá agent a branding v demo appke).*

## 📖 O projekte

LOV-DEVIL BUILDER 2026 vyvíja AI editor aplikácií v štýle Lovable.
`src/` obsahuje React/Vite/TypeScript UI, `server/` lokálny Hono backend,
`tests/` Vitest/Playwright overenia a `demo/index.html` historickú single-file
referenciu. Niektoré UI flows sú ukážky alebo používajú mock dáta; produkčné
nasadenie, billing ani izolácia nedôveryhodných buildov nie sú potvrdené.

## ✨ Demonštrované UI a pilotné funkcie (nie produkčné garancie)

| Oblasť | Popis |
|---|---|
| **Landing** | „Čo chceš postaviť?“ — prompt, rýchle šablóny (SaaS, Kanban, Settings, Dashboard), public toggle |
| **Chat + Agent Mode** | plán v 4 krokoch (analyzuj → naplánuj → generuj → ulož), streaming odpovede, kópia kódu, fork, re-run |
| **Canvas** | Preview / Code / Console / Diff, zoom 50–150 %, breakpointy desktop/tablet/mobile, Edit mode s vizuálnym výberom elementov |
| **/editor dashboard** | sidebar s projektmi + fulltext, connectors, live preview prepojený s canvasom, Publish/Share flow |
| **História verzií** | snapshots, pin, restore, read-only rewind, diff medzi verziami |
| **Publish** | Demonštračný flow; nie potvrdený produkčný CDN deployment |
| **Test suite** | Historická vstavaná demo suite + samostatné Vitest/Playwright testy v repozitári |

## 🚀 Rýchly štart

```bash
git clone https://github.com/erikbabcan-commits/LOV-DEVIL-BUILDER-2026.git
cd LOV-DEVIL-BUILDER-2026
```

Aktuálny React pilot potrebuje Node.js a lokálnu inštaláciu závislostí:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Na lokálne skúšanie backendu a UI použite v oddelených termináloch
`npm run server:mock` a `npm run dev`. Backend je určený iba pre loopback
single-user pilot, bez skutočného produkčného AI kľúča. `demo/index.html` možno
otvoriť samostatne bez build nástrojov, ale je to **historická referencia**.

V historickom deme: **Ctrl+Enter** odoslať · **Ctrl+K** zamerať prompt ·
**Ctrl+S** uložiť verziu · **Ctrl+Shift+T** spustiť vstavané kontroly.

## 🧭 Historická produktová roadmapa (ciele, nie doklad nasadenia)

| # | Míľnik | Cieľ |
|---|---|---|
| M1 | Reálny engine + MVP | LLM API, multi-file codegen, auth, hosting, billing Free/Pro — **prvý platiaci zákazník** |
| M2 | Editor + blueprinty | file explorer, Monaco, git-like history, galéria 12+ blueprintov, prompt knižnica |
| M3 | Fullstack & data | DB, auth pre end-userov, backend funkcie, custom domény + SSL |
| M4 | Tímy & Business | realtime kolaborácia, komentáre v preview, seat billing, RBAC |
| M5 | Enterprise | SSO/SAML, audit log, GDPR/SOC2 cesta, SLA |
| M6 | Ekosystém | komunitná galéria, marketplace blueprintov, affiliate |

➡️ **Kompletný backlog (epiky, prompt packy, blueprinty, cenník, riziká, DoD): [docs/BACKLOG.md](docs/BACKLOG.md)**

## 💳 Plány predplatného (návrh)

| | Free | Pro ~20 €/mes | Business ~50 €/mes | Enterprise |
|---|---|---|---|---|
| Generácie/mes | 10 | 200 | fair-use | custom |
| Blueprinty | 3 základné | celá galéria | + tím šablóny | + SSO, DPA |
| Súkromné projekty | ✗ | ✓ | ✓ | ✓ |
| Custom domény | ✗ | 1 | 10 | neobmedzené |
| Tím | ✗ | 1 používateľ | 3+ seats | RBAC + SLA |

## 🧪 Kvalita — test suite

História `demo/index.html` obsahuje vlastné browserové kontroly. Aktuálny
React/server kód má samostatné Vitest unit/integration testy a Playwright E2E.
Použi vyššie uvedené príkazy a [CI workflow](.github/workflows/ci.yml);
úspech v minulom CI nie je automaticky výsledkom testovania aktuálneho HEAD.

## 🏗️ Architektúra prototypu

- **React 18 + Vite + TypeScript + Zustand** — `src/`, `package.json`
- **Hono server s Mistral providerom a GitHub OAuth pilotom** — `server/`
- **esbuild bundling na hostiteľovi** — `server/sandbox/builder.ts`; build iba
  kompiluje vygenerovaný kód, ale **nie je izolovaný proces/kontajner**.
- **Historická single-file HTML referencia** — `demo/index.html`
- Design tokens (čierna + modrý akcent), responzívne od iPhone 14
- Historické demo má stav v objekte `state` a render funkcie (`renderChat`, `renderPreview`, `renderEditor`…)
- Historické demo používa ladiace logy `dbg()` (`console.debug`)
- Testy a build nie sú dôkazom bezpečného hostovania ľubovoľného kódu.

## 📁 Štruktúra repa

```text
LOV-DEVIL-BUILDER-2026/
├── README.md            # táto dokumentácia
├── docs/                 # backlog, migračný kontrakt, dôkazová mapa
├── demo/index.html       # historická HTML referencia
├── src/                  # React aplikácia
├── server/               # lokálny backend a build adapter
├── tests/                # Vitest a Playwright
└── package.json
```

## 📄 Licencia & kontakt

Repozitár je **verejne čitateľný**, ale neobsahuje schválený samostatný
`LICENSE` súbor. Pokiaľ vlastník neurčí inak, neudeľuje sa tým oprávnenie na
redistribúciu ani použitie kódu na tréning tretích strán. Konkrétne zmeny,
autorstvá a otvorené otázky sú v [dôkazovej mape](docs/ASKABLE_EVIDENCE.md).

---

*LOV-DEVIL BUILDER 2026 — postav appku ešte dnes.* 🚀
## OAuth and build boundaries (prototype)

`GITHUB_ALLOWED_ORIGINS` is a comma-separated exact-origin allowlist. Production
origins must be HTTPS and `GITHUB_CALLBACK_URL` must match the allowlist and exact
`/api/github/auth/callback` path (no query/fragment). OAuth state is consumed before
exchange; no live OAuth client configuration is changed by this PR.

Production requires `GITHUB_SESSION_DIR` (private, persistent, single-host
directory) and `GITHUB_SESSION_SECRET` (owner-generated 32-byte hex encryption
key). Files contain authenticated encryption, expire, and are bound to random
session IDs. Do not place the directory inside the repo. Multiple hosts require
a separately reviewed shared store; this implementation does not provide a
distributed session service or automatic expired-file garbage collection.

Generated imports are checked independently of package.json against a runtime
allowlist. esbuild compiles and never intentionally evaluates submitted code.
Compilation still shares the host compiler process: an isolated worker/container
with hard CPU/RAM/time limits remains REQUIRED before untrusted multi-user hosting.
The current backend stays a loopback pilot; do not describe it as production ready.
