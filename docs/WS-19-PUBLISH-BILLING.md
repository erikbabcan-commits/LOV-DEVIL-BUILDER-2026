# WS-19 — skutočný statický Publish a Cloud billing

Rozsah: editor na Lovable, Hono/PostgreSQL na VPS. Implementácia odstraňuje
ukážkové publikovanie v hlavnom aj modernom UI a pripája moderný frontend k
existujúcemu billing backendu. Samotná implementácia nezapína platby, nemigruje
produkciu a nenahrádza overenie hostovaného nasadenia.

## Publikovanie

Autentifikované `GET /api/publish` vracia skutočnú dostupnosť; `POST /api/publish`
prijíma iba UUID požiadavky, vlastný serverový projekt, presnú revíziu, snapshot
a `publicConsent:true`. Klient neposiela zostavené HTML ani cieľovú URL. Backend
pod zámkom vlastníka zachytí uložené zdroje, validuje ich a spustí existujúci
izolovaný compiler. Migrácia `011_publish.sql` uchováva job a dôkazy artefaktu.

Výsledok má stav `building`, `published` alebo `failed`. Opakovanie UUID
zachová presný výber; claim/CAS bráni starému workeru prepísať novší stav.
Verejná URL vzniká iba po včasnom dokončení zápisu, presne validovanom receipt
(SHA-256 a počet bajtov) a potvrdení DB stavu `published`. UI umožňuje zistiť
neistý výsledok pri zachovaní identity účtu, projektu a pôvodného výberu.

### Trvalý storage protokol — migrácia 013

Krátke transakcie pod zámkom vlastníka majú `lock_timeout=1 s` a
`statement_timeout=2 s`; nevykonávajú filesystem I/O. Nový job vstupuje do
`compiling` s rezerváciou maximálnej veľkosti artefaktu. Pri status požiadavke
vlastníka aj novom prijímaní sa `compiling` starší než 120 s uzavrie ako
`failed/empty` s 0 bajtmi, aj keď klient stratil receipt. Rovnaké UUID tým
nespúšťa nový build. Pred prvým I/O musí byť samostatne potvrdená DB fáza
`writing`; až potom sa smie fyzicky zapisovať.

Všetky inštancie store v procese zdieľajú filesystem gate: najviac **2 aktívne
operácie**, **8 čakajúcich**, deadline najviac **5 s** vrátane čakania. Slot sa
uvoľní až po skutočnom skončení práce. Zrušená čakajúca operácia sa neskôr
nesmie spustiť; samotný timeout bežiaceho I/O nepotvrdzuje jeho zastavenie.
Neistý `writing` preto ponecháva plnú rezerváciu. Potvrdené neskoré fyzické
uloženie smie skončiť iba ako `failed/retained` so skutočným počtom bajtov,
bez verejnej URL. `legacy_unknown` z existujúcich záznamov vyžaduje operátorské
obnovenie; kapacita sa z neho automaticky neuvoľňuje.

Trvalý limit pokusov je prednastavene **20**, vlastná konfigurácia najviac
**100**. Počítajú sa všetky joby vrátane neúspešných a prázdnych. Retencia,
vyčistenie osirelých súborov a bezpečné obnovenie neurčitých záznamov zostávajú
otvorenou operátorskou úlohou; diagnostické meranie súborov nepatrí do owner
transakcie a nesmie uvoľniť živého writera.

Kontrakt vychádza z [PublishService](../server/publish/service.ts),
[ArtifactStore](../server/publish/artifacts.ts),
[FilesystemGate](../server/publish/storageGate.ts),
[limitov konfigurácie](../server/publish/config.ts) a
[migrácie 013](../server/migrations/013_publish_storage_phase.sql).

Verejné HTML servuje **samostatný listener**, ktorý neobsahuje aplikáciu ani API.
Vyžaduje presný Host, inú hostname než editor a v produkčnej konfigurácii HTTPS.
Povoľuje iba GET/HEAD `/p/<artifact UUID>/`. Pred každým načítaním overí DB stav,
veľkosť a SHA-256 súboru; symlinky a prepis existujúceho artefaktu odmieta.
CSP používa `sandbox allow-scripts` bez `allow-same-origin`, nepovoľuje sieťové
API, formuláre, framing ani cudzie skripty. Verejný listener nevydáva auth cookies.

Táto verzia hostuje statické React aplikácie zostavené podporovaným toolchainom.
Nenasadzuje backend, DB/login generovanej aplikácie, ľubovoľné npm závislosti ani
HMR. Je to samostatný verejný snapshot; úprava projektu vyžaduje novú publikáciu.
Platí kapacita na vlastníka a rezerva voľného disku; retencia musí rátať aj s
neúspešnými pokusmi a osirelými artefaktmi. Prednastavená disková rezerva je 1 GiB.

Zapojenie je default OFF:

- `PUBLICPUBLISH_ENABLED=1`, existujúce `AUTH_ENABLED=1` a overená schéma migrácií 001–013;
- `PUBLICPUBLISH_BASE_URL`: presná HTTPS root URL verejného hostingu;
- `PUBLICPUBLISH_APP_URL`: presná root URL Lovable aplikácie, iná hostname;
- `PUBLICPUBLISH_ARTIFACT_DIR`: absolútna cesta mimo repozitára na trvalom volume;
- `PUBLICPUBLISH_BIND`/`PUBLICPUBLISH_PORT`: samostatný listener, štandardne loopback 8791;
- funkčný izolovaný sandbox runner. Host compiler sa povoľuje iba v explicitnej test fixture.

`deploy/compose.publish.yaml` je voliteľný vzor volume/loopback portu;
`deploy/ops/publish-nginx.conf.template` je vzor oddeleného HTTPS hosta.
Samostatný TLS vstup a izolovaný worker už majú vlastný prevádzkový dôkaz;
nový aplikačný runtime ešte nie je aktivovaný. Existujúca produkcia používa vlastné nginx/lov-net zapojenie;
ukážkový compose sa cez ňu nesmie spustiť bez prispôsobenia. Globálny existujúci
startup guard pre `NODE_ENV=production` sa touto funkciou neodstraňuje.

## Billing

`BILLING_ENABLED=0` zostáva bezpečný default. `BILLING_MODE=test|live` explicitne
volí prostredie; vynechaný režim zachová test pre existujúce konfigurácie.
Live vyžaduje `sk_live_…`, test `sk_test_…`. Kontrola režimu platí pre ceny,
zákazníkov, predplatné, Checkout session a podpísané udalosti. Connect sa stále
nepovoľuje. Webhook overuje pôvodné bajty oficiálnym SDK; návratová URL neprideľuje Pro.

Migrácia `012_billing_environment.sql` pridáva nemenné pripnutie prostredia DB.
Staré WS-18 billing dáta sú testové; ich DB sa nedá zapnúť ako live iba výmenou
kľúča. Live potrebuje samostatnú DB alebo osobitne posúdený offline prenos.
Konfiguračné fingerprinty a provider idempotency kľúče zohľadňujú režim. Nové
nasadenie nesmie zdieľať testové oprávnenia s platenými zákazníkmi.

Cloud proxy povoľuje presne `GET billing`, `POST billing/checkout` a
`POST billing/portal`; nepovoľuje webhook ani ľubovoľné customer/provider cesty.
Zachováva origin, JSON/body/deadline ochrany. Hono overí podpísaný Cloud JWT,
explicitnú väzbu identity a aktuálny DB plán. Moderné UI používa overené interné
userId; Cloud subject ani email ho nenahrádzajú. Receipt a oneskorené odpovede
sú viazané na účet/token/režim; Stripe presmerovanie musí mať presný HTTPS host.

Nový `npm run --silent billing:preflight -- --help` ponúka:

- bez prepínačov iba konfiguráciu; dotenv sa automaticky nenačítava;
- `--env-file <súkromný súbor>` pre explicitný zdroj nastavení;
- `--check-db`: schéma/pin v jednej pripnutej READ ONLY transakcii, bez migrácie či inicializácie pinu;
- `--check-stripe`: iba GET vlastného Stripe účtu a oboch cien; žiadne vytváranie objektov alebo platieb.

Existujúca API doména je chránená HTTP Basic Auth. Stripe musí mať prístup iba
k presnému podpísanému POST `/api/billing/webhook`; výnimku ukazuje
`deploy/ops/billing-webhook-nginx.conf.template`. Iné API cesty zostávajú chránené.
Pred registráciou endpointu treba overiť: nepodpísaný POST odmietnutý, platný
podpis prijatý, GET odmietnutý a ostatné chránené API bez prihlásenia stále 401.
Výnimka sa neinštaluje pred nasadením podpisového handlera a sama platby nezapína.

Preflight nepotvrdzuje správnosť webhook secretu, nastavenie portálu, právne/
daňové toky ani skutočnú platbu. Live účet musí byť pripravený na prijímanie
platieb. Samostatne treba nastaviť produkty/ceny, portál a doručovanie webhookov,
prejsť reálny sandbox nákup/cancel a až potom schváliť aktiváciu live platieb.
MCP prístup k Stripe sandboxu ostáva iba na čítanie; táto práca ho nerozširuje.

## Overenie a nasadenie

Aktuálna implementácia 013 má nové úplné lokálne gates PASS: **1 115 passed /
189 skipped main**, PostgreSQL 16.15 aj 18.6 **167/167** s cleanup, Docker
**21/21**, moderné UI **188/188**, hlavné/strict typy, lint a oba lokálne buildy.
Dôkaz: [PR22-RECOVERY-VERIFICATION.json](../deploy/lovable-github/proof/PR22-RECOVERY-VERIFICATION.json).
Ide o lokálne overenie runtime 186eba1; nový backend ani schema na VPS tým nie sú aktivované.
Produkčná DB má podľa doterajšieho auditu iba schému 001; tento release potrebuje
kontrolovaný prechod cez **001–013**, čerstvú restore-verified zálohu a nové
prevádzkové overenie. Billing pin migrácie 012 sa nemení a billing zostáva OFF.
Aktuálnu pripravenosť infraštruktúry opisuje
[WS19-INFRASTRUCTURE.json](../deploy/lovable-github/proof/WS19-INFRASTRUCTURE.json).

Nasledujúce brány sú **historické, pred storage protokolom 013**:
**1 076 passed / 181 skipped main**, **159/159 PostgreSQL
16.15 aj 18.6**, **175/175 moderné UI**, **21/21 Docker** a **22/22 React E2E**.
Prešli hlavné/strict typy, oba produkčné buildy, lint (0 chýb / 33 existujúcich
upozornení) a syntaktická kontrola nginx vzorov bez TLS certifikátov. Hlavný beh
predchádzal zúženiu typu testovacieho mocku; následne preflight 20/20 a všetky
typové kontroly prešli. Verifier má doplnené explicitné Node importy; jeho
assertions zodpovedajú vykonanému browser behu. Časové rozpočty hlavného test
runnera boli 15 s/test a 60 s/setup pri jednom workeri; aplikačné timeouty sa nemenili.
Dôkazy: [PUBLISH-BILLING-VERIFICATION.json](../deploy/lovable-github/proof/PUBLISH-BILLING-VERIFICATION.json).

Testovací
workflow používa podpísané syntetické Cloud identity, skutočný BFF/Hono, dočasnú
SQL DB, skutočný compiler a súborový/public HTTP priechod. Stripe je syntetická
hranica; nepredstavuje skutočný nákup. Natívne PG scenáre sa spúšťali osobitne.
Docker happy-path navyše prešiel PublishService → skutočný IsolatedExecutor/
private runner → Docker worker → trvalý artefakt → verejné HTTP 200; kontajnery sa upratali.

## Nadväzujúci hostovaný prenos a prevádzková pripravenosť

Nasledujúci záznam prenosu, runtime `7f2b923` a kapacity je historický; jeho
merania a chýbajúce komponenty nevyjadrujú dnešný stav. Novší infra dôkaz je
[WS19-INFRASTRUCTURE.json](../deploy/lovable-github/proof/WS19-INFRASTRUCTURE.json);
nový backend, schéma 013 a verejné publikovanie aplikácie zostávajú neaktivované.

Frontend je synchronizovaný cez privátny
[`erikbabcan-commits/vorkeeei`](https://github.com/erikbabcan-commits/vorkeeei).
[PR #1](https://github.com/erikbabcan-commits/vorkeeei/pull/1) preniesol 41 produkčných
overlay súborov a automaticky vygenerovaný route tree. Merge `f7e3361` aj následný
prevádzkový refresh `96751c31` majú overený strom `7f9cd337`; novší README a pôvodný
`.env` tree entry sa zachovali. Obsah `.env` sa nečítal. Build client/SSR/Workers
aj strict TypeScript prešli v skutočnom clone; neexistujú automatické workflowy.

Viditeľný Lovable Code Editor vrátil presné celé obsahy TopBar a ForgePublish;
SHA a bajtové dĺžky sa zhodujú s overlay. Po oficiálnom reštarte live preview sa
zobrazilo nové UI a skutočný Publish dialóg, existujúci Google login prešiel.
Hono, modely a publish readiness sú nedostupné. Cloud Secrets majú názov
`HONO_BASE_URL`, ale chýba `HONO_BASIC_AUTH`; hodnoty Secrets sa nečítali.
Žiadny artefakt sa nepublikoval. Kanonický verejný frontend je
`https://vorkeeei.lovable.app/`; jeho staršia verzia zatiaľ nebola znovu publikovaná.

Lovable už pred prenosom ukazoval **0 dostupných kreditov**. Agent neodoslal AI
prompt ani AI Build a nič nenakúpil. Nemožno tvrdiť aktuálne zachovanie historickej
30-kreditovej rezervy ani nulovú globálnu spotrebu workspace. Priamy Git prenos
nenahrádza meranie účtu alebo overenie verejného nasadenia.

Tri obrazy pre `linux/amd64` a runtime commit `7f2b923` sú zostavené, lokálne
smoke overené a archivované. Archív má **129 686 811 B**, unikátne rozbalené vrstvy
**433 890 304 B**. Node smoke potvrdzuje spustenie cieľovej architektúry, nie
produkčnú API/runner readiness. Odhad načítania hotových obrazov vrátane 1 GiB
publish rezervy a 512 MiB bezpečnostnej rezervy je **2 307 265 192 B (2,15 GiB)**.

Read-only VPS audit o 19:07 UTC nameral **91 % disku a 3 755 892 736 B (3,50 GiB)
voľných**, takže tomuto odhadu vyhovuje. Staršie merania 99 %/665 MiB a 90 %/3,86 GiB
sú historické. Server má 1 CPU, približne 2 GB RAM a zdieľaný Docker so 14 aktívnymi
kontajnermi. Dedikovaný worker socket chýba; chýbajú aj `newuidmap`, `newgidmap`,
`slirp4netns` a `fuse-overlayfs`. Runner nesmie dostať socket zdieľaného daemona.
Obrazy sa majú načítať hotové; kapacitu treba znovu zmerať tesne pred nasadením.

Schéma produkčnej DB má iba základ 001; nové tabuľky/kolóny migrácií 002–012
chýbajú. Pred nasadením treba čerstvú restore-verified LOV zálohu a súkromný rollback
snapshot, izolovaný worker a kontrolovanú migráciu/konfiguráciu. Na VPS ešte
neprebehlo načítanie obrazov, mazanie, zmena Secrets, migrácia ani deploy.

Read-only Stripe inventúra potvrdila existujúce testové Pro ceny **29 €/mesiac**
a **290 €/rok** pre ten istý aktívny produkt a **0 aktívnych default portálov**.
Je pripravený návrh nastavenia; nevykonal sa. Nejde o schválený live cenník ani
skutočnú platbu. Aktuálne Stripe oprávnenie je iba na čítanie a billing ostáva OFF.

Dôkazy: [hostovaný prenos a hranice](../deploy/lovable-github/proof/PUBLISH-BILLING-ROLLOUT.json),
[amd64 kapacita](../deploy/lovable-github/proof/WS19-AMD64-CAPACITY.json),
[VPS readiness](../deploy/lovable-github/proof/WS19-DEPLOYMENT-READINESS.json),
[Stripe inventúra](../deploy/lovable-github/proof/WS19-STRIPE-SANDBOX-INVENTORY.json).

## Reprodukovateľný lokálny browser priechod

Všetky tri kroky sú iba lokálne. Fixture vytvorí dočasnú SQL databázu a adresár
artefaktov; použije podpísané syntetické identity a syntetický Stripe gateway.

```bash
# Terminál 1: koreň backend repozitára
LOV_SERVER=0 NODE_ENV=test RELEASE_WORKFLOW_FIXTURE=1 BILLING_ENABLED=0 MISTRAL_API_KEY= OPENAI_API_KEY= ANTHROPIC_API_KEY= node --import tsx tests/fixtures/releaseWorkflowServer.ts

# Terminál 2: plný lokálny Lovable mirror s nainštalovanými závislosťami
node node_modules/vite/bin/vite.js --config qa/hybrid/vite.config.ts --host localhost

# Terminál 3: koreň backend repozitára
RELEASE_WORKFLOW_FIXTURE=1 node scripts/verify-publish-billing.mjs
```

Verifier otvára iba loopback fixture a zachytí navigáciu na Stripe syntetickou
stránkou. Nevytvára skutočnú platbu. Výstupy sú v `/tmp/lov-release-proof`.
Po skončení ukonči oba vlastné servery; fixture po SIGTERM odstráni dočasné dáta.
