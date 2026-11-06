# WS-7 — spotreba jednotlivých AI volaní

Lokálny prírastok k FORGE-106/804. Migrácia `008_ai_usage.sql` a aplikácia sa
nenasadili. FORGE-106, 804 ani 1202 týmto nie sú celé dokončené.

## Čo je implementované

Pri zapnutom auth je predvolený `PostgresAiUsageStore`. Prijatie AI úlohy zapisuje
`ai_runs` v tej istej pinned READ COMMITTED transakcii ako mesačný inkrement.
Zlyhanie alebo duplicitné ID vráti inkrement späť; zamietnutá kvóta nevytvorí run.
Iný DB objekt alebo adapter bez transakcií sa odmietne pred inference. Pilot bez
auth zostáva bez trvalého účtovania. Volatile adapter je explicitná test/pilot DI,
nie automatický fallback pri výpadku DB; má pevný limit 1 000 úloh.

Každé fyzické volanie `complete`/`stream` najprv rezervuje `ai_calls` a commitne.
Žiadna DB transakcia nečaká na provider sieť. Run lock serializuje call čísla,
terminálny stav a dokončenie; jeden run má najviac 128 volaní. Záznam obsahuje
interného vlastníka, náhodné UUID, druh úlohy, plán/mesiac pri prijatí, provider,
požadovaný/skutočný model, časy, stav a nahlásené tokeny. Neobsahuje prompty,
zdroje, názvy projektov, surové výnimky ani credentials.

Generovanie a každý plán/batch/pokračovanie sa merajú samostatne, ale mesačná
kvóta sa čerpá len raz. Autofix prijíma úlohu až pred prvou AI opravou: úspešný
počiatočný build ani chyba infra nečerpajú mesačnú kvótu a nevytvárajú AI run.
Obidva prípadné AI patch pokusy majú samostatné call záznamy.

Validné provider-reported nuly sú známa spotreba. Chýbajúca, záporná, necelá alebo
neprimeraná spotreba je NULL/unknown. Mistral to rozlišuje explicitným
`usageReported`; pri SSE sa zachytí aj posledný usage-only chunk a reader sa
uvoľní pri konci/chybe/zrušení. Tokeny sa neodhadujú z počtu znakov. Rozsah je
0–1 miliarda pre každý tokenový údaj jedného volania.

Zrušenie pred sieťou má `not_sent` a report ho nepočíta medzi provider pokusy.
Ak provider po zrušení ešte vráti platný výsledok, nahlásené tokeny zostanú
zaznamenané. Zlyhanie a zrušenie bez nahlásených tokenov sú unknown, nie nula.
Ak po odpovedi zlyhá ledger zápis, run je otrávený: ďalšia inference sa nepovolí,
UI dostane bezpečnú chybu a prepared/unknown záznam zostane. Pád procesu môže
ponechať `running/prepared`; automatické retry, refund ani odhad nuly neprebehne.
`pendingCalls` znamená neuzavretý záznam, nie dôkaz stále živého procesu.

## API a rozhranie

`GET /api/ai-usage` vyžaduje overenú identitu, používa iba jej interné user ID,
odmieta všetky query parametre, má owner rate limit a `Cache-Control: no-store`.
Report rozlišuje `calls`, `reportedCalls`, `unknownCalls`, `pendingCalls`,
`promptTokens`, `completionTokens` a UTC interval [periodStart, periodEnd).
Hranice sa posielajú do PG ako explicitné UTC okamihy; výsledok nezávisí od
serverového časového pásma. Volania sa zaraďujú podľa času ich rezervácie,
mesačná generačná kvóta podľa času prijatia úlohy. Pri úlohe cez polnoc môžu
patriť do odlišných mesiacov. Neúplné alebo príliš veľké agregáty vrátia 503,
nie nespoľahlivé číslo.

Hlavné „Moje projekty“ zobrazujú vstupné/výstupné tokeny, pokrytie a neznámu
spotrebu. Karta sa obnovuje každých 15 sekúnd počas otvorenia a umožňuje ručný
refresh. Chyba reportu neblokuje CRUD. Pri zmene účtu sa request zruší a karta
remountne spolu s account-keyed dialógom. Dialóg je vycentrovaný a rolovateľný.

Lokálna kópia Lovable má iba ďalší pevný GET v existujúcej serverovej proxy
`ai-usage`; žiadny owner override, mutácia ani ľubovoľná upstream URL.
Existujúci panel pripojenia zobrazuje validované tokeny a pokrytie, obnovuje ich
cez „Overiť znova“. Údaje sú viazané na aktuálny Cloud účet a oneskorená odpoveď
predchádzajúceho účtu sa ignoruje. Hosted projekt sa nemenil; 30-kreditová
rezerva platí. Prenášací overlay je v `deploy/lovable-github`.

## Overenie

- Hlavná sada: 687 passed / 77 skipped; platený live smoke explicitne vylúčený,
  MISTRAL_API_KEY prázdny. Skips obsahujú aj 7 nových opt-in PG scenárov.
- Lovable lokálna sada: 67/67.
- Natívny PostgreSQL 16.15 a 18.6: 55/55 na každej verzii, migrácie 001–008
  vrátane opakovania; loopback/SCRAM/private temp a potvrdený cleanup.
- Nové natívne scenáre: rollback prijatia/rezervácie, 10/32 admissions,
  128/140 call reservations, reopen/unknown, account isolation a cascade,
  UTC hranica mesiaca a terminálny stav. Existujúci signed Cloud JWT → proxy →
  Hono → PG scenár overuje aj report, celú tokenovú sumu a okamžitú revokáciu.
- TypeScript hlavného projektu, oboch natívnych test graphov a Lovable; oba
  produkčné buildy; hlavný ESLint 0 chýb / 41 starších upozornení, cielený nový
  kód a UI bez chýb. Presné logy a odtlačky sú v receipts pod `proof/`.
- IAB: skutočný lokálny HTTP/SSE s pg-mem a syntetickým providerom: 8 → 9 úloh,
  2 provider volania, 200 vstupných + 1 000 výstupných tokenov; zmeny odmietnuté,
  projekt nezmenený. Bob má samostatné nuly a prázdne projekty. Desktop a
  skutočný 390×844 viewport bez horizontálneho overflow.
- Lovable vizuálna fixture používa skutočný komponent, syntetické odpovede bez
  siete: 4/5 známych volaní a 16 600 tokenov, neúplný súčet; Bob 0/200 a 0
  tokenov. Nie je to dôkaz živého Cloud bridge ani plateného Mistral volania.

## Čo zostáva otvorené

Staršie úlohy pred aktiváciou ledgeru sa spätne nepoznajú. UI výslovne uvádza
„od zapnutia merania“; unknown coverage sa vzťahuje iba na zaznamenané volania.
Report nie je faktúra ani tokenový limit plánu. Ceny za konkrétny model,
verziovaný cenník, výpočet nákladov, admin cost dashboard/marža, mesačné tokenové
limity a billing synchronizácia ešte chýbajú. Nie je zavedený nový retry ani
failover; FORGE-101/106/1202 zostávajú otvorené.

Ledger má account FK/cascade, ale účtové GDPR API, export, automatická retencia,
operátorské riešenie neuzavretých volaní a dohľad sú samostatná chýbajúca práca.
Účtovanie samotné nepotvrdzuje GDPR compliance. Dáta sa automaticky nemažú.
Pred budúcim nasadením treba DB zálohu, migračnú/reverznú stratégiu, kontrolu
008 nad staging DB a živé overenie bridge. Staré binárky 008 nevyužijú; pri
rollbacku neodstraňovať tabuľky so spotrebou. Produkčný public-deployment guard
sa týmto nemení. Celý backlog M1–M6 a jeho Definition of Done zostávajú v platnosti.


Nadväzujúci WS-8 lokálne pridáva verziovaný cenník, historické cost snapshoty a
read-only CLI/offline dashboard. Vyššie uvedený stav chýbajúceho cenníka je stav
WS-7; aktuálne správanie a zostávajúce obmedzenia sú v `docs/WS-8-AI-COSTS.md`.
