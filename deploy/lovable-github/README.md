# Lovable AI + GitHub — lokálne pripravený overlay

WS-17 opravuje hlavný frontend v `source`, nie súbory tohto overlay. Jeho 68
hashov zostáva zhodných s lokálnym Lovable mirrorom; 146 UI testov nižšie je
historický výsledok WS-16, ktorý sa v tejto fáze neopakoval. Aktuálne main/PG
kontroly a browser dôkazy sú v `proof/MAIN-CODE-EDITOR-VERIFICATION.json` a hlavnom
`docs/WS-17-MAIN-CODE-EDITOR.md`. Hosted projekt a kredity sa nemenili.

Najnovšie WS-16: CodeMirror, strom/add/rename/delete a UTF-8 import/drop, owner-
local koncepty, immutable ručné verzie a reálna kompilácia s inline chybami.
146 UI testov, 87 PostgreSQL scenárov na každej z verzií 16.15/18.6 a browser
desktop/mobile. Balík má 49 zdrojových/unit, 17 QA a 2 package súbory (68 hashov).
Pribudli CodeMirror dependencies; pred prenesením zlúčiť s prípadnými novšími
hosted package súbormi. Detaily v hlavnom `docs/WS-16-FILE-EDITOR.md`.

Prírastok WS-15: skutočný ZIP aktuálnej alebo historickej verzie, bez chatu,
s presným README/`.gitignore`, kontrolou celého archívu a mobilným dialógom.
Overené reálne browser downloady aj rozbalenie/build 12 pribalených šablón.
Balík má 45 zdrojových/unit súborov, 17 QA súborov a `package.json`/`bun.lock`
(64 hashov). Pribudla iba priama závislosť JSZip 3.10.2; existujúce uzamknuté
balíčky sa nezmenili. Novšie hosted package súbory pri budúcom prenose zachovať
a zlúčiť dependency zmenu. Detaily v hlavnom `docs/WS-15-ZIP-EXPORT.md`.

Zdroj: samostatná pracovná kópia `../lovable-github-local` vedľa hlavného repo.
Pôvodný kontrolovaný Lovable export `../lovable-hybrid-20261106` zostal zachovaný.
Tento balík nie je nahraný do Lovable ani nasadený. Neobsahuje `.env`, tajomstvá,
databázové migrácie, generované integrácie alebo ručne upravený routeTree.

WS-14 dopĺňa skutočný Hono AI workspace: serverový katalóg/výber modelu,
SSE otázky a návrhy, diff pred schválením, immutable históriu, kompiláciu,
Hono projekty s CAS a owner-scoped IndexedDB obnovu rozpracovanej práce.
Mobile review je kompaktnejší, téma zostáva zachovaná. V tejto fáze mal overlay
41 zdrojových/unit a 17 fixture súborov (58 hashov). Podrobnosti a limity:
`docs/WS-14-LOVABLE-AI.md` v hlavnom repozitári. Hosted verzia sa nezmenila.

GitHub časť: decentná karta v existujúcom sidebare, stav/retry/pripojenie/
potvrdené odpojenie, callback `/github/callback`, serverová route a BFF jadro.
Callback hneď odstráni code/state z browser adresy; výmenu spustí používateľ.
Na callbacku sa nelogujú prihlasovacie údaje a nie je pridaná analytika.
Pred živým použitím treba overiť aj redakciu query parametrov v hosting logoch.

Overenie lokálnej pracovnej kópie: 146/146 testov (36 pôvodných + 110 pridaných),
TypeScript, cielený ESLint a build klienta, SSR aj Workers. Serverové bridge
markery a názvy infra Secrets sa nenašli vo verejných klientskych assetoch.
Vizuálna kontrola lokálnej fixture v IAB prešla na desktope aj mobile 390×844:
dlhý username sa zalomí, dokument nepretečie horizontálne, callback sa zmestí
a odstráni query parametre. Overené aj obnovenie kontroly s vypnutým súhlasom
a terminálny stav zrušenej prípravy. Opravený mobilný panel používa existujúci Sheet:
fokus vstúpi do dialógu, Shift+Tab ho udrží vnútri a Escape vráti fokus na
„Projekty“. Chybový/retry stav bol viditeľný; úspešné zotavenie pokrýva unit test.
Screenshoty testovacích dát sú v `proof/`. Nejde o živý GitHub súhlas alebo
overenie hostovanej aplikácie. Lokálna fixture je v `lovable-github-local/qa/github`;
spustenie: `vite --config qa/github/vite.config.ts` z tejto pracovnej kópie.
`MANIFEST.json` obsahuje SHA-256 prenášaných súborov.

## Pred zapojením

Reálny PostgreSQL súbeh už je overený lokálne: 87/87 testov prešlo na PostgreSQL
16.15 aj 18.6. Dočasné clustre používali SCRAM a loopback, produkčný `.env` sa
nečítal a po teste boli zastavené/odstránené. Logy sú v `proof/`. Runner
`deploy/test-projects-native.py` prijíma dôveryhodné lokálne PostgreSQL binárky;
nič nesťahuje. Toto nenahrádza živé nasadenie alebo GitHub súhlas.

1. Lokálne migrácie 001–009 a súbeh sú overené. Pred nasadením pripraviť kontrolu
   a rollback nad aktuálnou DB schémou; potom overiť živý Cloud → Hono bridge
   a account binding. Produkčné dáta sa týmto balíkom nemenia.
2. Pripraviť samostatnú OAuth konfiguráciu pre tento flow. Aktuálny produkčný
   callback legacy aplikácie nemeniť. Vybrať jednu pevnú HTTPS doménu a callback
   `https://<doména>/github/callback`; BFF neprijíma iný origin automaticky.
3. Na Hono použiť predvolene vypnuté `GITHUB_CLOUD_ENABLED` a samostatné
   `GITHUB_CLOUD_EXPORT_ENABLED`, pevný Cloud issuer a konfiguráciu z
   `server/.env.example`. Startup má runtime factory a kontrolu schémy;
   postup je v `docs/GITHUB-ACTIVATION.md`. Vyžaduje samostatný
   32-bajtový encryption key a iný náhodný bridge secret, nikdy do klienta.
4. V Lovable serverových Secrets potrebuje route existujúce `SUPABASE_URL`,
   `SUPABASE_PUBLISHABLE_KEY`, `HONO_BASE_URL`, prípadné `HONO_BASIC_AUTH` a nové
   `GITHUB_BRIDGE_SECRET`, `GITHUB_CLOUD_CLIENT_ID`, `GITHUB_CLOUD_CALLBACK_URL`.
   Žiadna hodnota nepatrí do VITE_ premenných alebo chatu. Názvy sú iba kontrakt;
   nové Secrets zatiaľ neboli vytvorené ani nakonfigurované.
5. Až keď bude povolený hosted build pri zachovaní rezervy 30 kreditov, preniesť
   overlay cez autorizovaný editor/sync, nechať router vygenerovať routeTree
   a overiť login → GitHub súhlas → callback → stav → odpojenie. Nie je potrebná
   žiadna zmena Supabase schémy alebo generovaných integrácií.

Výmena tokenu ani GitHub súhlas nie sú odosielané automaticky pri otvorení
stránky. UI pracuje iba s rovnakým účtom a ignoruje jeho staršie odpovede.
Balík už obsahuje exportný dialóg pre skutočné uložené projekty a historické
verzie: kontrola mena verejného cieľa, verzie a súborov; vypnutý súhlas pred
potvrdením; výsledok a opätovné čítanie stavu po timeoute. Session storage drží
len UUID oddelene podľa app účtu. Obnovené výsledky ukazujú pôvodný GitHub účet.
BFF exportné POST akcie sú `export/prepare`, `export/confirm`, `export/status`,
`export/review`, `export/cancel`, `export/reconcile`. Obnovená kontrola overuje pôvodné zdroje aj
GitHub prepojenie a vyžaduje čerstvý súhlas. Zrušenie prípravy prebehne na serveri;
iba zrušený/vypršaný návrh uvoľní názov, jeho UUID sa nikdy znovu neaktivuje.
Neprenášajú zdroje z browsera do writeru; Hono ich načíta z vlastnej DB.
Serverový writer aj ledger sú v hlavnom Hono repozitári, nie v tomto UI balíku.
Pri running/failed sa dá výslovne overiť už vykonaný zápis cez GitHub GET.
Server kontroluje uložený checkpoint, repo/owner ID, branch/commit/tree a bloby;
pri zhode obnoví výsledok bez nového zápisu. Známy čiastočne vytvorený repozitár
má odkaz na ručnú kontrolu. BFF reconcile deadline je 35s, serverový reader 20s.
Pre running/failed/succeeded zostáva názov rezervovaný. Chýbajúci checkpoint,
neskoršia zmena vetvy alebo účtu a retencia ledgeru vyžadujú operátorský postup.
Živé konto ani repozitár sa zatiaľ nevytvorili.


Lokálny storage prírastok pridáva do generickej Hono proxy iba GET
`/api/project-storage`. Query vrátane owner a mutácie sú odmietnuté; test je
súčasťou balíka. Meter kapacity a správa pri prekročení sú implementované v
hlavnom projekte `source/src/features/projects/ProjectLibrary.tsx`; tento overlay
ich do samostatného Lovable rozhrania nepridáva. Žiadne hosted Secrets ani
kapacita kreditov sa touto prípravou nemenia.


Panel pripojenia teraz zobrazuje validovaný mesačný limit AI z existujúceho
`auth/me`. Neúplný usage nie je prezentovaný ako nula a ľubovoľné HTTP 200 JSON
nie je platným účtom. Pri zmene Cloud účtu sa stará kvóta skryje okamžite.
Prešlo upozornenie 8/10, vyčerpanie 10/10 a prepnutie na samostatný účet 0/200,
na desktope aj 390px mobile. Fixture s výhradne syntetickými dátami je v
`../lovable-github-local/qa/quota`; spúšťa sa `vite --config qa/quota/vite.config.ts`
a otvorí sa `/qa/quota/index.html`. Nie je to živé Cloud → Hono prepojenie.
V tejto historickej quota fáze mal balík 22 zdrojových/unit súborov a 5 súborov
vizuálnej fixture; aktuálne WS-14 počty sú uvedené hore. Pôvodný export zostáva zachovaný.

Najnovšie celkové výsledky: 891 passed/109 skipped main, 146/146 Lovable UI,
TypeScript/buildy a hlavný lint 0 chýb/34 existujúcich upozornení; nové UI čisté.
Staršie čísla sa vzťahujú na označené fázy. Autoritatívny lokálny receipt
a SHA-256 logov sú v `proof/LOCAL-VERIFICATION.json`.


WS-7 pridáva fixed GET `ai-usage` do existujúcej Hono proxy a validovaný
read-only report tokenov do rovnakého connection panela. Report rozlišuje známe
aj neznáme volania; nikdy nemení neznámu spotrebu na nulu. Stav patrí aktuálnemu
Cloud používateľovi a oneskorené odpovede sa ignorujú. Panel sa dá rolovať na
mobile. Backend vyžaduje migráciu 008; UI aj bez nej zobrazí bezpečný unavailable
stav a projekty neblokuje. Nejde o fakturáciu alebo náklady v eurách. Screenshoty
`proof/ai-usage-*.png` a `AI-USAGE-VERIFICATION.json` dokumentujú iba lokálne
syntetické overenie. Detaily a otvorené požiadavky: `docs/WS-7-AI-USAGE.md`.


WS-8 nemení Lovable zdroje ani overlay (rovnakých 27 hashov); pridáva backendové
snapshoty odhadovaných nákladov, read-only operátorský report a samostatný lokálny
HTML dashboard. Tieto finančné údaje sa neposielajú zákazníckym API ani do
Lovable. Nový backend vyžaduje migráciu 009 aj bez aktívneho cenníka. Native PG
teraz prešiel 68/68 na oboch verziách; detail/limity sú v `docs/WS-8-AI-COSTS.md`.
Ukážka `proof/ai-cost-dashboard-fixture.html` obsahuje iba syntetické údaje,
nie živé ceny alebo finančné dáta. Žiadne hosted kredity sa nečerpali.


Historický stav WS-9: iba pevná GET proxy `/api/ai-models` s unit overením. Skutočný výber
providera a failover UI patrí do hlavného Hono frontendu. TopBar/generovanie
v tomto Lovable exporte zostávajú demo; živé AI prepojenie týmto balíkom nevzniká.
Lokálne 68/68 UI testov, TypeScript, cielený lint a client/SSR/Workers build.

WS-14 tento lokálny demo AI tok nahradil reálnym Hono transportom a projektovým
controllerom. Hosted AI zostáva neoverené. Browser fixture `qa/hybrid` používa
dočasné podpísané identity a companion `tests/fixtures/hybridAiUiServer.ts` z
hlavného projektu; overuje skutočný backend/compile tok bez živého LLM.
Screenshoty `proof/hybrid-ai-*.jpg` a nový
`proof/AI-LOVABLE-WORKSPACE-VERIFICATION.json` zachytávajú výsledky a hranice.
