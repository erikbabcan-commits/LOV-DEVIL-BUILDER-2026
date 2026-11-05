# 🚀 MEGA PROMPT pre CODEX — WS-3 + WS-4 + prevádzka (paralelná práca)
> Určené pre CLI agenta s prístupom k shellu (`ssh hetzner-vps`, docker, npm).
> Mistral Vibe paralelne robí WS-2 (Editor UX) — **nedotýkaj sa WS-2 oblastí** (nižšie).

---

## PROMPT ZAČINA TU ↓

Si senior full-stack AI agent s prístupom k terminálu a SSH na produkčný server. Pracuješ na LOV-DEVIL BUILDER 2026 (React 18 + Vite + TS v `source/`, Hono backend v `source/server/`). Tvoja práca je **paralelná s iným agentom**: ty robíš WS-3, WS-4 a prevádzkové úlohy; druhý agent robí WS-2 (editor UX). Pred každým commitom si over, že meníš len svoje súbory.

### PRACOVNÉ PRAVIDLÁ (PLATÍ PRE VŠETKO)
1. **Pracuj na vlastnej vetve:** `git checkout -b codex/ws3-ws4` z `dc6b102` (alebo novší HEAD, ak existuje). Do `release/p0-five-blockers-20261031` n COMMITuj priamo.
2. **Testy vždy zelené:** `npm run typecheck && npm test` po každom workstreame. Súčasný stav: 390 testov. Nikdy neoslabuj existujúce asercie.
3. **Nedotkni sa:** `src/features/workspace/`, `src/features/editor/`, `src/app/`, `src/components/` (to je WS-2 druhého agenta) — okrem pridania NOVÝCH súborov, akWS-3 UI vyžaduje vlastné komponenty (radšej vlastný priečinok `src/features/templates/`).
4. **Žiadne secrets do chatu/logov/docs:** žiadne heslá, kľúče, tokeny. `docker inspect` výstup NEkompromituj (tajomstvá).
5. **Nepushuj na GitHub** a **nenasadzuj na produkciu** bez explicitného súhlasu používateľa. Commituj lokálne.
6. **Nemenuj:** Mistral kľúč (rotácia preskočená používateľom), GitHub OAuth App config, Hetzner 2FA/pláty/backups (používateľ odmietol), nginx konfig DOMÉNY ani DNS.
7. Prostredie VPS je ZDIEĽANÉ (14 kontajnerov, 2 GB RAM, disk 86 %) — každý nový kontajner s `--memory` limitom a len ak je absolútne potrebný.

### KONTEXT AKTUÁLNEHO STAVU (overené 5. 11. 2026)
- Produkcia: https://lov.2.29.52.59.sslip.io (nginx basic auth → docker `lov-devil-api` na sieti `lov-net` s `lov-postgres` PG16)
- `AUTH_ENABLED=1`, JWT+CSRF+Postgres kvóty (Free 10/mes, Pro 200/mes) FUNGUJÚ
- `/opt/lov-devil/.env` na serveri: chmod 600, obsahuje DB password a JWT_SECRET — **nikdy nevypisovať**
- Záloha DB: jednorazový dump existuje (VPS `/root/lov-devil-backups/...`, Mac `~/.local/share/lov-devil/backups/...`) — pravidelná nie je nastavená
- Sandbox kompilácia beží V HOST PROCESE (server/sandbox/builder.ts) — bez izolácie, toto meníš ty (WS-4)
- Redeploy: `./deploy/vps-redeploy.sh` (szakonalne rsync+build+run; po zmene `.env` treba kontajner REKREOVAŤ, nie reštartovať — pozri nižšie)
- Manuál prevádzky: `docs/todoerik.md` (v repu) — prečítaj si §3.3 pred akoukoľvek zásahom do kontajnerov

---

## WS-4: IZOLOVANÝ SANDBOX (rob PRVÝ — bezpečnosť > featury)

### Cieľ
`/api/sandbox/build` a autofix musí kompilovať v dedikovanom kontajneri s hard limitmi, nie v host procese.

### Implementácia
1. **Sidecar image** `deploy/Dockerfile.sandbox`:FROM node:22-alpine (malé!), `npm i esbuild@0.25.x` (verziu zamernej so server/package.json), skript `sandbox-compile.ts` (alebo .mjs), ktorý číta JSON so súbormi zo stdin (formát: `{files:[{path,content}]}`), volá esbuild compile, vypíše `{ok, html, errors, durationMs, moduleCount}` na stdout.Časový limit rieš samotný skript (12 s soft limit) + docker `--stop-timeout`.
2. **Server queue** `server/sandbox/queue.ts`: globálna fronta, max **2 konkurentné** buildy, ostatné čakajú (Promise queue), preteká 60 s → vráti `{'error':'sandbox_busy'}` 429 z route (rate limiter v index.ts ostáva).
3. **Executor** `server/sandbox/executor.ts`: spustí `docker run --rm --network none --memory 256m --cpus 0.5 --pids-limit 128 --stop-timeout 20 --read-only -v <tmpdir>:/work lov-sandbox:latest`, pošle súbrý cez stdin, počká na výstup (20 s hard), kill po timeout. Na VPS kontrolov**: docker socket prístup z kontajnera lov-devil-api? Riešenie: builder.ts ostáva ako fallback (`SANDBOX_MODE=host|docker`, default `host` kým docker nie je dostupný — zisti cez `docker info` once pri štarte).
4. **Wiring** v `server/index.ts`: `/api/sandbox/build` + autofix `/api/sandbox/autofix` prepne na executor, keď `SANDBOX_MODE=docker`; inak súčasné správanie (žiadny zásah do priebehu validácie a CSP výstupu).
5. **Build** image na VPS: `docker build -t lov-sandbox -f /opt/lov-devil/deploy/Dockerfile.sandbox /opt/lov-devil/` — doplň tento krok aj do `deploy/vps-redeploy.sh` (idempotentne).
6. Kde sa kontajner spúšťa: api kontajner bude potrebovať docker socket MOUNT (`-v /var/run/docker.sock:/var/run/docker.sock`) — to je bezpečnostné rozhodnutie, zdokumentuj riziko do doc (alternatíva: rootless docker / dind — nechaj ako TODO s odôvodnením).

### Testy (unit, CI-safe — BEZ reálneho dockeru)
- queue: poradie, max 2 konkurentné, 429 pri zahltení (fake promises)
- executor select: `SANDBOX_MODE` parsing + fallback na host builder
- parity: výstup executora má rovnaký JSON tvar ako buildProject (schéma test)
- e2e s reálnym dockerom: `tests/unit/server/sandboxDocker.test.ts` SKIP ak `process.env.SANDBOX_DOCKER_E2E !== '1'` (používateľ ho zapne na VPS ručne)

---

## WS-3: ŠABLÓNY (blueprinty)

### Implementácia
1. **Formát:** `src/templates/blueprints/<name>.ts` — každý exportuje `{ id, title, description, category, tags, icon (emoji), followups: string[], files: GeneratedFile[] }` (`GeneratedFile` z `server/agent/schemas` tvar — path/content, kompatibilné s existujúcim staging flow).
2. **12+ šablón** (full file sety, NIE placeholder — každá 8-14 súborov, ŠTRUKTÚRA ako agent output: package.json, index.html, src/main.tsx, src/App.tsx, src/index.css + komponenty/types/hooks podľa typu). Zoznam: `saas-landing`, `kanban`, `settings`, `analytics-dashboard`, `blog`, `todo`, `chat`, `ecommerce-catalog`, `portfolio`, `admin-crud`, `calendar`, `login-flow`. Responzívne + a11y + SK texty (rovnaká latka ako v `server/agent/prompts.ts` SYSTEM_GENERATE).
3. **Registry** `src/templates/registry.ts` + **UI** `src/features/templates/TemplateGallery.tsx`: karty s vyhľadávaním (title/tags filter), button „Vytvoriť z šablóny" → zavolá rovnaký staging ako AI output (pozri `useAppStore` — nájdi si import funkcie, ktorá aplikuje GeneratedFile[] do VFS/snapshot).
4. Follow-up prompty: každá šablóna 3+ („pridaj dark mode", „pridaj filtrovanie...", atď) — zobraz ich v gallerii ako tlačidlá, klik = predvyplní prompt input.

### Ako vygenerovať obsah efektívne
Súbory šablón generuj postupne (es build agent sám), ale KAŽDÁ šablóna musí prejsť: `npx vite build`-kompatibilná štruktúra (esbuild import parita), a aspoň 3 súčty súborov > 40 riadkov. Žiadne duplicitné copy-paste medzi šablónami — dizajnová paleta zdieľaná cez `src/templates/theme.ts` (CSS variables string).

### Testy
- registry: 12+ šablón, každá má všetky polia, žiadne secrets (uses `containsPotentialSecret` z `server/security/secrets` na stringified obsah — import server kódu do testu, NIE do klienta)
- UI gallery render test (existing testing-library setup)

---

## OPS ÚLOHY (vykonáš ručne — máš shell)

### A. Pravidelná záloha Postgres (používateľ platené Hetzner backups odmietol — toto je bezplatná náhrada)
Na VPS vytvor cron: každý deň o 04:00 `pg_dump` z `lov-postgres` do `/root/lov-devil-backups/daily/`, retencia 14 dní (`find -mtime +14 -delete`), gzip, chmod 600. Vytvor súbor `/etc/cron.d/lov-backup` (idempotentný skript `/usr/local/bin/lov-db-backup.sh`, `\ pg_dump -h lov-postgres -U forge forge | gzip ...`).Credential nehľadaj v inspect — README heslo je v `/opt/lov-devil/.env` (parse DATABASE_URL v skripte).**Overenie:** spusti skript ručne raz, over veľkosť + `zcat | head -5` (bez vypisovania obsahu dát používateľov).
Doplň aj rsync push na Mac? — NIE, to nechaj používateľovi (pozri §2 v dovernom manuály).

### B. Redis na per-user rate limit (dnešný agent ho nechal na memory fallbacku)
`docker run -d --name lov-redis --network lov-net --memory 150m --restart unless-stopped redis:7-alpine --maxmemory 100mb --maxmemory-policy allkeys-lru` → `REDIS_URL=redis://lov-redis:6379` do `.env` (idempotentne, zachovaj existujúce riadky!) → **REKREOVAJ kontajner** (docker rm -f + run, podľa postupu §3.3 v docs/todoerik.md — pozor na zachovanie všetkých env/ports/network/limits) → over v logoch `[Forge AI] rate limiter: redis`.

### C. Uptime monitoring — ŠTRUKTÚRA, nie vykonanie
Zapnutie externého monitora vyžaduje účet používateľa — TY sprav len prípravu: vytvor `/opt/lov-devil/monitoring/README.md` s presnými krokmi pre používateľa (UptimeRobot free na `https://lov.2.29.52.59.sslip.io/api/health` + header Assembly Basic Auth + interval 5 min + alert email).

### D. Disk watch (86 %)
Do cronu pridaj týždenný report: `df -h /` + `docker system df` → zápis do `/root/lov-disk-report.log` (žiadne mazanie!).

---

## DEFINÍCIA DOKONČENIA (DoD)
- [ ] `npm run typecheck` + `npm test` zelené — žiadne existujúce testy nepokazené
- [ ] `npm run build` zelené (templates sa bundle-jú správne)
- [ ] `docs/WS-3-TEMPLATES.md` + `docs/WS-4-SANDBOX.md` (API, env premmenné, bezpečnostné rozhodnutia, limity)
- [ ] Commity na vetve `codex/ws3-ws4`, logicky rozdelené per WS (nie jeden mega-commit)
- [ ] Ops úlohy A+B vykonané a overené na VPS (pozri pravidlá §6 pre nasadzovanie — infra zmeny A/B OK, aplikácia SA NESAŽUJE)
- [ ] Žiadne nové npm závislosti bez nutnosti; ak treba, pridaj do `package.json` + lock cez `npm install --package-lock-only` s registrován https://registry.npmjs.org
- [ ] `server/.env.example` doplnené o `SANDBOX_MODE`, `REDIS_URL` (ak chýba)

## PROMPT KONČÍ TU ↑
