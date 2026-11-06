# WS-14 — Lovable rozhranie pripojené na Hono

Lokálna pracovná kópia Lovable už používa skutočný Hono kontrakt pre AI,
kompiláciu a projekty. Prenosný overlay je v `deploy/lovable-github`; obsahuje
41 zdrojových/unit súborov a 17 súborov vizuálnych fixture. Hostovaný Lovable
projekt tieto zmeny ešte neobsahuje. Nebol spustený hosted build ani čerpanie
kreditov; požadovaná rezerva 30 kreditov zostáva podmienkou ďalšieho nasadenia.

## Výsledné správanie

- Výber modelu číta serverový katalóg. Request používa vybraný model a iba
  výslovne odsúhlasené záložné modely. Zmena modelu, katalógu alebo účtu resetuje
  súhlas s fallbackom.
- Chat posiela úplný aktuálny kód, históriu a konverzáciu cez rovnaký origin do
  existujúcej serverovej proxy. Auto režim rozlišuje otázku od zmeny. Odpoveď na
  otázku streamuje text bez nového snapshotu alebo kompilácie. Cancel ruší request.
- Návrh súborov zostáva oddelený od projektu. UI ukazuje skutočný diff vrátane
  presných source-bound patchov z WS-12. Až schválenie vytvorí nový immutable
  snapshot. Odmietnutie alebo zastaraný návrh nemení zdroje.
- Náhľad používa skutočný compile endpoint; iframe má sandbox bez same-origin
  oprávnenia. Kód, diff, konzola a história zobrazujú aktuálny projekt. Obnovenie
  verzie používa jej uložené zdroje a opätovnú kompiláciu.
- Editor číta zoznam projektov z Hono, otvorí ich a ukladá s `expectedRevision`.
  CAS konflikt zachová lokálnu prácu a umožní uložiť samostatnú kópiu.
- IndexedDB uchováva zdroje, verzie a konverzáciu oddelene podľa Cloud účtu.
  Lokálne kópie sú dostupné v editore. Otvorenie serverovej verzie s rovnakým ID
  najprv zachová rozpracovanú zmenu ako samostatnú lokálnu kópiu. Zlyhanie zápisu
  blokuje prepnutie, ktoré by stratilo neuložené dáta. Toto nie je serverová záloha.
- Prepnutie účtu synchrónne vymení celý workspace; oneskorená odpoveď starého
  účtu sa nepoužije. Transport po asynchrónnom načítaní relácie znovu overuje
  očakávané user ID. Starý controller tak neodošle zdroje s tokenom nového účtu.

Zachovaná je existujúca téma a komponenty. Mobilná kontrola zmien má kompaktnejší
chat a čitateľné schválenie; pribudla tmavá schéma natívnych ovládačov. Nejde o
redizajn. ZIP/publish na TopBare a blueprint galéria zostávajú označené demo.
GitHub používa samostatný už pripravený BFF/exportný flow.

## Identita a serverová autorita

Browser načíta používateľský token cez existujúci Cloud SDK; tento krok neurčuje
oprávnenia. Serverová route naďalej overuje reláciu cez `getUser`, zostavuje vlastné
hlavičky a povoľuje iba pevné cesty. Hono nezávisle overuje JWT a explicitnú
identity väzbu, vlastníka, plán aj CAS. Nemenili sa generované integrácie, Cloud
DDL, Secrets ani produkčné prostredie. Provider kľúče a infra credentials sa
neposielajú klientovi. Zdrojovú autoritu má Hono, nie Cloud databáza ani IndexedDB.

React provider má samostatný kontext a riadený životný cyklus aj pri StrictMode
effect replay. Skutočné odpojenie preruší prácu. SSR a prvé prihlásenie nevyvolajú
platené generovanie; generovanie spúšťa používateľ.

## Overenie a jeho hranice

| Kontrola | Výsledok |
|---|---|
| Hlavná lokálna suite | 851 passed / 108 skipped; platený live smoke vylúčený |
| Lovable pracovná kópia | 86/86 testov v 11 súboroch |
| PostgreSQL 16.15 | 86/86 scenárov, cluster zastavený a odstránený |
| PostgreSQL 18.6 | 86/86 scenárov, cluster zastavený a odstránený |
| TypeScript | hlavný, strict native/CLI graf aj Lovable prešli |
| Build | hlavný frontend aj Lovable klient/SSR/Workers prešli |
| ESLint | hlavný 0 chýb / 40 existujúcich warnings; nové Lovable súbory čisté |
| Prenos | 58 overlay/mirror hashov zhodných; 10 pôvodných exportných hashov zachovaných |

Nové native scenáre používajú priamo controller z prenosného overlay, skutočne
podpísaný dočasný ES256 token, serverovú proxy, Hono a reálny PostgreSQL. Overujú
otázku bez mutácie, presný patch, schválenie, kompiláciu, uloženie/reopen verzií
aj chatu; ďalej CAS konflikt, kópiu, cudzieho ownera a odobratie identity väzby.
Usage je durable: otázka a zmena tvoria dve mesačné úlohy a päť meraných volaní.

Browser test na desktope 1280×720 a mobile 390×844 používa rovnakú aplikáciu,
transport a backend s pg-mem. Iba Cloud session a provider odpoveď sú syntetické;
kompilácia React projektu je skutočná. Overené:

1. Pôvodný päťsúborový projekt: hlavné tlačidlo modré `rgb(37,99,235)` a vedľajšie
   sivé `rgb(100,116,139)`. Otázka zdroje nemení.
2. Diff upraví jediný CSS riadok (+1/−1). Do schválenia zostáva modrá; po
   schválení a kompilácii je hlavné tlačidlo červené `rgb(220,38,38)`, sivé sa nemení.
3. Server save revízie 2, refresh IndexedDB a reopen zachovajú oba snapshoty aj chat.
4. Bob nevidí Alice projekt, iframe ani lokálne kópie. Návrat Alice obnoví jej prácu.
5. Otvorenie servera s rozpracovaným názvom zachová samostatnú lokálnu kópiu,
   ktorú možno znovu otvoriť a skompilovať.
6. Obnova v1, ďalší návrh a jeho odmietnutie zachovajú modrú aj počet verzií;
   obnova v2 vráti červenú. Konečný fixture meter má 3 úlohy, 8 volaní a 405
   syntetických tokenov. Pred opakovaním mal 2 úlohy, 5 volaní a 250 tokenov.

Počas prípravy fixture bol opravený chýbajúci QueryClient, konštrukcia Node Request
a HMR/context problém. Finálne studené desktopové/mobilné relácie nemali browser
warnings/errors ani horizontálne pretečenie. Dočasné karty boli zatvorené,
viewport obnovený a vlastné servery 5191/8789 zastavené.

Nejde o overenie kvality/latencie živého LLM alebo produkčnej izolácie: fixture
používa dôveryhodný lokálny HostExecutor. Provider kľúče pri testoch boli prázdne.
Screenshoty, SHA-256 logov a presný rozsah sú v
`deploy/lovable-github/proof/AI-LOVABLE-WORKSPACE-VERIFICATION.json`.

## Opakovanie lokálnej browser kontroly

Zo `source` spustiť s lokálnym Node v PATH:

```sh
HYBRID_AI_UI_FIXTURE=1 NODE_ENV=test MISTRAL_API_KEY= OPENAI_API_KEY= ANTHROPIC_API_KEY= node --import tsx tests/fixtures/hybridAiUiServer.ts
```

V druhom termináli z `../lovable-github-local`:

```sh
node node_modules/vite/bin/vite.js --config qa/hybrid/vite.config.ts
```

Otvoriť `http://localhost:5191/qa/hybrid/index.html`. Fixture poskytuje iba
dočasné testovacie identity na loopbacku; nespúšťať ju ako produkčnú službu.

## Otvorené položky

FORGE-101/102/103/104/107 a projektový tok sú rozšírené aj do lokálneho Lovable
rozhrania; akceptačné kritériá celého M1 tým nie sú dokončené. Zostáva autorizované
hosted prenesenie pri kreditovej rezerve, nasadenie Hono/migrácií, serverové
Secrets, explicitná väzba skutočnej Cloud identity a živý end-to-end test.
Ďalej živé evaly kvality/latencie, export ZIP/publish, billing aplikácie, fullstack
runtime, prílohy/vision a zvyšok M1–M6. Nebol vytvorený commit ani deploy.

Stripe CLI/MCP je samostatný nástroj agenta, nie implementácia billing backlogu.
Používateľ schválil sandbox Eab-EU s.r.o. s oprávnením Read. OAuth login prešiel
a lokálna konfigurácia hlási `o_auth`; tento bežiaci chat zatiaľ neponúka Stripe
MCP volateľné nástroje, preto samotné MCP API volanie ešte nie je overené.
