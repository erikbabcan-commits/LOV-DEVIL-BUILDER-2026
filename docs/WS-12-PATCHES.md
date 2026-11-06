# WS-12 — cielené úpravy a kontrola pred schválením

6. 11. 2026. Lokálny prírastok FORGE-104/502/503/1103. Zmeny nie sú
commitnuté ani nasadené. Žiadne platené inference alebo Lovable kredity.

## Čo sa mení

Pri iterate/fix plánovač navrhne iba dotknuté súbory. Namiesto kompletného
generovania ich obsahu dostane `Forge Patch Editor (forge-patch-v1)` celý aktuálny
kód s SHA-256 každého súboru a vráti striktne validovaný JSON návrh. Create si
ponecháva existujúci generátor. Auto classifier a pamäť z WS-10/11 ostávajú.

Modify vyžaduje presný pôvodný hash a neprázdny search, ktorý sa v pôvodnom
súbore vyskytuje práve raz. Každé z najviac 16 edits na súbor sa vyhodnotí
voči pôvodnému obsahu. Prekrytie, nejednoznačnosť, chýbajúci text, no-op a starý
hash sa odmietnu. Aplikovanie rozsahov odzadu zachová ostatný obsah vrátane CRLF
a Unicode. Osamelé UTF-16 surrogate znaky a search deliaci emoji sa odmietnu,
aby sa pri UTF-8 serializácii nezmenili bajty mimo editovaných rozsahov.
Pri súbore dlhšom než 1024 znakov sa odmietne search obsahujúci celý súbor;
nejde o meranie sémantickej minimálnosti ľubovoľnej veľkej čiastočnej náhrady.

Create musí mať nový path, delete presný hash existujúceho súboru. Zoznam zmien
musí presne zodpovedať unikátnemu plánu, najviac 32 súborov. Platí existujúci
path guard a limit výsledného projektu 40 súborov / 200 kB na súbor / 2 MB spolu.
Iba patch vetva navyše pozná existujúce legacy `styles.css` a `app.js`; compiler
whitelist sa nerozširuje. Empty file je povolený, zmazanie celého projektu nie.
Kontroluje sa aj existujúci secret guard výsledného projektu a zhrnutia.

Všetko vzniká v pracovnej kópii. Chyba v neskoršej zmene nezverejní ani skoršiu
platnú zmenu. Neplatný/truncated JSON alebo konflikt zastaví úlohu s čitateľnou
statickou správou, bez raw modelového výstupu, autorepair alebo tichej regenerácie.
HTTP retry/failover z WS-9 sa tým nemení. Classifier, plán a patch sú normálne
merané fyzické volania; mesačný limit celej úlohy sa čerpá raz aj pri konflikte.

Na existujúcej SSE hranici sa po úplnej validácii prenášajú materializované
obsahy **iba zmenených súborov**, s `editMode:patch` a zhrnutím. Klient nepotrebuje
vyhodnocovať modelové search/replace. Výstup je stále iba návrh na schválenie.

## Kontrola v rozhraní

Review má tlačidlo „Skontrolovať rozdiel“. Diff pred schválením porovná skutočné
pôvodné súbory a úplný navrhovaný výsledok; používa rovnaké operácie ako approval.
Zobrazuje path, pridané/odstránené riadky, create/delete a zhrnutie. Kód je React
text, nevykonáva sa. Prvých 400 riadkov možno rozbaliť, rozsiahly diff má bounded
coarse režim. Prepínač uložených verzií zachová možnosť vrátiť sa k návrhu.

Approval kontroluje projekt, vetvu, snapshot aj skutočný zachytený obsah. Po
lokálnej zmene je návrh zastaraný, UI blokuje použitie a rovnaká kontrola zostáva
aj v store. Úspešné schválenie vytvorí novú verziu; pôvodná sa nemení. Diff potom
ukazuje skutočnú históriu. Na mobile sa dá z diffu vrátiť ku schváleniu a nástroje
viewportu/zoomu sa zobrazujú iba pri náhľade, čím uvoľnia miesto ostatným tabom.
Farby, existujúci dizajn a hlavný layout ostali zachované.

React checklist: typované props a operácie, memoizovaný výpočet diffu, žiadna nová
knižnica, network request alebo globálny listener; textové vykreslenie obsahu,
labelované ovládanie a čitateľné stale/error stavy. Žiadna migrácia DB; stále 001–009.

## Overenie

Hlavná sada: **840 passed / 103 skipped**, platený live smoke vylúčený a všetky
tri API kľúče prázdne. TypeScript hlavnej aplikácie aj strict native/CLI graf,
produkčný build a lint: 0 errors / 41 existujúcich warnings. Pred finálnymi
Unicode/copy úpravami prešla aj cielená 15-testová UI/project-sync sada.
Presné logy, odtlačky a snímky: `deploy/lovable-github/proof/AI-PATCHES-VERIFICATION.json`.

Natívny PostgreSQL **81/81 na 16.15 aj 18.6**: predchádzajúcich 78 scenárov plus
UI store → Hono → uloženie/obnovenie schválenej jednoriadkovej zmeny, a dva reálne
adapter/ledger scenáre cez syntetický HTTP transport. Overujú presný hash/text,
nezmenenú starú JSONB verziu, trvalé účtovanie a odmietnutie viac-súborového
konfliktu bez čiastočného výsledku alebo ďalšieho generovania. Clustre sú iba
loopback/SCRAM/private temp; po testoch zastavené a odstránené.

IAB desktop a 390×844, syntetická Alice/pg-mem/testovací model:

- React projekt s piatimi súbormi sa reálne lokálne skompiloval. Hlavné tlačidlo
  bolo modré `rgb(37,99,235)`, druhé sivé `rgb(100,116,139)`.
- Po návrhu ostal pôvodný náhľad modrý; Diff ukázal iba `src/index.css`, +1/−1,
  `#2563eb` → `#dc2626`. Schválenie vytvorilo v2 a skompilovalo červené tlačidlo
  `rgb(220,38,38)`, druhé zostalo sivé.
- Uloženie na server vytvorilo revision 2. Opätovné otvorenie a ďalšia reálna
  lokálna kompilácia zachovali obe správne farby aj verziu v2.
- Ďalšia fixture úloha zámerne vrátila chybný hash: čitateľný konflikt bez nového
  návrhu/verzie. Dve úlohy = 6 nahlásených volaní, 180 input + 130 output = 310
  syntetických tokenov. Mesačný čítač 8 seeded → 10/10.
- Bez browser warn/error. Viewport resetnutý, vlastná karta a QA servery upratané.

Toto je overenie protokolu, perzistencie, UI a skutočnej kompilácie dôveryhodného
malého testovacieho projektu na lokálnom hoste. Nie je to živé meranie kvality LLM
ani dôkaz produkčnej sandbox izolácie. WS-4 má vlastné Docker overenie.

## Otvorené

Nadväzujúci `docs/WS-13-BUILD-REPAIR.md` nahrádza pôvodný full-file formát v
samostatnej build-error autofix vetve a pridáva explicitný UI/review tok.
Nasledujúci odsek zachytáva hranicu samotného WS-12 pred týmto prírastkom.

FORGE-104/502/503 ostávajú čiastočné: presnosť a minimálnosť reálnych modelových
patchov potrebuje golden eval a živé meranie. Samostatná automatická build-error
vetva `server/agent/autofix.ts` stále používa pôvodný full-file fix formát; tento
prírastok pokrýva explicitné iterate/fix/auto požiadavky používateľa. Nie je
zavedený AST edit, rename, binary patch, inštalácia nových npm závislostí ani
nový runtime. Žiadne produkčné migrácie, env alebo publish/deploy kroky.

Lokálny Lovable mirror ani overlay sa nemenili: 27 source/fixture odtlačkov
zodpovedá manifestu a 10 pristine súborov pôvodnému exportu. Jeho skorších 68 UI
testov/build zostáva historickým overením nezmeneného kódu; neopakovali sa.
Hosted AI wiring a ďalší M1–M6 backlog sú otvorené. Rezerva 30 Lovable kreditov platí.
