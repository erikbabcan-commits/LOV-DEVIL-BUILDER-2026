# 🔥 Forge — kompletný backlog
**Cieľ:** z prototypu (workspace + /editor + publish demo + test suite) spraviť plnohodnotný Lovable-style AI editor, ktorý si zákazník kúpi na **mesačné predplatné**.
**Stratégia:** MVP predajné do konca M1/Q1 — reálny AI engine, hosting, auth a billing. Všetko ostatné buduje na tom.

---

## 0. Stav — čo už existuje (M0 ✔)

| Hotovo | Poznámka |
|---|---|
| Lovable-style workspace | landing „Čo chceš postaviť?", Agent Mode checklist, streaming |
| Chat + Agent Mode | plán → generácia → snapshot (simulácia, mock modely) |
| Canvas panely | Preview / Code / Console / Diff, zoom, viewporty, Edit mode |
| História verzií | snapshots, pin, restore, read-only rewind |
| Publish modal | build → deploy → URL (fake) |
| /editor dashboard | sidebar s projektmi, search, connectors, live preview prepojený s canvasom |
| Test suite | ~60 testov, Ctrl+Shift+T, restore stavu |
| Téma | čierna + modrý akcent, responzívne (iPhone 14) |

**Čo je fake a musí sa nahradiť reálnym:** LLM volania (mock), generované appky (4 šablóny), publish URL, ZIP export, connectors, billing, účty.

---

## 1. Míľniky (roadmap)

| # | Míľnik | Obsah | Trvanie | Výstup / brána |
|---|---|---|---|---|
| **M1** | **Reálny engine + MVP predaj** | AI backend, multi-file codegen, sandbox preview, auth, hosting na `*.forge.app`, billing Free/Pro | 6–10 týždňov | **prvý platiaci zákazník** |
| **M2** | **Editor + blueprinty** | file explorer, Monaco, git-like history, blueprint galéria + wizard, prompt knižnica | 6–8 týždňov | Pro retencia, onboarding do 5 min — **✅ prototyp hotový (M2 Build Prompt nižšie)** |
| **M3** | **Fullstack & data** | DB pre vygenerované appky, auth pre end-userov, backend funkcie, custom domény + SSL | 6–8 týždňov | appky „robia niečo užitočné" — **✅ prototyp hotový (M3 Build Prompt nižšie)** |
| **M4** | **Tímy & Business tier** | realtime kolaborácia, komentáre v preview, share linky, seat billing, RBAC | 6–8 týždňov | B2B (Business) plán — **✅ prototyp hotový (Build Prompty nižšie)** |
| **M5** | **Enterprise & scale** | SSO/SAML, audit log, compliance (GDPR/SOC2 cesta), SLA, rate limiting | 8–12 týždňov | Enterprise zákazky — **✅ prototyp hotový (Build Prompty nižšie)** |
| **M6** | **Ekosystém** | komunitná galéria, marketplace blueprintov, remix, affiliate, template contest | priebežne | rast organický (virality) — **✅ prototyp hotový (Build Prompty nižšie)** |

---

## 2. Epiky & backlog

### 🤖 Epik 1 — AI Engine (FORGE-1xx) · M1 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 101 | Provider-agnostické LLM API (Mistral/OpenAI/Anthropic) + failover | výber modelu v UI reálne prepína model; fallback pri výpadku; latencia < 15 s do prvého tokenu | L |
| 102 | Streaming odpovedí do chatu (SSE/WebSocket) | tokeny píšu priebežne, cancel tlačidlo funguje | M |
| 103 | Multi-file codegen (React/Vite projekt, nielen single-file HTML) | AI vráti zoznam súborov + obsah; explorer ich zobrazí | L |
| 104 | Diff-based editácie (patch existujúceho kódu, nie celá regenerácia) | zmena „pfarbu tlačidla" upraví 1 súbor; Diff tab ukazuje reálny diff | L |
| 105 | Intent klasifikácia: nová appka vs. iterácia vs. fix vs. otázka | routing presnosť > 90 % na eval sete (150 promptov) | M |
| 106 | Retry, timeouty, usage metering per request | chyba providera = čitateľná správa + auto-retry; spotreba sa ráta do plánu | M |
| 107 | Kontext manažment (sumarizácia konverzácie + projekt snapshot) | 20+ správ bez prerušenia; tokeny pod limitom; historky nezabudnú kód | M |
| 108 | Attachments: obrázky/screenshots do promptu (vision) | upload → AI vidí obrázok → vygeneruje podľa neho | M |

### 🧩 Epik 2 — Codegen & runtime (FORGE-2xx) · M1–M3 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 201 | Sandbox preview pre fullstack (WebContainers/Firecracker) | `npm install`, dev server, HMR beží v prehliadači/VM izolovane | XL |
| 202 | Build pipeline (Vite) + produkčný build | „Publish" najprv prejde reálnym buildom; chyby sa zobrazia v Console | L |
| 203 | Závislosti: npm balíčky na želanie | „pridaj recharts" → AI prida + nainštaluje | M |
| 204 | Databáza ako služba (tabuľky, seed, migrácie) | AI navrhne schému, UI editor tabuliek, data browser | XL |
| 205 | Auth šablóny pre vygenerované appky (login/register/OAuth) | 1 klik = funkčný login nad Forge DB | L |
| 206 | Serverless funkcie / API routes | „pridaj endpoint /api/orders" → beží v produkcii | L |
| 207 | Secrets vault (env premenné, šifrované) | API kľúče sa nikdy nezobrazia AI ani v exporte | M |

### 🖥️ Epik 3 — Editor (FORGE-3xx) · M2 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 301 | File explorer (strom súborov, add/rename/delete/upload) | plná správa súborov, drag & drop | L |
| 302 | Monaco/CodeMirror editor (highlight, autocomplete, TS) | editácia = recompile náhľad; chyby inline | L |
| 303 | Git-like verzovanie: commity, branches, merge/rollback | snapshoty sú de facto commity; restore + diff + fork vetiev | XL |
| 304 | Visual Edit mode → reálne CSS patche | klik na element = AI/JSON patch, nie len hover highlight | L |
| 305 | Reálna Dev console (logy, chyby, sieť z preview) | Console tab = živé logy runtime, nie mock zoznam | M |
| 306 | Komponent library („insert component": navbar, footer, formulár…) | vloženie bez rozbitia layoutu | M |
| 307 | Breakpoints & device frames + režim „reálne zariadenie" | existujúce viewporty + otvorenie v novom tabe (mimo sandboxu) | S |
| 308 | Linting + autoformát + TS strict check | chyby v editore, nie až pri builde | M |

### 🧱 Epik 4 — Blueprinty (FORGE-4xx) · M2 · **P0** *(explicitne požadované)*

Blueprint = **parameterizovateľná šablóna celej aplikácie** (nič mock — reálny projekt s DB, auth, stránkami), ktorá sa vygeneruje na 1 klik.

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 401 | Blueprint formát + runtime | metadata: stack, screens, DB schéma, env, sekcie AI promptov; verzie blueprintu | L |
| 402 | Štartovacia galéria (12+): SaaS starter, e-shop, blog+CMS, rezervačný systém, CRM, portfólio, members area, AI chatbot, invoicing, event registrácia, job board, recipes/fándž | každý blueprint: živý demo, zoznam funkcií, stack, čas „do appky" < 60 s | XL |
| 403 | Blueprint wizard | výber → parametre (brand, logo, farby, jazyk, mená entít) → AI doladí → hotovo | M |
| 404 | Blueprint forking / „Remix" | remix uloží kópiu do môjho účtu ako nový projekt | S |
| 405 | Private blueprinty (Pro/Business) | tím si uloží vlastný blueprint + interné šablóny | M |
| 406 | Komunitná galéria + moderácia | publish blueprintu, hodnotenie, tagy, „trending" | L |
| 407 | Marketplace + revenue share (M6) | predaj platených blueprintov, 80/20 split, payouts | XL |
| 408 | Blueprint analýza: usage → optimalizácia konverzie | miera „blueprint → publish" per šablóna | M |

### 📝 Epik 5 — Prompty & AI ops (FORGE-5xx) · M1–M2 · **P0** *(explicitne požadované)*

Systémové prompty = jadro produktu. Verziované, testované, A/B.

| ID | Prompt pack | Účel / akceptačné kritériá | Odhad |
|---|---|---|---|
| 501 | **P1 — Master Builder Prompt** | plánovanie (Agent Mode kroky), brand konzistencia, dizajn systém, slovenčina/angličtina podľa používateľa; vždy najprv plán, potom kód, potom zhrnutie | M |
| 502 | **P2 — Iterate/Edit Prompt** | zmeny len v dotknutých súboroch, zachovať fungujúce časti, stručné vysvetlenie zmien | M |
| 503 | **P3 — Fix/Debug Prompt** | dostane chybu + kontext → oprava + regresný fix; koreň príčiny, nie len symptóm | M |
| 504 | **P4 — Explain Code Prompt** | „vysvetli tento súbor/element" — pre netechnických zákazníkov, jednoducho | S |
| 505 | **P5 — Blueprint Parameterization Prompt** | naplní blueprint parametrami brandu (farvy, tón, jazyk, naming) konzistentne | M |
| 506 | **P6 — Test Generation Prompt** | AI k vygenerovanej appke napíše unit + e2e testy; nahradí mock test suite z prototypu reálnymi testami | M |
| 507 | **P7 — SEO/Content Prompt** | meta tagy, OG obrázky, copy pre landing vygenerovanej appky | S |
| 508 | **P8 — Safety Meta-Prompt (guardrails)** | odolnosť na prompt injection, žiadne secrets do kódu, bezpečné defaults, licenčne čisté dependency | M |
| 509 | Eval set (golden prompts + očakávané výstupy) + nočné regresné behy | zmena promptu nerozbije > 5 % prípadov; report do interného dashboardu | L |
| 510 | Prompt versioning + A/B + feature flagy | prepnutie verzie promptu bez deploy | M |

**Kostra Master Prompt (P1) — východzí bod:**

```text
Si Forge Agent — staviaš produkčne kvalitné webové appky.
Pravidlá:
1) Najprv krátky plán (3–6 krokov), potom kód, na konci zhrnutie + návrhy na ďalší krok.
2) Vždy dodržuj brand používateľa: {brand_fareby, fonty, tón hlasu, jazyk}.
3) Kód: TypeScript + React + Vite, Tailwind; žiadne todo komentáre, všetko musí bežať na prvé spustenie.
4) DB schémy navrhuj len keď appka reálne potrebuje dáta; vždy s migráciou a seedom.
5) Nikdy nevkladaj secrets ani kľúče do kódu — používaj env premenné z vaultu.
6) Keď opravuješ, men len to, čo je nutné (diff), a vysvetli zmenu v 1–2 vetách.
7) Ak je požiadavka nejednoznačná, polož presne jednu spresňujúcu otázku.
```

### 🚀 Epik 6 — Hosting & publish (FORGE-6xx) · M1 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 601 | Reálny deploy na CDN + `*.forge.app` subdoména | publish z demo → reálna URL, HTTP 200, SSL, global CDN | L |
| 602 | Custom domains + auto SSL (Let's Encrypt) | „pripoj doménu" = 2 DNS záznamy, validácia, cert automaticky | M |
| 603 | Preview deployments (per commit/branch) | každá verzia má vlastnú URL; produkcia sa mení len „Promote" | M |
| 604 | Rollback deployment na predchádzajúcu verziu | 1 klik, < 30 s | S |
| 605 | Export: ZIP + GitHub (push do repo) | súčasný „Export ZIP" musí vrátiť reálny projekt | M |
| 606 | Build statusy + logy v publish flow | súčasný modal so 4 krokmi napojený na reálny pipeline stav | S |

### 🔐 Epik 7 — Auth & organizácie (FORGE-7xx) · M1 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 701 | Registrácia/login: e-mail+heslo, Google, GitHub | heslá bcrypt/argon2, e-mail verify, reset hesla | M |
| 702 | 2FA (TOTP) | Pro+ feature | S |
| 703 | Organizácie & tímy, role (owner/admin/editor/viewer) | pozvánky e-mailom, RBAC na projektoch | L |
| 704 | Prenos vlastníctva projektu, mazanie s grace period | soft-delete 30 dní | S |
| 705 | SSO/SAML/SCIM (M5, Enterprise) | Okta/Entra, automated provisioning | XL |

### 💳 Epik 8 — Billing & predplatné (FORGE-8xx) · M1 · **P0** *(jadro obchodného cieľa)*

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 801 | Stripe: mesačné + ročné plány, 14-dňový trial | upgrade/downgrade/cancel self-service, proration | L |
| 802 | Pricing page (SK/EN) + plán porovnanie | jasné limity, FAQ, „najpopulárnejší" badge | S |
| 803 | Feature gating + usage limits (middleware) | limit dosiahnutý = upsell, nie tvrdá stena (soft limit + upozornenie) | M |
| 804 | Usage metering dashboard (generácie, tokeny, blueprinty, deploys) | zákazník vidí spotrebu v reálnom čase (rozšíri /editor) | M |
| 805 | Fakturácie: DPH/EU B2B reverse charge, IČO/DIČ, stiahnutie faktúr | daňovo korektné pre SK/EU | M |
| 806 | Dunning (neúspešné platby), refund flow, legal (GDPR, ToS, DPA) | automatické e-maily, compliance | M |
| 807 | Seat billing pre Business plán | pridať/odobrať člena mení fakturu pro rata | M |
| 808 | Affiliate/partner rabaty (M6) | referral link, provízia 20 % 12 mesiacov | M |

**Návrh plánov (východzí, overovať cenovú citlivosť):**

| | **Free** | **Pro** ~20 €/mes | **Business** ~50 €/mes (3 seats) | **Enterprise** — custom |
|---|---|---|---|---|
| Generácie/mesiac | 10 | 200 | neob. „fair-use" | SLA |
| AI tokeny | 100 k | 5 M | 20 M | custom |
| Blueprinty | 3 základné | celá galéria + private | + tím šablóny | + SSO, DPA |
| Súkromné projekty | ✗ | ✓ | ✓ | ✓ |
| Custom domény | ✗ | 1 | 10 | neob. |
| Export ZIP/GitHub | ✗ | ✓ | ✓ | ✓ |
| Rollback & branches | ✗ | ✓ | ✓ | ✓ |
| Tím/kolaborácia | ✗ | 1 užívateľ | 3+ seats | neob. + RBAC |
| Support | komunita | e-mail < 48 h | priorita < 24 h | CSM, SLA 99.9 % |

### 👥 Epik 9 — Kolaborácia (FORGE-9xx) · M4 · P1

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 901 | Realtime multi-user edit (CRDT/Yjs) | 2+ ľudia bez konfliktov, prítomnosť (avatary) | XL |
| 902 | Komentáre v preview (annotácia na elemente) | klik = koment, thread, resolve; AI odpovedá na koment | L |
| 903 | Share linky: view / comment / edit s expiráciou | prístup bez účtu pre view | M |
| 904 | Activity feed + audit log | kto čo kedy (zákaz aj pre Enterprise audit) | M |
| 905 | Approvals: publish len so súhlasom roly | Enterprise workflow | M |

### 🛡️ Epik 10 — Security & compliance (FORGE-10xx) · M1 (základ) / M5 · P0/P1

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 1001 | Sandbox izolácia ( žiadny prístup k dátam iných zákazníkov) | pentestom overené; egress filter | XL |
| 1002 | Prompt injection ochrana (P8) + content moderácia uploadov | eval: < 2 % prienik | M |
| 1003 | Šifrovanie secrets vault (KMS), rotácia kľúčov | audit: secrets nikdy v logoch | M |
| 1004 | Rate limiting + abuse monitoring per účet/IP | anti-scraper, anti-mining | M |
| 1005 | GDPR: DPA, mazanie účtu + export dát, logs retention | súlad od dňa 1 (EU trh) | M |
| 1006 | SOC 2 Type II cesta (M5) | 12-mesiac observačnosť, security program | XL |
| 1007 | Zálohy, DR, uptime statusy (99.9 % Enterprise) | RTO/RPO definované, status page | M |

### 🎨 Epik 11 — Product/UX & onboarding (FORGE-11xx) · M1–M2 · P1

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 1101 | Onboarding wizard + interaktívny tour | „time to first app" < 5 min; skip možný | M |
| 1102 | Vzorové demo projekty (bez registrácie — playground) | visitor vyskúša pred signup (konverzia) | M |
| 1103 | Prázdne stavy + errory + skeletony (jednotný systém) | žiadny „dead end" v UI | S |
| 1104 | i18n SK/EN (celá UI vrátane editora) | prekladač, fallback EN | M |
| 1105 | Templatesá „app pre mňa": AI interview (3 otázky → návrh) | warm-up preplnenie promptu | M |
| 1106 | Notifikácie: e-mail (publish, limit, digest týždeň) | opt-in, unsubscribe | M |
| 1107 | PWA / mobilná podpora editora | /editor responzívne (sidebar na mobile dopracovať) | M |
| 1108 | Nápoveda/docs + AI asistent v dokumentácii | self-service podpora znižuje cost per user | M |

### 📊 Epik 12 — Analytics & operácie (FORGE-12xx) · M1+ · P1

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 1201 | Produktová analytika (funnel: signup → 1. appka → publish → platba) | North Star: „publikované appky / týždeň" | M |
| 1202 | Interný dashboard: LLM costy per user/plán | margin > 70 % na Pro pláne | M |
| 1203 | Zákaznícke analytiky pre ich appky (opt-in) | Forge = analytics pre end-userov (pridaná hodnota) | M |
| 1204 | Support: ticketing + znalostná báza + SLA per plán | < 5 % ticketov na chybu AI | M |
| 1205 | Feedback: in-app návrhy + roadmap voting | prioritizácia podľa zákazníkov | S |

---

## 3. Prioritizácia (MoSCoW pre M1 — „o čo dnes zákazník platí")

**Must (M1):** 101–107, 201–202, 103, 301 (min. read-only explorer), 501–505, 508–510, 601, 605–606, 701, 703 (solo stačí), 801–806, 1001 (základ), 1005, 1101–1103, 1201–1202
**Should (M2):** 108, 204–206, 302–306, 401–405, 506–507, 602–604, 1104–1105
**Could (M3+):** 207, 303 branches/merge, 406–407, 901–903, 1203
**Won't (pre M1):** marketplace payouts (407), SSO (705), SOC2 (1006), affiliate (808)

## 4. Kritické riziká & závislosti

1. **LLM costy** — metering (106, 1202) musí byť v M1, inak sa dá Pro plán predávať so stratou.
2. **Sandbox bezpečnosť** (1001) — priamy predpoklad pre multi-tenant hosting; blokuje custom domény v M3.
3. **Kvalita AI výstupov** — bez eval setu (509) každa iterácia promptov = hazard retencie.
4. **Single-point dependency** na jedného providera → failover (101) v M1.
5. **Konkurencia** (Lovable, v0, Bolt) — diferenciácia: SK/EU lokalizácia, blueprínty pre vertikály (denné dostihy: kade, fitness, wellness), DPH/faktury podľa EU, data residency v EU.

## 5. Quick wins z existujúceho prototypu (dni, nie týždne)

- /editor: doplniť projekty na mobile (sidebar sa skrýva) — FORGE-1107
- Publish button v /editore prepojiť s reálnym publish flow (už je) + „Publikované" state perzistovať
- Export ZIP: nahrať mock ZIP aspoň so skutočným obsahom `index.html` (do 605)
- Konverzný CTA „Upgrade" → pricing sekcia (prázdna mapa plánov pred M1)
- Keyboard shortcut help overlay (?), command paleta (Ctrl+K)

## 6. Definition of Done — „MVP, za ktoré sa platí"

- [ ] Zákazník zaregistruje, popíše ideu, do 5 min má bežiacu appku na verejnej URL
- [ ] Zákazník uvidí vlastné dáta (DB) a login v appke funguje
- [ ] Platba kartou → Pro plán aktívny, faktúra s DPH stiahnuteľná
- [ ] Usage dashboard ukazuje spotrebu a limity plánu
- [ ] Chyba AI = čitateľná správa + retry, nielen spinner
- [ ] Rollback na predchádzajúcu verziu < 30 s
- [ ] Zrušenie predplatného self-service (GDPR-ready)
- [ ] Uptime publish pipeline > 99 % počas prvého mesiaca
---

## 7. M2 Build Prompt — Editor + blueprinty

> Prompt priamo na mieru z míľnika **M2**. Cieľ: jeden senior frontend engineer implementuje celý M2 do existujúceho single-file prototypu.

**Rola:** Si senior frontend engineer. Pracuješ v existujúcom single-file HTML prototype Forge AI Builder (Lovable klon). Doimplementuj celý míľnik M2 — Editor + blueprinty.

**Rozsah (5 vecí):**

1. **File explorer + editor** — záložka „Súbory" v `/editor` dashboardu: virtuálny VFS (index.html, styles.css, app.js, README.md) extrahovaný z jedného HTML snapshotu, Mono-like editor s číslami riadkov a syntax highlightom, editácia v textarea, uloženie (Ctrl+Enter) spätne skladá single-file HTML a prekreslí live preview.
2. **Git-like history** — záložka „History": commity = verzie (hash, HEAD badge, správa, +adds/−dels diff štatistika), akcie Obnoviť / Pozrieť / Diff, tvorba branch (`feature/xxxx`) a checkout.
3. **Blueprint galéria** — 6 blueprintov (SaaS Landing, Kanban, Settings, CRM Dashboard, Blog SaaS, E-shop Dashboard) s náhľadmi, stackom a časom generovania.
4. **Brand wizard** — klik na blueprint otvorí wizard: názov značky, primárna farba (color picker), jazyk UI (SK/EN); po potvrdení sa spustí generovanie s aplikovaným brandingom (premapovanie mien a farieb šablóny).
5. **Prompt knižnica** — 8 overených promptov (Build×2, Edit×2, Fix, Explain, Tests, SEO) so zástupnými `[zátvorkami]`; klik vloží prompt do composeru.

**Pravidlá:**

- Zachovaj všetky existujúce ID/API — test suite musí ostať zelená.
- Žiadne CDN závislosti, všetko inline v jednom súbore.
- Slovenské UI, dbg() log na každej akcii, respektuj CSS tokens a tmavú tému.
- Všetky zmeny responsive (mobil 390 px).
- V reťazcoch v JS vždy escapuj `</script>` ako `<\/script>`.

**Akceptačné kritériá:**

- Onboarding do 5 min: používateľ bez vygenerovaného projektu vie otvoriť každú záložku a niečo s ňou urobiť.
- Uloženie súboru sa prejaví v live preview bez reloadu.
- Blueprint wizard vygeneruje projekt s aplikovanou vlastnou značkou podľa vstupu.

**Stav: ✅ celý M2 implementovaný v prototype (8. 10. 2026)** — file explorer s VFS, editor so syntax highlightom, git-like history s branchmi, blueprint galéria s brand wizardom a prompt knižnica sú v workspace prototype hotové a otestované (syntax-check + smoke-test roundtrip VFS/brand; plná suite Ctrl+Shift+T v prehliadači).
---

## 8. M3 Build Prompt — Fullstack & data

> Prompt priamo na mieru z míľnika **M3**. Cieľ: jeden senior frontend engineer implementuje celý M3 do existujúceho single-file prototypu (nadväzuje na hotový M2 editor).

**Rola:** Si senior frontend engineer. Pracuješ v existujúcom single-file HTML prototype Forge AI Builder (Lovable klon, hotové M0–M2). Doimplementuj celý míľnik M3 — Fullstack & data.

**Rozsah (4 veci):**

1. **DB pre vygenerované appky** — nová záložka „Backend → DB" v `/editor`: per-projekt databáza (tabuľky podľa typu appky: `leads`/`tasks`/`profiles`/`orders` + `users`), schéma, data browser so záznamami, pridanie/odstránenie záznamu, počty riadkov.
2. **Auth pre end-userov** — „Backend → Auth": zapnutie/vypnutie auth per projekt, providery (E-mail/Google/GitHub), zoznam registrovaných end-userov, sessions metrika; zapnutie vloží login obrazovku priamo do live preview appky (jedným klikom vrátiť).
3. **Backend funkcie** — „Backend → Funkcie": serverless API endpointy per projekt (`GET/POST /api/…`), metóda, path, popis, latencia; „Testovať" vykoná mock volanie a odpoveď 200 vypíše do Console.
4. **Custom domény + SSL** — „Backend → Domény": pripojenie vlastnej domény (validácia formátu), DNS + Let's Encrypt wizard (3 kroky: A záznam → CNAME → cert), zoznam domén so SSL statusom, primárna doména, odobranie.

**Pravidlá:**

- Zachovaj všetky existujúce ID/API — test suite musí ostať zelená.
- Žiadne CDN závislosti, všetko inline v jednom súbore.
- Slovenské UI, dbg() log na každej akcii, respektuj CSS tokens a tmavú tému.
- Všetky zmeny responsive (mobil 390 px).
- V reťazcoch v JS vždy escapuj `</script>` ako `<\/script>`.
- Backend cache per snapshot ID (ako VFS), reset pri novom projekte.

**Akceptačné kritériá:**

- Každá zo 4 sekcií Backendu je použiteľná bez vygenerovaného projektu (prázdny stav) aj s projektom.
- Zapnutie auth preukázateľne zmení live preview (login obrazovka) a dá sa vypnúť.
- Test endpointu vypíše odpoveď do Console; pripojená doména má SSL status.
- DB záznamy sa dajú pridávať a mazať bez reloadu.

**Stav: ✅ celý M3 implementovaný v prototype (8. 10. 2026)** — DB data browser, end-user auth s login injekciou do preview, serverless funkcie s testovaním a custom domény s SSL wizardom sú v workspace prototype hotové a otestované (syntax-check + smoke-test; plná suite Ctrl+Shift+T v prehliadači).
---

## 9. M4 Build Prompt — Tímy & Business tier

> Z míľnika **M4**. Cieľ: jeden senior frontend engineer doimplementuje tímové funkcie do existujúceho single-file prototypu (nadväzuje na M0–M3).

**Rola:** Si senior frontend engineer v existujúcom single-file HTML prototype Forge AI Builder (hotové M0–M3). Doimplementuj míľnik M4 — Tímy & Business tier.

**Rozsah (5 vecí):**

1. **Realtime kolaborácia (demonštrácia)** — záložka „Tím" v `/editor`: online presence (avatary členov, live indikátor, simulovaní spolupracujúci), počet aktívnych editácií.
2. **Komentáre v preview** — komentárové piny priamo nad live preview v editore (klik na pin = thread), nový komentár s odpoveďou AI, resolve.
3. **Share linky** — generovanie zdieľacích liniek s oprávnením view / comment / edit a expiráciou (1 deň / 7 dní / 30 dní / neobmedzene), zoznam + revokácia.
4. **Seat billing** — Business plán: počet seats, pridanie/odobranie seatu s proration prepočtom (pro rata), cena per seat.
5. **RBAC** — roly owner / admin / editor / viewer, zmena roly klikom, pozvánka e-mailom (demo), akcie obmedzené rolou (viewer nemôže publish/export).

**Pravidlá:** zachovaj existujúce ID/API (test suite zelená), žiadne CDN, SK UI, dbg() na každej akcii, CSS tokens + tmavá téma, responsive 390 px, `</script>` v JS vždy ako `<\/script>`.

**Akceptačné kritériá:** každá z 5 vecí použiteľná bez projektu aj s projektom; koment pin je vizuálne ukotvený v preview a thread sa dá resolvnúť; share link sa dá vytvoriť aj revoknúť; zmena roly sa prejaví v audit logu (M5).

**Stav: ✅ celý M4 implementovaný v prototype (8. 10. 2026)** — tím so seatmi a RBAC, presence, komentáre v preview s AI odpoveďou, share linky s oprávnením a expiráciou. Nová záložka „👥 Tím" v `/editor`.

---

## 10. M5 Build Prompt — Enterprise & scale

> Z míľnika **M5**. Nadväzuje na M4 (tím + audit log sú základ).

**Rola:** Si senior frontend engineer v existujúcom single-file HTML prototype Forge AI Builder (hotové M0–M4). Doimplementuj míľnik M5 — Enterprise & scale.

**Rozsah (5 vecí):**

1. **Audit log** — neúprosný záznam akcií (kto čo kedy): zmeny rolí, share linky, publish, restore, auth toggle, domény, GDPR akcie; filtrovateľný zoznam v „Tím → Audit".
2. **SSO/SAML (Enterprise)** — prepínač SSO s flow (SAML metadata, enforced SSO), Okta/Entra zmienka, gate na pláne.
3. **Compliance (GDPR/SOC2 cesta)** — GDPR export dát (JSON download) a mazanie účtu s grace period (soft-delete 30 dní), SOC2 „v programe" badge, DPA odkaz.
4. **SLA** — Enterprise SLA 99,9 % status, uptime indicator, support priority.
5. **Rate limiting** — usage meter (generácie vs. limit plánu), soft limit + upozornenie pred tvrdou stenou, hlavička „transparentná spotreba".

**Pravidlá:** ako v predchádzajúcich promtoch — ID/API, zelené testy, žiadne CDN, SK UI, dbg(), tokens, responsive, `<\/script>`.

**Akceptačné kritériá:** audit log zachytáva reálne akcie z M4 (rola, share, publish); GDPR export vráti platný JSON; rate meter ukazuje spotrebu; SSO toggle preukázateľne mení stav a zapisuje do auditu.

**Stav: ✅ celý M5 implementovaný v prototype (8. 10. 2026)** — audit log napojený na tímové akcie, SSO/SAML, GDPR export + soft-delete, SLA status a rate limiting meter v „Tím → Audit & Compliance".

---

## 11. M6 Build Prompt — Ekosystém

> Z míľnika **M6**. Viralita: galéria, marketplace, remix, affiliate.

**Rola:** Si senior frontend engineer v existujúcom single-file HTML prototype Forge AI Builder (hotové M0–M5). Doimplementuj míľnik M6 — Ekosystém.

**Rozsah (5 vecí):**

1. **Komunitná galéria** — záložka „Galéria" v `/editor`: publikované blueprinty od komunity s autorom, lajkami, remix počtom, tagmi, „trending" badge, filtrovacie chipy, moderácia publishu (vlastný projekt → galéria).
2. **Marketplace blueprintov** — platené blueprinty s cenou, kúpa (checkout flow) → odomknutie remixu, revenue share 80/20.
3. **Remix** — klik na „Remix" skopíruje blueprint do môjho účtu ako nový projekt (spustí generáciu so šablónou daného typu).
4. **Affiliate** — referral link (forge.app/r/xx) s počtom klikov/konverzií a províziou 20 % / 12 mesiacov, copy to clipboard.
5. **Template contest** — aktívny súťažný template s hlasovaním (1 hlas per účet), leaderboard submitted šablón.

**Pravidlá:** ako v predchádzajúcich promtoch — ID/API, zelené testy, žiadne CDN, SK UI, dbg(), tokens, responsive, `<\/script>`.

**Akceptačné kritériá:** galéria sa dá filtrovať; platený remix vyžaduje kúpu a po nej funguje; remix reálne spustí generáciu; affiliate link sa dá skopírovať; hlas sa započíta len raz.

**Stav: ✅ celý M6 implementovaný v prototype (8. 10. 2026)** — komunitná galéria s filtrami, moderáciou a trending, marketplace s checkout flow, remix, affiliate panel aj template contest s hlasovaním. Nová záložka „🌐 Galéria" v `/editor`.
