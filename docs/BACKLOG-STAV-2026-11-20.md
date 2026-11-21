# 📋 LOV-DEVIL BUILDER 2026 — AKTUÁLNY STAV BACKLOGU & SPRINTU
**Dátum a čas aktualizácie:** 20. november 2026, 19:46 CET  
**Integračná základňa:** `feat/issue-75-production-vercel` | Vlna 3 `5395459` | Opravy Vlny 2 `5d106f6`  
**Metrika kvality:** 1 400 testov zelených | 0 pádov | 0 typecheck chýb | 0 lint chýb | Vitest 1400/0/221  

---

## 🟢 1. ČO MÁME KOMPLETNE HOTOVÉ (OVERENÉ S PASS)

### A. Architektúra & Vercel Produkčná Brána (Krok 0) — PASS od Bory
- **🟢 Produkčný Fail-Closed Checklist (`server/production.ts`):** Striktné brány pre produkčný runtime, izolovaný sandbox a povinné overenie schémy pred štartom.
- **🟢 Statický Vercel Frontend Build (`vercel.json`):** SPA fallback rewrite na `/index.html` bez kolízie s `/api/*`.
- **🟢 Cross-Origin Cookie Autentifikácia:** Doplnené `credentials: 'include'` na všetkých klientskych volaniach API.
- **🟢 Viditeľnosť AI Modelu v UI:**
  - Tlačidlo `#modelChip` v `TopBar.tsx` explicitne zobrazuje `Model: [názov]`.
  - Pridaný klikateľný odznak modelu v `LandingPage.tsx` aj `Workspace.tsx` editore.
  - Zrozumiteľné navádzacie texty v `AiModelMenu.tsx` pri výpadku servera alebo prázdnom katalógu.
- **🟢 Offline Validácia Schemas:** Do repozitára dodaný `tsconfig.schema.json`, vyriešená chyba `EAI_AGAIN` v IDE.
- **🟢 Integrácia PR #77 & Opravy (`6dd44d0`):**
  - `023_agent_jobs.sql` začlenené bez konfliktov.
  - Opravená izolácia routera — `GET /api/health` je 100 % anonymný (200 OK) a nezablokovaný auth guardom.
  - Ošetrené chýbajúce `.catch` na 6 volaniach `saveMeta(...)` v `useAppStore.ts`.

### B. Vlna 1: Trvalé Úlohy, Bezpečnostný AST Guard, Editor & Billing — PASS od Bory (`c72ee9b`)
- **🟢 Agent 1 — Trvalé AI Úlohy (Durable Jobs & Worker):**
  - Implementovaný `server/agent/worker.ts` s atomickým odpočítaním kvóty cez ledger výhradne pri stave `succeeded`.
  - Fail-fast ochrana: okamžité 429 (kvóta) a 503 (vypnuté AI) priamo pri odoslaní `POST /api/agent/jobs`.
  - Ochrana proti duplicitám s `Idempotency-Key` a limit max 3 aktívnych jobov na používateľa.
- **🟢 Agent 2 — Resilientný Klientsky Transport:**
  - Automatický fallback z SSE streamu na polling stavu pri prerušení spojenia.
  - Ukladanie konceptov a rozpracovaných návrhov do lokálnej IndexedDB.
  - Exponenciálny retry backoff pri sieťových výpadkoch.
- **🟢 Agent 4 — Sandbox AST Bezpečnostný Inšpektor:**
  - TypeScript Compiler API guard blokujúci `fs`, `child_process`, `node:*`, `eval`, `new Function`, `process.env` a dynamické importy.
  - 0 falošných poplachov na všetkých 19 overených blueprintoch.
  - Maskovanie citlivých údajov (`sk_live`, `ghp_`, `whsec_`, Bearer tokeny) v chybových logoch.
- **🟢 Agent 5 — Stripe Webhook Fronta & Rekonciliácia:**
  - Migrácia `025_billing_webhook_queue.sql` s idempotenciou udalostí.
  - 7-dňová grace period pri zlyhaní platby a bezpečný downgrade na plán `free` cez flag v DB (bez mazania dát).
- **🟢 Agent 6 — Profesionálny Editor:**
  - Multi-file záložkový systém s dirty indikátorom.
  - Klávesová skratka Ctrl+P / Cmd+P pre rýchle fuzzy vyhľadávanie v súboroch.
  - Inline zobrazenie lint chýb z kompilátora priamo v CodeMirror.

### C. Vlna 2: GitHub Sync, Publikačný Engine & Domény — PASS od Bory + Opravy P2 HOTOVÉ (`5d106f6`)
- **🟢 Agent 3 — GitHub Cloud Sync:**
  - Export do vetvy `forge/<slug>` a otvorenie Pull Requestu (ochrana pred priamym prepísaním `main`).
  - Ochrana pred prepísaním novších remote zmien; bezpečný predvolený scope `public_repo`.
  - Prehliadačový GitHub sync smerovaný cez BFF (backend-for-frontend), vyriešená 403 chyba.
- **🟢 Agent 7 — Publikačný Engine, Domény & Rollback:**
  - Generovanie subdomén a okamžitý rollback na predchádzajúci snapshot (opravená chyba 409 doplnením živej verzie a kontrolou vlastníka).
  - **Ochrana pred obsadením cudzích domén:** neoverený claim po 72 h exspiruje, vlastník môže doménu uvoľniť, max 5 čakajúcich domén na účet, prísna validácia hostname (odmietnutie IP, localhostu a internej zóny).
  - Ochrana pred zneužitím slugov: prevzatie slugu po trvalom zmazaní projektu je zablokované.
  - Striktné cache hlavičky (`Cache-Control: public, max-age=31536000, immutable` pre assety, `no-cache` pre index).
- **🟢 Agent 8 — Smart Router:**
  - Inteligentná kaskáda modelov s odhadom nákladov (USD / EUR).
  - Nastavený za feature flag (predvolene vypnutý) — pri požiadavke bez modelu zostáva pôvodný default.
  - Manuálne zvolený model má vždy 100 % prioritu; Free plán nikdy nedostane drahý prémiový model.

### D. Vlna 3: Autonómny Self-Healing Loop & Infra — PASS od Bory (`5395459`)
- **🟢 Agent 9 — AI Auto-Fixer:**
  - Až 3 pokusy o samoopravu pri chybe kompilácie (kvóta 1 jednotka za každý platený pokus).
  - Bezpečný návrat na posledný funkčný koncept, ak oprava zlyhá.
  - Bezpečnostný AST guard: oprava sa nespustí, ak kód obsahuje nepovolené volania.
  - Starý PWA klient kompatibilný s 3 pokusmi.
- **🟢 Docker Memory Limit (512 MB):**
  - Zvýšené z 256 MB na 512 MB v samostatnom commite (prevencia OOM pri 2 MB vstupoch a esbuild kompilácii).
- **🟢 Chromium E2E Infra:**
  - Chromium úspešne nainštalované a funkčné pre Playwright testovaciu súpravu.

---

## 🔴 2. ČO TREBA OPRAVIŤ / DOKONČIŤ (KONTROLNÉ BODY A NÁLEZY)

- **🔴 Úloha C — Race Condition pri Súbežných Joboch (Zámok slotov):**
  - *Problém:* Súbežné HTTP požiadavky od rovnakého používateľa môžu v milisekundovom okne obísť limit 3 aktívnych jobov.
  - *Riešenie:* Doplniť atomický databázový zámok (`SELECT ... FOR UPDATE` alebo transakčný check constraint) a uvoľnenie slotu pri zlyhaní vytvorenia jobu pred zapnutím `AGENT_JOBS_WORKER=1`.
- **🔴 TIC TAC Bezpečnostné & Tokové P2 Nálezy:**
  - *Slot release:* Okamžité uvoľnenie slotu pri chybe počas inicializácie jobu.
  - *Discard flow:* Oprava toku zmien pri zahodení rozpracovaného konceptu (discard).
  - *Cross-domain CSRF:* Ochrana proti CSRF, keď frontend (Vercel) a API (Lovable/Custom server) bežia na rôznych doménach.
- **🔴 Lovable BFF Deployment pre GitHub Sync:**
  - *Problém:* Nová BFF cesta pre GitHub sync ešte nie je nasadená v produkčnej kópii Lovable (na živej appke by vrátila 404).
  - *Riešenie:* Po schválení a pushi zosynchronizovať BFF endpoint v Lovable infraštruktúre.
- **🔴 Nálezy z auditu SEO4WEB (4 drobnosti):**
  - *Problém:* V `index.html` chýbajú OpenGraph tagy, Twitter Cards a canonical meta; v projekte zatiaľ chýba priečinok `public/` s `manifest.webmanifest`, `robots.txt` a `favicon.svg`.
  - *Riešenie:* Samostatná úloha pre lokálneho Mistral agenta, doplní statické assety bez blokovania backendu.

---

## 🟠 3. ČO NÁS EŠTE ČAKÁ (PRIEBEH A BUDÚCE KROKY)

- **🟠 Vlna 4 — Agent 10 (E2E Playwright Chaos & Load Suite) [PRÁVE BEŽÍ]:**
  - Agenta 10 poslal BOSS do QA & Ship fázy.
  - Beží lokálne na porte 3002+ s mockmi.
  - Podmienka úspechu: **3× po sebe bezchybný prechod celého balíka** (výpadok siete, responzivita 390/768/1280px, kompletný flow od promptu po export).
- **🟠 Spojenie Vlny 3 a opravenej Vlny 2 pre Boru a TIC TAC:**
  - BOSS po dokončení Agenta 10 spojí vetvu `5d106f6` a `5395459` na presné SHA a predloží na finálny pre-merge review.
- **🟠 Záverečný Systémový Audit TIC TAC:**
  - Overenie celkovej integrity, Redis rate-limiteru a stability pred zlučovaním.
- **🟠 Voliteľný Live Stream SSE pre Autofix ("Pokus N z 3"):**
  - Zaradené ako samostatná mini-úloha po Agentovi 10 (aby sa nezdržala QA fáza).
- **🟠 Finálny Push, PR & Merge do `main`:**
  - Čaká sa na Erik-ovo explicitné "ÁNO".
  - Následne prebehne push, PR, spustenie plnej CI s natívnym Postgresom a aktivácia produkčného prostredia.
