# 🔥 LOV-DEVIL BUILDER 2026

> Verejný zdrojový repozitár pre AI builder pilot: React/Vite UI, lokálny Hono
> backend, Mistral/OpenAI/Anthropic providery a GitHub OAuth integrácia. **Nie je to
> produkčne izolovaná multi-user platforma ani hotová predplatiteľská služba.**

![status](https://img.shields.io/badge/stav-loopback%20pilot-2563eb) ![UI](https://img.shields.io/badge/UI-SK%2FEN-101b33) ![repo](https://img.shields.io/badge/repozitár-verejný-64748b)

*Interný kódový názov prototypu: **Forge** (tak sa volá agent a branding v demo appke).*

## 📖 O projekte

LOV-DEVIL BUILDER 2026 vyvíja AI editor aplikácií v štýle Lovable.
`src/` obsahuje React/Vite/TypeScript UI, `server/` lokálny Hono backend,
`tests/` Vitest/Playwright overenia a `demo/index.html` historickú single-file
referenciu. Niektoré UI flows sú ukážky alebo používajú mock dáta; produkčné
nasadenie, billing ani izolácia nedôveryhodných buildov nie sú potvrdené.

Lokálne prírastky WS-3 až WS-19 zahŕňajú immutable projekty, kvóty a metering,
review AI patchov, CodeMirror editor a skutočný ZIP. Nový statický Publish v oboch
UI ukladá zostavený snapshot na oddelený verejný listener; moderný Lovable panel
používa Cloud billing bridge s explicitným test/live režimom a DB pinom.
**Publish aj billing zostávajú predvolene vypnuté, produkcia sa neaktivovala.**
Kontrakt a limity sú v [WS-19](docs/WS-19-PUBLISH-BILLING.md) a
[backlogu](docs/BACKLOG.md); [lokálne overenie PR #21](docs/LOCAL-VERIFICATION-2026-11-06.md)
je historický základ pred WS-19. Nové lokálne brány: **1 076/181 main**,
**159/159 PG na každej verzii**, **175/175 Lovable**, **21/21 Docker**, **22/22 E2E**;
[aktuálny dôkaz](deploy/lovable-github/proof/PUBLISH-BILLING-VERIFICATION.json).

`src/` je pôvodný hlavný frontend. Moderné Lovable UI má vlastný synchronizovaný
[privátny repozitár](https://github.com/erikbabcan-commits/vorkeeei); 41 produkčných
overlay súborov a automaticky vygenerovaný route tree sú prenesené do editora. Nové
rozhranie je overené v live preview; verejná verzia ešte nebola aktualizovaná.
Presný stav je v [Lovable hybrid](docs/LOVABLE-HYBRID.md) a
[prevádzkovom dôkaze](deploy/lovable-github/proof/PUBLISH-BILLING-ROLLOUT.json).
Spustenie tohto koreňového Vite projektu samo neotvára Lovable frontend.

## ✨ Demonštrované UI a pilotné funkcie (nie produkčné garancie)

| Oblasť | Popis |
|---|---|
| **Landing** | „Čo chceš postaviť?“ — prompt, rýchle šablóny (SaaS, Kanban, Settings, Dashboard), public toggle |
| **Chat + Agent Mode** | plán v 4 krokoch (analyzuj → naplánuj → generuj → ulož), streaming odpovede, kópia kódu, fork, re-run |
| **Canvas** | Preview / Code / Console / Diff, zoom 50–150 %, breakpointy desktop/tablet/mobile, Edit mode s vizuálnym výberom elementov |
| **/editor dashboard** | sidebar s projektmi + fulltext, connectors, live preview prepojený s canvasom, Publish/Share flow |
| **História verzií** | snapshots, pin, restore, read-only rewind, diff medzi verziami |
| **Publish** | Lokálne implementovaný statický job, skutočný compiler, nemenný HTML artefakt a oddelená verejná URL; produkčné HTTPS/CDN neaktivované |
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
MISTRAL_API_KEY= OPENAI_API_KEY= ANTHROPIC_API_KEY= npm test -- --exclude '**/liveSmoke.test.ts'
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
Použi vyššie uvedené príkazy. [CI workflow](.github/workflows/ci.yml) je iba
manuálny; aktuálne overovanie prebieha lokálne v testovacích sandboxoch.
Úspech v minulom CI nie je automaticky výsledkom testovania aktuálneho HEAD.
Predchádzajúce výsledky a odtlačky zachováva
[lokálne overenie PR #21](docs/LOCAL-VERIFICATION-2026-11-06.md). WS-19 má
nové finálne brány; pôvodné počty nedokazujú jeho aktuálny strom. Lokálny browser
už overil Cloud BFF → Hono → compiler → artefakt/HTTP 200 a syntetický billing
webhook → Pro s oddeleným Free účtom. Skutočná Stripe platba tým nie je overená.

## 🏗️ Architektúra prototypu

- **React 18 + Vite + TypeScript + Zustand** — `src/`, `package.json`
- **Hono server, providery, Postgres projekty/kvóty a voliteľný Stripe test/live režim** — `server/`; billing je default OFF, prostredie sa pripína v DB.
- **Statický Publish** — vlastný serverový snapshot → compiler → nemenné HTML; samostatný listener/hostname s CSP bez sieťových API. Fullstack hosting tým nevzniká.
- **Compile-only sandbox** — hostiteľský pilot alebo výslovne nakonfigurovaný
  súkromný runner s jednorazovými Docker workermi; [rozsah WS-4](docs/WS-4-SANDBOX.md).
  Toto ešte nie je fullstack runtime s ľubovoľnými npm balíčkami a HMR.
- **Historická single-file HTML referencia** — `demo/index.html`
- Design tokens (čierna + modrý akcent), responzívne od iPhone 14
- Historické demo má stav v objekte `state` a render funkcie (`renderChat`, `renderPreview`, `renderEditor`…)
- Historické demo používa ladiace logy `dbg()` (`console.debug`)
- Testy a build nie sú dôkazom bezpečného hostovania ľubovoľného kódu.

Read-only kontrola VPS o 19:07 UTC namerala **91 % disku a 3,50 GiB voľných**.
Tri obrazy `linux/amd64` sú zostavené a uložené lokálne: archív má 129 686 811 B,
unikátne rozbalené vrstvy 433 890 304 B. Odhad pre načítanie hotových obrazov vrátane
rezervy je 2,15 GiB; aktuálne meranie mu vyhovuje. To nepotvrdzuje prevádzkovú
pripravenosť: chýba dedikovaný izolovaný worker, migrácie 002–012 a nové nastavenia.
Na VPS sa obrazy nenačítali, nič sa nemazalo ani nenasadzovalo.

V novom Lovable live preview sa zobrazil skutočný Publish dialóg a prešlo
existujúce Google prihlásenie; Hono, modely a publish readiness zatiaľ hlásia
nedostupnosť. Cloud má názov `HONO_BASE_URL`, ale chýba `HONO_BASIC_AUTH`; hodnoty
Secrets sa nečítali. Stripe read-only inventúra potvrdila existujúce testové Pro
ceny 29 €/mesiac a 290 €/rok, no žiadny aktívny default Customer Portal. Platby
ostávajú vypnuté. Lovable už pred prenosom ukazoval 0 dostupných kreditov; agent
neodoslal AI prompt ani AI Build a nepotvrdzuje zachovanie historickej rezervy 30.

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
