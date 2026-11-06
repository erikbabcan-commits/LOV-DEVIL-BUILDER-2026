# WS-8 — odhady AI nákladov a interný report

Lokálny prírastok k FORGE-106/1202. Nadväzuje na ledger WS-7. Nie je nasadený,
nevykonáva billing a nedokazuje cieľ marže >70 %. Celý M1–M6 backlog zostáva v platnosti.

## Cenník a uloženie odhadu

`AI_PRICE_POLICY_JSON` je voliteľný serverový JSON cenník. Predvolene neexistuje:
spotreba sa meria, ale chýbajúca cena zostáva neznáma. Repo neobsahuje aktuálne
ceny providerov. `deploy/ops/ai-price-policy.example.json` používa výslovne
fiktívne ceny aj provider/model; nesmie sa prevziať ako živý cenník. Operátor
musí overiť zmluvné/súčasné ceny, modely, účinnosť aj podporovaný spôsob účtovania.

Schéma: `schemaVersion:1`, verziovaný identifikátor, `currency:USD`,
`basis:uncached-text-tokens`, 1–128 sadzieb. Každá má `provider`, presný nahlásený
`model`, interval `[validFrom, validUntil)` v UTC a desatinné stringy
`inputUsdPerMillion`/`outputUsdPerMillion` (0–10 000 USD, najviac 6 desatinných
miest). Číselné JSON hodnoty, prekrývajúce sa intervaly pre rovnaký provider/model,
ďalšie polia, neplatné dátumy, identifikátory s tajomstvami a dokument nad 64 KiB
sa odmietnu. Neplatná konfigurácia zlyhá pred provider/DB startup side effects.

Normalizácia peňazí, dátumov a poradia sadzieb vytvorí stabilný SHA-256 odtlačok;
aplikácia drží nemennú kópiu. Migrácia 009 pridáva `ai_price_policies` a
`ai_call_costs`, plus časový index pre globálne mesačné reporty. Pri rezervácii
volania sa v tej istej transakcii zapíše odtlačok cenníka, ktorý vtedy platí.
Cenník je v aplikácii append-only a opakovane sa kontroluje hash jeho obsahu.
Nie je kryptografickou ochranou pred administrátorom s plným právom meniť DB.

Dokončenie načíta zachytený cenník, provider a čas rezervácie z DB, aj keď sa
medzitým zmenila konfigurácia alebo mesiac. Sadzba sa vyberie podľa presného
modelu **nahláseného providerom** a času začiatku. Požadovaný model nie je fallback
za chýbajúci skutočný model. Explicitne nahlásený alias sa dá oceniť len vlastnou
presnou účinnou sadzbou; aplikácia neodhaduje jeho verziu.

Výpočet používa BigInt a celé mikro-USD:
`ceil((inputTokens * inputRateMicroUsdPerMillion + outputTokens * outputRateMicroUsdPerMillion) / 1_000_000)`.
Zaokrúhli sa nahor raz za celé volanie. Cena, index sadzby a nahlásené tokeny sa
commitnú spolu. Platná nahlásená nulová spotreba so známou sadzbou má známu cenu
0; chýbajúca cena/spotreba/model alebo neúčinná sadzba sú `unpriced` s dôvodom.
Známy `not_sent` sa do provider nákladov nepočíta. Neuzavretý záznam zostáva
unknown. Zmena cenníka nepreceňuje staré volania ani nedopĺňa predtým chýbajúci
cenník. Poškodený snapshot alebo chyba transakcie nevyrobí falošnú cenu.

009 je potrebná aj bez zapnutého cenníka, pretože každé nové volanie zaznamenáva
aj stav ocenenia. Kontrola jej tabuliek/stĺpcov je v prijímacej transakcii:
chýbajúca migrácia vráti mesačný inkrement späť a HTTP 503 príde pred SSE/inference.
Zlyhanie neskoršieho zápisu rezervácie neodošle provider request; zlyhanie po
odpovedi zastaví ďalšie volania v úlohe podľa pravidiel WS-7. Pri spätnom návrate
na starší binárny kód sa tabuľky s údajmi nemažú. Volania zo staršieho kódu bez
cost snapshotu sa vo finančnom reporte označia ako legacy/unknown, nikdy spätne
neocenia dnešným cenníkom.

## Operátorský report a dashboard

Nový príkaz:

```sh
pnpm run ai:usage-report -- --month 2026-11 --env-file /absolute/private/report.env
pnpm run ai:usage-report -- --month 2026-11 --user-id INTERNAL_ID --plan pro --env-file /absolute/private/report.env --html-output /absolute/private/new-report.html
```

Pri spustení bez package-manager wrappera možno použiť lokálne nainštalovaný
`node node_modules/tsx/dist/cli.mjs scripts/ai-usage-report.ts` s rovnakými flagmi.
CLI neimportuje dotenv/config ani server/index. Načíta iba výslovne uvedený
súkromný súbor (bežný súbor do 64 KiB, bez group/world oprávnení), procesové
premenné majú prednosť. Potrebuje iba DATABASE_URL; nepoužíva AI, Stripe ani OAuth
credentials. JSON na stdout obsahuje interné účty a náklady, preto ho operátor
ukladá/uchováva ako súkromné prevádzkové dáta.

Spojenie má 5s connection/statement limity a celý report beží na jednom pinned
spojení v `REPEATABLE READ READ ONLY` transakcii, ukončenej ROLLBACK. Test prešiel
s login rolou, ktorej boli udelené iba USAGE na testovú schému a SELECT na tabuľky.
Príkaz nemení schému, väzby, plány ani ceny; nevolá providerov, nerepricinguje a
nevykonáva billing operácie. Nečíta produkčný env automaticky. Chyby nevypisujú
URL, credentials, súkromné cesty ani DB výnimky.

Report zoskupuje zaznamenané volania podľa interného user ID a **plánu pri prijatí
úlohy**, nie dnešného plánu účtu. Rozsah je UTC mesiac podľa začiatku volania;
volanie cez polnoc patrí do mesiaca jeho začiatku. Voliteľné filtre user/plan sú
SQL parametre. Report má najviac 500 skupín a 128 snapshotov cenníka; pri väčšom
rozsahu odmietne vydať neúplné súčty. Operátor má použiť užší filter; extrémne
množstvo verzií pre jediný účet vyžaduje samostatný DB audit/report.

- `estimatedKnownCostUsd`: iba známa časť, presný desatinný string.
- `estimatedRecordedCostUsd`: NULL, ak niektoré zaznamenané volanie nemá cenu.
- `unknownCostCalls`, `pendingCalls`, `legacyCallsWithoutCostSnapshot`: pokrytie
  a medzery, nie nárok na nulové náklady alebo dôkaz živého procesu.
- `coverage:recorded_calls_only`: ani úplné pokrytie neobsahuje historickú
  spotrebu pred aktiváciou ledgeru. Súčet nie je celkový firemný účet providera.
- Veľké peňažné/tokenové agregáty zostávajú presné celočíselné/desatinné stringy.

`--html-output` vytvorí nový samostatný súbor s právami 0600 a odmietne prepísať
existujúci. Súbor sa generuje až po uzavretí DB transakcie; JSON sa vypíše až po
úspešnom uložení. Dockerfile obsahuje CLI aj presnú šablónu; výsledný Docker image
sa v tomto prírastku nestaval ani nenasadzoval.

HTML dashboard funguje offline, má CSP so zakázanou sieťou, nepoužíva CDN,
localStorage ani externé fonty. Filtruje účet/plán, triedi podľa známeho nákladu,
chýbajúcich cien alebo účtu a prepočítava súhrny pomocou BigInt. Úplne neznáma
cena/spotreba sa zobrazuje ako „Neznáme“, nie $0. Tabuľka sa na mobile roluje vo
vlastnom označenom regióne; stránka nepretečie horizontálne. Žiadne ceny ani cost
polia sa nepridávajú do zákazníckeho `/api/ai-usage` alebo Lovable bridge.

UI filtre sú len lokálny pohľad; celý rozsah pôvodného reportu zostáva v súbore.
Nie je to webový admin s RBAC ani zákaznícky dokument. Skutočné reporty s nákladmi
sa nepridávajú do repo/verejného hostingu. JSON je pri vložení escapovaný a UI
vypisuje dáta cez textContent; aj interné ID obsahujúce `</script>` ostáva textom.
V `proof/ai-cost-dashboard-fixture.html` sú výlučne označené syntetické údaje a
fiktívne ceny pre ukážku/QA, nie používateľove finančné dáta.

## Overenie a otvorený rozsah

Hlavná sada: **721 passed / 90 skipped** (nových 34 unit scenárov a 13 opt-in PG
cost scenárov). Platený live smoke bol vylúčený, MISTRAL_API_KEY prázdny.
Natívny PostgreSQL **16.15 aj 18.6: 68/68** vrátane replay/upgrade 008→009,
transakčných rollbackov, zachytenej sadzby pri rotácii/zmene mesiaca, neznámych
nákladov, constraints/cascade, rozdelenia plánov a účtov, schema driftu pred
spotrebovaním kvóty, skutočného podpísaného HTTP/SSE generovania s cenníkom a
CLI s SELECT-only rolou, súkromným HTML a odmietnutím prepisu. Oba dočasné
loopback/SCRAM clustre boli zastavené a odstránené.

TypeScript hlavného projektu aj striktný native/CLI graph a produkčný build prešli.
Hlavný ESLint: 0 chýb / 41 pôvodných upozornení; nový cost kód má cielený čistý lint.
Lovable UI sa v tejto fáze nemenilo; predchádzajúcich 67/67 testov a build receipts
zostávajú platné pri overených rovnakých 27 overlay hashoch. Pôvodných 10
kontrolovaných fingerprintov exportu ostáva bez zmeny.

IAB overenie skutočného offline HTML so syntetickým reportom: celok $0.014400,
4/5 cien; Free filter $0.007200 a 2/2; Alice/Pro filter zobrazuje Neznáme, 0/1;
prázdny výsledok, triedenie podľa chýbajúcich cien, desktop a reálny CSS viewport
390×844 bez horizontálneho pretečenia stránky. Browser konzola bez error/warn.
Screenshoty, ukážka, SHA-256 logov a presný scope sú v `proof/AI-COSTS-VERIFICATION.json`.

Otvorené zostávajú overené živé ceny/konfigurácia, billing a skutočné faktúry,
cache/multimodal/ďalšie poplatky a príjmy, kurz/dane, enforcement finančného a
tokenového budgetu, webový admin/RBAC, marža >70 %, automatické dohliadanie na
neuzavreté záznamy a retencia. Retry/failover, publishing/fullstack a ostatné
M1–M6 požiadavky sa nemenia na hotové. Produkcia, paid API, Lovable kredity,
účty a repozitáre sa nemenili; nevznikli commity.
