# 🚀 MEGA PROMPT — posuň LOV-DEVIL editor na úroveň Lovable
> Tento prompt skopíruj celý a vlož AI agentovi (Mistral Vibe / editor kódu s prístupom k repu).
> Predpoklad: pracuješ v `source/` na vetve `release/p0-five-blockers-20261031`.

---

## PROMPT ZAČINA TU ↓

Si senior full-stack AI agent. Tvojou úlohou je premeniť LOV-DEVIL BUILDER 2026 z single-user pilotu na produkt na úrovni **Lovable** (lovable.dev). Pracuj iteratívne, po každom workstreame spusti testy a skontroluj, že nič nefunguje horšie ako predtým. Nepridávaj špekulatívne funkcie — implementuj len to, čo je v zozname.

### KONTEXT AKTUÁLNEHO STAVU (2026-11-05)
- React 18 + Vite + TS UI (`src/`), Hono backend (`server/`), SSE agent lifecycle (plan → generate → validate → stage)
- Agent generuje po batchoch (4 súbory/volanie, continuation pri truncate, 12-18 súborov na generáciu, ~55 kB kódu)
- Sandbox compile-only cez esbuild, CSP iframe, whitelist react/react-dom
- Produkčný pilot beží na VPS (nginx + Docker), basic auth, Mistral API
- CHÝBA: user auth, trvalé kvóty, izolácia sandboxu, billing, GitHub sync nastavený, publish flow, šablóny
- Existujúci roadmap: `docs/BACKLOG.md` (M1-M6), bezpečnostné limity: `docs/DEPLOYMENT-BLUEPRINT.md` §10

### KONŠTRUKČNÉ PRAVIDLÁ (NEDOTKNUTEĽNÉ)
1. Zachovaj existujúce bezpečnostné guary: secret scanning v requestoch aj výstupoch, path traversal guard, CORS allowlist, rate limiter, budget guard
2. `MISTRAL_API_KEY` a všetky secrets len server-side
3. Testy: každý nový modul má unit testy; plná suite musí odpovedať zelená (momentálne 379)
4. Migrácie a schema zmeny: dopredu si prečítaj `src/services/persistence` (IndexedDB v2) a zachovaj spätnú kompatibilitu
5. Neprepisuj existujúcu architektúru bez nutnosti — pridávaj vrstvy, nerozbíjaj kontrakty SSE eventov (AgentEventSchema)
6. Všetko nové UI: responzívne (mobile-first), a11y (aria, klávesnica), SK/EN texty

### WORKSTREAMY PODĽA PRIORÍT — ROBÍ SA POSTUPNE

#### WS-1: User auth + trvalé kvóty (M1) — ZÁKLAD VŠETKÉHO
- Tabuľka users (email + heslo bcrypt, alebo magic-link bez hesla) v Postgres
- Session/JWT (httpOnly cookie, CSRF token) — nahraď basic auth
- Registrácia/login/reset v UI (nová screen pred projektovým dashboardom)
- Všetky `/api/*` chránené middleware (okrem `/api/auth/*` a `/api/health`)
- `src/services/persistence` — projekty a snapshoty presun do DB (IndexedDB zostáva ako cache pre offline draft)
- **Trvalé kvóty v Postgres**: generácie/deň per user (Free 10, Pro 200 — konfigurák), atomic increment (`SELECT ... FOR UPDATE` alebo advisory lock), reset pri reboote NESMIE stačiť
- Rate limit prepni na Redis (upstash/valkey alebo in-memory s fallbackom) — per-user, nie per-process

#### WS-2: Editor na úrovni Lovable — UX (M2)
- **File explorer** (strom) v `/editor` — copy/rename/delete, context menu, upload
- **Monaco editor** (`monaco-editor` npm) pre Code view — syntax highlight TSX/JSON/CSS, tab-per-file, auto-save so dirty indicatorom, `Ctrl+S` existuje — zachovaj
- **Diff view**: klik na snapshot v histórii → side-by-side diff pred/po
- Edit mode: výber elementu v preview → AI chat prompt „uprav presne tento element" (kontext: vybraná componenta + props) — použi existujúci iframe messaging
- Console: real-time chyby z preview (window.onerror forwarding cez postMessage)
- Záchrom: auto-save draft každých 30 s (IndexedDB), indikátor „uložené/ukladám"

#### WS-3: Šablóny (blueprinty) — M2/ZAČIATOK M6
- `src/templates/` — 12+ šablón (SaaS, Kanban, Blog, E-shop, Portfolio, Admin, Todo, Dashboard analitika, Kalendár, Chat, Landing, Login-flow)
- Každá šablóna = kompletný súborový set v JSON (rovnaká schéma ako agent output)
- „Šablóny" sekcia v UI s kartami, filtrami, „Vytvoriť z šablóny" → staging ako pri AI generácii
- Prompt knižnica: každá šablóna obsahuje 3+ hotové follow-up prompty („pridaj auth do tejto šablóny", „pripoj databázu...")

#### WS-4: Izolovaný sandbox (M1 — POVinné pre multi-user!)
- Move compile do dedikovaného kontajnera (Docker-in-Docker alebo sidecar `node:22-alpine` s esbuild CLI)
- Hard limity: `--memory 256m --cpus 0.5 --pids 128 --network none`, timeout 20 s, kill po timeout
- Queue: max 2 konkurentné buildy globálne, ostatné čakajú s SSE progressom
- retry 1×, ak zlyhá → autofix loop (existuje v `server/agent/autofix.ts`) — prepoj

#### WS-5: Billing (M1 finále — AKO POSLEDNÝ)
- Stripe Checkout + webhooks (subscription created/failed/deleted), ak je účet dostupný (inak: mockmod `BILLING_MOCK=1` so stripe JSON podobnými dátami a prepínačom Free/Pro v UI)
- Plány: Free 10 generácií/mes, Pro 20 € (200 generácií, private projekty, 1 custom doména)
- Paywall v UI (upgrade modal pri 90 % kvóty a pri prekročení)
- Server: enforcement per-plan limitami (WS-1 kvóty čítajú plán)

### DEFINÍCIA DOKONČENIA (DoD) — každý workstream
- [ ] Implementované + unit testy zelené + typecheck zelený
- [ ] Manuálny smoke test v `npm run dev` — vždy reálne kliknúť/nastreliť flow
- [ ] Nové API endpointy: OpenAPI komentáre + zod validácia vstupu (ako existujúce)
- [ ] Migrácie/seed dát pre lokálny dev (`server/migrations/*.sql`)
- [ ] Dokumentácia: krátky `docs/WS-*.md` s API + env premenými + limitmi
- [ ] Žiadne secrets v klietke, žiadne `any`, žiadne TODO komentáre v produkčnom kóde
- [ ] Nepokazené ani nemenené chovanie existujúcich SSE eventov a persistence (v2)

### ENV PREMENNÉ (pridaj do `server/.env.example`)
```
DATABASE_URL=postgresql://...
REDIS_URL=redis://localhost:6379
JWT_SECRET=
BILLING_MOCK=1
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

### AKÝKOĽVEK POCHYBNOSTI
Keď narazíš na konflikt medzi týmto promptom a existujúcim kódom — existujúci kód vyhráva, ak ide o bezpečnostný guard; inak implementuj tak, aby fungoval aj bez migrácie (feature flags cez env: `AUTH_ENABLED=0` default → appka funguje aj bez Postgres, pre lokálny pilot).

## PROMPT KONČÍ TU ↑
