# AI prijatie úloh, limity a zrušenie

Lokálny prírastok FORGE-102/106/803/804/1103 na existujúcej vetve. Bez commitov,
produkčného nasadenia, platených AI volaní a hostovaných Lovable zmien. Nejde
zatiaľ o tokenové účtovníctvo, reálny Stripe billing alebo dokončenie celého M1.

## Čo limit znamená

Existujúci prevádzkový plán `free` má 10 a `pro` 200 prijatých AI úloh za UTC
kalendárny mesiac. Plán sa číta zo serverovej DB, nie z request body alebo
upraveného klienta. Pridelenie plánu stále nie je prepojené na platbu.

Jedno generovanie tvorené plánom, batchmi a pokračovaniami = jedna prijatá
úloha. Autofix sa ráta raz, až tesne pred prvou AI opravou; počiatočný úspešný
build alebo infraštruktúrne zlyhanie nečerpajú mesačnú AI kvótu. Obe opravy toho
istého autofix behu zostávajú jednou úlohou. Zrušenie po prijatí alebo chyba
providera kvótu automaticky nevracajú: inference už mohla stáť peniaze.

Počet prijatých úloh nie je presný počet provider volaní, tokenov ani eur.
Pri strate potvrdenia DB commit môže byť prijatie uložené aj keď sa HTTP
nedokončilo; automatický refund alebo opakovanie sa nevykonáva. Durable
request-id ledger, finančné metering udalosti a manuálne zosúladenie sú otvorené.
Staršie nafúknuté počítadlá sa bez dôkazov neprepisujú; oprava bráni novému
navyšovaniu pri zamietnutí. Aj legitímny downgrade môže nechať usage nad limitom.

## Atomické uloženie

`PostgresQuotaStore.consume` vyžaduje pripnutú `DbLike.transaction` capability
z `dbFromPool`. Beží v READ COMMITTED aj pri inom predvolenom isolation level
spojenia. Existujúci users riadok sa uzamkne pred načítaním plánu; tým sa
serializujú prijatia, zmena plánu a zmazanie účtu. Seed chýbajúceho nulového
počítadla a podmienený UPDATE sú v tej istej transakcii. Zamietnuté požiadavky
nezvyšujú uložené generations. DB chyba vykoná rollback. V transakcii nie je
žiadne provider ani iné externé volanie.

Mesačné okno môže ísť iba dopredu. Oneskorená požiadavka z predošlého mesiaca
neprepíše nové počítadlo; zlyhá s generickým quota_unavailable. Adaptér bez
transakcií a neexistujúci používateľ odmietnu prijatie pred inference. Čítanie
usage zostáva možné bez transakcie. Nová migrácia nie je potrebná.

## HTTP a zrušenie

Pred mesačnou kvótou sa overí auth/CSRF, rate limit, provider, JSON, schéma,
secrets, zrušenie a lokálna kapacita. Agent body má limit 8 000 000 bajtov.
Neplatné a nepripravené požiadavky nezvyšujú mesačný čítač. Ak mesačná kvóta
alebo jej DB zlyhá po lokálnom prijatí, nevyužitý lokálny slot sa vráti vrátane
denného čítača. Vrátenie je idempotentné a nerozbije nasledujúci UTC deň.
Autofix lokálny budget pokrýva aj skutočne vykonaný počiatočný build.

`quota_exceeded` vracia 429 s vlastným snapshotom; `quota_unavailable` 503 bez
DB detailov. Pri odmietnutí prijatia sa provider nevolá. Request
abort aj zrušenie SSE readera prenesú signál na provider. Súbežný slot sa uvoľní
až keď provider/generátor naozaj skončí, nie už pri zavretí klienta. Neochotný
custom provider preto ďalej blokuje svoj slot. Fetch provider má existujúci
transportný deadline; jeho ignorovanie sa nemaskuje tvrdením, že práca skončila.

Klient rozlišuje kvótu, rate limit, prevádzkový budget, vypršaný login, chybu
spotreby, vypnuté AI a chýbajúci provider. Prerušený stream bez terminálnej
udalosti nie je úspech. Reader sa vždy ruší/uvoľní. Chybové a zrušené behy
uzatvoria správu v chate a neaplikujú návrh. Nezavádza sa slepý automatický retry.

## Rozhranie

Hlavný editor ukazuje zostávajúce AI úlohy a knižnica projektov mesačný meter.
Od 80 % zobrazuje upozornenie. Prijatá alebo kvótou odmietnutá AI požiadavka
vyvolá nové overené čítanie auth/me; client event neprenáša identitu ani
oprávnenie. Platí existujúca sekvencia auth odpovedí a oddelenie účtov. Ručné
obnovenie projektov obnoví aj kvótu. Lokálne úpravy a export zostávajú dostupné.

Lokálna Lovable kópia má meter v existujúcom paneli pripojenia backendov.
Zobrazuje iba validovanú kvótu skutočne prepojeného účtu. Chýbajúce/poškodené
údaje sa nevydávajú za nulovú spotrebu a ľubovoľná HTTP 200 odpoveď sa nevydáva
za platný účet. Dáta predošlého Cloud používateľa sa skryjú okamžite pri zmene
účtu. Hostované UI, jeho Cloud Secrets a živé prepojenie sa nemenili; rezerva
30 Lovable kreditov ostáva.

Mock provider pre lokálne fixture bol opravený: rozpoznáva explicitný plan JSON
kontrakt namiesto zastaranej frázy. Testy s ním zostávajú syntetické; nepreukazujú
živý provider, cenu ani latenciu pod 15 sekúnd.

## Otvorené kritériá

Tokeny a náklady per provider volanie, dashboard výnosov/marže, durable request
ledger a finančné limity, distribuovaná concurrency, retry/failover a 150-prompt
intent eval zostávajú otvorené. Stripe predplatné/trial/portál/webhooky nevznikajú
tým, že je na počítači nainštalovaný Stripe agent plugin. Verejný deployment
guard zostáva zapnutý a nezavádza sa nový public runtime.


## Doterajšie overenie

105 cielených main scenárov prešlo. Na PostgreSQL 16.15 aj 18.6 prešlo 48/48
integračných scenárov vrátane siedmich nových counter testov: opakované odmietnutie,
upgrade a nový store, posun mesiaca s oneskorenou požiadavkou, 64 súbežných
prijatí, chýbajúci vlastník/transaction adaptér, rollback a nezmenené legacy dáta.
Quota kontrakt používa connection default REPEATABLE READ; adaptér ho explicitne
prekoná READ COMMITTED. Oba dočasné SCRAM/loopback clustre sa zastavili a odstránili.
Prísny TypeScript explicitného native test graphu prešiel.

Lovable kópia má 63/63 unit testov, TypeScript, cielený lint a build klienta,
SSR aj Workers. Browser kontrola hlavného editora používala skutočný lokálny
Hono/auth/quota/klient s pg-mem a syntetickým providerom: počiatočných 8 úloh,
dve prijaté (9 a 10), potom 429 a zachovaný projekt, a Bob s vlastnými 0/10.
Lovable panel sa vykreslil s 8/10, 10/10 a Bob 0/200; žiadny odchádzajúci
provider alebo Cloud request tam neprebehol. Dokument mal pri viewport 390 px
šírku 390 px v oboch rozhraniach. Screenshoty sú v `deploy/lovable-github/proof/`.
Dočasné fixture servery boli po kontrole zastavené.


Konečné celé overenie: **667 passed/70 skipped** (platený live smoke explicitne
vylúčený, Mistral key prázdny). TypeScript a produkčný Vite build prešli; celoplošný
ESLint má 0 chýb/41 upozornení. V explicitnom native graph typechecku sú aj nové
Cloud → quota integračné assertions. Kompletných 48/48 testov na oboch PG verziách
po doplnení tohto priechodu znova prešlo: hostile user_metadata neobíde Free 10,
dalšia úloha vráti 429 bez inference a zrušenie identity linku ihneď vráti 401.

Prenosný Lovable overlay má 20 source/unit a 5 reprodukčných vizuálnych súborov.
Zdrojový lint UI je čistý; fixture má iba existujúceho typu Fast Refresh warning
pre entry component bez exportu. Pôvodný export mal nezmenených všetkých 10
zaznamenaných source fingerprintov. Verejné main/UI assety neobsahovali kontrolované
názvy serverových Secrets. Podrobné receipt súbory a hashe sú v
`deploy/lovable-github/proof/`. Všetko zostáva lokálne, bez commitov a nasadenia.


Nadväzujúci lokálny prírastok WS-7 už pridáva samostatný trvalý ledger provider
volaní a tokenový report. Predchádzajúce obmedzenia vyššie popisujú stav WS-6;
aktuálne správanie, overenie a zostávajúce finančné/prevádzkové limity sú v
`docs/WS-7-AI-USAGE.md`. Nejde o spätný odhad staršej spotreby ani o dokončený billing.
