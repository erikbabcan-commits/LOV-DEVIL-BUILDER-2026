# WS-19 — skutočný statický Publish a Cloud billing

Rozsah: editor na Lovable, Hono/PostgreSQL na VPS. Implementácia odstraňuje
ukážkové publikovanie v hlavnom aj modernom UI a pripája moderný frontend k
existujúcemu billing backendu. Samotná implementácia nezapína platby, nemigruje
produkciu a nenahrádza overenie hostovaného nasadenia.

## Odvolanie verejného odkazu

Migrácia `018_publish_withdrawal.sql` umožní vlastníkovi odvolať konkrétnu
publikáciu. Po potvrdení server vráti HTTP 404 pri nových GET a HEAD
požiadavkách na pôvodnú adresu. Zostavený artefakt aj história publikovania
zostávajú uložené. Nové publikovanie má nový odkaz.

Verejný listener používa pre nové odpovede `Cache-Control: no-store`.
Klientom, ktoré už dostali starú odpoveď s ročnou cache, môže uložená kópia
zostať prístupná až do jej vypršania. Fyzická retencia súborov ostáva samostatný krok.

### Nácvik migrácie 015 → 018 a návratu

Izolovaný PostgreSQL 16 začal na rovnakom odtlačku schémy 015 ako produkcia.
Pri držanom zámku na `publish_jobs` sa dávka 016–018 po limite 1 s celá vrátila.
Po uvoľnení zámku prešli všetky tri migrácie v jednej transakcii. Výsledný
odtlačok `8580b42fa86cd595a88aefd48b63a53e1a149493e3d357d4d5d3a6aac16ed7a8`
sa zhodoval s čistou referenčnou databázou. Lokálny runtime spustený s týmto
pinom overil export, podanie a odvolanie žiadosti o zrušenie účtu a odvolanie
verejného odkazu. Druhý syntetický odkaz zostal dostupný.

Pre návrat po migrácii priprav kompatibilný obraz z produkčnej verzie
`daf3321` s migráciami 016–018 a aktuálnym `server/publish/public.ts`.
Pôvodný produkčný obraz na novom pine odmietne štart. Kompatibilný runtime
musí aj po návrate vracať `404` pre odvolané GET a HEAD a `200` pre druhý
odkaz, vždy s `Cache-Control: no-store`. Schému 018 ponechaj. Ak kompatibilný
runtime nie je dostupný, odstav verejný listener až do overeného obnovenia.

Po lokálnom nácviku vznikli na VPS dve overené `linux/amd64` vrstvy.
Kandidát `lov-devil-api-ws19:withdraw018-reviewed-amd64` má digest
`sha256:cc9aa317d28d1889f2aa811dba56c8bf2cbd4711f8ea597ca396cfbe55639a0a`.
Návratový obraz `lov-devil-api-ws19:daf3321-schema018-safe` má digest
`sha256:8da62fe15bd3ad240f6ea38c57e2c34b18697b46d488f3e11903578b0cb7d75b`.
Izolovaná sieť bez zverejnených portov a dočasná databáza overili štart
oboch obrazov aj výsledky GET a HEAD. Testovacie kontajnery a sieť sa
odstránili. Aktívny produkčný kontajner na schéme 015 zostal zdravý.

Pred výmenou produkcie over obnovu aktuálnej zálohy mimo VPS, cieľový
odtlačok, diskovú rezervu, izolovaný runner a systemd návrat pod existujúcim
zámkom.

## Neaktívny VPS kandidát `0b416e1` · 8. 11. 2026

Obraz `lov-devil-api-ws19:0b416e1-schema018-candidate` na VPS má digest
`sha256:7e3354accd81e87eb6132fe04da0e1959bc470b903f74c3a4c763ce54588eb2b`.
Tri zmenené súbory a aktuálny `server/.env.example` doplnili existujúci amd64
obraz. Kontrolné súčty všetkých 119 súborov v `server/` a `shared/` sedia
s Gitom. Voľný disk bol približne 2,066 GB pred aj po teste.

V dočasnej internej sieti bez zverejnených portov prešli migrácie do PostgreSQL 16
na tmpfs a štart s produkčným pinom schémy 018. Dve platné React revízie sa
skompilovali lokálnym testovacím executorom. Pri simulovanom neskoršom dokončení
prvej revízie aj po zlyhaní tretej ostal hlavným odkazom výsledok druhej.
Anonymná požiadavka vrátila 401 a iný účet dostal prázdny výsledok. Druhá
revízia pred odvolaním vrátila 200, po odvolaní GET aj HEAD vrátili 404
s `no-store` a prvá revízia vrátila 200.

Dočasné kontajnery aj sieť sa odstránili. Identita, čas štartu a obrazy
produkčného API, PostgreSQL a runnera sa zhodovali pred a po teste. Produkčné
health prešlo a adresár záloh na VPS zostal prázdny. Kandidát ostáva neaktívny.
Živý Cloud/BFF a produkčný izolovaný executor sa týmto testom neoverovali.

## Produkčný obraz `aba5cf4` a schéma 018 · 7. 11. 2026

Pred výmenou sa záloha `20261107T213941Z` preniesla priamo na Mac.
Obnova potvrdila 17 tabuliek a rovnaký odtlačok schémy 015 ako produkcia.
Adresár záloh na VPS zostal prázdny.

Pod zámkom `/run/lock/lov-devil-stage-switch.lock` prešli migrácie 016–018
v jednej transakcii. Od 21:43 UTC beží `lov-devil-api-013-aba5cf4a8ef3`
s digestom `sha256:cc9aa317d28d1889f2aa811dba56c8bf2cbd4711f8ea597ca396cfbe55639a0a`
a odtlačkom `8580b42fa86cd595a88aefd48b63a53e1a149493e3d357d4d5d3a6aac16ed7a8`.
Priame kontroly API, schémy a runnera prešli za 4,6 s od začiatku výmeny.
Nasledovala úspešná kontrola `lov-devil-staging.service`.

Health vrátil HTTP 200, anonymné čítanie účtu a spotreby HTTP 401.
Verejná neexistujúca trasa `/p/…/` vrátila pri GET aj HEAD HTTP 404
s `Cache-Control: no-store`. Operátorský front žiadostí vrátil 0 položiek
na spracovanie. Živý billing je vypnutý. Prihlásený Lovable tok a odvolanie
reálnej verejnej publikácie zatiaľ čakajú na overenie.

Pri návrate pod tým istým zámkom zastav nový kontajner a spusti pripravený
`lov-devil-api-013-daf3321e0180` s digestom
`sha256:8da62fe15bd3ad240f6ea38c57e2c34b18697b46d488f3e11903578b0cb7d75b`.
V `/etc/lov-devil/staging.env` nastav `LOV_STAGING_API` a `LOV_STAGING_API_IMAGE`
na tento kontajner. Over zdravie API, runner a ochranu verejnej trasy, potom
uvoľni zámok a spusti `lov-devil-staging.service`. Ponechaj schému 018, aby
návrat zachoval odvolané odkazy.

## Produkčný obraz `daf3321` a schéma 015 · 7. 11. 2026

Kontrola o 20:19 UTC potvrdila aktívny kontajner `lov-devil-api-013-daf332191dfe`
s digestom `sha256:88a3805823b5af94cc75c3b6fdb7d45395bda8d324c22e21c5eb791aad1fa55c`
a odtlačkom schémy `d89a35628e26fd83f3f762ff841a52400f486e81f9e4f8f0d8c73bd9dcc64051`.
Systemd recovery prešiel. Loopback health vrátil HTTP 200, anonymné API
HTTP 401 a root hosta publikácií HTTP 404. Adresár záloh na VPS bol prázdny.

Izolovaný test na PostgreSQL 16 započítal jednu podpísanú syntetickú Pro faktúru.
Nulová faktúra, neznáme predplatné a opakované doručenie počet nezvýšili.
Test nevykonal žiadne sieťové volania na Stripe a overil štart návratového obrazu
na schéme 015. V produkcii je `BILLING_ENABLED=0`. Týždenný report uviedol
`positiveInvoiceEvidence: unavailable` a `billingEvidence: unconfigured`.

Pri návrate pod zámkom `/run/lock/lov-devil-stage-switch.lock` zastav nový
kontajner a spusti `lov-devil-api-013-2f52d61e0150` s digestom
`sha256:7747feb2bde7d42f954ca5a35fee51dac39fc8c40fe061026bf59f6b5f24a627`.
V `/etc/lov-devil/staging.env` nastav `LOV_STAGING_API` na názov kontajnera
a `LOV_STAGING_API_IMAGE` na jeho digest. Over health a ochranu portov
8788/8791, uvoľni zámok a over `lov-devil-staging.service`. Schému 015 ponechaj.

## Produkčný obraz `2f52d61` a schéma 014 · 7. 11. 2026

O 20:05 UTC prešla samostatná migrácia 014 s krátkym limitom na zámok a dotaz.
Nové API overuje schému bez replayu na odtlačku
`56bf339835ac2d5a3f96e54b02fa6ee245b586484e24e98026a0dccefe4c38e6`.
Beží kontajner `lov-devil-api-013-2f52d6129beb` s digestom
`sha256:7bea5bebe15cccc86a985b57785c73a0a7a0177a988873196c50a4ec2f74daa3`.
Health sa obnovil za 3,28 sekundy od začiatku výmeny. Porty, volumes, Nginx,
Basic ochrana a vypnutý billing boli zachované. Systemd recovery prešiel.

Pred zmenou prešiel na izolovanom PostgreSQL 16 na VPS prechod 013 → 014,
prihlásené uloženie syntetického projektu a štart návratového obrazu na 014.
Dočasná databáza aj sieť boli odstránené. Produkčný read-only týždenný report
zobrazil nový údaj so zdrojom `server-observed`. Prihlásený tok z Lovable sa
týmto neoveril.

Pri návrate pod zámkom `/run/lock/lov-devil-stage-switch.lock` zastav nový
kontajner a spusti pripravený `lov-devil-api-013-7f10413e0140` s digestom
`sha256:e626b9b8287d4761a590c80d5acaa47b87c3315991939b79fceb60a17bb78b90`.
V `/etc/lov-devil/staging.env` nastav naň `LOV_STAGING_API` aj
`LOV_STAGING_API_IMAGE`. Over health a ochranu portov 8788/8791, uvoľni zámok
a over `lov-devil-staging.service`. Schému 014 ponechaj, aby ostali zachované
zaznamenané časy. Pôvodný obraz s odtlačkom 013 by na nej pri novom štarte zlyhal.

## Produkčný obraz `7f10413` · 7. 11. 2026

Rozšírenie spotreby publikovaní beží na VPS od 19:40 UTC na API porte 8788
a artifact porte 8791. Obraz má digest
`sha256:7cc54062d2db37a4008323dd7a5c9afe72cf9ccd07ab5e07ca5a8e5dee7bb922`.
Obsah dvoch zmenených súborov súhlasí s Git commitom. Izolovaný VPS smoke
použil dočasnú PostgreSQL v RAM, úspešne overil účty, UTC hranice aj dostupnosť
AI metrík pri nedostupnej publish tabuľke a odstránil testovacie kontajnery.

Pri výmene kontajnera prešli health HTTP 200, anonymný auth a usage HTTP 401,
verejná Basic ochrana 401 a artifact root 404. Konfigurácia Nginx sa nemenila.
`lov-devil-staging.service` overila nový pin s výsledkom `success`. Schéma sa
overuje existujúcim odtlačkom bez replay migrácií. Billing zostáva vypnutý.

Pri návrate použi zámok `/run/lock/lov-devil-stage-switch.lock`, zastav
`lov-devil-api-013-7f10413e6a55`, spusti ponechaný
`lov-devil-api-013-2b556f916f92` a over health aj auth na 8788 a artifact
listener na 8791. V `/etc/lov-devil/staging.env` obnov jeho názov a digest
`sha256:43a40c1572988d62b68284e886c9b8da7ebfd3f7cc035cd3380be723c8b35186`.
Po uvoľnení zámku over `lov-devil-staging.service`. Táto výmena sama nepotvrdzuje
produkčný prihlásený tok z Lovable.

## Produkčný API upstream · 7. 11. 2026

Nginx smeruje existujúce Basic-chránené `/api/` na loopback 8788
(runtime `2b556f9`). Pôvodné API na 8787 zostáva zdravé a pripravené na návrat.
Prepnutie zmenilo jediný riadok `proxy_pass` v `/etc/nginx/sites-available/lov-devil`.
`nginx -t` prešlo a po graceful reloade bol pozorovaný nový worker pri rovnakom
master procese. Kontroly pred aj po zmene potvrdili health HTTP 200 na oboch
loopbackoch a HTTP 401 s `unauthenticated` na šiestich chránených trasách na
každom z nich.

Následná nezávislá kontrola o 18:57:11 UTC potvrdila aktívny Nginx, obidva zdravé
kontajnery a zapnutú systemd obnovu. Z Macu prešlo overenie TLS. Pilot API bez
Basic prihlásenia vrátilo HTTP 401 a root oddeleného artifact hosta vrátil
HTTP 404. Ten stále smeruje na loopback 8791. Prepnutie nezanechalo na VPS
žiadnu novú zálohu a zálohový adresár bol pri následnej kontrole prázdny.

Pri návrate najprv over `GET http://127.0.0.1:8787/api/health` priamo na VPS.
Pod zámkom `/run/lock/lov-devil-stage-switch.lock` vráť iba `proxy_pass`
v `location /api/` na 8787, over `nginx -t` a vykonaj `systemctl reload nginx`.
Znovu over pôvodné API, Basic 401 na verejnej API trase a TLS odpoveď na
oddelenom artifact hoste. Produkčné API na 8788 závisí od existujúceho časovača
`lov-devil-staging.timer`, napriek historickému názvu jednotky.

Prihlásený Cloud → BFF → Hono tok a skutočný verejný Publish cez Lovable
vyžadujú samostatné overenie. Billing je vypnutý. Hosted frontend a Stripe
nastavenia sa týmto prepnutím nemenili.

## Historický prevádzkový dodatok pred prepnutím API — STAGED

Kontrolované VPS kroky overili schému **001–013** vrátane read-only štrukturálnej
kontroly. Pred nimi bola restore-verified záloha `20261106T213102Z` (3 tabuľky,
5 552 B). Autentifikovaný runner vykonal skutočný compile a upratal svoj worker;
nové API prešlo health kontrolou na loopbacku 8788, samostatný artifact listener
používa 8791. Existujúci produkčný proxy ostáva na starom 8787 a Basic ochrana
zostáva nezmenená. API aj runner sú **STAGED**, s `restart=no`; tento krok
neustanovil produkčnú dostupnosť ani HA.

Pri app gate bola spotreba API **90 206 208 / 335 544 320 B**, runnera
**59 654 144 / 134 217 728 B**, oba so swap limitom 0. Ide o zaznamenané meranie,
nie trvalý prísľub spotreby. Backend merge `494cd434` má presne overený strom
`842b8f7` a nezmenených 301 source SHA. Frontend main `676b8bd` je zlúčený a jeho
Git push/merge bol overený v histórii Lovable editora; kanonický verejný frontend
nebol znovu publikovaný. Git cleanup vlastných zlúčených vetiev prešiel bez force.

Finálny read-only audit **21:37:58 UTC** potvrdil health oboch API a odmietnutie
anonymného `/api/auth/me` stavom 401; nové API má auth zapnutú. Pôvodná nginx
konfigurácia/proxy 8787 aj externá Basic 401 ochrana zostali zachované. Oddelený
public host má dôveryhodné TLS a root 404 bez cookies/Basic challenge — **nejde
o artefakt HTTP200**. Beží 16 globálnych kontajnerov (14 pôvodných + nové API/runner),
baseline zdieľanej Docker služby je zachovaný; po compile ostalo 0 rootless workerov.

Owner dry-run je **PASS s 0 zápismi** a nezmenenými kontajnerovými/proxy
invariantmi. Automatická kontrola schválenia však odmietla owner apply ešte
**pred vykonaním**: nový trvalý autentifikačný účet a nemenná identity väzba
vyžadujú konkrétne schválenie používateľa. Takáto auth DB zmena sa nevykonala.
Owner binding a Cloud Basic transport sú stále na konkrétnom schválení/manuálnom
vstupe; žiadne hodnoty tajomstiev tu nie sú uvedené. Syntetický projekt, publish
job ani verejný HTTP200 smoke sa nespustili. Celý Cloud → BFF → Hono workflow,
Stripe aktivácia/skutočná platba a kanonický verejný republish zostávajú
neoverené alebo vypnuté. M1–M6 tým nie sú uzavreté.

[Sanitizovaný STAGED ops dôkaz](../deploy/lovable-github/proof/WS19-STAGED-OPERATIONS-2026-11-06.json)
obsahuje iba stavové flagy, merania a verejné source/Git referencie. Staršie
lokálne a infra receipts zostávajú historické a nemenia sa; operátorské skripty
sa nepridávajú do repozitára. Recovery runbook nižšie sa na VPS nevykonal.

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

Publikovanie, readiness a diagnostika zdieľajú procesný filesystem gate: najviac **2 aktívne
operácie**, **8 čakajúcich**, deadline najviac **5 s** vrátane čakania. Slot sa
uvoľní až po skutočnom skončení práce. Zrušená čakajúca operácia sa neskôr
nesmie spustiť; samotný timeout bežiaceho I/O nepotvrdzuje jeho zastavenie.
Neistý `writing` preto ponecháva plnú rezerváciu. Potvrdené neskoré fyzické
uloženie smie skončiť iba ako `failed/retained` so skutočným počtom bajtov,
bez verejnej URL. `legacy_unknown` z existujúcich záznamov vyžaduje operátorské
obnovenie; kapacita sa z neho automaticky neuvoľňuje.

Anonymné čítania artefaktov používajú samostatný procesný bounded gate
(2 aktívne / 8 čakajúcich / 5 s); nespotrebúvajú sloty publikovania.
Trvalý limit pokusov je prednastavene **20**, vlastná konfigurácia najviac
**100**. Počítajú sa všetky joby vrátane neúspešných a prázdnych. Pilotná politika
uchováva všetky UUID záznamy bez mazania. Bezpečnú ručnú obnovu a limity popisuje
[operátorský runbook](#publish-storage-recovery); diagnostické meranie súborov
nepatrí do owner transakcie a nesmie uvoľniť živého writera.

Kontrakt vychádza z [PublishService](../server/publish/service.ts),
[ArtifactStore](../server/publish/artifacts.ts),
[FilesystemGate](../server/publish/storageGate.ts),
[limitov konfigurácie](../server/publish/config.ts) a
[migrácie 013](../server/migrations/013_publish_storage_phase.sql).

<a id="publish-storage-recovery"></a>

### Operátorská obnova `writing` a `legacy_unknown`

Tento postup je podmienka aktivácie hostingu. Je to ručná odstávková obnova,
nie periodický cleanup. `building/writing` môže zostať po páde procesu alebo po
zlyhaní oboch DB aktualizácií `publish()` a `fail()`; status ho automaticky
neuvoľní. Samotný vek, neúspešný HTTP výsledok ani vypršanie lease nepreukazujú,
že zápis skončil. Ak ktorýkoľvek dôkaz chýba, ponechaj pôvodnú rezerváciu.
Postup sa teraz na VPS nevykonal.

1. Založ súkromný prípad (`umask 077`, nový adresár `0700` mimo artefaktov).
   Zachovaj čerstvú restore-verified DB zálohu a zálohu artefaktového volume.
   Do súkromného auditu ulož presný owner/request/artifact/claim, stav, fázu,
   bajty/hash, `updated_at`, konfiguráciu a identitu všetkých zapisovačov.
   Nepublikuj zdroje projektu, identity ani prihlasovacie údaje do logov PR.
2. Uzavri príjem nových publish požiadaviek a zastav **všetky** LOV procesy,
   repliky a maintenance úlohy, ktoré môžu zapisovať do tejto DB/volume.
   Zablokuj ich automatické znovuspustenie. Roster musí zahŕňať aj prípadné host
   procesy; ak ho nemožno úplne doložiť, nepokračuj. Nezastavuj zdieľaný Docker,
   PostgreSQL ani cudzie aplikácie. Pre vlastné rollout kontajnery použi iba
   explicitne overené mená/owner labely zo súkromného prípadu:

   ```bash
   # Každé meno najprv porovnaj s odsúhlaseným rosterom a immutable image ID.
   docker --host unix:///var/run/docker.sock inspect --format '{{.Name}} {{.Image}} {{index .Config.Labels "lov-devil.owner"}} {{index .Config.Labels "lov-devil.role"}}' "$LOV_PUBLISH_CONTAINER" >> "$CASE_DIR/writers-before.txt"
   docker --host unix:///var/run/docker.sock stop --time 30 "$LOV_PUBLISH_CONTAINER"
   test "$(docker --host unix:///var/run/docker.sock inspect --format '{{.State.Running}}:{{.State.Pid}}:{{.HostConfig.RestartPolicy.Name}}' "$LOV_PUBLISH_CONTAINER")" = 'false:0:no'
   ```

   Ulož výsledok pre každý zapisovač a dôkaz vypnutého orchestrátora/reštartov.
   Zaniknutý proces nesmie mať živé potomky ani prebiehajúce I/O. Čakanie 5/120 s
   ani prázdny worker zoznam tento dôkaz nenahrádza. Volume drž mimo zapisovačov
   až do skončenia DB kontroly. Pri neistom alebo zaseknutom I/O obnova končí
   bez zmeny účtovania.
3. Pri stálej odstávke exportuj cieľový riadok iba na čítanie. `psql` spúšťaj
   z existujúceho schváleného maintenance prostredia s privátnou libpq service
   konfiguráciou `lov-maintenance`; heslo/DSN nepatrí na argv ani do príkladu.
   Súkromný `case.vars.sql` (`0600`) obsahuje `owner_id` a `request_id` ako
   psql premenné; hodnoty sú konkrétne identifikátory odsúhlaseného prípadu.
   Ulož nasledujúce SQL ako `export.sql` vedľa neho:

   ```sql
   \set ON_ERROR_STOP on
   \ir case.vars.sql
   BEGIN READ ONLY;
   SELECT jsonb_build_object(
     'owner_id',owner_id,'request_id',request_id,'artifact_id',artifact_id,
     'claim_id',claim_id,'state',state,'storage_phase',storage_phase,
     'artifact_bytes',artifact_bytes,'artifact_sha256',artifact_sha256,
     'updated_at',updated_at)
   FROM publish_jobs WHERE owner_id=:'owner_id' AND request_id=:'request_id'::uuid;
   COMMIT;
   ```

   ```bash
   PGSERVICE=lov-maintenance psql -X -qAt --set ON_ERROR_STOP=1 --file "$CASE_DIR/export.sql" > "$CASE_DIR/row.json"
   ```

4. Mimo DB transakcie over všetky finálne aj dočasné súbory daného artifact UUID.
   Nasledujúci jednorazový read-only inventár ulož ako `inventory.py` do prípadu.
   `ARTIFACT_ROOT` musí byť presný skutočný trvalý volume z odsúhlaseného mountu,
   s overeným root parent reťazcom; nepouži symlink alebo adresár z projektu.
   `ARTIFACT_FILE_UID` je overené host UID zapisovača (pri súčasnom rootful API 0).
   Inventár odmietne neznámy formát, symlink, cudzí hardlink aj zmenu počas čítania;
   rovnaký inode cez temp/final počíta iba raz a pre každý vstup uloží SHA-256.

   ```python
   import hashlib, json, os, re, stat, uuid
   from pathlib import Path
   if not __debug__:
       raise SystemExit('inventory requires Python without optimization')
   job = json.loads(Path(os.environ['CASE_DIR'], 'row.json').read_text())
   assert job['state'] in ('building', 'failed'), 'published row requires separate review'
   artifact = str(uuid.UUID(job['artifact_id']))
   expected_uid = int(os.environ['ARTIFACT_FILE_UID'])
   root = os.open(os.environ['ARTIFACT_ROOT'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
   try:
       names = sorted(os.listdir(root)); before = os.fstat(root)
       rows, inodes = [], {}
       for name in names:
           if not (name.startswith(artifact + '.') or name.startswith('.' + artifact + '.')):
               continue
           if name != artifact + '.html':
               assert re.fullmatch(r'\.' + re.escape(artifact) + r'\.[0-9a-f-]{36}\.tmp', name), 'unknown artifact filename'
               assert str(uuid.UUID(name[38:-4])) == name[38:-4], 'invalid temporary UUID'
           fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
           try:
               first = os.fstat(fd)
               assert stat.S_ISREG(first.st_mode) and 0 <= first.st_size <= 2147483647
               assert first.st_uid == expected_uid and stat.S_IMODE(first.st_mode) == 0o600
               digest = hashlib.sha256()
               while True:
                   block = os.read(fd, 1048576)
                   if not block: break
                   digest.update(block)
               last = os.fstat(fd)
               fields = ('st_dev','st_ino','st_size','st_nlink','st_mtime_ns','st_ctime_ns')
               assert all(getattr(first, k) == getattr(last, k) for k in fields), 'file changed'
               key = (first.st_dev, first.st_ino)
               record = inodes.setdefault(key, {'bytes': first.st_size, 'links': first.st_nlink, 'names': []})
               assert record['bytes'] == first.st_size and record['links'] == first.st_nlink
               record['names'].append(name)
               rows.append({'name': name, 'device': first.st_dev, 'inode': first.st_ino,
                            'bytes': first.st_size, 'sha256': digest.hexdigest()})
           finally:
               os.close(fd)
       assert sorted(os.listdir(root)) == names and os.fstat(root).st_mtime_ns == before.st_mtime_ns
       assert all(x['links'] == len(x['names']) for x in inodes.values()), 'unaccounted hardlink'
       total = sum(x['bytes'] for x in inodes.values())
       assert 0 <= total <= 2147483647
       print(json.dumps({'complete': True, 'artifact_id': artifact,
                         'uniqueBytes': total, 'entries': rows}, sort_keys=True))
   finally:
       os.close(root)
   ```

   ```bash
   export CASE_DIR ARTIFACT_ROOT ARTIFACT_FILE_UID
   timeout 30s python3 "$CASE_DIR/inventory.py" > "$CASE_DIR/inventory.json"
   sha256sum "$CASE_DIR/row.json" "$CASE_DIR/inventory.json" > "$CASE_DIR/evidence.sha256"
   ```

   Vyžaduj exit 0, `complete:true`, úplný stop-proof a ľudskú kontrolu inventára.
   **Žiadne položky** dovoľujú `failed/empty`, 0 bajtov a NULL hash. Pozitívny
   počet jedinečných bajtov dovoľuje iba `failed/retained` s celou nameranou
   veľkosťou; neznižuj ju na pôvodný limit ani na veľkosť samotného final súboru.
   Existujúce nulové/neurčité súbory, nezodpovedajúci hash, neznámy inode alebo
   timeout znamenajú stop bez uvoľnenia rezervácie. Tento postup súbory nemaže.
   `legacy_unknown` pre nepublikovaný job používa tie isté dôkazy; jeho fáza sama
   nedokazuje prázdne úložisko. `published/legacy_unknown` sa týmto postupom
   nemení ani neodpublikuje: vyžaduje samostatné posúdenie final hashu/veľkosti,
   extra temp inodov a zachovania existujúcej URL pred aktiváciou vlastníka.
5. Až po kontrole inventára doplň privátne premenné: pôvodný `artifact_id`,
   `claim_id` (prázdny reťazec pre NULL), `observed_phase`, `observed_updated_at`,
   schválené `physical_bytes`, `writer_stopped=true`, `inventory_complete=true`
   a čerstvý `new_claim_id` UUID. Ulož toto SQL ako `recover.sql`. I/O, hashing
   ani export nevykonávaj v tejto krátkej transakcii. Claim a timestamp CAS musia
   presne zodpovedať exportu; 0 alebo viac než 1 zmena vynúti rollback.
   `SELECT 1/0` je úmyselná chyba pri odmietnutí; `ON_ERROR_STOP` zaručí nenulový
   exit kód. Obyčajné `\quit` ho v podporovaných psql verziách nezaručuje.

   ```sql
   \set ON_ERROR_STOP on
   \ir case.vars.sql
   \if :writer_stopped
   \else
   SELECT 1/0 AS recovery_refused;
   \endif
   \if :inventory_complete
   \else
   SELECT 1/0 AS recovery_refused;
   \endif
   BEGIN;
   SET LOCAL lock_timeout='1000ms';
   SET LOCAL statement_timeout='2000ms';
   WITH owner_lock AS (
     SELECT id FROM users WHERE id=:'owner_id' FOR UPDATE
   ), changed AS (
     UPDATE publish_jobs AS j SET
       state='failed',
       storage_phase=CASE WHEN :'physical_bytes'::integer=0 THEN 'empty' ELSE 'retained' END,
       artifact_bytes=:'physical_bytes'::integer, artifact_sha256=NULL,
       claim_id=:'new_claim_id'::uuid, error_code='publish_operator_recovered',
       errors='[]'::jsonb, updated_at=now()
     FROM owner_lock WHERE j.owner_id=owner_lock.id
       AND j.request_id=:'request_id'::uuid AND j.artifact_id=:'artifact_id'::uuid
       AND j.claim_id IS NOT DISTINCT FROM NULLIF(:'claim_id','')::uuid
       AND j.updated_at=:'observed_updated_at'::timestamptz
       AND j.storage_phase=:'observed_phase' AND j.state IN ('building','failed')
       AND :'physical_bytes'::integer>=0
       AND :'new_claim_id'::uuid IS DISTINCT FROM NULLIF(:'claim_id','')::uuid
     RETURNING j.request_id
   ) SELECT count(*)=1 AS exactly_one FROM changed \gset
   \if :exactly_one
   COMMIT;
   \else
   ROLLBACK;
   SELECT 1/0 AS recovery_refused;
   \endif
   ```

   ```bash
   PGSERVICE=lov-maintenance psql -X --set ON_ERROR_STOP=1 --file "$CASE_DIR/recover.sql" > "$CASE_DIR/sql-result.txt"
   ```

   V stálej odstávke zopakuj read-only export a filesystem inventár. Over
   `failed/empty/0` alebo `failed/retained/skutočné bajty`, nový claim a nezmenené
   súbory. Job nedostane verejnú URL; nikdy ho ručne neprepni na `published`.
   Pri rozpore zachovaj odstávku a nový audit. Až po úspešnej kontrole obnov iba
   vlastné schválené LOV služby a skontroluj readiness. Neposielaj automatický
   retry ani nový publish POST za používateľa.

### Pilotná politika pokusov a retencie

**Žiadny job sa v pilote nemaže**, vrátane `failed/empty`. Všetky request UUID
zostávajú trvalými záznamami a všetky pokusy sa naďalej počítajú; prechod na
`empty` uvoľní iba bajty. Bez tombstone protokolu by zmazanie dovolilo starému
klientovi po GET 404 zopakovať POST s rovnakým UUID.

`readPublishConfig` má aktuálne pevné `PublishConfig.maxArtifacts=20`.
**Premenná `PUBLICPUBLISH_MAX_ARTIFACTS` neexistuje**. Pri dosiahnutí limitu
publikovanie odmietni a odovzdaj prípad podpore; neobchádzaj ho mazaním riadkov.
Po audite zneužitia, počtu pokusov, skutočných bajtov a voľného disku možno
samostatne posúdiť zmenu konfigurácie/release `maxArtifacts` najviac na **100**,
čo povoľuje validator. Nejde o automatické zvýšenie ani aktuálny env prepínač.
Pri 100 zostáva nový Publish odmietnutý a rieši ho podpora. Automatická retencia,
bezpečný cleanup osirelých súborov a budúci UUID tombstone/pruning protokol sú
stále otvorené; tento runbook ich neoznačuje za implementované.

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
nové API/runner sú v režime STAGED podľa prevádzkového dodatku vyššie. Produkčný proxy stále používa pôvodné nginx/lov-net zapojenie;
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

Aktuálny read-isolation addendum pre runtime `d9b279b` má **1 117 passed /
189 skipped main**, **21/21 Docker**, typy, build a lint PASS (0 chýb / 33
existujúcich upozornení). Všetkých 301 source witnesses zostalo počas siedmich
brán nezmenených. Offline inventár runbooku prešiel **10/10** syntetických
filesystem prípadov; jeho SQL prešlo **20/20** CAS/flag prípadov na dočasných
natívnych PG16/18 so schémou 001–013 a odstránením oboch clustrov. Ide o lokálne
fixture dôkazy, žiadne produkčné SQL. Anonymné reads sú oddelené od publishing
kapacity. [Addendum a logy](../deploy/lovable-github/proof/PR22-READ-ISOLATION-VERIFICATION.json).
Frontend PR#3 je zlúčený ako `676b8bdf5d7d9dd0d385479c46c55367ee9ca86a`;
Git push aj merge sú overené v histórii Lovable editora o 21:15:16 UTC. Ide
o viditeľnú synchronizáciu histórie, nie nové kopírovanie/hash overenie súboru.
Kanonický verejný frontend zatiaľ nebol znovu publikovaný.
Dodatočné čerstvé natívne PG16.15 aj18.6 prešli **167/167** na tom istom
runtime/witnesses; oba clustre boli zastavené a odstránené. Moderné UI sa
nemenilo; jeho pôvodných 188 zostáva historickým dôkazom, nie novým behom.

Predchádzajúca implementácia 013 mala úplné lokálne gates PASS: **1 115 passed /
189 skipped main**, PostgreSQL 16.15 aj 18.6 **167/167** s cleanup, Docker
**21/21**, moderné UI **188/188**, hlavné/strict typy, lint a oba lokálne buildy.
Dôkaz: [PR22-RECOVERY-VERIFICATION.json](../deploy/lovable-github/proof/PR22-RECOVERY-VERIFICATION.json).
Ide o historický lokálny cut runtime 186eba1 pred VPS krokmi. Vtedajšia DB mala
iba schému 001; kontrolovaný prechod **001–013** je teraz overený v samostatnom
STAGED ops dodatku vyššie. Lokálne gates samy nepotvrdzujú plný Cloud workflow.
Billing pin migrácie 012 sa nemení a billing zostáva OFF.
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

## Štart nad pripravenou databázou

Predvolený štart s `AUTH_ENABLED=1` prehráva migrácie. Migrácia 006 počas
replay vyžaduje zámok na `github_exports`, aj keď výsledná schéma ostáva
rovnaká. Pre výmenu API nad už migrovanou databázou sa dá nastaviť
`DATABASE_SCHEMA_SHA256`.

1. V izolovanej referenčnej databáze rovnakej hlavnej verzie PostgreSQL
   aplikuj migrácie presného release. Použi rovnaký cieľový namespace.
2. Z referenčnej databázy aj cieľa získaj odtlačok príkazom
   `npm run db:migrate -- --schema-fingerprint` s príslušným súkromným
   `DATABASE_URL`. Príkaz používa transakciu iba na čítanie.
3. Nastav `DATABASE_SCHEMA_SHA256` iba ak sú oba odtlačky zhodné. Pri
   nesúlade štart skončí pred otvorením listenerov a migrácie sa nespustia.
   Pri plánovanej migrácii aplikuj SQL samostatne, potom over nový odtlačok.

Odtlačok zahŕňa súbory migrácií, hlavnú verziu PostgreSQL, namespace a
metadáta tabuliek, stĺpcov, obmedzení a indexov. Neporovnáva obsah tabuliek
ani prevádzkové oprávnenia. Existujúce readiness kontroly zapnutých
funkcií ostávajú súčasťou štartu.

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
