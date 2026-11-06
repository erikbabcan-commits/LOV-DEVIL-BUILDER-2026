# WS-16 — skutočný súborový editor v lokálnom Lovable

Záložky Kód/Súbory už umožňujú upraviť zdroje cez CodeMirror, pridať, premenovať
alebo odstrániť súbor a importovať UTF-8 zdroje cez picker aj pretiahnutie.
Adresárový strom a výber súboru používajú rovnaký aktuálny projekt. CodeMirror
sa načíta až pri editácii; TS/JS/JSX, CSS, HTML a JSON majú jazykové rozšírenia,
číslovanie riadkov, vyhľadávanie a základné dopĺňanie. Tab zostáva dostupný na
presun fokusu. Existujúca tmavá téma a rozloženie zostávajú zachované.

Toto je lokálna pracovná kópia a prenosný overlay, nie nasadená Lovable zmena.
Hostované buildy, kredity, produkčné Secrets, schéma a backend sa nemenili.

## Verzie a rozpracovaná práca

„Upraviť súbory“ vytvorí samostatný koncept. Schválené `workspace.files`, história,
AI kontext a serverová verzia zostanú pôvodné. Koncept patrí účtu a projektu,
ukladá sa do existujúcej IndexedDB a obnoví sa po refreshe alebo návrate účtu.
Neposiela sa do projektového API. Rozšírenie lokálneho záznamu je voliteľné;
predchádzajúce záznamy bez neho zostávajú čitateľné, DB version upgrade netreba.

Počas editácie sú AI, projektové prepnutie, restore, server save, kompilácia
schválených zdrojov a ZIP zablokované. UI vysvetľuje, ako úpravy dokončiť.
Tým sa zabráni strate konceptu alebo tichému exportu staršej verzie. Odhlásenie
a zmena účtu okamžite vymenia workspace; koncept zostane uložený pôvodnému účtu.

„Použiť a spustiť náhľad“ najprv overí pôvodnú source verziu, celú sadu súborov,
limity a históriu. Vytvorí jediný nový immutable snapshot s `kind=edit`, rodičom
a presnými `sourceFiles`; potom zavolá existujúci Hono compile endpoint.
Pôvodné snapshoty sa neprepisujú. No-op nevytvorí verziu. Zlyhaná validácia alebo
zastaraný základ zachová koncept. „Zrušiť úpravy“ nemení schválené zdroje.
Serverové uloženie je samostatný explicitný CAS krok po použití zmien.

Kompilačné chyby sa zobrazia pri príslušnom súbore a v CodeMirrore. Ak diagnostika
obsahuje riadok/stĺpec, rozsah sa označí; inak sa použije začiatok súboru.
Označenie patrí poslednému buildu a po ďalšej úprave odlišného obsahu sa nepoužíva
ako aktuálna diagnostika. Pri chybe načítania rozšíreného editora zostáva
ovládateľný textový fallback. Nie je pridané spustenie plateného AI fixu.

## Import a limity

- Cieľový priečinok je explicitný; prázdny znamená koreň. Cesty sa neskracujú ani
  ticho neprepisujú. Po premenovaní UI pripomenie úpravu importov.
- Import prečíta celú dávku pred zmenou konceptu. Duplicitná/nepovolená cesta,
  chybný UTF-8, NUL, limit alebo rozpoznaný credential blokuje celú dávku.
- Zmena konceptu počas asynchrónneho čítania zahodí neskorý výsledok. Dispose
  starého účtu neumožní jeho ďalšiu mutáciu alebo zápis.
- Používajú sa existujúce workspace limity 40 súborov, 200 000 B na súbor a
  2 000 000 B spolu; nie širšie limity ZIP. Obsah sa neprerezáva.
- Import je zdrojový text, nie binárne prílohy alebo vision upload z FORGE-108.
  Kontrola známych tvarov kľúčov zostáva heuristikou, nie zárukou detekcie tajomstiev.

## Overenie

| Kontrola | Výsledok |
|---|---|
| Lovable UI/unit suite | 146/146 v 15 súboroch |
| Hlavná suite | 891 passed / 109 skipped; platený live smoke vylúčený |
| PostgreSQL 16.15 a 18.6 | 87/87 na každej verzii, cleanup potvrdený |
| TypeScript | Lovable, hlavný aj strict native/CLI graf prešli |
| ESLint | nové Lovable súbory čisté; hlavný 0 errors / 34 existujúcich warnings |
| Build | hlavný produkčný aj Lovable klient/SSR/Workers prešli |

14 nových controller scenárov overuje oddelenie zdrojov, jednu novú verziu,
obnovu konceptu, no-op/delete/restore, blokovanie konkurenčných akcií, odmietnutie
nebezpečných ciest/kľúčov/UTF-8 overflow, stale základ a dispose. Sedem React
scenárov overuje apply/compile, add/rename/delete/cancel, chyby, picker/drop,
atomickú chybnú dávku a oneskorený import. V týchto React testoch je editor
nahradený textarea; skutočný CodeMirror bol overený osobitne v prehliadači.

Nový native scenár používa controller z overlay cez skutočne podpísaný dočasný
Cloud JWT → serverovú proxy → Hono → PostgreSQL. Obnoví koncept bez mutácie DB,
použije ručnú CSS zmenu, skutočne ju skompiluje, uloží cez CAS a znovu otvorí
obe verzie. Pôvodná história zostáva identická; editor metadata nie sú na serveri.
Mesačné AI čerpanie aj počet `ai_runs` zostali nula.

Browser desktop/390×844 použil skutočný CodeMirror, vrátane syntax spanov a
TypeScript doplnenia lokálnej premennej `uploaded`. Zmena CSS na `#16a34a` sa
obnovila po refreshe, po apply sa skompilovala, uložila a po reopen mala hlavné
tlačidlo `rgb(22,163,74)`, druhé ostalo `rgb(100,116,139)`. Prešli add/rename/delete,
skutočný picker import UTF-8 fixture, prepnutie Alice/Bob a obnova jej konceptu.
Synteticky pokazený App vyvolal reálnu esbuild chybu a jeden inline marker;
obnova funkčnej v2 vrátila zelený náhľad. Finálny server r3 uchováva tri snapshoty
(v1 pôvodná, v2 funkčná ručná, v3 zámerne pokazená) a aktívnu v2.
Po zrušení importného konceptu nezostal importovaný testovací súbor v projekte.

Browser fixture má syntetické identity, pg-mem a dôveryhodný HostExecutor;
nejde o produkčnú izoláciu alebo živý LLM. Bez warn/error záznamov a horizontálneho
pretečenia dokumentu (390 px). Karta 21 zatvorená, viewport resetovaný, vlastné
QA servery zastavené. Dôkazy sú v `deploy/lovable-github/proof/manual-files-*`
a `MANUAL-EDITOR-VERIFICATION.json`.

Pribudlo šesť priamych editorových závislostí a 27 uzamknutých balíčkov navyše
oproti WS-15. Existujúce lock entries ostali nezmenené; loopback registry URL sa
neprenášajú. Overlay má 49 zdrojových/unit, 17 QA a 2 package súbory (68 hashov).
Pôvodných desať exportných hashov je zachovaných. Opakovanie fixture a native
kontrol používa postupy WS-14 a `deploy/test-projects-native.py`.

FORGE-301/302/303 sú rozšírené lokálne; semantic TypeScript language service,
kompletný strict/lint/format flow z FORGE-308, automatické prepisovanie importov,
branches/merge, binárne uploady a hosted prenos zostávajú otvorené. Starší Monaco
editor hlavného frontendu sa týmto prírastkom nemení. Celé M1–M6 nie je hotové.
Bez commit/deploy/produkčných zmien, platených inference alebo Lovable kreditov.

Použité API podklady: [React CodeMirror](https://github.com/uiwjs/react-codemirror/tree/master/core),
[CodeMirror lint](https://codemirror.net/examples/lint/),
[CodeMirror prístupný Tab](https://codemirror.net/examples/tab/).
