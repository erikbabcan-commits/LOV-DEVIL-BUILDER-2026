# Serverové úložisko projektov — API základ

Implementované na existujúcej pracovnej vetve, bez commitov a bez produkčnej
migrácie. Klient má knižnicu projektov a ručné uloženie/otvorenie zo servera,
pričom ponecháva lokálnu perzistenciu podľa účtu. Automatická synchronizácia
na pozadí zatiaľ nie je zapnutá.

## Vlastníctvo a uloženie

`server/migrations/002_projects.sql` pridáva `builder_projects` s kompozitným
primárnym kľúčom `(owner_id, project_id)` a FK na `users`. Rovnaké lokálne ID
u dvoch účtov nekoliduje. Primárny index pokrýva bodové operácie aj owner/cursor
listing. Workspace je jeden JSONB dokument; jeho obsah a revízia sa menia
jedným atomickým UPDATE. Žiadne súbory sa nezapisujú do filesystemu a kód sa
pri uložení nespúšťa. Vymazanie používateľa cez databázu kaskáduje jeho projekty;
samotné account-delete API týmto prírastkom nevzniká.

Router sa registruje iba s existujúcim durable auth wiring. Všetky queries
obsahujú owner ID z overenej session, nikdy z request body. Mutácie prechádzajú
existujúcim CSRF middleware. Cudzie ID vracia 404; žiadna odpoveď neobsahuje
workspace cudzieho účtu. Projektové odpovede majú `Cache-Control: no-store`.
Databázové chyby vracajú generický 503 bez SQL, credentials alebo obsahu projektu.

## Kontrakt API

| Metóda a cesta | Správanie |
|---|---|
| `GET /api/project-storage` | vlastná kapacita `{usedBytes,limitBytes,usedProjects,limitProjects,trashedProjects,warning}`, bez query parametrov |
| `GET /api/projects?cursor=ID` | najviac 50 aktívnych projektov, iba metadata, `nextCursor` alebo null |
| `GET /api/projects?deleted=1&cursor=ID` | metadata projektov v koši |
| `GET /api/projects/:id` | vlastný `{id, revision, workspace}`, 404 cudzí/neexistujúci, 410 vlastný vymazaný |
| `POST /api/projects/:id` | `{expectedRevision,workspace}`; revízia 0 vytvára, ostatné aktualizujú |
| `POST /api/projects/:id/delete` | `{expectedRevision}`; soft delete a zvýšenie revízie |
| `POST /api/projects/:id/restore` | `{expectedRevision}`; obnova v 30-dňovej lehote a zvýšenie revízie |

Workspace obsahuje `title`, `isPublic`, `liveId`, `snapshots` a `files`.
Súbory majú `{name,content,modified?}`; snapshoty zodpovedajú klientskym poliam
`id,v,prompt,kind,time,html,pinned?,msg?,parentId?,sourceFiles?`. Klient má poslať
tento explicitný tvar, nie pridať IndexedDB interné `projectId` či owner fields.
Hodnota `isPublic` je iba uložená voľba, nevytvára verejný share link ani deploy.

Úspešné vytvorenie vracia 201 a revíziu 1; ďalšie mutácie 200 s novou revíziou.
409 znamená konflikt revízie, existujúci create alebo zmenu nemennej histórie.
Pri ukladaní existujú všetky predchádzajúce snapshoty v pôvodnom poradí a s
rovnakým obsahom; meniť sa môže iba `pinned`. Nové verzie sa pripájajú na koniec.
Databázové `WHERE revision = expectedRevision` zabezpečí jediného víťaza aj
pri dvoch súbežných zápisoch. Vytváranie navyše chráni unique constraint.

Klient nesmie konflikt riešiť slepým prepisom. Po timeout/network chybe môže
byť zápis dokončený; najprv treba načítať serverový dokument a rozhodnúť podľa
jeho revízie/obsahu. Revízia sa zvyšuje aj pri opakovaní identického obsahu.

## Kapacita účtu a súbežné ukladanie · 6. 11. 2026

Pilot má rovnakú kapacitu pre každý účet: predvolene **64 MiB JSONB workspace
obsahu a 100 uchovaných projektov**. Nejde o Free/Pro predplatné ani platené
navýšenie. Operátor ju môže nastaviť cez `PROJECT_STORAGE_MAX_BYTES` (1 až
1 073 741 824) a `PROJECT_STORAGE_MAX_PROJECTS` (1 až 10 000); neplatná hodnota
zastaví štart. Jednotlivé projekty naďalej podliehajú existujúcim limitom.

Používa sa PostgreSQL `octet_length(workspace::text)`: kanonická JSONB UTF-8
reprezentácia vrátane histórie. Do počtu aj bajtov patria všetky uchované
projekty, **aj kôš a položky po uplynutí lehoty obnovy**. Soft-delete miesto
neuvoľní; restore ho nezaberie druhýkrát. Automatický fyzický purge nie je
implementovaný. Metrika nezahŕňa indexy, metadata, WAL ani zálohy a nepredstavuje
limit fyzického disku alebo celej inštancie.

Každý workspace zápis používa `dbFromPool` a jednu pripnutú DB connection:
`BEGIN ISOLATION LEVEL READ COMMITTED`, zámok existujúceho `users` riadka
vlastníka, kontrola revízie/histórie, meranie súčtu a až potom INSERT/UPDATE.
Ďalší zápis toho istého účtu po získaní zámku vidí aktuálne commitnuté dáta,
aj pri inom predvolenom isolation level spojenia. Chyba vykoná ROLLBACK a
connection sa uvoľní. Adaptér bez `transaction` capability odmieta workspace
zápisy 503; samostatné `pool.query('BEGIN')` nie je podporovaná náhrada.
Delete/restore nemenia účtované rozmery a zachovávajú existujúcu CAS podmienku.

Súčet sa meria z aktuálnych riadkov; netreba novú migráciu ani backfill počítadla.
To znamená prechod cez JSONB obsah celého účtu pri čítaní kapacity a zápise.
Pred väčším rozsahom treba zmerať náklady a navrhnúť účtované počítadlá; zmena
ich neskrýva za neoverený claim o škálovaní.

Prekročenie vracia 413 `project_storage_quota` s aktuálnou kapacitou. Žiadny
workspace, revízia ani lokálna väzba sa pri odmietnutí nezmení. Po znížení
limitu možno čítať, exportovať, obnovovať, uložiť rovnaký alebo menší obsah;
zápis nesmie zväčšiť rozmer, ktorý je nad limitom. Nové projekty ho neobídu.
Knižnica zobrazuje využitie a upozorní od 80 % ktoréhokoľvek limitu. Zlyhanie
merania neblokuje otvorenie projektov. Lokálna práca a export ostávajú dostupné.

Cloud allowlist obsahuje jediný nový GET `/api/project-storage`; owner sa
odvodí z overenej identity a query/POST sa odmietajú. Zmena Lovable proxy je
pripravená iba v lokálnej kópii a portable overlay; hosted aplikácia sa nemenila.

## Limity a otvorené časti

- Body max 8 000 000 bajtov, najviac 100 snapshotov a 40 súborov v sade.
  Existujúce limity súborov: 200 kB na súbor a 2 MB na sadu. Historické source
  payloady sa validujú rovnako ako živé zdroje. Legacy `styles.css`/`app.js`
  sú povolené popri existujúcom path allowliste.
- ID max 128 znakov `A-Za-z0-9_-`, title max 120 znakov. Duplicitné ID/verzie,
  chýbajúci live snapshot, neplatní predchodcovia, traversal a vysoko dôveryhodné
  credential vzory sa odmietajú. Chyby validácie nevypisujú vstupný obsah.
- Používa sa existujúci rate limiter s kľúčom `projects:<userId>`, oddelene od
  AI kľúčov. Kapacita má vlastný kľúč `project-storage:<userId>`; limiter nie je distribuovaný.
- Kôš neumožňuje obnovu po 30 dňoch. Automatické fyzické mazanie po lehote
  ešte nie je implementované; nejde o uzavretie GDPR retention kritérií.
- Nie sú zavedené serverové branches/merge, spolupráca, verejné čítanie,
  organizácie/RBAC, deduplikácia veľkej histórie ani storage billing.
  JSONB dokument zjednodušuje atomické uloženie, ale limituje veľkosť histórie.
- API je súčasťou existujúceho servera po migrácii; aktuálnu produkciu sme
  nemenili. Pred verejným zapnutím zostávajú otvorené fyzická retencia, limity celej inštancie, billing a prevádzkové kontroly.

## Overenie a opakovanie

Osem spoločných API scenárov beží nad pg-mem. Skutočný PostgreSQL vykonáva tie
isté scenáre a navyše závod dvoch počiatočných create požiadaviek. Testy zahŕňajú
owner izoláciu aj pri rovnakých IDs, auth/CSRF, revízie, nemennosť, kôš/expiráciu,
validáciu, secrets, byte limit, pagination a redakciu chýb. Nad reálnym PG sa
v každom scenári migrácie spustia dvakrát. pg-mem opakovanie CREATE IF NOT EXISTS
nie je dôkazom: jeho AST coverage pri opakovaní zlyhá, preto ho overuje reálny PG.

Reálny rootless Linux: **9/9 prešlo**, Vitest 3.84 s. Test používal PostgreSQL 17
Alpine image `sha256:5d9ee39acd134b44f52fc49ca3b88fc651f0560b0db93292fcd37ff150c71d3a`,
samostatný kontajner UID 70, readonly root, tmpfs dáta, náhodné testovacie heslo,
loopback port a nové privátne schémy. PG pool má 4 spojenia. Po skončení sa
odstránili schémy, kontajner aj dočasný env; label lookup bol prázdny. Cudzie
dev kontajnery sa nemenili. Log zostáva na testovacom Linuxe:
`/home/vorkei/.cache/lov-devil-backlog/run-20261105/projects-postgres.log`.

```sh
NODE_ENV=test MISTRAL_API_KEY= npm test -- tests/unit/server/projects.test.ts
# Iba explicitne vybraný neprodukčný Docker daemon:
docker pull docker.io/library/postgres:17-alpine@sha256:5d9ee39acd134b44f52fc49ca3b88fc651f0560b0db93292fcd37ff150c71d3a
PROJECTS_TEST_DAEMON=1 bash deploy/test-projects.sh
```

Testovací script nevychádza z aplikačného `.env` a testu vyprázdni Mistral kľúč.
Konečná lokálna sada: **480 passed, 31 skipped** (21 Docker compile scenárov,
9 PG scenárov spustených osobitne, 1 pôvodný skip). Platený live smoke bol
výslovne vylúčený. TypeScript/produkčný build, ESLint nového rozsahu,
`bash -n deploy/test-projects.sh` a `git diff --check` prešli.
Produkčný `DATABASE_URL` sa na testovanie nepoužíva. Nová migrácia je aditívna;
budúci rollback API môže tabuľku ponechať bez zmeny používateľských dát. Tabuľku
automaticky neodstraňuj pri rollbacku; export/záloha a deštruktívna migrácia sú
samostatné prevádzkové rozhodnutia.

## Následná integrácia do rozhrania

`Moje projekty` v hornej lište otvára natívny modal s lokálnymi projektmi,
serverovým zoznamom, pagination a košom. Pilot zobrazuje iba lokálne projekty;
serverové ovládanie sa ponúka overenému účtu. Súborový composer, generovanie
a review sa musia dokončiť pred prepnutím. Počas operácie sa modal nezatvorí;
Ctrl+S v pozadí nevytvára checkpoint.

Projekt sa ukladá na server výslovnou akciou. Známa serverová revízia sa
uchováva pri lokálnom projekte. 409 nemení lokálny obsah; samostatné tlačidlo
uloží serverovú kópiu pod novým ID. Timeout/network chyba môže znamenať už
dokončený zápis, preto sa nesľubuje, že sa nič nezapísalo. Rovnaký projekt
sa dá načítať pod tým istým účtom v inom prehliadači cez serverový zoznam.
Automatické pozadie, realtime spolupráca a offline fronta zápisov ešte nie sú.

Pred otvorením sa aktuálny stav uloží lokálne. Ak serverový import nahrádza
rovnaké lokálne ID, jedna IndexedDB transakcia najprv vytvorí lokálnu kópiu
so snapshotmi, živými súbormi a runmi, potom nahradí pôvodný projekt a pointer.
Zlyhanie transakcie vráti obidve operácie späť. Import neprejde do pamäte pred
úspechom; epoch/fingerprint zabraňuje otvoreniu starej odpovede v inom účte
alebo zmenenom projekte. Lokálne kópie sa dajú z knižnice znovu otvoriť.

Serverové snapshot ID sa mapujú na nové lokálne UUID a ich mapping zostáva
pri projekte. Export späť na server používa pôvodné ID a predchodcov, takže
história ostáva nemenná. To umožňuje otvoriť aj samostatnú serverovú kópiu
bez kolízie s existujúcimi ID v IndexedDB. Verzie sa po obnove triedia podľa
`v`; poradie indexu IndexedDB podľa náhodných ID nie je chronologické.

Validátor workspace je zdieľaný v `shared/projectSchema.ts`, používa rovnaké
path/size/secret pravidlá na klientovi aj serveri. Výpočet UTF-8 bajtov cez
TextEncoder funguje v oboch runtime. ProjectLibrary a Zod sa načítajú lazy;
produkčný library chunk má približne 99 kB, hlavný bundle približne 376 kB.

Aktuálne výsledky: **486 passed/36 skipped** v plnej lokálnej sade; 36 skipov
znamená 21 Docker compile scenárov, 14 PG scenárov spustených osobitne a jeden
pôvodný skip. TypeScript/produkčný build, lint nového rozsahu a bash syntax prešli.
Klient kontroluje aj zhodu projektového ID v read/save/delete/restore odpovedi;
validný dokument alebo potvrdenie iného projektu odmietne samostatný regresný test.
Testy stále nemajú živý Mistral kľúč a live smoke je vylúčený.

Reálny PostgreSQL: **14/14 passed**, 9.89 s. Deväť pôvodných API scenárov plus
päť integračných scenárov s React/jsdom, fetch transportom do skutočného Hono
routera, skutočným PG poolom a fake-indexeddb: save/open/edit/resave, kópia
s kolidujúcimi server IDs, konflikt dvoch verzií, zmena účtu počas čítania,
atomic rollback a ovládanie koša/obnovy. Testovací kontajner po behu nezostal.
Log: `/home/vorkei/.cache/lov-devil-backlog/run-20261105/project-sync-postgres-final.log`.
Prvý pokus nespustil TSX integračný súbor pre existujúci include pattern;
počítajú sa až výsledky následného behu so správne objaveným `.test.ts` súborom.

Klikacie overenie prebehlo samostatne v loopback fixture s pg-mem (nie produkcia):
otvorenie 13-súborového React projektu, premenovanie, save na revíziu 2,
presun do koša, obnova na revíziu 4, otvorenie s lokálnou kópiou a prepnutie
alice→bob→alice. Bob nevidel lokálne ani serverové projekty Alice. Šírka
dokumentu aj viewportu bola 474 px. Screenshot je v artefaktoch chatu.

Pre opakovanie klikacieho fixture testu, pri voľnom porte 8788 a Vite proxy
na 127.0.0.1:8788 s frontendom na 5176:

```sh
NODE_ENV=test MISTRAL_API_KEY= LOV_SERVER=0 AUTH_ENABLED=0 PROJECTS_UI_FIXTURE=1 \
  ./node_modules/.bin/tsx tests/fixtures/projectsUiServer.ts
# Otvor http://localhost:8788/__test/session/alice (alebo bob).
```

Fixture má iba syntetické účty, vlastný podpisový secret a databázu v pamäti.
Binduje výlučne loopback a vyžaduje oba testové prepínače. Nepoužívaj ho ako
produkčný server. Pôvodná databáza pilota ani reálne účty sa nemenili.

Backend `deploy/Dockerfile` teraz kopíruje aj `shared/`; bez toho by runtime
nenašiel nový validátor. Samostatný testovací image sa úspešne zostavil a
v read-only/no-network kontajneri prešiel import API, interný health request
a nájdenie migrácie 002. Použil sa predvolený používateľ API image (root),
nie compile worker UID 65532. Prvý pokus s vnúteným UID 65532 nevedel čítať
súkromné módy súborov v testovacom stage; tento neúspešný pokus nie je dôkaz
non-root behu API. USER ani oprávnenia produkčných session volumes sa nemenili.
Overený lokálny image ID:
`sha256:ef6a811d236273a3dcba430a7576175df986ddc701249b0640509b85a6b8ad42`.
Logy: `project-sync-image.log` (build a prvý pokus) a
`project-sync-image-final.log` (úspešná kontrola) v rovnakom testovacom adresári.


## Overenie kapacity · 6. 11. 2026

Na PostgreSQL **16.15 aj 18.6 prešlo 41/41 integračných scenárov**. Nových deväť
storage scenárov a UI scenáre overujú kanonické UTF-8 bajty, vlastníctvo,
retained count/bytes, kôš/restore, zníženie kapacity, adaptér bez transakcií,
8 súbežných create, rast dvoch rôznych projektov a rollback po už vykonanom
INSERT. Default connection isolation je v quota kontrakte REPEATABLE READ;
produkčný adaptér ho pre každý zápis explicitne nahrádza READ COMMITTED.
Podpísaný Cloud JWT → proxy → Hono → PG flow číta aj nový metadata endpoint.
Oba dočasné clustre sa zastavili a odstránili; GitHub provider zostal simulovaný.

Klikacie overenie pri 390×844 px potvrdilo kapacitu 1/1, zamietnutie novej
serverovej kópie a zachovanie lokálneho projektu. Dokument nepretečie vodorovne.
Použilo iba syntetické loopback pg-mem dáta. Screenshoty a PG receipt sú v
`deploy/lovable-github/proof/`; fixture a Vite boli po overení zastavené.

Celoplošný lint má 0 chýb a 46 upozornení. Súčasťou upratania je Node prostredie
pre sandbox `.mjs` fixture a presun zámernej karantény po neistom Docker create
do catch vetvy; cleanup zostáva vo finally a pri zlyhaní má naďalej prednosť.
16 sandbox regresných testov prešlo; nové reálne Docker scenáre sa v tejto fáze
nespúšťali. Kapacitná zmena nemení runtime izoláciu ani produkčné nasadenie.

Konečná celá sada: **639 passed, 63 skipped**; platený live smoke vylúčený,
Mistral kľúč prázdny. 61 lokálnych Lovable testov, TypeScript oboch kópií a oba
buildy prešli. Skoršie zaťažené behy narazili na 5s budget dlhých testov.
Stránkovanie teraz seeduje dáta priamo; uloženie/kôš a obnova majú samostatné
UI scenáre. Testové ani aplikačné timeouty sa nezvyšovali.
