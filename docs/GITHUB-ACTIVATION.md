# Cloud GitHub — konfigurácia a kontrola pred aktiváciou

Lokálne pripravený postup pre existujúci chránený pilot/staging. Táto zmena
nenasadila kód, nespustila produkčné migrácie, nevytvorila Secrets ani GitHub
aplikáciu a nemenila hostované Lovable. Rezerva 30 Lovable kreditov stále platí.
Samotná prítomnosť prihlasovacích údajov službu nezapne.

## Režimy

| `GITHUB_CLOUD_ENABLED` | `GITHUB_CLOUD_EXPORT_ENABLED` | Správanie |
|---|---|---|
| prázdne alebo `0` | prázdne alebo `0` | Cloud GitHub routy vypnuté |
| `1` | prázdne alebo `0` | Pripojenie/stav/odpojenie; exportné akcie vracajú 503 |
| `1` | `1` | Aj prepare/review/confirm/status/cancel/reconcile |
| `0` | `1` | Chyba konfigurácie pred DB pripojením a migráciami |

Iné hodnoty prepínačov sa odmietnu. Scope je pevný `public_repo`; legacy
`GITHUB_OAUTH_SCOPE`, client ID/secret a callback sa do tohto flow nepreberajú.
`NODE_ENV=production` zostáva blokovaný existujúcou public-deployment guardou.
Nové prepínače ju neodstraňujú ani nenahrádzajú širšie MVP prevádzkové brány.

## Prostredie API a BFF

API potrebuje existujúce `AUTH_ENABLED=1`, `DATABASE_URL`, `JWT_SECRET` (minimálne
32 znakov), pevný `CLOUD_AUTH_ISSUER` a explicitnú väzbu identity. Issuer musí
byť kanonické HTTPS `/auth/v1`; nevypočítava sa z tokenu používateľa.

| Premenná na Hono API | Účel |
|---|---|
| `GITHUB_CLOUD_CLIENT_ID` | Samostatne zvolená OAuth konfigurácia pre Cloud flow |
| `GITHUB_CLOUD_CLIENT_SECRET` | Serverový provider secret, nikdy do browsera |
| `GITHUB_CLOUD_ALLOWED_ORIGIN` | Jedna presná HTTPS doména frontendu, bez koncového lomítka |
| `GITHUB_CLOUD_CALLBACK_URL` | Tá istá doména a presne `/github/callback`, bez query/hash/credentials |
| `GITHUB_CLOUD_ENCRYPTION_KEY` | Nezávislých 32 náhodných bajtov vo forme 64 hex znakov |
| `GITHUB_BRIDGE_SECRET` | Iný 64-hex kľúč medzi BFF a API |

Encryption/bridge kľúče sa nesmú rovnať sebe ani `JWT_SECRET`,
`GITHUB_SESSION_SECRET`, `SANDBOX_RUNNER_TOKEN` či provider secretu. Validácia
kontroluje formát a oddelenie kľúčov; neoveruje ich pôvod ani platnosť u GitHubu.
Vzory sú v `server/.env.example`. Compose číta API premenné z koreňového `.env`;
samotný zápis do `deploy/.env` ich neprenesie do app procesu.

Lovable BFF má vlastné serverové Secrets: `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `HONO_BASE_URL`, prípadné `HONO_BASIC_AUTH`, rovnaký
`GITHUB_BRIDGE_SECRET`, `GITHUB_CLOUD_CLIENT_ID` a `GITHUB_CLOUD_CALLBACK_URL`.
Encryption key ani OAuth client secret do BFF nepatria. Súkromné hodnoty vrátane
bridge key a Basic Auth nepatria do `VITE_*`, chatu alebo verejných assetov.
Supabase URL a publishable key sú verejné identifikátory; ich existujúce použitie
v generovanej klientskej integrácii sa nemení. Nginx Basic Auth sa zachová.

## Preflight bez zápisov

Z koreňa repozitára; cesta nižšie je zástupný príklad, nie vytvorený súbor:

```bash
npm run --silent github:preflight -- --help
npm run --silent github:preflight -- --env-file /secure/lov-cloud.env
npm run --silent github:preflight -- --env-file /secure/lov-cloud.env --check-db
```

CLI automaticky nečíta koreňový dotenv. Explicitný súbor má limit 64 KiB;
hodnoty existujúce v prostredí procesu majú prednosť, rovnako ako pri bežnom
dotenv štarte API. Hodnoty Secrets nepatria medzi argumenty príkazu. Výstup
obsahuje režim, názvy problémových polí a výsledok kontroly, nie ich hodnoty,
súkromné cesty, DB výnimky, účty alebo provider odpovede.

Bez `--check-db` sa nevykoná žiadne sieťové volanie. S ním sa použije jeden
DB klient v `BEGIN READ ONLY`, iba SELECT a následný ROLLBACK/ukončenie poolu.
Kontrola overí dostupnosť stĺpcov a oprávnenie SELECT, platné unique indexy pre
identity/state/job/project, presnú partial rezerváciu názvu a exportné stavy.
Nie je to úplný audit schémy ani doklad o každej historickej migrácii. OAuth-only
režim nevyžaduje exportné tabuľky. Návratový kód je nenulový pri neplatnej
konfigurácii alebo nepripravenej DB; vypnutý režim DB vôbec nekontaktuje.

Preflight nevytvára identity link, nemigruje, nemaže, neštartuje API a nevolá
GitHub, JWKS, AI ani Lovable build. `ok:true` bez DB kontroly znamená iba platnú
konfiguráciu; aj s DB kontrolou zostávajú live login, issuer/JWKS, provider
credentials a hostované prepojenie samostatným overením.

## Štart a neskoršie zapojenie

`server/index.ts` parsuje konfiguráciu pred providerom a DB vedľajšími účinkami.
Existujúci `AUTH_ENABLED=1` štart potom naďalej aplikuje migrácie 001–007;
preflight tieto migrácie nenahrádza. Pred sprístupnením Cloud GitHub routov
nasleduje rovnaká kontrola schémy a zapojenie `makeCloudGitHubWiring` s existujúcim
Cloud validátorom. Neplatná schéma zastaví štart servera.
Kontajnery budú obsahovať preflight aj existujúci identity helper; nový image
sa týmto prírastkom ešte nebuildoval ani nenasadzoval.

Najprv sa dá samostatne overiť OAuth-only režim. Identity helper má stále iba
dry run, kým operátor po overení vlastníctva oboch účtov nepoužije `--apply`.
Provider súhlas ani vytvorenie repozitára sa nespúšťajú pri štarte. Až po
overení hostovaného BFF a prihlásenia sa osobitne zapne export; každé zverejnenie
naďalej vyžaduje kontrolu súborov a výslovný súhlas používateľa.

Pri neskoršom vypnutí exportu stačí `GITHUB_CLOUD_EXPORT_ENABLED=0`; pri vypnutí
celého Cloud flow musia byť oba prepínače `0`. Zmena sa prejaví kontrolovaným
reštartom procesu. Potvrdené rozpracované exporty treba pred reštartom nechať
dobehnúť alebo potom zosúladiť podľa uložených dôkazov. Ledger, pending údaje,
kľúče ani identity sa pri prepnutí nemažú; neúplný zápis sa neopakuje naslepo.

Na lokálnych PostgreSQL 16.15 a 18.6 prešlo **30/30 scenárov** vrátane
read-only CLI, chýbajúcich DB kontraktov a skutočnej runtime factory:
podpísaný Cloud JWT → BFF → OAuth-only (export 503) → export zapnutý → simulovaný
GitHub zápis so stratenou odpoveďou → read-only recovery. GitHub bol simulovaný,
databázy skutočné a dočasné; oba clustre sa zastavili a odstránili.
