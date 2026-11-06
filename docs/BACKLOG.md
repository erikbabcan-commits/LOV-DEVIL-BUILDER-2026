# 🔥 Forge — kompletný backlog
**Cieľ:** z prototypu (workspace + /editor + publish demo + test suite) spraviť plnohodnotný Lovable-style AI editor, ktorý si zákazník kúpi na **mesačné predplatné**.
**Stratégia:** MVP predajné do konca M1/Q1 — reálny AI engine, hosting, auth a billing. Všetko ostatné buduje na tom.

---

## 0. Stav — čo už existuje (M0 ✔)

| Hotovo | Poznámka |
|---|---|
| Lovable-style workspace | landing „Čo chceš postaviť?", Agent Mode checklist, streaming |
| Chat + Agent Mode | plán → generácia → snapshot (simulácia, mock modely) |
| Canvas panely | Preview / Code / Console / Diff, zoom, viewporty, Edit mode |
| História verzií | snapshots, pin, restore, read-only rewind |
| Publish modal | build → deploy → URL (fake) |
| /editor dashboard | sidebar s projektmi, search, connectors, live preview prepojený s canvasom |
| Test suite | ~60 testov, Ctrl+Shift+T, restore stavu |
| Téma | čierna + modrý akcent, responzívne (iPhone 14) |

**Čo je fake a musí sa nahradiť reálnym:** LLM volania (mock), generované appky (4 šablóny), publish URL, ZIP export, connectors, billing, účty.

### Lokálny záverečný gate a Git cleanup · 6. 11. 2026

Pred usporiadaním commitov prešlo hlavné overenie **1002 passed / 157 skipped**,
TypeScript, strict native/CLI graf, ESLint **0 errors / 33 baseline warnings**
a produkčný build. Samostatné lokálne sandboxy overili Docker **21/21**, React
E2E **22/22**, historické demo **6/6 + 112/112** vnútorných kontrol a moderný
Lovable mirror **146/146** vrátane typov a buildov. Natívne PostgreSQL brány sa
po úprave rozpočtu štartu testovacích fixture overili sériovo: **135/135 na
16.15 aj18.6**, oba clustre zastavené a odstránené. Po poslednej úprave testovacích
rozpočtov prešlo aj80/80 billing testov, strict graf a lint harnessu. Oprava fingerprintu konceptu zachová rovnaký
podklad aj po obnove IndexedDB s iným poradím súborov, bez oslabenia kontrol
obsahu alebo verzie. Presný mobilný billing gate390×844 prešiel bez pretečenia.
Rozsah a aktuálne výsledky: [lokálne overenie](LOCAL-VERIFICATION-2026-11-06.md).
Ide o používateľom vyžiadané upratanie s lokálnymi testami pred pauzou v nových
funkciách. Celý M1–M6 zostáva otvorený; produkcia, Stripe a hosted Lovable sa
nemenia.

### Predplatné a overený serverový plán · WS-18 · 6. 11. 2026

Pribudol predvolene vypnutý sandbox Stripe Checkout/Portal pre mesačný a ročný
Pro plán, trvalá identita zákazníka, idempotentné prípravy, podpísané webhooky,
dedup a canonical reconciliation pod rovnakým owner lockom ako AI kvóty.
Čerstvý plán a konečnú expiráciu čítajú cookie/Cloud auth aj kvóty z DB; spotreba
sa pri zmene plánu neresetuje. Každé neterminálne predplatné blokuje druhý nákup.
Hlavný frontend má decentnú kartu plánu/cien/správy v Moje projekty s chráneným
retry a neskorými odpoveďami podľa účtu. Návratová URL neaktivuje Pro.
Overené **1001 passed/157 skipped**, z toho billing **61 backend+19 UI**;
**135/135 PG 16.15 aj 18.6**, TypeScript/lint/build. Browser overil syntetické
Free→Pro→scheduled cancel→Free, owner isolation a disabled stav. Následný
headless browser preukázal presných390×844 bez pretečenia a s dostupným CTA;
fixture/hosted limity sú v `docs/WS-18-BILLING.md`.
Migrácia010 je iba lokálna. Skutočné Stripe produkty/ceny/portál/webhooky,
živé platby, dane/dunning/refundy a Lovable Cloud billing bridge ostávajú otvorené.
FORGE-801/803/804 sú čiastočné, nie hotový platený M1. Bez deployu, externých
Stripe zápisov alebo Lovable kreditov. Nasleduje už len používateľom žiadaný
Git cleanup/commity/merge s lokálnym overením a potom pauza v nových funkciách.

### Hlavný editor: koncepty a nemenné uloženie · WS-17 · 6. 11. 2026

Aj hlavný frontend má lokálne pribalený CodeMirror, obnoviteľné koncepty podľa
účtu/projektu/verzie a funkčný jednoduchý editor. Uloženie/Ctrl+S vytvára jedinú
novú ručnú verziu, zachová rodiča a spúšťa reálnu kompiláciu. Presný podklad a
epochy blokujú neskoré aplikovanie; neuložený koncept chráni aj pred konkurenčným
checkpointom, dashboard editáciou, restore, AI, exportom a serverovými operáciami.
Obnova projektu bez chatu otvorí workspace. UI len decentne doladené aj na 390 px.
Overenie: **921 passed / 110 skipped main**, desktop/mobile browser: reálny
CodeMirror/fallback, refresh konceptu, prepnutie účtu a návrat, green CSS build,
serverový save/reopen rev2, história2 a nezmenená AI spotreba. **88/88 PG 16.15
aj 18.6**, TypeScript/build/lint (0 errors/33 warnings). Dôkazy eviduje `deploy/lovable-github/proof/MAIN-CODE-EDITOR-VERIFICATION.json`.
Lokálny Lovable editor/68 hashov overlay sa nemenili; 146 UI testov patrí WS-16,
nejde o opakovaný beh. Detaily: `docs/WS-17-MAIN-CODE-EDITOR.md`.
FORGE-302/303/1103 ostávajú čiastočné; semantic TS/lint/format, branches/merge,
hosted prenos a celý M1–M6 nie sú hotové. Odložený editor chunk ~582kB zostáva
nad Vite upozornením. Bez commit/deploy, produkčných zmien alebo kreditov.

### Súborový editor a ručné verzie · WS-16 · 6. 11. 2026

Lokálny Lovable má CodeMirror so syntaxou/dopĺňaním, strom súborov, add/rename/
delete a atomický UTF-8 picker/drop import. Koncept je oddelený od schváleného
kódu a uložený podľa účtu/projektu; apply vytvorí immutable verziu a skutočne
kompiluje. Chyba sa zobrazí pri súbore aj inline; restore vráti pôvodný kód.
Overenie: **146/146 UI**, **891 passed / 109 skipped main**, **87/87 PG 16.15
aj 18.6**, TypeScript/buildy a lint main 0/34 baseline warnings, nové UI čisté.
Browser desktop/390px overil reálny CodeMirror, TS completion, refresh konceptu,
ručnú zelenú CSS zmenu, CAS save/reopen, súborové operácie, skutočný import,
owner switch, build chybu a návrat funkčnej verzie. Detaily: `docs/WS-16-FILE-EDITOR.md`.
FORGE-301/302/303 sú rozšírené lokálne; semantic TS/lint/format, branches/merge,
binárne prílohy a hosted prenos ostávajú otvorené. Hlavný starší Monaco sa nemení.
Bez commit/deploy/produkčných zmien, platených inference alebo Lovable kreditov.

### Skutočný ZIP aktuálnej a historickej verzie · WS-15 · 6. 11. 2026

Lovable demo Export ZIP je nahradený reálnym lokálnym stiahnutím: výber verzie,
zoznam/bajty a presné zdroje, bez chatu alebo čakajúceho AI návrhu. Rovnaké jadro
používa hlavný frontend; zachová README aj `.gitignore`, blokuje celý archív pri
nebezpečných cestách, kolíziách, UTF-8 limitoch alebo rozpoznaných kľúčoch.
Zmena účtu/projektu/verzie počas generovania zahodí oneskorený download.
Overenie: **891 passed / 108 skipped main**, **125/125 Lovable UI**, TypeScript,
buildy, lint main 0/34 existujúcich warnings a nové UI čisté. Reálne ZIP-y oboma
buildermi pre **12/12 šablón** → CRC/úplné zdroje → rozbalenie → TypeScript/Vite
build s čerstvou spoločnou inštaláciou identického toolchainu. Browser desktop
a 390px stiahol v2/v1; nezávislý Python CRC potvrdil presný jednoriadkový CSS
rozdiel, Escape/fokus/účty a žiadne pretečenie. Detaily: `docs/WS-15-ZIP-EXPORT.md`.
FORGE-605 má reálny ZIP tok lokálne v oboch UI; hosted prenos a živý GitHub flow
ostávajú otvorené. Bez commit/deploy, produkčných zmien, hosted buildov, platených
inference alebo Lovable kreditov. PostgreSQL sa nemenil; posledné WS-14 overenie
86/86 na každej verzii sa v tejto fáze neopakovalo.

### Lovable AI workspace napojený lokálne · WS-14 · 6. 11. 2026

Lokálny Lovable frontend používa skutočný Hono katalóg modelov, SSE/auto intent,
oddelený návrh a diff, schválenie do immutable verzie, compile-only náhľad a
projektové CRUD s CAS. IndexedDB chráni rozpracované zdroje aj históriu podľa účtu;
prepnutie ownera aj tokenu je overené. Otvorenie serverovej verzie zachová dirty
projekt ako samostatnú lokálnu kópiu. Kompaktný mobilný review bez redizajnu.
Overenie: **851 passed / 108 skipped main**, **86/86 Lovable UI**, **86/86 PG 16.15
aj 18.6**, TypeScript/buildy, main lint 0/40 baseline warnings, nové UI čisté.
Browser desktop/390px: otázka bez zmeny → jeden CSS diff → approval → reálna
kompilácia → save/reopen; účty, lokálna obnova, história a odmietnutie. Provider
je syntetický, nejde o živú kvalitu LLM. Prenosný overlay má 58 súborov.
Detaily a dôkazy: `docs/WS-14-LOVABLE-AI.md`. Hosted Lovable zostáva bez zmien,
žiadne kredity, commit/deploy alebo produkčné zmeny. Živá aktivácia, publish,
ZIP, billing a zvyšok M1–M6 ostávajú otvorené. Stripe MCP OAuth sandbox Read je
autorizovaný samostatne; nejde o billing aplikácie.

### AI oprava overená buildom · WS-13 · 6. 11. 2026

Automatická build-error vetva teraz používa presné source-bound patche z WS-12
nad celým kódom, bez 4000-znakového rezu alebo full-file fallbacku. Najviac dva
repair kroky a tri kompilácie, pred každým nové hashe; konflikt/infra chyba
zastaví ďalšiu opravu. Prvý priveľký kontext sa odmietne pred mesačným čerpaním.
Pri chybe náhľadu pribudlo explicitné AI tlačidlo → kontrolný build → Diff/review
→ schválenie. Pôvodné zdroje aj snapshot zostávajú do approval bez zmien.
Overenie: **851 passed / 106 skipped**, **84/84 PG 16.15 aj 18.6**, oba TypeScript
grafy, build, lint 0 errors / 40 existujúcich warnings. Browser desktop/390px
overil skutočnú compile chybu, jedno-riadkovú opravu, kontrolu, approval aj
uloženie/reopen/recompile; jedna syntetická AI úloha/volanie. Opravené aj mobilné
prepínanie Chat/Diff/Preview bez redizajnu. Detaily: `docs/WS-13-BUILD-REPAIR.md`.
FORGE-104/202/503 ostávajú čiastočné: živá kvalita/regresné evaly a produkčný Vite
publish pipeline nie sú hotové. Bez commit/deploy/produkčných zmien, platených
inference, hosted Lovable úprav alebo kreditov.

### Cielené úpravy a diff pred schválením · WS-12 · 6. 11. 2026

Iterate/fix používa source-bound JSON patch: presný SHA-256, jedinečný pôvodný
search, neprekrývajúce sa rozsahy a atomická kontrola celého výsledku. Mení iba
plánované súbory; konflikt zastaví úlohu bez tichej regenerácie. Review ukazuje
skutočný diff pred schválením, blokuje zastaraný návrh a zachová pôvodnú verziu.
Na mobile pribudol návrat ku schváleniu a kompaktnejší toolbar bez redizajnu.
Overenie: **840 passed / 103 skipped**, **81/81 PG 16.15 aj 18.6**, oba TypeScript
grafy, build, lint 0 errors / 41 baseline warnings. Browser desktop/390px:
iba jeden CSS riadok, modrá pred schválením → červená po ňom, druhé tlačidlo bez
zmeny; uloženie/reopen zachová v2; chybný hash nemá nový návrh. Dve syntetické
úlohy = 6 meraných calls. Detaily a limity: `docs/WS-12-PATCHES.md`.
FORGE-104/502/503 sú čiastočné: živá kvalita patchov/eval a samostatná automatická
build-error autofix vetva zostávajú otvorené. Žiadny commit/deploy, produkčné
zmeny, platené inference alebo Lovable kredity. Hosted Lovable wiring sa nemenilo.

### Zámer a odpoveď bez zmien · WS-11 · 6. 11. 2026

Lokálne implementované auto routing create/iterate/fix/explain cez validované
merané classifier volanie. Otázka používa reálny provider stream bez plan/stage,
compilera alebo mutácie. UI spojí delty, označí prerušenú odpoveď, Re-run patrí
ku konkrétnej otázke a vybranému modelu; kopírovanie skutočne používa Clipboard.
Merač jasne uvádza čerpanie aj za otázky. Bez redizajnu/hosted zmien/kreditov.
Pripravených 150 SK/EN eval promptov a offline export/scorer s odtlačkami,
confusion/recall a presnými >90 % / max5 % regression hranicami. Nejde o nameranú
presnosť LLM; príklad má zámerne 135/150 syntetických výsledkov a gate neprejde.
Overenie: **816 passed / 100 skipped**, **78/78 PG 16.15 aj 18.6**, TypeScript,
strict native/CLI graf, build, lint 0 errors / 41 baseline warnings; finálna
quota copy ešte 17 cielených UI/project-sync testov. Browser desktop/390px:
otázka → odpoveď → copy → Re-run ostáva bez zmien, 4calls za2úlohy. Native PG
preverí nezmenený workspace/revíziu a durable accounting aj chybný classifier.
FORGE-105/102/504/509 sú čiastočné: presnosť reálneho modelu, živá kvalita/latencia,
nočný eval CI/dashboard a širšie prompt packy zostávajú otvorené. Rozsah a limity:
`docs/WS-11-INTENT.md`. Žiadne commit/deploy/produkčné migrácie, platené inference
alebo Lovable kredity; 30-kreditová rezerva platí.

### Pamäť konverzácie a úplný snapshot · WS-10 · 6. 11. 2026

Lokálne doplnené odoslanie a owner/CAS uloženie chatu, obnovenie aj po refreshe,
meraná rolling sumarizácia starších správ a úplný aktuálny/generated kód bez
3000-znakového orezania. Kontrola kontextu s rezervou výstupu platí pred každým
fyzickým volaním a používa najmenší limit povoleného fallback reťazca. Priveľký
snapshot odmietne preflight pred kvótou; neskorší rast sa zastaví bez aplikovania.
Návrh v histórii rozlišuje pripravené/odmietnuté/použité. Správy sú text bez HTML
vykonávania; odstránený nepravdivý pevný údaj 200k ctx. Bez redizajnu alebo kreditov.
Overenie: **787 passed / 98 skipped**, **76/76 PostgreSQL 16.15 aj 18.6**,
TypeScript/build, lint 0 errors / 41 baseline warnings. Desktop/390px: 26 správ
zo servera → generovanie → refresh → ďalšia úloha → odmietnutie; šesť meraných
calls za dve mesačné úlohy. Syntetické dáta, žiadne živé inference. Nezmenený
Lovable overlay má stále 68 UI testov; hostované AI zostáva otvorené.
FORGE-107 ostáva čiastočné: kvalita reálnej pamäte/20+ sessions potrebuje golden
eval set a live overenie; cache a správa veľmi dlhého chatu sú ďalšia práca.
Podrobnosti a limity: `docs/WS-10-CONTEXT.md`.

### Výber modelu, retry a failover · WS-9 · 6. 11. 2026

Lokálne implementované Mistral/OpenAI Responses/Claude Messages adaptéry, pevný
serverový katalóg a skutočný výber v hlavnom UI. Nové služby sú default OFF;
záložné modely vyžadujú presný aktuálny opt-in príjemcov. Ohraničený retry
prechodných HTTP odmietnutí, bez replay pri partial stream/sieťovej neistote alebo
chybe ledgeru. Každý fyzický pokus má usage/cost záznam, mesačná úloha iba jeden.
Overenie: **766 passed / 95 skipped**, **73/73 PG 16.15 aj 18.6**, **68/68 lokálne
Lovable UI**, oba buildy, TypeScript, lint 0 errors / 41 baseline warnings.
Browser desktop/390px overil syntetický fallback a priamy výber, tokeny aj
reset súhlasu. Lovable má iba proxy katalógu; jeho AI UI zostáva demo. Bez
živých inference, hosted zmien, commitov/deployu; 30-kreditová rezerva platí.
FORGE-101 ostáva čiastočné (latencia <15s a živá kvalita neoverené), rovnako
106/804/1202 a celý M1. Detaily: `docs/WS-9-PROVIDERS.md`.

### Odhady AI nákladov · WS-8 · 6. 11. 2026

Lokálne doplnený verziovaný serverový cenník, snapshot pri rezervácii každého
volania a presné BigInt odhady mikro-USD. Zmena cien nemení historické výsledky;
chýbajúca cena/model/usage zostáva unknown. Kontrola migrácie 009 pri prijatí
vráti mesačný inkrement späť pri chýbajúcej schéme. Operátor má READ ONLY CLI
report per účet/plán a samostatný offline dashboard s filtrami, pokrytím a
mobilným zobrazením. Fiktívny príklad sa nepovažuje za živé ceny.
Overenie: **721/90 main**, **68/68 PostgreSQL 16.15 aj 18.6**, build, TypeScript,
čistý nový lint; dashboard browser desktop/390px, bez provider calls alebo
hosted zmien. FORGE-1202 zostáva čiastočné: webový admin, billing/príjmy, reálne
ceny a preukázaná >70 % marža nie sú hotové. Detaily: `docs/WS-8-AI-COSTS.md`.

### Spotreba provider volaní · WS-7 · 6. 11. 2026

Lokálne doplnené trvalé účtovanie každého AI volania a owner-only tokenový report.
Migrácia 008 zapisuje prijatie úlohy atomicky s kvótou; pred každou inference
musí existovať call rezervácia. Tokeny bez údajov zostávajú unknown, pád/zrušenie
sa neprezentuje ako nula a zlyhanie ledgeru blokuje ďalšiu inference.
Hlavné UI aj lokálny Lovable panel zobrazujú vstup/výstup a pokrytie bez redizajnu.
Overenie: **687/77 hlavná sada, 67/67 Lovable UI, 55/55 natívny PG 16.15 aj 18.6**,
oba buildy a TypeScript, browser desktop/390px vrátane druhého účtu.
Bez platených AI volaní, hosted zmien, commitov alebo nasadenia. FORGE-106/804 sú
čiastočné: retry, finančné costy/cenník, tokenové limity a celý usage dashboard
zostávajú otvorené, rovnako FORGE-1202. Detaily: `docs/WS-7-AI-USAGE.md`.

### Lovable hybrid a GitHub konektor · 6. 11. 2026

Na požiadanie sa pripravuje prepojenie samostatného Lovable UI s Cloud auth/prílohami
a existujúcim Hono backendom. Hono má voliteľné JWKS overovanie Cloud user tokenov,
explicitné väzby identity na existujúce účty a pevný zoznam povolených API ciest.
Cloud je aktívny v Europe (Ireland), používateľovo prihlásenie v IAB náhľade
funguje. Serverová proxy a stavový panel sú uložené v Lovable; presný export
prešiel 36/36 testami a lokálnym client/SSR/Workers buildom. Živé Cloud → Hono
prepojenie, serverové Secrets, identity binding, projektové CRUD ovládanie
a produkčné nasadenie zostávajú otvorené. Prílohy zatiaľ nie sú implementované.

GitHub: lokálne opravená väzba OAuth relácie na interný účet, odmietnutie
legacy/pilot relácií po prepnutí účtu a vynútenie public-only limitu aj pre
starší širší token. Predvolený scope je `public_repo`; chýbajúce udelené práva
blokujú export. Hostované GitHub tlačidlo v Lovable je stále ukážkové; lokálne
implementované BFF prepojenie a návrh neskoršej GitHub App sú v `docs/GITHUB-CONNECTOR.md`.

Aktuálne celkové overenie main repo: **851 testov prešlo, 106 bolo preskočených**
(opt-in Docker/PG a pôvodný skip), platený live smoke vylúčený, Mistral kľúč prázdny.
TypeScript, cielený lint a produkčný build prešli. GitHub regresie zahŕňajú aj
prepnutie účtu či zmenu prepojenia medzi potvrdením a odoslaním: pôvodné súbory
sa vtedy neodošlú. **17/17 reálnych PostgreSQL scenárov** vrátane Basic/Cloud
transportu a operátorského identity helpera prešlo na testovacom Linuxe, cleanup
potvrdený. Zmeny nie sú commitnuté ani nasadené. Lovable rezerva 30 kreditov platí;
pri poslednom zostatku 32,8 sa ďalšie generácie a hosted buildy nespúšťajú.
Presný kontrakt a prevádzkové limity: `docs/LOVABLE-HYBRID.md`.

Prvý prvok Cloud GitHub flow: migrácia 004 a durable pending helper ukladajú
iba odtlačky state/nonce, viažu ich na interný účet a atomicky spotrebujú
neexpirovaný stav. Nový začiatok nahradí starší, účet má najviac jeden záznam.
Nadväzujúca serverová služba implementuje PKCE S256, výmenu kódu, overenie
GitHub identity, šifrované uloženie tokenu, stav a lokálne odpojenie. Vynucuje
public-only práva, pevný HTTPS callback, 10s provider deadline a limit odpovede.
Výsledok starého flow neobnoví odpojené alebo novšie prepojenie. Osem testov
služby a štyri testy pending úložiska prešli. Rozšírených **30/30 reálnych PG
testov prešlo na PostgreSQL 16.15 aj 18.6** v dočasných natívnych clustroch na Macu
(testovací Linux offline). Zahŕňajú migrácie 004–007, 8 súbežných spotrebovaní state,
late finish vs. disconnect/restart, celý JWT/BFF/OAuth/PG priechod a jeden writer
pri 8 súbežných potvrdeniach exportu.
Oba clustre boli zastavené a odstránené. Produkcia sa nemenila.
Cloud OAuth endpointy aj serverová BFF factory sú lokálne implementované,
štandardný startup ich predvolene nezapína; explicitné runtime prepínače a
read-only preflight sú v `docs/GITHUB-ACTIVATION.md`. Vyžadujú overenú Cloud identitu a samostatný
serverový bridge key, BFF viaže flow na vlastnú __Host-/HttpOnly nonce cookie.
Štrnásť HTTP/BFF testov prešlo vrátane skutočného Hono middleware a simulovaného
GitHubu. UI a Lovable route wiring sú pripravené lokálne v samostatnej kópii
`lovable-github-local` a prenášacom balíku `deploy/lovable-github`: GitHub karta,
callback, retry, odpojenie a account-switch guard. Prešlo 60/60 UI testov,
TypeScript, cielený lint a client/SSR/Workers build. Lokálna vizuálna kontrola
prešla na desktope a 390px mobile; opravený fokus/klávesnica mobilného panela
pomocou existujúceho Sheet. Screenshoty sú súčasťou prenášacieho balíka.
Hosted prenos, konfigurácia a živé prepojenie zostávajú otvorené.
Serverový výber exportnej verzie je pripravený: historické zdroje z vlastného
projektu, CAS revízia, kontrola ciest/tajomstiev a deterministický fingerprint.
Prešiel ôsmimi unit testami aj reálnym PG scenárom. Lokálne sú pripravené writer
nového verejného repozitára a prepare/confirm pipeline s durable ledgerom,
väzbou súhlasu na cieľ/zdroje/prepojenie a kontrolou tree/commit/ref/blob integrity.
Šestnásť ďalších unit testov prešlo. Neisté výsledky sa automaticky neopakujú;
retencia a manuálna obnova neúplných zápisov sú otvorené. HTTP aj lokálne Lovable UI exportu sú pripravené:
výber skutočného serverového projektu/verzie, kontrola súborov, výslovný public
súhlas, výsledok a bezpečné obnovenie stavu cez UUID oddelene pre app účet.
BFF akcie sú dostupné len pri explicitnom exporter wiring; default vypnuté.
Native PG test overuje aj prepare/confirm/status a idempotentný retry.
Hostovaná aktivácia a živý GitHub zápis neprebehli.

FORGE-605/1103: doplnené obnovenie serverovej kontroly súborov podľa UUID,
zrušenie nepotvrdenej prípravy a expirácia. Migrácia 006 uvoľní názov iba pre
cancelled/expired; starý UUID zostáva neaktívny a nemožno ho znovu potvrdiť.
Running/failed/succeeded rezervácie sa automaticky neuvoľňujú. Reálny PG test
overuje súbeh nových rezervácií, cancel vs. confirm a upgrade naplnenej schémy 005.
UI po reload vyžaduje čerstvý súhlas; zrušenie a expirácia už nemajú slepý koniec.
Retencia ledgeru a manuálne posúdenie neúplných/starších GitHub zápisov zostávajú otvorené.
Overenie tohto prírastku: **627 passed/52 skipped**, 60/60 lokálnych UI testov,
30/30 reálnych PG scenárov na 16.15 aj 18.6; TypeScript, cielený lint a oba buildy
prešli. Preskočené PG/Docker scenáre sa spúšťajú samostatne; platený smoke vylúčený.

FORGE-605/1103: migrácia 007 ukladá repo/commit/tree/blob dôkazy pred posunom
vetvy. Nová read-only kontrola výsledku vie obnoviť running/failed → succeeded
po strate PATCH odpovede či páde pred uložením výsledku. Žiadny nový GitHub zápis
sa pri nej nespustí. Overuje pôvodný repo/owner ID, verejnosť, tip vetvy, commit,
rodiča, tree a každý blob/mode. Obnova funguje aj po úprave/zmazaní projektu a
refreshi pripojenia toho istého GitHub ID. Neúplné dôkazy alebo zmenená vetva
vyžadujú ručné zosúladenie; retencia zostáva otvorená. UI má samostatnú kontrolu
a odkaz na známy čiastočne vytvorený repozitár; na 390px mobile overený simulovaný
priechod chyba → kontrola → výsledok. Produkcia, živý GitHub ani kredity sa nemenili.

Cloud GitHub startup je pripravený: oddelené default-off OAuth/export prepínače,
validácia pred DB/migráciami, samostatné Secrets a callback, runtime factory
a kontrola DB stĺpcov/unique indexov/exportných stavov. Nový `github:preflight`
číta iba explicitný dotenv; voliteľne overí DB v READ ONLY transakcii, nič
neprepája/nemigruje/neštartuje a nevolá providera. 25 nových unit/CLI testov
a tri nové reálne PG scenáre prešli. Postup: `docs/GITHUB-ACTIVATION.md`.
Verejný deployment guard ostáva; živá konfigurácia, identity binding, hosted
prenos a overenie stále nie sú dokončené.

### AI limity a priebeh úloh · 6. 11. 2026

Čiastočný prírastok FORGE-102/106/803/804/1103: odmietnutia nezvyšujú uloženú
mesačnú spotrebu, predpríprava ju nečerpá a autofix sa ráta raz až pred prvou
inference. Kvóta používa pripnutú READ COMMITTED transakciu a owner lock;
64 súbežných požiadaviek prijme presne 10. Oneskorený starý mesiac neprepíše
nový čítač. Zrušený reader drží concurrent slot, kým provider naozaj neskončí.
UI rozlišuje vyčerpanie, rate limit, denný budget, auth a dostupnosť služby;
prerušený stream nie je úspešný návrh. Mesačný meter a upozornenie od 80 % sú
v hlavnom editore aj lokálnej Lovable kópii. Príprava nevyčerpala hosted kredity.

105 cielených main testov, 63 Lovable UI testov a **48/48 PG scenárov na 16.15
aj 18.6** prešlo. Browser fixture overila 8→9→10 a odmietnutie ďalšej úlohy bez
zmeny projektu, prepnutie účtov a 390px panel. Ide o syntetický provider a lokálne
rozhrania. Bez novej migrácie, commitov a produkcie. Tokenové/nákladové účtovanie,
provider failover/retry, billing a živá hostovaná aktivácia zostávajú otvorené.
Detaily: `docs/WS-6-AI-QUOTAS.md`. Konečná main sada má **667 passed/70 skipped**,
TypeScript/build prešli a celoplošný lint má 0 chýb/41 upozornení. Nový Cloud →
proxy → PG quota → syntetická inference priechod prešiel aj po zrušení identity
väzby (401 bez ďalšieho provider volania).

### Overený prírastok WS-4 · 5. 11. 2026

Izolovaná **compile-only** kompilácia je implementovaná na vetve
`codex/ws4-sandbox-isolation`: súkromný trusted runner, jednorazové Docker workery,
spoločná fronta buildu aj všetkých autofix rebuildov (1 aktívny + 8 čakajúcich),
hard resource limity, watchdog, cancellation a potvrdený cleanup. Pri infra chybe
sa nespúšťa platený AI autofix a izolovaný režim nepoužije host fallback.

Overenie: **419 lokálnych testov prešlo**, 10 preskočených (9 Docker scenárov
spúšťaných oddelene + 1 existujúci preskočený test). Platený `liveSmoke.test.ts`
bol výslovne vylúčený a `MISTRAL_API_KEY` prázdny. **9/9 reálnych Docker testov
prešlo na samostatnom rootless Linuxe**, vrátane kernel limitov, siete/filesystemu,
timeoutu s potomkom, OOM, cancellation, cleanupu a výsledného runner image.
TypeScript a produkčný build prešli. Produkcia ani existujúce credentials sa
nemenili. Podrobnosti, limity, spustenie testov, budúci deploy a rollback:
`docs/WS-4-SANDBOX.md`.

**FORGE-201 a FORGE-1001 zostávajú otvorené.** Tento prírastok nezavádza fullstack
runtime/HMR, ľubovoľné npm balíčky ani nenahrádza tenant pentest a širšie egress
kritériá. Nasadenie na kapacitne obmedzený VPS je samostatný budúci krok.

### Overený prírastok šablón a UX · 5. 11. 2026

- 12 samostatných React/TypeScript štartovacích projektov po 13 súborov,
  funkčné lokálne interakcie, filtre galérie, názov/farba značky a follow-up prompty.
- Galéria a AI návrhy majú viditeľnú kontrolu súborov pred použitím. Schválenie
  vytvorí novú verziu; starý obsah a historické React zdroje sa zachovajú.
- Spoločný composer sa naozaj predvyplní z prompt knižnice. Zrušená alebo stará
  kompilácia neprepíše náhľad nového projektu. Obnovenie preview nevymaže dokument.
- Mobilný panel projektov má klávesnicu/fokus; loading, chyby, retry a prázdne
  stavy boli doplnené. Výpadok auth API už neotvorí editor ako pilot bez loginu.
- Samostatný [Lovable UI návrh](https://lovable.dev/projects/21fdbb9f-3bac-49a3-8479-875cc9734777)
  zachováva pôvodný tmavý shell a modrý akcent. Nie je prepojený s backendom.

Overenie: **455 lokálnych testov prešlo**, 22 skipov (21 Docker spustených
osobitne + 1 pôvodný skip), TypeScript a produkčný build prešli.
**12/12 exportovaných projektov prešlo tsc/Vite buildom** na testovacom Linuxe;
**21/21 reálnych Docker scenárov prešlo** vrátane všetkých šablón.
Klikacie overenie potvrdilo branding → review → build → pridanie/presun úlohy,
mobilný fokus, obnovenie projektu a zotavenie po výpadku API.
Detaily, príkazy, obmedzenia a výsledky: `docs/WS-3-TEMPLATES.md`.

**FORGE-401–403, 303, 701 a 1102–1103 tým získavajú čiastočný prírastok,
nie úplné uzavretie.** Šablóny majú lokálne ukážkové dáta; DB/auth/platby
zákazníckych aplikácií, hostovanie, širší wizard, fullstack runtime, tenant
izolácia, úplný súborový diff a billing zostávajú otvorené. Zmeny nie sú
commitnuté ani nasadené; rozdelenie commitov nasleduje po spoločnej kontrole.

---

### Súborový diff a predchodcovia verzií · 5. 11. 2026

FORGE-104/303: Diff panel teraz porovnáva skutočné zdroje vybraných verzií
(React, CSS, JSON aj HTML), vrátane pridaných/odstránených súborov a riadkov.
V History je priamy vstup Diff pre konkrétnu verziu. Nové snapshoty ukladajú
`parentId`, takže zmena po obnovení staršej verzie používa správny základ.
Metadata sa zachovávajú v IndexedDB v2 bez zmeny schémy; staršie snapshoty
bez predchodcu predvolia predchádzajúcu uloženú verziu. Chýbajúce/poškodené
zdroje zobrazia chybu, nie falošné porovnanie voči prázdnemu projektu.

Overenie: **463 passed, 22 skipped**, TypeScript/produkčný build, čistý lint
dotknutých komponentov a klikacie porovnanie `src/brand.ts` (+1/−1) prešli.
Veľké zmeny používajú ohraničený výpočet a postupné zobrazenie ďalších riadkov.
Diff je iba na čítanie; nevykonáva kód súborov. Branch/merge UI, patch-based AI
editácie a serverové verziovanie zostávajú otvorené. Bez commitov a deployu.

### Lokálne projekty oddelené podľa účtu · 5. 11. 2026

Overený účet teraz používa vlastnú IndexedDB databázu pre projekty, snapshoty,
súbory, runy a meta ukazovatele. Pilot ponecháva pôvodnú databázu bez migrácie
alebo mazania. Anonymný používateľ a neoverený stav nemajú aktívne úložisko.
Po zmene overenej identity sa zrušia generovanie/kompilácia a čakajúci autosave,
vyčistí sa obsah pamäte aj súkromné logy a obnoví sa iba databáza nového účtu.
Oneskorený restore alebo auth výsledok nemôže obnoviť predchádzajúci účet.
Pri návrate na kartu sa relácia znovu overí.

Overenie: **472 passed/22 skipped**, 9 nových testov pre hranice účtov,
TypeScript/produkčný build a lint dotknutého rozsahu prešli. Klikacie overenie
potvrdilo zachovanie pilotnej v2 a `src/brand.ts` po reload.

**FORGE-703/1001 zostávajú otvorené:** toto je lokálne oddelenie dát, nie
serverová autorizácia projektov, šifrovanie alebo samostatná bezpečnostná
hranica pred skriptom na tom istom origin. Staré neoznačené dáta vrátane
starších prihlásených relácií zostávajú v pôvodnej databáze; automatický import
prvému prihlásenému účtu by mohol priradiť cudzie dáta. Budúci prenos musí
výslovne určiť vlastníka. Synchronizácia medzi zariadeniami ešte neexistuje.
Bez commitov a bez zásahu do produkcie.

### Serverové projekty — API základ · 5. 11. 2026

Pridaná aditívna migrácia `002_projects.sql` a auth-only API pre uloženie,
načítanie, owner listing s pagination, konflikt revízie, nemennú históriu
a soft-delete/obnovu do 30 dní. Owner sa berie iba zo session; cudzie ID sa
správa ako neexistujúce. Súbežné zápisy chráni atomická revízia a unique constraint.
Osem API scenárov prešlo nad pg-mem; **9/9 prešlo nad reálnym PostgreSQL**
vrátane opakovania migrácií, dvoch súbežných create aj update požiadaviek.
Testovací kontajner bol odstránený, produkčná migrácia sa nespúšťala.
Celá lokálna sada: **480 passed/31 skipped** (9 PG + 21 Docker spúšťaných
osobitne a 1 pôvodný skip), TypeScript/produkčný build a cielený lint prešli.

Rozsah, API, limity a testovacie prostredie: `docs/WS-5-PROJECT-STORAGE.md`.
**Automatická synchronizácia, import pôvodných dát bez vlastníka, plánové storage entitlements, fyzická retention,
organizácie/RBAC a verejné zdieľanie zostávajú otvorené.** Klient stále používa
lokálne projekty; následná ručná integrácia do UI je uvedená nižšie.

### Projektová knižnica a ručné serverové ukladanie · 5. 11. 2026

UI má `Moje projekty`: lokálne uložené projekty, serverový zoznam s pagination,
uloženie, uloženie kópie, otvorenie, kôš a obnova. Overený účet vie načítať
serverový projekt v inom prehliadači. Pilot používa iba lokálne dáta. Konflikt
revízie neprepíše lokálnu prácu; otvorenie serverovej verzie pri rovnakom ID
vytvorí atomickú lokálnu záložnú kópiu. Mapping snapshot IDs zachová serverovú
históriu aj pri kópiách; oneskorené odpovede sa neaplikujú po zmene účtu/projektu.

**486 lokálnych testov prešlo**, 36 skipov (14 PG + 21 Docker spustených
osobitne + 1 pôvodný). **14/14 prešlo nad reálnym PostgreSQL**, vrátane
React/klient → Hono → PG → lokálna cache a koša v UI. Klikacie overenie v
samostatnom loopback pg-mem fixture potvrdilo save/open/trash/restore aj
oddelenie alice/bob. TypeScript, build a cielený lint prešli. Bez commitov
a bez produkčnej migrácie. Detaily: `docs/WS-5-PROJECT-STORAGE.md`.

Automatický sync, offline fronta, spolupráca, plánové storage entitlements a legacy import
s potvrdeným vlastníctvom ešte nie sú implementované. Zdieľanie ani publish
sa uložením na server nezapína.

### Kapacita serverových projektov · 6. 11. 2026

FORGE-803/1103 získavajú ďalší čiastočný prírastok: prevádzková kapacita účtu
64 MiB/100 projektov, varovanie od 80 %, vlastníkom viazané metadata API a
atomické odmietnutie nadlimitného zápisu so zachovaním lokálnej práce. Kôš sa
počíta a obnova sa neúčtuje druhýkrát. Pinned READ COMMITTED transakcia so
zámkom vlastníka chráni súbežné tvorby aj rast rôznych projektov toho istého účtu.
Nejde o dokončené predplatné, fyzickú retenciu ani globálnu ochranu disku.
Overenie: 639/63 hlavná sada, 61 Lovable UI testov, po 41/41 PG 16.15 a 18.6;
TypeScript/buildy prešli a celoplošný lint má 0 chýb/46 upozornení.
Bez novej migrácie, commitov a zásahu do produkcie. Podrobnosti a opakovanie
sú v `docs/WS-5-PROJECT-STORAGE.md`.

## 1. Míľniky (roadmap)

| # | Míľnik | Obsah | Trvanie | Výstup / brána |
|---|---|---|---|---|
| **M1** | **Reálny engine + MVP predaj** | AI backend, multi-file codegen, sandbox preview, auth, hosting na `*.forge.app`, billing Free/Pro | 6–10 týždňov | **prvý platiaci zákazník** |
| **M2** | **Editor + blueprinty** | file explorer, Monaco, git-like history, blueprint galéria + wizard, prompt knižnica | 6–8 týždňov | Pro retencia, onboarding do 5 min — **✅ prototyp hotový (M2 Build Prompt nižšie)** |
| **M3** | **Fullstack & data** | DB pre vygenerované appky, auth pre end-userov, backend funkcie, custom domény + SSL | 6–8 týždňov | appky „robia niečo užitočné" — **✅ prototyp hotový (M3 Build Prompt nižšie)** |
| **M4** | **Tímy & Business tier** | realtime kolaborácia, komentáre v preview, share linky, seat billing, RBAC | 6–8 týždňov | B2B (Business) plán — **✅ prototyp hotový (Build Prompty nižšie)** |
| **M5** | **Enterprise & scale** | SSO/SAML, audit log, compliance (GDPR/SOC2 cesta), SLA, rate limiting | 8–12 týždňov | Enterprise zákazky — **✅ prototyp hotový (Build Prompty nižšie)** |
| **M6** | **Ekosystém** | komunitná galéria, marketplace blueprintov, remix, affiliate, template contest | priebežne | rast organický (virality) — **✅ prototyp hotový (Build Prompty nižšie)** |

---

## 2. Epiky & backlog

### 🤖 Epik 1 — AI Engine (FORGE-1xx) · M1 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 101 | Provider-agnostické LLM API (Mistral/OpenAI/Anthropic) + failover | výber modelu v UI reálne prepína model; fallback pri výpadku; latencia < 15 s do prvého tokenu | L |
| 102 | Streaming odpovedí do chatu (SSE/WebSocket) | tokeny píšu priebežne, cancel tlačidlo funguje | M |
| 103 | Multi-file codegen (React/Vite projekt, nielen single-file HTML) | AI vráti zoznam súborov + obsah; explorer ich zobrazí | L |
| 104 | Diff-based editácie (patch existujúceho kódu, nie celá regenerácia) | zmena „pfarbu tlačidla" upraví 1 súbor; Diff tab ukazuje reálny diff | L |
| 105 | Intent klasifikácia: nová appka vs. iterácia vs. fix vs. otázka | routing presnosť > 90 % na eval sete (150 promptov) | M |
| 106 | Retry, timeouty, usage metering per request | chyba providera = čitateľná správa + auto-retry; spotreba sa ráta do plánu | M |
| 107 | Kontext manažment (sumarizácia konverzácie + projekt snapshot) | 20+ správ bez prerušenia; tokeny pod limitom; historky nezabudnú kód | M |
| 108 | Attachments: obrázky/screenshots do promptu (vision) | upload → AI vidí obrázok → vygeneruje podľa neho | M |

### 🧩 Epik 2 — Codegen & runtime (FORGE-2xx) · M1–M3 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 201 | Sandbox preview pre fullstack (WebContainers/Firecracker) — **otvorené; WS-4 dokončuje iba compile izoláciu** | `npm install`, dev server, HMR beží v prehliadači/VM izolovane | XL |
| 202 | Build pipeline (Vite) + produkčný build | „Publish" najprv prejde reálnym buildom; chyby sa zobrazia v Console | L |
| 203 | Závislosti: npm balíčky na želanie | „pridaj recharts" → AI prida + nainštaluje | M |
| 204 | Databáza ako služba (tabuľky, seed, migrácie) | AI navrhne schému, UI editor tabuliek, data browser | XL |
| 205 | Auth šablóny pre vygenerované appky (login/register/OAuth) | 1 klik = funkčný login nad Forge DB | L |
| 206 | Serverless funkcie / API routes | „pridaj endpoint /api/orders" → beží v produkcii | L |
| 207 | Secrets vault (env premenné, šifrované) | API kľúče sa nikdy nezobrazia AI ani v exporte | M |

### 🖥️ Epik 3 — Editor (FORGE-3xx) · M2 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 301 | File explorer (strom súborov, add/rename/delete/upload) | plná správa súborov, drag & drop | L |
| 302 | Monaco/CodeMirror editor (highlight, autocomplete, TS) | editácia = recompile náhľad; chyby inline | L |
| 303 | Git-like verzovanie: commity, branches, merge/rollback | snapshoty sú de facto commity; restore + diff + fork vetiev | XL |
| 304 | Visual Edit mode → reálne CSS patche | klik na element = AI/JSON patch, nie len hover highlight | L |
| 305 | Reálna Dev console (logy, chyby, sieť z preview) | Console tab = živé logy runtime, nie mock zoznam | M |
| 306 | Komponent library („insert component": navbar, footer, formulár…) | vloženie bez rozbitia layoutu | M |
| 307 | Breakpoints & device frames + režim „reálne zariadenie" | existujúce viewporty + otvorenie v novom tabe (mimo sandboxu) | S |
| 308 | Linting + autoformát + TS strict check | chyby v editore, nie až pri builde | M |

### 🧱 Epik 4 — Blueprinty (FORGE-4xx) · M2 · **P0** *(explicitne požadované)*

Blueprint = **parameterizovateľná šablóna celej aplikácie** (nič mock — reálny projekt s DB, auth, stránkami), ktorá sa vygeneruje na 1 klik.

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 401 | Blueprint formát + runtime | metadata: stack, screens, DB schéma, env, sekcie AI promptov; verzie blueprintu | L |
| 402 | Štartovacia galéria (12+): SaaS starter, e-shop, blog+CMS, rezervačný systém, CRM, portfólio, members area, AI chatbot, invoicing, event registrácia, job board, recipes/fándž | každý blueprint: živý demo, zoznam funkcií, stack, čas „do appky" < 60 s | XL |
| 403 | Blueprint wizard | výber → parametre (brand, logo, farby, jazyk, mená entít) → AI doladí → hotovo | M |
| 404 | Blueprint forking / „Remix" | remix uloží kópiu do môjho účtu ako nový projekt | S |
| 405 | Private blueprinty (Pro/Business) | tím si uloží vlastný blueprint + interné šablóny | M |
| 406 | Komunitná galéria + moderácia | publish blueprintu, hodnotenie, tagy, „trending" | L |
| 407 | Marketplace + revenue share (M6) | predaj platených blueprintov, 80/20 split, payouts | XL |
| 408 | Blueprint analýza: usage → optimalizácia konverzie | miera „blueprint → publish" per šablóna | M |

### 📝 Epik 5 — Prompty & AI ops (FORGE-5xx) · M1–M2 · **P0** *(explicitne požadované)*

Systémové prompty = jadro produktu. Verziované, testované, A/B.

| ID | Prompt pack | Účel / akceptačné kritériá | Odhad |
|---|---|---|---|
| 501 | **P1 — Master Builder Prompt** | plánovanie (Agent Mode kroky), brand konzistencia, dizajn systém, slovenčina/angličtina podľa používateľa; vždy najprv plán, potom kód, potom zhrnutie | M |
| 502 | **P2 — Iterate/Edit Prompt** | zmeny len v dotknutých súboroch, zachovať fungujúce časti, stručné vysvetlenie zmien | M |
| 503 | **P3 — Fix/Debug Prompt** | dostane chybu + kontext → oprava + regresný fix; koreň príčiny, nie len symptóm | M |
| 504 | **P4 — Explain Code Prompt** | „vysvetli tento súbor/element" — pre netechnických zákazníkov, jednoducho | S |
| 505 | **P5 — Blueprint Parameterization Prompt** | naplní blueprint parametrami brandu (farvy, tón, jazyk, naming) konzistentne | M |
| 506 | **P6 — Test Generation Prompt** | AI k vygenerovanej appke napíše unit + e2e testy; nahradí mock test suite z prototypu reálnymi testami | M |
| 507 | **P7 — SEO/Content Prompt** | meta tagy, OG obrázky, copy pre landing vygenerovanej appky | S |
| 508 | **P8 — Safety Meta-Prompt (guardrails)** | odolnosť na prompt injection, žiadne secrets do kódu, bezpečné defaults, licenčne čisté dependency | M |
| 509 | Eval set (golden prompts + očakávané výstupy) + nočné regresné behy | zmena promptu nerozbije > 5 % prípadov; report do interného dashboardu | L |
| 510 | Prompt versioning + A/B + feature flagy | prepnutie verzie promptu bez deploy | M |

**Kostra Master Prompt (P1) — východzí bod:**

```text
Si Forge Agent — staviaš produkčne kvalitné webové appky.
Pravidlá:
1) Najprv krátky plán (3–6 krokov), potom kód, na konci zhrnutie + návrhy na ďalší krok.
2) Vždy dodržuj brand používateľa: {brand_fareby, fonty, tón hlasu, jazyk}.
3) Kód: TypeScript + React + Vite, Tailwind; žiadne todo komentáre, všetko musí bežať na prvé spustenie.
4) DB schémy navrhuj len keď appka reálne potrebuje dáta; vždy s migráciou a seedom.
5) Nikdy nevkladaj secrets ani kľúče do kódu — používaj env premenné z vaultu.
6) Keď opravuješ, men len to, čo je nutné (diff), a vysvetli zmenu v 1–2 vetách.
7) Ak je požiadavka nejednoznačná, polož presne jednu spresňujúcu otázku.
```

### 🚀 Epik 6 — Hosting & publish (FORGE-6xx) · M1 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 601 | Reálny deploy na CDN + `*.forge.app` subdoména | publish z demo → reálna URL, HTTP 200, SSL, global CDN | L |
| 602 | Custom domains + auto SSL (Let's Encrypt) | „pripoj doménu" = 2 DNS záznamy, validácia, cert automaticky | M |
| 603 | Preview deployments (per commit/branch) | každá verzia má vlastnú URL; produkcia sa mení len „Promote" | M |
| 604 | Rollback deployment na predchádzajúcu verziu | 1 klik, < 30 s | S |
| 605 | Export: ZIP + GitHub (push do repo) | súčasný „Export ZIP" musí vrátiť reálny projekt | M |
| 606 | Build statusy + logy v publish flow | súčasný modal so 4 krokmi napojený na reálny pipeline stav | S |

### 🔐 Epik 7 — Auth & organizácie (FORGE-7xx) · M1 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 701 | Registrácia/login: e-mail+heslo, Google, GitHub | heslá bcrypt/argon2, e-mail verify, reset hesla | M |
| 702 | 2FA (TOTP) | Pro+ feature | S |
| 703 | Organizácie & tímy, role (owner/admin/editor/viewer) | pozvánky e-mailom, RBAC na projektoch | L |
| 704 | Prenos vlastníctva projektu, mazanie s grace period | soft-delete 30 dní | S |
| 705 | SSO/SAML/SCIM (M5, Enterprise) | Okta/Entra, automated provisioning | XL |

### 💳 Epik 8 — Billing & predplatné (FORGE-8xx) · M1 · **P0** *(jadro obchodného cieľa)*

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 801 | Stripe: mesačné + ročné plány, 14-dňový trial | upgrade/downgrade/cancel self-service, proration | L |
| 802 | Pricing page (SK/EN) + plán porovnanie | jasné limity, FAQ, „najpopulárnejší" badge | S |
| 803 | Feature gating + usage limits (middleware) | limit dosiahnutý = upsell, nie tvrdá stena (soft limit + upozornenie) | M |
| 804 | Usage metering dashboard (generácie, tokeny, blueprinty, deploys) | zákazník vidí spotrebu v reálnom čase (rozšíri /editor) | M |
| 805 | Fakturácie: DPH/EU B2B reverse charge, IČO/DIČ, stiahnutie faktúr | daňovo korektné pre SK/EU | M |
| 806 | Dunning (neúspešné platby), refund flow, legal (GDPR, ToS, DPA) | automatické e-maily, compliance | M |
| 807 | Seat billing pre Business plán | pridať/odobrať člena mení fakturu pro rata | M |
| 808 | Affiliate/partner rabaty (M6) | referral link, provízia 20 % 12 mesiacov | M |

**Návrh plánov (východzí, overovať cenovú citlivosť):**

| | **Free** | **Pro** ~20 €/mes | **Business** ~50 €/mes (3 seats) | **Enterprise** — custom |
|---|---|---|---|---|
| Generácie/mesiac | 10 | 200 | neob. „fair-use" | SLA |
| AI tokeny | 100 k | 5 M | 20 M | custom |
| Blueprinty | 3 základné | celá galéria + private | + tím šablóny | + SSO, DPA |
| Súkromné projekty | ✗ | ✓ | ✓ | ✓ |
| Custom domény | ✗ | 1 | 10 | neob. |
| Export ZIP/GitHub | ✗ | ✓ | ✓ | ✓ |
| Rollback & branches | ✗ | ✓ | ✓ | ✓ |
| Tím/kolaborácia | ✗ | 1 užívateľ | 3+ seats | neob. + RBAC |
| Support | komunita | e-mail < 48 h | priorita < 24 h | CSM, SLA 99.9 % |

### 👥 Epik 9 — Kolaborácia (FORGE-9xx) · M4 · P1

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 901 | Realtime multi-user edit (CRDT/Yjs) | 2+ ľudia bez konfliktov, prítomnosť (avatary) | XL |
| 902 | Komentáre v preview (annotácia na elemente) | klik = koment, thread, resolve; AI odpovedá na koment | L |
| 903 | Share linky: view / comment / edit s expiráciou | prístup bez účtu pre view | M |
| 904 | Activity feed + audit log | kto čo kedy (zákaz aj pre Enterprise audit) | M |
| 905 | Approvals: publish len so súhlasom roly | Enterprise workflow | M |

### 🛡️ Epik 10 — Security & compliance (FORGE-10xx) · M1 (základ) / M5 · P0/P1

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 1001 | Sandbox izolácia (žiadny prístup k dátam iných zákazníkov) — **otvorené; overený compile základ WS-4** | pentestom overené; egress filter | XL |
| 1002 | Prompt injection ochrana (P8) + content moderácia uploadov | eval: < 2 % prienik | M |
| 1003 | Šifrovanie secrets vault (KMS), rotácia kľúčov | audit: secrets nikdy v logoch | M |
| 1004 | Rate limiting + abuse monitoring per účet/IP | anti-scraper, anti-mining | M |
| 1005 | GDPR: DPA, mazanie účtu + export dát, logs retention | súlad od dňa 1 (EU trh) | M |
| 1006 | SOC 2 Type II cesta (M5) | 12-mesiac observačnosť, security program | XL |
| 1007 | Zálohy, DR, uptime statusy (99.9 % Enterprise) | RTO/RPO definované, status page | M |

### 🎨 Epik 11 — Product/UX & onboarding (FORGE-11xx) · M1–M2 · P1

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 1101 | Onboarding wizard + interaktívny tour | „time to first app" < 5 min; skip možný | M |
| 1102 | Vzorové demo projekty (bez registrácie — playground) | visitor vyskúša pred signup (konverzia) | M |
| 1103 | Prázdne stavy + errory + skeletony (jednotný systém) | žiadny „dead end" v UI | S |
| 1104 | i18n SK/EN (celá UI vrátane editora) | prekladač, fallback EN | M |
| 1105 | Templatesá „app pre mňa": AI interview (3 otázky → návrh) | warm-up preplnenie promptu | M |
| 1106 | Notifikácie: e-mail (publish, limit, digest týždeň) | opt-in, unsubscribe | M |
| 1107 | PWA / mobilná podpora editora | /editor responzívne (sidebar na mobile dopracovať) | M |
| 1108 | Nápoveda/docs + AI asistent v dokumentácii | self-service podpora znižuje cost per user | M |

### 📊 Epik 12 — Analytics & operácie (FORGE-12xx) · M1+ · P1

| ID | Položka | Akceptačné kritériá | Odhad |
|---|---|---|---|
| 1201 | Produktová analytika (funnel: signup → 1. appka → publish → platba) | North Star: „publikované appky / týždeň" | M |
| 1202 | Interný dashboard: LLM costy per user/plán | margin > 70 % na Pro pláne | M |
| 1203 | Zákaznícke analytiky pre ich appky (opt-in) | Forge = analytics pre end-userov (pridaná hodnota) | M |
| 1204 | Support: ticketing + znalostná báza + SLA per plán | < 5 % ticketov na chybu AI | M |
| 1205 | Feedback: in-app návrhy + roadmap voting | prioritizácia podľa zákazníkov | S |

---

## 3. Prioritizácia (MoSCoW pre M1 — „o čo dnes zákazník platí")

**Must (M1):** 101–107, 201–202, 103, 301 (min. read-only explorer), 501–505, 508–510, 601, 605–606, 701, 703 (solo stačí), 801–806, 1001 (základ), 1005, 1101–1103, 1201–1202
**Should (M2):** 108, 204–206, 302–306, 401–405, 506–507, 602–604, 1104–1105
**Could (M3+):** 207, 303 branches/merge, 406–407, 901–903, 1203
**Won't (pre M1):** marketplace payouts (407), SSO (705), SOC2 (1006), affiliate (808)

## 4. Kritické riziká & závislosti

1. **LLM costy** — metering (106, 1202) musí byť v M1, inak sa dá Pro plán predávať so stratou.
2. **Sandbox bezpečnosť** (1001) — priamy predpoklad pre multi-tenant hosting; blokuje custom domény v M3.
3. **Kvalita AI výstupov** — bez eval setu (509) každa iterácia promptov = hazard retencie.
4. **Single-point dependency** na jedného providera → failover (101) v M1.
5. **Konkurencia** (Lovable, v0, Bolt) — diferenciácia: SK/EU lokalizácia, blueprínty pre vertikály (denné dostihy: kade, fitness, wellness), DPH/faktury podľa EU, data residency v EU.

## 5. Quick wins z existujúceho prototypu (dni, nie týždne)

- /editor: doplniť projekty na mobile (sidebar sa skrýva) — FORGE-1107
- Publish button v /editore prepojiť s reálnym publish flow (už je) + „Publikované" state perzistovať
- Export ZIP: nahrať mock ZIP aspoň so skutočným obsahom `index.html` (do 605)
- Konverzný CTA „Upgrade" → pricing sekcia (prázdna mapa plánov pred M1)
- Keyboard shortcut help overlay (?), command paleta (Ctrl+K)

## 6. Definition of Done — „MVP, za ktoré sa platí"

- [ ] Zákazník zaregistruje, popíše ideu, do 5 min má bežiacu appku na verejnej URL
- [ ] Zákazník uvidí vlastné dáta (DB) a login v appke funguje
- [ ] Platba kartou → Pro plán aktívny, faktúra s DPH stiahnuteľná
- [ ] Usage dashboard ukazuje spotrebu a limity plánu
- [ ] Chyba AI = čitateľná správa + retry, nielen spinner
- [ ] Rollback na predchádzajúcu verziu < 30 s
- [ ] Zrušenie predplatného self-service (GDPR-ready)
- [ ] Uptime publish pipeline > 99 % počas prvého mesiaca
---

## 7. M2 Build Prompt — Editor + blueprinty

> Prompt priamo na mieru z míľnika **M2**. Cieľ: jeden senior frontend engineer implementuje celý M2 do existujúceho single-file prototypu.

**Rola:** Si senior frontend engineer. Pracuješ v existujúcom single-file HTML prototype Forge AI Builder (Lovable klon). Doimplementuj celý míľnik M2 — Editor + blueprinty.

**Rozsah (5 vecí):**

1. **File explorer + editor** — záložka „Súbory" v `/editor` dashboardu: virtuálny VFS (index.html, styles.css, app.js, README.md) extrahovaný z jedného HTML snapshotu, Mono-like editor s číslami riadkov a syntax highlightom, editácia v textarea, uloženie (Ctrl+Enter) spätne skladá single-file HTML a prekreslí live preview.
2. **Git-like history** — záložka „History": commity = verzie (hash, HEAD badge, správa, +adds/−dels diff štatistika), akcie Obnoviť / Pozrieť / Diff, tvorba branch (`feature/xxxx`) a checkout.
3. **Blueprint galéria** — 6 blueprintov (SaaS Landing, Kanban, Settings, CRM Dashboard, Blog SaaS, E-shop Dashboard) s náhľadmi, stackom a časom generovania.
4. **Brand wizard** — klik na blueprint otvorí wizard: názov značky, primárna farba (color picker), jazyk UI (SK/EN); po potvrdení sa spustí generovanie s aplikovaným brandingom (premapovanie mien a farieb šablóny).
5. **Prompt knižnica** — 8 overených promptov (Build×2, Edit×2, Fix, Explain, Tests, SEO) so zástupnými `[zátvorkami]`; klik vloží prompt do composeru.

**Pravidlá:**

- Zachovaj všetky existujúce ID/API — test suite musí ostať zelená.
- Žiadne CDN závislosti, všetko inline v jednom súbore.
- Slovenské UI, dbg() log na každej akcii, respektuj CSS tokens a tmavú tému.
- Všetky zmeny responsive (mobil 390 px).
- V reťazcoch v JS vždy escapuj `</script>` ako `<\/script>`.

**Akceptačné kritériá:**

- Onboarding do 5 min: používateľ bez vygenerovaného projektu vie otvoriť každú záložku a niečo s ňou urobiť.
- Uloženie súboru sa prejaví v live preview bez reloadu.
- Blueprint wizard vygeneruje projekt s aplikovanou vlastnou značkou podľa vstupu.

**Stav: ✅ celý M2 implementovaný v prototype (8. 10. 2026)** — file explorer s VFS, editor so syntax highlightom, git-like history s branchmi, blueprint galéria s brand wizardom a prompt knižnica sú v workspace prototype hotové a otestované (syntax-check + smoke-test roundtrip VFS/brand; plná suite Ctrl+Shift+T v prehliadači).
---

## 8. M3 Build Prompt — Fullstack & data

> Prompt priamo na mieru z míľnika **M3**. Cieľ: jeden senior frontend engineer implementuje celý M3 do existujúceho single-file prototypu (nadväzuje na hotový M2 editor).

**Rola:** Si senior frontend engineer. Pracuješ v existujúcom single-file HTML prototype Forge AI Builder (Lovable klon, hotové M0–M2). Doimplementuj celý míľnik M3 — Fullstack & data.

**Rozsah (4 veci):**

1. **DB pre vygenerované appky** — nová záložka „Backend → DB" v `/editor`: per-projekt databáza (tabuľky podľa typu appky: `leads`/`tasks`/`profiles`/`orders` + `users`), schéma, data browser so záznamami, pridanie/odstránenie záznamu, počty riadkov.
2. **Auth pre end-userov** — „Backend → Auth": zapnutie/vypnutie auth per projekt, providery (E-mail/Google/GitHub), zoznam registrovaných end-userov, sessions metrika; zapnutie vloží login obrazovku priamo do live preview appky (jedným klikom vrátiť).
3. **Backend funkcie** — „Backend → Funkcie": serverless API endpointy per projekt (`GET/POST /api/…`), metóda, path, popis, latencia; „Testovať" vykoná mock volanie a odpoveď 200 vypíše do Console.
4. **Custom domény + SSL** — „Backend → Domény": pripojenie vlastnej domény (validácia formátu), DNS + Let's Encrypt wizard (3 kroky: A záznam → CNAME → cert), zoznam domén so SSL statusom, primárna doména, odobranie.

**Pravidlá:**

- Zachovaj všetky existujúce ID/API — test suite musí ostať zelená.
- Žiadne CDN závislosti, všetko inline v jednom súbore.
- Slovenské UI, dbg() log na každej akcii, respektuj CSS tokens a tmavú tému.
- Všetky zmeny responsive (mobil 390 px).
- V reťazcoch v JS vždy escapuj `</script>` ako `<\/script>`.
- Backend cache per snapshot ID (ako VFS), reset pri novom projekte.

**Akceptačné kritériá:**

- Každá zo 4 sekcií Backendu je použiteľná bez vygenerovaného projektu (prázdny stav) aj s projektom.
- Zapnutie auth preukázateľne zmení live preview (login obrazovka) a dá sa vypnúť.
- Test endpointu vypíše odpoveď do Console; pripojená doména má SSL status.
- DB záznamy sa dajú pridávať a mazať bez reloadu.

**Stav: ✅ celý M3 implementovaný v prototype (8. 10. 2026)** — DB data browser, end-user auth s login injekciou do preview, serverless funkcie s testovaním a custom domény s SSL wizardom sú v workspace prototype hotové a otestované (syntax-check + smoke-test; plná suite Ctrl+Shift+T v prehliadači).
---

## 9. M4 Build Prompt — Tímy & Business tier

> Z míľnika **M4**. Cieľ: jeden senior frontend engineer doimplementuje tímové funkcie do existujúceho single-file prototypu (nadväzuje na M0–M3).

**Rola:** Si senior frontend engineer v existujúcom single-file HTML prototype Forge AI Builder (hotové M0–M3). Doimplementuj míľnik M4 — Tímy & Business tier.

**Rozsah (5 vecí):**

1. **Realtime kolaborácia (demonštrácia)** — záložka „Tím" v `/editor`: online presence (avatary členov, live indikátor, simulovaní spolupracujúci), počet aktívnych editácií.
2. **Komentáre v preview** — komentárové piny priamo nad live preview v editore (klik na pin = thread), nový komentár s odpoveďou AI, resolve.
3. **Share linky** — generovanie zdieľacích liniek s oprávnením view / comment / edit a expiráciou (1 deň / 7 dní / 30 dní / neobmedzene), zoznam + revokácia.
4. **Seat billing** — Business plán: počet seats, pridanie/odobranie seatu s proration prepočtom (pro rata), cena per seat.
5. **RBAC** — roly owner / admin / editor / viewer, zmena roly klikom, pozvánka e-mailom (demo), akcie obmedzené rolou (viewer nemôže publish/export).

**Pravidlá:** zachovaj existujúce ID/API (test suite zelená), žiadne CDN, SK UI, dbg() na každej akcii, CSS tokens + tmavá téma, responsive 390 px, `</script>` v JS vždy ako `<\/script>`.

**Akceptačné kritériá:** každá z 5 vecí použiteľná bez projektu aj s projektom; koment pin je vizuálne ukotvený v preview a thread sa dá resolvnúť; share link sa dá vytvoriť aj revoknúť; zmena roly sa prejaví v audit logu (M5).

**Stav: ✅ celý M4 implementovaný v prototype (8. 10. 2026)** — tím so seatmi a RBAC, presence, komentáre v preview s AI odpoveďou, share linky s oprávnením a expiráciou. Nová záložka „👥 Tím" v `/editor`.

---

## 10. M5 Build Prompt — Enterprise & scale

> Z míľnika **M5**. Nadväzuje na M4 (tím + audit log sú základ).

**Rola:** Si senior frontend engineer v existujúcom single-file HTML prototype Forge AI Builder (hotové M0–M4). Doimplementuj míľnik M5 — Enterprise & scale.

**Rozsah (5 vecí):**

1. **Audit log** — neúprosný záznam akcií (kto čo kedy): zmeny rolí, share linky, publish, restore, auth toggle, domény, GDPR akcie; filtrovateľný zoznam v „Tím → Audit".
2. **SSO/SAML (Enterprise)** — prepínač SSO s flow (SAML metadata, enforced SSO), Okta/Entra zmienka, gate na pláne.
3. **Compliance (GDPR/SOC2 cesta)** — GDPR export dát (JSON download) a mazanie účtu s grace period (soft-delete 30 dní), SOC2 „v programe" badge, DPA odkaz.
4. **SLA** — Enterprise SLA 99,9 % status, uptime indicator, support priority.
5. **Rate limiting** — usage meter (generácie vs. limit plánu), soft limit + upozornenie pred tvrdou stenou, hlavička „transparentná spotreba".

**Pravidlá:** ako v predchádzajúcich promtoch — ID/API, zelené testy, žiadne CDN, SK UI, dbg(), tokens, responsive, `<\/script>`.

**Akceptačné kritériá:** audit log zachytáva reálne akcie z M4 (rola, share, publish); GDPR export vráti platný JSON; rate meter ukazuje spotrebu; SSO toggle preukázateľne mení stav a zapisuje do auditu.

**Stav: ✅ celý M5 implementovaný v prototype (8. 10. 2026)** — audit log napojený na tímové akcie, SSO/SAML, GDPR export + soft-delete, SLA status a rate limiting meter v „Tím → Audit & Compliance".

---

## 11. M6 Build Prompt — Ekosystém

> Z míľnika **M6**. Viralita: galéria, marketplace, remix, affiliate.

**Rola:** Si senior frontend engineer v existujúcom single-file HTML prototype Forge AI Builder (hotové M0–M5). Doimplementuj míľnik M6 — Ekosystém.

**Rozsah (5 vecí):**

1. **Komunitná galéria** — záložka „Galéria" v `/editor`: publikované blueprinty od komunity s autorom, lajkami, remix počtom, tagmi, „trending" badge, filtrovacie chipy, moderácia publishu (vlastný projekt → galéria).
2. **Marketplace blueprintov** — platené blueprinty s cenou, kúpa (checkout flow) → odomknutie remixu, revenue share 80/20.
3. **Remix** — klik na „Remix" skopíruje blueprint do môjho účtu ako nový projekt (spustí generáciu so šablónou daného typu).
4. **Affiliate** — referral link (forge.app/r/xx) s počtom klikov/konverzií a províziou 20 % / 12 mesiacov, copy to clipboard.
5. **Template contest** — aktívny súťažný template s hlasovaním (1 hlas per účet), leaderboard submitted šablón.

**Pravidlá:** ako v predchádzajúcich promtoch — ID/API, zelené testy, žiadne CDN, SK UI, dbg(), tokens, responsive, `<\/script>`.

**Akceptačné kritériá:** galéria sa dá filtrovať; platený remix vyžaduje kúpu a po nej funguje; remix reálne spustí generáciu; affiliate link sa dá skopírovať; hlas sa započíta len raz.

**Stav: ✅ celý M6 implementovaný v prototype (8. 10. 2026)** — komunitná galéria s filtrami, moderáciou a trending, marketplace s checkout flow, remix, affiliate panel aj template contest s hlasovaním. Nová záložka „🌐 Galéria" v `/editor`.
