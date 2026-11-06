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

`loadPublishConfig` má aktuálne pevné `PublishConfig.maxArtifacts=20`.
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

Aktuálny read-isolation addendum pre runtime `d9b279b` má **1 117 passed /
189 skipped main**, **21/21 Docker**, typy, build a lint PASS (0 chýb / 33
existujúcich upozornení). Všetkých 301 source witnesses zostalo počas siedmich
brán nezmenených. Offline inventár runbooku prešiel **8/8** syntetických
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
