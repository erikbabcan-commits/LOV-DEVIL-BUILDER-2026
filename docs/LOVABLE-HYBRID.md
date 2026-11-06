# Lovable UI + Cloud + Hono

WS-18 pridáva billing do hlavného cookie klienta a Hono (default OFF, iba
sandbox); Lovable billing proxy sa týmto nerozširuje. Hostovaný ani lokálny
Lovable zdrojový overlay sa nemení. Hlavné lokálne overenie:1001 passed/157
skipped a135 natívnych PG scenárov na každej verzii; detaily WS-18-BILLING.md.
Pri lokálnom overovaní je5177 starší hlavný frontend, nie Lovable UI. Skutočný
Lovable frontend zostáva v samostatnom `../lovable-github-local`; postupy a
hosted aktivačné limity nižšie tým nie sú nahradené.

Aktualizácia WS-17: hlavný frontend má samostatne opravený CodeMirror, privátne
obnoviteľné koncepty a immutable ručné uloženie/Ctrl+S s kompiláciou a CAS
save/reopen. Táto fáza nemení Lovable zdrojový overlay (68 hashov); historických
146 UI testov patrí WS-16. Main má 921 passed/110 skipped; aktuálne databázové
výsledky a limity evidujú `docs/WS-17-MAIN-CODE-EDITOR.md` a jeho JSON dôkaz.
Hosted projekt ani kredity sa nemenili.

Aktualizácia WS-16: lokálny CodeMirror a správa súborov vytvárajú skutočné ručné
verzie, kompilujú a zobrazujú chyby pri zdroji. Oddelené koncepty sa obnovujú
podľa účtu. Overené 146 UI testami, 87 PG scenármi na každej verzii a skutočným
browser tokom. Overlay má 68 položiek. Hosted stav/kredity sa nemenili;
podrobnosti a limity: `docs/WS-16-FILE-EDITOR.md`.

Aktualizácia WS-15: lokálny overlay už exportuje presné ZIP-y aktuálnych aj
historických zdrojov, s mobilným dialógom a kontrolou integrity. Overené aj
samostatné rozbalenie/build 12 šablón. Celkovo 125 UI testov; prenosný balík má
64 položiek vrátane aktualizovaného package manifestu a Bun locku. Hosted projekt
sa nemenil a kredity sa nečerpali. Detaily: `docs/WS-15-ZIP-EXPORT.md`.

Aktualizácia WS-14 (6. 11. 2026): samostatná lokálna pracovná kópia a prenosný
overlay už majú reálne ovládanie Hono AI, náhľadu, histórie aj projektového CRUD.
Prešlo 86 UI testov a 86 PostgreSQL scenárov na každej z verzií 16.15/18.6;
browser overil podpis testovacej Cloud identity → proxy → Hono → kompiláciu a
save/reopen. Živý Cloud/produkčný bridge tým nie je overený. Zmeny neboli
prenesené do hostovaného projektu a kredity sa nečerpali. Presný aktuálny rozsah,
limity a dôkazy: `docs/WS-14-LOVABLE-AI.md`. Opis uloženého exportu a hosted
aktivácie nižšie zostáva oddeleným historickým/prevádzkovým stavom.

Stav: lokálny Hono adaptér a prenosná serverová proxy sú implementované a
otestované. Používateľ schválil Cloud v Európe a Lovable potvrdil jeho aktiváciu
5. 11. 2026. V nastavení existujúcej databázy sa následne potvrdil región
Europe (Ireland). Prihlásenie, serverová proxy a stavový panel sú uložené
v Lovable. Používateľovo prihlásenie do aplikácie sa overilo v jeho IAB náhľade
6. 11. 2026; kontrola inej relácie Chrome nebola dôkazom chýbajúceho loginu.
Živé prepojenie s Hono ešte nie je overené; produkčný API kontajner ani Nginx
sa nemenili. Cloud storage pre prílohy zatiaľ nie je implementované.

Verejné discovery a JWKS sa nezávisle overili cez HTTP:
`https://wmjjecacgpfarrktecim.supabase.co/auth/v1` je presný issuer, JWKS obsahuje
EC/ES256 kľúč `d70aa4b0-5f29-43bd-b50f-b03965154b22`. To samo nepreukazuje,
akým algoritmom sa podpisuje skutočný user token; ten treba overiť po login.

Lovable projekt: https://lovable.dev/projects/21fdbb9f-3bac-49a3-8479-875cc9734777
Aktuálny kontrolovaný export je vedľa repozitára v `../lovable-hybrid-20261106`
(TanStack Start). Desať upravených súborov sa bajtovo zhoduje s finálnym archívom
`vorkeeei (2).zip`; odtlačky eviduje `SYNC-VERIFICATION.json` v exporte.
Nie je to synchronizovaný Git checkout. Lovable konektor má prístup k inému účtu;
správny projekt sa kontroloval cez prihlásené relácie prehliadača.

Kreditový limit používateľa: neklesnúť pod 30. Posledný overený zostatok 32,8;
ďalšie AI generovanie ani hosted buildy sa nespúšťajú. Existujúce automatické
dobíjanie pri 25 kreditoch nebolo zapnuté ani zmenené touto prácou. Lokálne
overovanie exportu nespotrebúva Lovable kredity.

## Autorita dát a identity

- Hono: projekty, workspace, immutable snapshoty, CAS, sandbox, AI kvóty.
- Lovable Cloud: používateľské prihlásenie, súkromné prílohy a auth predvoľby.
- TanStack server: autentifikovaná proxy s pevným zoznamom ciest; browser nepozná
  infra credentials. Žiadne duplicitné tabuľky projektových verzií v Cloud.

Cloud poskytne pôvodný user access token. Hono nezávisle overuje podpis RS256/ES256,
pevný `CLOUD_AUTH_ISSUER`, `aud=authenticated`, expiráciu, iat, subject a rolu.
Anonymous aj service-role tokeny odmieta. JWKS URL vzniká iba z konfigurácie
operátora; token nesmie určiť issuer ani adresu na sťahovanie kľúčov.
HS256 sa nepodporuje; zdieľaný Supabase podpisový secret sa neprenáša.

Migrácia `003_identity_links.sql` viaže `(issuer,subject)` na existujúce `users.id`.
Prepojenie je explicitné a spravované operátorom; zatiaľ nemá verejný linkovací
endpoint ani automatické vytváranie účtov. Email ani `user_metadata` účty nespája.
Existujúce projekty a kvóty zostávajú pri internom ID. Plán aj väzba sa čítajú
z DB pri každej požiadavke. Zmazanie väzby zastaví ďalšie požiadavky okamžite.
Operátorský nástroj `scripts/link-cloud-identity.ts` má predvolene iba dry run:
vyžaduje explicitné `DATABASE_URL`, `CLOUD_AUTH_ISSUER`, `--user-id` a `--subject`.
Väzbu vytvorí až `--apply`, nikdy neprepíše existujúcu a nepriraďuje podľa emailu.
Nečíta automaticky dotenv a neloguje konfiguráciu ani DB výnimky. Pred použitím
treba overiť vlastníctvo oboch identít. Na produkcii nebol spustený.
Staré heslové prihlásenie naďalej používa cookie a CSRF; neplatný Bearer nesmie
spadnúť späť na cookie. Cloud tokeny nesmú volať cookie-bound GitHub/export routy.
Výpadok JWKS alebo identity DB vracia 503, neplatný/neprepojený token 401.

Samostatný Cloud GitHub router a BFF factory sú pripravené v hlavnom repozitári,
default startup ich nezapína. Explicitné runtime prepínače a read-only preflight
sú pripravené v `docs/GITHUB-ACTIVATION.md`. Majú oddelené routy, overeného Cloud ownera,
serverový bridge key a HttpOnly nonce cookie; generický API kontrakt nižšie
ani cookie GitHub flow sa nerozširujú. Detaily v `docs/GITHUB-CONNECTOR.md`.
BFF ani callback UI zatiaľ nie sú nahrané a zapojené v hostovanom Lovable.
Lokálny overlay už obsahuje aj export uloženého projektu/historickej verzie
cez oddelené prepare/confirm/status/review/cancel/reconcile endpointy. Obnovená príprava
znovu overí súbory a vyžaduje čerstvý súhlas; zrušenie či expirácia uvoľní názov
iba pred začatím zápisu. JSON kontrakt je spoločný
v `shared/githubExportProtocol.ts`; GitHub nemení generický Hono allowlist. Následný lokálny storage prírastok pridáva iba GET `/api/project-storage`.
Read-only reconcile vie obnoviť výsledok po stratenej odpovedi či páde iba podľa
úplného serverového checkpointu z migrácie 007. Overuje ten istý verejný repo,
GitHub owner ID, branch/commit/tree a odtlačky súborov; nepridáva nový zápis.
Staršie/neúplné dôkazy alebo zmenená vetva ostávajú na ručné posúdenie.

Aktuálna produkcia používa Nginx `auth_basic`, nie vzorový Caddyfile v repozitári.
Ochrana sa nevypína. Bez transportného Secretu proxy posiela štandardný user
Bearer. Voliteľný `HONO_BASIC_AUTH` (server-only `username:password`) nastaví
`Authorization: Basic ...` pre existujúci Nginx a presne danú hlavičku
`X-LOV-Cloud-Authorization: Bearer ...` pre Hono. Hono vyžaduje syntaktický Basic
transport a aj tak nezávisle overuje pôvodný Cloud user JWT. Ambivalentná či
neplatná sekundárna hlavička neprijme cookie ako náhradu. Žiadne voľné názvy
infra hlavičiek. V proxy sa oba údaje zostavujú iba zo serverovej konfigurácie
a overenej relácie, nikdy z podvrhnutých hlavičiek klienta.

## Presný API kontrakt pre Lovable

Zoznam ciest je v `shared/honoBridge.ts`:

| Metóda a cesta | Vstup / výsledok |
|---|---|
| GET `/api/auth/me` | `{user:{id,email,plan},quota}` |
| GET `/api/project-storage` | vlastná kapacita účtu bez owner/query vstupu |
| GET `/api/projects?deleted=0&cursor=<id>` | `{projects:[{id,title,revision,updatedAt,deletedAt}],nextCursor}` |
| GET `/api/projects/:id` | `{id,revision,workspace}` |
| POST `/api/projects/:id` | `{expectedRevision,workspace}` → `{id,revision}` |
| POST `/api/projects/:id/delete` | `{expectedRevision}` → `{id,revision}` |
| POST `/api/projects/:id/restore` | `{expectedRevision}` → `{id,revision}` |
| GET `/api/sandbox/ready` | pripravenosť kompilátora |
| POST `/api/sandbox/build` | `{files:[{path,content}]}` → výsledok compile-only buildu |
| POST `/api/sandbox/autofix` | `{files:[{path,content}]}` → výsledok autofixu |
| POST `/api/agent/generate` | agent request → SSE; schéma `server/agent/schemas.ts` |

ID: `^[A-Za-z0-9_-]{1,128}$`. Create má `expectedRevision=0` a vracia 201;
update 200; stale CAS a zmenená stará história 409. Soft delete/restore majú CAS,
restore je možný 30 dní. `POST /api/projects`, PUT a samostatná snapshots route
neexistujú. Workspace schéma je `shared/projectSchema.ts`, súbory majú `name`,
snapshotové zdroje `sourceFiles` sú JSON string. Sandbox vstup používa `path`.
Limit projektového requestu je 8 000 000 bajtov, 40 súborov a 100 snapshotov.

Proxy musí overiť prihlásenie na serveri; vziať iba overený pôvodný user token;
zahodiť cudzie cookies a infra hlavičky; povoliť len uvedené metódy/cesty a
validované query parametre. Pevná HTTPS cieľová adresa zo Secrets, žiadne URL od
klienta, `redirect: manual` a odmietnutie 3xx. Bounded body, celkový timeout
vrátane streamovania (20s CRUD, 35s build, 130s AI), propagácia abortu,
`Cache-Control: no-store`, SSE bez bufferovania. Zachovať HTTP 401/403/409/429/503;
žiadne úspešné mock odpovede pri výpadku backendu.

Prenosná implementácia je `server/integrations/honoProxy.ts` (Web APIs bez Node
závislostí). Vstup `/api/hono/projects` mapuje na `/api/projects`; autentifikátor
injektuje oficiálna serverová Cloud integrácia, nie browser callback. Presný
route/query kontrakt je v `shared/honoBridge.ts`. Toto nie je automaticky
nasadená TanStack route: kód a runtime napojenie v Lovable sa overujú osobitne.

## Aktivačné kroky, ktoré ešte zostávajú

1. Cloud a región Europe (Ireland) sú overené; login aplikácie funguje.
2. Discovery issuer a asymetrický JWKS sú overené. Pri reálnom bridge teste ešte
   overiť podpis a audience skutočnej používateľskej relácie; nelogovať JWT.
3. Proxy aj login sú uložené v Lovable. Potvrdiť serverový `HONO_BASE_URL` a
   aktuálny hosted build; lokálny build sám nedokazuje nasadenie. Cloud migrácie
   vykonáva Lovable. Projektové CRUD je napojené v lokálnej WS-14 kópii;
   hostované UI ešte tento prírastok neobsahuje.
4. Pripraviť nasadenie Hono adaptéra a migrácie 003, potom explicitne previazať
   preukázaný Cloud subject s účtom používateľa. JWT z browsera sa neloguje.
5. Používateľ uloží existujúce Basic Auth údaje priamo do serverových Secrets
   Lovable ako `HONO_BASIC_AUTH`; hodnotu nesmie posielať do chatu. Pevný dvojitý
   transport vyššie zachová Nginx aj samostatnú Cloud identitu. Neukladať ho do
   VITE_* ani do klienta. Tento Secret ešte nie je nakonfigurovaný.
6. Skutočný test: Cloud login → Hono `/auth/me` → vlastné projekty → CAS save →
   sandbox; cudzí účet nič nevidí. Až tento test potvrdí živé prepojenie.

Lokálne zapnutie vyžaduje `AUTH_ENABLED=1`, DB, JWT secret a presný
`CLOUD_AUTH_ISSUER`; bez issuer zostáva Cloud vstup vypnutý. Nastavenie issuer
bez AUTH_ENABLED=1 spôsobí chybu štartu. Táto zmena neodstraňuje existujúci zákaz
verejného runtime v `server/index.ts`; produkčný deploy je samostatný krok.

## Overenie

`tests/unit/server/cloud-auth.test.ts`: skutočne podpísané ES256 tokeny + Hono +
pg-mem; identita a DB plán, CRUD/CAS/oddelenie vlastníkov, zrušenie prepojenia,
falošný podpis/issuer/audience/expirácia/rola/anonymous/HS256/missing claims,
odmietnutie fallbacku na cookie, chýbajúca DB a default vypnutý Cloud.
Testy používajú iba vygenerované dočasné kľúče, bez živých služieb alebo AI.

`tests/unit/server/hono-proxy.test.ts`: pevná URL/route/query mapa, auth pred
upstream volaním, same-origin JSON mutácie, body/response limity, odstránenie
klientskych a upstream cookies/hlavičiek, zákaz redirectov, skutočné postupné
SSE, deadline počas auth/request body/fetch/streamu, cancel a dvojitý transport.
Podpísaný Cloud token prechádza cez proxy → skutočný Hono → pg-mem.

Na samostatnom rootless Linuxe prešlo **17/17 PostgreSQL scenárov**, vrátane
troch nových Cloud testov: súbežné väzby, uniqueness/FK/cascade a podpísaný token
→ proxy → Hono → PG s CAS/delete/restore/revocation. Migrácie 001–003 sa v každom
scenári prehrali dvakrát. Testovací kontajner bol po behu odstránený, label
`lov-devil.test=projects` bol prázdny. Log:
`/home/vorkei/.cache/lov-devil-backlog/run-20261105/cloud-identity-operator-final.log`.
Finálny beh zahŕňa Basic transport aj súbežné použitie operátorského helpera;
17/17 prešlo, exit 0, po behu bol uvedený Docker label prázdny.

Novšie rozšírené overenie na Macu: **30/30 PG scenárov prešlo na PostgreSQL
16.15 aj 18.6**, vrátane migrácií 004–007, GitHub state race, late finish vs.
disconnect/restart, podpísaného JWT/BFF/OAuth/PG, historického exportného výberu
a jediného writer volania pri 8 súbežných potvrdeniach exportu.
Provider GitHub bol simulovaný. Native runner nečíta app dotenv, používa SCRAM
a loopback; oba dočasné clustre zastavil a odstránil. Logy a receipt sú
v `deploy/lovable-github/proof/`; helper je `deploy/test-projects-native.py`.
Toto overenie nenahrádza živý bridge so skutočným Cloud issuerom a účtom.

Presný uložený Lovable export: 36/36 testov, TypeScript a build klienta,
SSR aj Workers prešli lokálne. Verejné assety neobsahovali serverové proxy
markery ani `HONO_BASIC_AUTH`. Stav najnovšieho hosted buildu nebol preukázaný.
GitHub tlačidlo v Lovable stále iba zobrazuje ukážkovú správu; návrh reálneho
napojenia a lokálna oprava izolácie účtov sú v `docs/GITHUB-CONNECTOR.md`.

Dokumentácia použitá pri návrhu:
- https://docs.lovable.dev/features/cloud
- https://supabase.com/docs/guides/auth/jwts
- https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md

Backlog príloh, 30+ formátov, ZIP a Auth brány zostáva zachovaný v pláne Lovable;
nie je touto integračnou prípravou implementovaný.
