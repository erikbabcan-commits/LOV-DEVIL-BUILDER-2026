# P0 hardening — pracovný stav (2026-10-28)

Tento dokument rozlišuje lokálny pilot od verejnej produkcie. **Lokálne P0 opravy neznamenajú splnené produkčné release brány. Verejný funkčný AI backend zostáva blokovaný.**

## Overené hranice

- Server sa štandardne viaže na `127.0.0.1`. Spustenie backendu s `NODE_ENV=production` fail-closed odmietne, keďže zatiaľ nemáme centralizovanú autentifikáciu a trvalé účtové kvóty.
- `AI_GENERATION_ENABLED=0` zastaví generovanie aj autofix. Lokálny single-process admission guard poskytuje maximálne 2 paralelné a 30 denných behov (konfigurovateľné cez `ServerConfig`). **Nie je to fakturačný ani distribuovaný quota engine.**
- API request body je obmedzené na 3 MB, vygenerované súbory majú vlastné limity a Zod validáciu.
- High-confidence secret scanner zamieta známe credential patterns v celom validovanom AI kontexte (vrátane histórie, názvov a ciest), pláne, generovanom výsledku a sandbox builde. Autofix kontroluje aj dekódovaný JSON výstup pred aplikovaním patchu a ďalším volaním modelu. Chybové výstupy sa redaktujú pred skrátením; pri PEM private key sa odstráni celý blok vrátane tela, pri neúplnom bloku zvyšok vstupu. **Nezaručuje rozpoznanie všetkých tajomstiev.**
- Lokálny Origin allowlist je presný (`http://localhost:5173`, `http://127.0.0.1:5173`). Podvrhnuté prefixy a nepovolené Origin sa odmietajú ešte pred prijatím AI behu. Požiadavky bez Origin ostávajú pre lokálny CLI pilot; nejde o náhradu produkčnej autentifikácie.
- `server/sandbox/builder.ts` iba kompiluje kód; nepúšťa používateľský Node proces. Importy sú zúžené na React runtime, výsledný bundle je limitovaný a iframe používa `sandbox="allow-scripts"` a CSP s `connect-src 'none'`.
- AI `stage` v klientovi vyžaduje explicitné Approve alebo Reject. Návrh je viazaný na projekt, snapshot a presný vstupný obsah zachytený pred požiadavkou; zmena projektu alebo súborov počas behu či review zneplatní schválenie. Oneskorený zrušený run neprepíše novší projekt. Reject nemení súbory, Approve tvorí nový snapshot jediným synchronným zápisom a je idempotentný pre opakovaný klik.
- AI kontext obsahuje iba zdroje z vybraného základného snapshotu. Ukladanie používa iba live snapshot, nie práve prezeranú históriu. Project, snapshoty, celý live file-set a `lastProject` sa ukladajú v jednej IndexedDB transakcii; identické opakované uloženie je povolené, konflikt immutable obsahu zruší celý zápis. Schválené odstránenia súborov sa po obnove nevracajú a revision counter sa obnoví z uložených dát.
- Falošný úspešný Publish je odstránený, tlačidlo ho označuje ako demo a oznamuje neexistujúcu hosting integráciu.
- GitHub Actions na pracovnej vetve sú už od commitu `0ef4d14` iba `workflow_dispatch`. Default vetva sa tým nemení. Release príprava nesmie spúšťať platené CI ani živé AI volania bez osobitne potvrdeného rozpočtu.

## Verejné API (lokálny pilot)

| Endpoint | Metóda | Stav |
|---|---|---|
| `/api/health` | GET | Lokálna diagnostika konfigurácie; nie dôkaz úspešnej AI inference |
| `/api/agent/generate` | POST | SSE, lokálny admission limit a kill switch; verejný režim blokovaný |
| `/api/sandbox/build` | POST | esbuild compile-only; verejný režim blokovaný |
| `/api/sandbox/autofix` | POST | Oprava maximálne na 2 pokusy, lokálny admission limit; verejný režim blokovaný |
| `/api/github/auth/*` | GET/POST | GitHub OAuth, sessions v pamäti procesu; nie identity provider pre celý produkt |
| `/api/github/export` | POST | Existujúca OAuth ochrana, export do GitHub repo |
| `/api/export/validate` | POST | Validácia exportných súborov |

Príklady odpovedí bezpečnostných brán: `ai_disabled` (503), `BUDGET_EXCEEDED` (429), `request_too_large` (413), `secret_in_context` (SSE error alebo HTTP 400).

## Threat model — otvorené riziká

| Riziko | Súčasná ochrana | Čo chýba pre produkciu |
|---|---|---|
| Zneužitie plateného AI API | loopback + kill switch + lokálne limity | prihlásenie, per-user quotas, atómické rezervácie, reálne token/cost metering |
| Spustenie nedôveryhodného kódu | compile-only, iframe CSP | worker/OS izolácia, memory/CPU/time quota a egress kontrola na úrovni hosta |
| Prompt injection | nedôveryhodný kontext označený, whitelist súborov | adversarial evals, striktné capability hranice a testované politiky |
| Únik tajomstva | high-confidence scan/redaction | vault, viacvrstvové secret scanning, neprenosnosť citlivých dát do LLM |
| Strata projektu | IndexedDB snapshoty, review gate | server-side DB, transakcie, idempotentné run entity, backup/restore |
| OAuth session | kryptografický state, HTTP-only cookie | odolná session store, login vlastníka aplikácie, revocation provider tokenu |
| Nedôveryhodný deployment stav | demo Publish otvorene označené | skutočný hosting, deploy verification a audit trail |

### Zostávajúce hranice lokálnej perzistencie

Oprava opakovaného uloženia nie je potvrdením všetkých editorových workflow.
Existujúci `saveEdFile()` mení obsah pod tým istým snapshot ID; následný persist
už uloženej verzie musí takýto konflikt odmietnuť. Treba doplniť verziovanie
manuálnych úprav a plné historické zdroje. Súčasná schéma súborov je iba podľa
projektu/cesty. Bez batch verzie alebo tombstones nie sú vyriešené zastarané
odstránenia pri editovaní vo viacerých taboch. Tieto scenáre zostávajú release
blokermi; nepredpokladajte bezpečnú súbežnú multi-tab editáciu.

## Brány pred verejným deployom

1. Zaviesť serverové identity používateľov a ownership/authorization na všetky mutácie.
2. Implementovať durable per-user usage metering a finančný kill switch s hard limitom.
3. Preniesť build do izolovaného procesu alebo VM s vynucovanými zdrojovými limitmi a egress kontrolou.
4. Zrealizovať dokumentovaný end-to-end bezpečnostný test suite vrátane útokov na súbeh, session a prompt injection.
5. Doplniť server-side persistence a audit log. Až potom otvoriť verejný bind.

Konkrétny produkčný cieľ ani API routing nie sú v tomto repozitári nakonfigurované.
`npm run build` zostaví Vite frontend, nie verejný Node backend. Stav release
preflightu a chýbajúce rozhodnutia sú v [RELEASE-PREFLIGHT.md](RELEASE-PREFLIGHT.md).

## Lokálne testovanie bez platenej AI

```bash
npm ci --ignore-scripts
MISTRAL_API_KEY= npm run typecheck
MISTRAL_API_KEY= npm run lint
MISTRAL_API_KEY= npm run test -- tests/unit
MISTRAL_API_KEY= npm run build
```

Pre testy esbuild musí byť nainštalovaná platformová binárka; ak `npm ci --ignore-scripts` neumožní esbuild build, použite `npm ci` v dôveryhodnom lokálnom prostredí. GitHub Actions sa nesmú spustiť automaticky bez vedomého súhlasu s nákladmi.
