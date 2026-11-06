# 🔥 Forge — kompletný backlog

**Aktualizované:** 6. 11. 2026 po kontrolovaných VPS krokoch: schéma **001–013**, autentifikovaný runner so skutočným compile/cleanup a nové loopback API majú **PASS v režime STAGED**. Produkčný proxy zostáva na starom porte 8787 a Basic ochrana sa nemenila; služby majú `restart=no`, nejde o produkčnú HA. Aplikácia nie je kompletne prepojená cez Cloud/BFF.
**Základ WS-19:** merge PR #21 · `fce375d05921da665fbdb8a93830937c71df8c38`; `7f2b923` a [pôvodný dôkaz](../deploy/lovable-github/proof/PUBLISH-BILLING-VERIFICATION.json) sú historický stav pred review. **Posledné úplné review overenie (historické, pred fázou 013):** runtime `9e49e0e2ecdc004215d926ebfdc30171bc3bc2a2`, docs head `5ef32af` · [zachovaný dôkaz](../deploy/lovable-github/proof/PR22-REVIEW-FIXES.json). **Aktuálna infra:** [samostatný dôkaz](../deploy/lovable-github/proof/WS19-INFRASTRUCTURE.json).
**Historický recovery cut runtime `186eba1` (pred merge PR #22):** **1 115 passed / 189 skipped main**, **167/167 PostgreSQL16 aj18** s cleanup, **21/21 Docker**, **188/188 moderné UI**, hlavné/strict typy, lint a oba lokálne buildy PASS · [nový dôkaz](../deploy/lovable-github/proof/PR22-RECOVERY-VERIFICATION.json). V tomto cute bol backend PR #22 ešte otvorený; aktuálne je zlúčený v `494cd434` podľa postops dodatku nižšie. Frontend [PR#3](https://github.com/erikbabcan-commits/vorkeeei/pull/3) je **MERGED `676b8bd`** a jeho Git push/merge je overený v histórii Lovable editora (21:15:16 UTC). Kanonická verejná verzia nebola znovu publikovaná.
**Aktuálny read-isolation addendum:** runtime `d9b279b56f370982b69b43a51827121564c3d52d` má **1 117 passed / 189 skipped main**, **167/167 natívne PG16 aj18** s cleanup, **21/21 Docker**, typy/build/lint PASS (0 chýb / 33 existujúcich upozornení), 301 nezmenených source witnesses počas všetkých siedmich brán. Anonymné čítania majú vlastnú bounded kapacitu. [Vykonateľný offline runbook](WS-19-PUBLISH-BILLING.md#publish-storage-recovery) má 10/10 syntetických filesystem kontrol vrátane odmietnutia optimalizovaného Pythonu a 20/20 CAS kontrol na dočasných PG16/18; na VPS sa nevykonal. Všetky pokusy/UUID ostávajú bez mazania; automatická retencia je otvorená. Pôvodné recovery dôkazy zostávajú zachované; 188 moderného UI je historický výsledok pre nezmenené zdroje. [Nový dôkaz](../deploy/lovable-github/proof/PR22-READ-ISOLATION-VERIFICATION.json). Produkčná aktivácia zostáva otvorená.
**Aktuálny postops cut:** backend PR#22 je zlúčený v `494cd434` (strom zhodný s overeným `842b8f7`, runtime `d9b279b`, 301 source SHA bez zmeny); frontend main `676b8bd` je potvrdený históriou Lovable editora. Obe main sú čisté a vlastné zlúčené pracovné vetvy boli zmazané bežným postupom bez force. Owner dry-run prešiel s **0 zápismi**; owner apply automatická kontrola schválenia odmietla **pred spustením**, pretože vytvorenie trvalého auth účtu a nemennej identity väzby potrebuje konkrétny súhlas používateľa. Owner väzba a Cloud Basic transport čakajú na konkrétne schválenie/manuálny vstup. Finálny read-only audit 21:37:58 UTC potvrdil healthy API, anonymné `/api/auth/me`→401, zachovaný starý proxy/Basic a TLS root 404 bez cookies; 16 bežiacich kontajnerov je 14 pôvodných + 2 nové STAGED, rootless workerov po compile 0. Nevznikol syntetický projekt ani publish job; verejné artifact HTTP200, celý Cloud/BFF workflow, Stripe platba a kanonický verejný republish nie sú overené. [Samostatný sanitizovaný ops dôkaz](../deploy/lovable-github/proof/WS19-STAGED-OPERATIONS-2026-11-06.json). Všetky míľniky zostávajú otvorené.
**Mobilná hlavička:** opravené orezanie ovládania pri úzkom displeji; lokálny browser overil 320/390/767/1280 CSS px bez prekročenia okraja a dostupné premenovanie. 188 UI testov a lokálny build PASS. Oprava je v frontend Git main `f5d6628`; hostovaný render tejto malej úpravy sa ešte neoveril; [dôkaz](../deploy/lovable-github/proof/MOBILE-TOPBAR-VERIFICATION.json).
**Cieľ:** plnohodnotný AI editor s reálnym hostingom a plateným predplatným.
**Stav:** lokálne overený pilot a nové UI v hostovanom live preview; žiadny z míľnikov M1–M6 nie je uzavretý.
**Cieľ je znovu aktívny:** pokračujeme podľa pôvodného backlogu. Aktuálna priorita je
dokončiť živé Cloud → Hono prepojenie a WS-19 aktiváciu; lokálne testy ani UI prenos
nenahrádzajú prvý úplný produkčný workflow.

---

## 0. Aktuálny stav

### Implementované a zostávajúce časti

| Oblasť | Čo je implementované a overené | Čo zostáva otvorené |
|---|---|---|
| AI engine | Mistral/OpenAI/Anthropic adaptéry, výber modelu, SSE, cancel, ohraničený retry/failover, intent a správa kontextu | Živá kvalita, latencia a presnosť na eval sete; finálne prevádzkové zapnutie |
| AI zmeny a história | Source-bound patche, skutočný diff, schválenie do nemennej verzie, restore a build-error repair | Živé regresné evaly, plnohodnotné branches/merge a produkčný publish |
| Šablóny | 12 React/TypeScript štartovacích projektov, branding, wizard a kontrola zdrojov pred použitím | Fullstack blueprinty s reálnou DB/auth, širšie parametre a komunitné funkcie |
| Súborový editor | Lokálne overené CodeMirror, koncepty, ručné verzie a textové CRUD/import/drop; produkčný kód je prenesený do Lovable editora | Sémantický TS/lint/format, binárne prílohy a úplné živé overenie editora; verejná aktualizácia zatiaľ neprebehla |
| Projekty a kvóty | Účtovo oddelená IndexedDB, ručný serverový save/open, CAS, nemenná história, 30-dňový kôš/obnova, kapacitné a AI limity | Automatický sync, fyzická retencia, potvrdený legacy import, tímy a RBAC |
| ZIP a GitHub | Skutočný ZIP aktuálnej/historickej verzie; lokálny Cloud GitHub BFF, prepare/confirm, ledger a read-only obnova výsledku | Aktivácia nového hostovaného Cloud toku a skutočný export aplikáciou do GitHubu |
| Billing | Default OFF; explicitný test/live režim s DB pinom, podpísané webhooky, idempotencia, čerstvé DB oprávnenia; Cloud billing BFF a moderný panel | Aktivácia a živé overenie nového toku, skutočné Stripe nastavenie/platba, operátorské reconciliation CLI, dane/faktúry a dunning/refundy |
| Sandbox a publish | Compile-only izolácia; obe UI používajú skutočný statický publish job zo serverového snapshotu do nemenného HTML na oddelenom verejnom listeneri; lokálne HTTP 200 a samostatný TLS sslip.io vstup overené | Produkčná promócia hostingu, CDN/custom domains, retencia a rollback; fullstack runtime, HMR, ľubovoľné npm balíčky a produkčná tenant izolácia |
| Auth | Cookie auth a Cloud Google prihlásenie majú implementované/overené čiastkové toky | Kompletné email verify/reset flow, nasadenie nového hybridu, organizácie a 2FA aplikácie |
| Prevádzka | Restore-verified záloha; schéma 001–013 a štrukturálny postcheck PASS. Vlastný rootless worker, autentifikovaný runner so skutočným compile/cleanup a loopback API sú overené v STAGED režime; TLS root 404 bez Basic/cookies a zachovaný proxy 8787/Basic | Cloud owner binding a Basic transport so špecifickým schválením, riadená produkčná promócia/upstream a plný Cloud E2E; service autostart/obnova, skutočný ACME renewal test, DR/SLA. STAGED služby majú restart=no |

Hlavný React frontend v `src/` a moderný Lovable frontend sa spúšťajú samostatne.
Lokálny moderný mirror je v `../lovable-github-local`; prenosný balík je
[`deploy/lovable-github`](../deploy/lovable-github/README.md).
Spustenie koreňového Vite projektu samo neotvára nové Lovable UI. Moderný frontend
je synchronizovaný cez privátny `erikbabcan-commits/vorkeeei`; nové live preview je
overiteľné, verejný `https://vorkeeei.lovable.app/` ešte nebol aktualizovaný. Cloud →
Hono tok stále vyžaduje serverový Basic transport, identity binding a živé overenie.

### Aktuálna infra — rootless worker a TLS, bez nového aplikačného deploymentu

Vlastný rootless Docker daemon na VPS je skutočne READY (technický UID 987,
overlay2/systemd/cgroupv2). Jeho slice má 640 MiB pamäte, 0 swap, 0,75 CPU a
limit 512 úloh. Reviewed inštalátor prešiel 79 guard kontrolami; globálny Docker
ostal nezmenený. Nie je to nové API ani pripojený Hono runner.

Do tohto daemona bol načítaný iba overený worker. Target engine uvádza config
digest `b6272b9d…`; layer DiffID kontrola ho mapuje na lokálny manifest `68307ef2…`.
Nejde o tvrdenie, že lokálne obrazy API/runner runtime `9e49e0e` už bežia na VPS.
Skutočná fixture overila kernel limity 256 MiB/0,5 CPU/pids 128, 0 capabilities,
no-new-privileges, seccomp, read-only root, samostatnú sieť bez IPv4 routes a
32 MiB tmpfs s noexec/nosuid/nodev. Mapovanie požadovaného UID 65532 bolo overené.
React compile marker prešiel a vlastná fixture sa odstránila. Výsledok preverila
prísna Python kontrola formátu/limitov; nejde o nový celý Hono Publish workflow
ani o vyvolanie TypeScript `parseBuildResult` v tejto VPS fixture.
Po tomto kroku bolo nameraných **3 354 742 784 B voľného disku** a
**1 045 778 432 B dostupnej pamäte**. Staré API na porte 8787 aj globálny daemon
ostali nezmenené; databáza a schema sa týmto worker krokom nemenili.

Oddelený HTTPS vstup `published.2.29.52.59.sslip.io` má vydaný certifikát.
Nezávislé externé pozorovanie potvrdilo jediný očakávaný SAN a platnosť do
**4. 2. 2027 19:25:04 GMT**. Externý výsledok bol následne zapísaný; presný čas samotnej kontroly nebol samostatne zachytený. Root odpovedá 404 bez Basic challenge a bez cookies;
to ešte nie je publikovaný artefakt s HTTP 200. Aplikačný listener zatiaľ nebeží.
Existujúci Lov web ani API/Docker sa TLS krokom nemenili. Inštalátor mal 25 guard
kontrol. Vlastný obnovovací hook je nainštalovaný a chráni presnú publish
lineage; lokálne prešlo 31 guard kontrol. Skutočne spustené guard dry-runy
nainštalovaného hooku pre vlastnú, existujúcu aplikačnú a prázdnu lineage prešli
s **0 príkazmi Nginx**. Certbot timer je **enabled/active**, ďalší beh má
**7. 11. 2026 09:07:41 UTC**. Renewal konfigurácia zostala nezmenená.
**Skutočný ACME renewal nebol testovaný**; konfigurácia, dispatch guard a timer
nepreukazujú vydanie ani servovanie nového obnoveného certifikátu.

Nový Basic transport účet **nebol vytvorený**; jeho výslovné schválenie ešte
chýba. Produkčné migrácie 002–012 stále chýbajú; nová storage fáza 013 je
lokálne commitnutá a overená, na produkčnej DB tiež nie je aplikovaná. Nové aplikačné runtime ani billing/Stripe platby a verejný
frontend neboli aktivované či znovu publikované. Infra príprava neuzatvára M1–M6.

Tri Major nálezy pri vzdialenom head `5ef32af` sú opravené v lokálnom runtime
`186eba1223dad2f0a081f2aa524feb5508a144fa` a nové úplné gates prešli. Backend
oprava ešte nebola pushnutá ani opätovne posúdená CodeRabbit; pôvodné tri vlákna
sa preto týmto dokumentom neuzatvárajú. Moderný frontend má otvorený PR#3 na
presnom head `4f2ef43`, jeho nový CodeRabbit review prebieha. Historických
1101/183 main, 161 PG a 178 moderných testov nižšie zostáva zachovaný dobový stav.

Sanitizovaný dôkaz bez osobných identít, credential údajov, host PID, container
UUID a cgroup ciest: [WS19 infrastructure](../deploy/lovable-github/proof/WS19-INFRASTRUCTURE.json).

### PR #22 — nové recovery/storage overenie runtime 186eba1

1. Expired compiling lease sa obnoví cez owner-scoped status/admission sweep aj
   bez pôvodného browser receipt. Claim fencing zastaví starého compilera;
   writing/legacy_unknown rezervy sa neuvoľňujú odhadom neprítomnosti súborov.
2. Fyzický storage už nedrží DB transakciu. Migrácia013 odlišuje compiling,
   writing, retained, empty a legacy_unknown; spoločná bounded brána povoľuje
   2 aktívne I/O a 8 čakajúcich s 5-sekundovým deadline volajúceho. Fyzicky
   zaseknutý zápis ďalej drží slot aj byte rezervu. Natívny pool max 5 pri dvoch
   blokovaných writeroch a piatich inventory volaniach zostal dostupný, iný owner
   dostal auth/me HTTP 200 v rozpočte; skutočné testovacie dáta vlastníka sa nepoužili.
3. Hlavné aj moderné UI obnovia pôvodný pending UUID pred novým save/UUID aj po
   zmene zdrojov či revízie. GET404 a sieťová neistota ho zachovajú. Starý úspešný
   artefakt je označený ako predchádzajúca verzia a nemení aktuálny publication
   stav; iba zhodný terminal receipt sa odstráni. Nová verzia vyžaduje ďalší
   výslovný súhlas a klik. Owner/project/workspace a presná server revision/snapshot
   kontrola zostávajú zachované.

| Nové úplné gates runtime 186eba1 | Výsledok |
|---|---|
| Hlavná sada | **1 115 passed / 189 skipped** |
| PostgreSQL 16.15 a 18.6 | **167/167 na každej**, oba dočasné clustre stopped/removed |
| Docker sandbox/publish | **21/21** |
| Moderný mirror | **188/188** v 17 súboroch; Publish 21/21 vrátane10 nových regresií |
| Hlavný Publish dialóg | **29/29** vrátane7 nových regresií |
| Typy, lint, lokálne buildy | PASS; hlavný lint 0 chýb / 33 existujúcich upozornení |

Všetkých sedem hlavných gates má totožný witness 300 runtime/config/test súborov
a žiadnu zmenu počas behu; všetkých 14 commitnutých súborov zodpovedá receipt.
Moderný mirror a overlay sú byte-identické. Nový API linux/amd64 obraz186eba1
prešiel lokálnym Node 26 nonroot/read-only/network-none smoke a bol zabalený
s nezmeneným overeným runnerom 9e49. Git-diff witness pokrýva sandbox aj oba
tranzitívne security importy; worker 9e49 už beží v samostatnom rootless daemone
pod config digest b627…, API/runner archív však tento krok nenačítal ani nespustil.
Node smoke nie je aplikačné/auth readiness. Živý Cloud→Hono, kontrolované
migrácie 001–013, nový Basic účet so schválením vlastníka, nové API/runner,
public artefakt HTTP 200, verejný frontend republish a skutočný Stripe tok ostávajú
otvorené. Nové gates neuzatvárajú M1–M6 ani nepotvrdzujú aktuálny kreditový zostatok.

Dôkaz: [PR22-RECOVERY-VERIFICATION.json](../deploy/lovable-github/proof/PR22-RECOVERY-VERIFICATION.json)
a [samostatný manifest 11 sanitizovaných logov](../deploy/lovable-github/proof/PR22-RECOVERY-LOGS.json).

### PR #22 — historické úplné overenie runtime 9e49 / head 5ef

Runtime commit `9e49e0e2ecdc004215d926ebfdc30171bc3bc2a2` opravuje štyri
nálezy pôvodného CodeRabbit review; backendový PR #22 je pri tomto zázname
stále otvorený. Ide o zachovaný historický beh pred tromi ďalšími Major nálezmi a pripravovanou fázou013; nie o nové finálne gates ani nasadenie aplikácie.

1. Zlyhané publish joby uvoľnia nevyužitú byte rezervu. Reálne zachované súbory sa
   ďalej účtujú, building joby držia rezerváciu a zápisy sú ohradené owner lockom
   a platným claim/state. Trvalý limit počtu pokusov zostáva ochranou pred
   zneužitím; retencia/cleanup tým nie sú hotové.
2. Hlavný Publish dialóg rozlišuje potvrdené vstupné odmietnutie bez jobu od
   neistého výsledku. Po zosúladení projektu ďalší výslovný pokus uloží čerstvú
   revíziu a nový UUID; sieť/timeout/protokol a `publish_request_conflict`
   zachovajú pôvodný UUID. Neskorá odpoveď nezmaže novší alebo cudzí receipt.
3. Moderný dialóg po overenom failed jobe odstráni iba zhodnú selection. Prvý
   pokus po opätovnom otvorení už používa nový UUID; building a neurčité
   výsledky ostávajú obnoviteľné.
4. Nginx vzor zachová presný Host aj s neštandardným HTTPS portom a naďalej
   odstraňuje Cookie a Authorization. Negatívna kontrola aj opravený HTTP tok
   boli overené lokálne, bez inštalácie na VPS.

| Historická úplná kontrola 9e49/head 5ef | Výsledok |
|---|---|
| Hlavná sada | **1 101 passed / 183 skipped** |
| PostgreSQL 16.15 a 18.6 | **161/161 na každej verzii**, oba dočasné clustre zastavené a odstránené |
| Docker sandbox/publish | **21/21** |
| Moderný Lovable mirror | **178/178**, strict TypeScript a client/SSR/Workers build PASS |
| Hlavné typy, lint a build | PASS; **0 lint chýb / 33 existujúcich upozornení** |
| Nginx vzor | Syntax aj skutočný HTTP Host/port negatívny kontrolný prípad a opravený tok PASS |

Pri tomto historickom behu hlavné gates zachytili rovnakých 699 zdrojových hashov bez zmien počas
behu; desať dotknutých súborov sa zhoduje s runtime commit receipt. Nové
sanitizované `review-*.txt` logy majú samostatný hash manifest; historických
16 `release-*.txt` logov a pre-review `7f2b923` receipts zostalo zachovaných.
Pôvodné počty 1 076/181, 159 PG a 175 moderných testov nižšie sú **pred review**;
nie sú aktuálnym finálnym overením. Skorších 22 React E2E sa tu nevydáva za nový beh.

Frontend oprava jediného produkčného súboru (+3 riadky) bola prenesená cez
[PR #2](https://github.com/erikbabcan-commits/vorkeeei/pull/2): head `46372049`,
merge `fe3b0d80`, strom `a4fca4d1`. Main súbor má rovnaký SHA ako moderný mirror.
CodeRabbit skončil success, bez vecných inline nálezov; iba všeobecné docstring
upozornenie. `local/sandbox-verification` bol success a GitHub Actions zostali
na 0 behoch. Viditeľná Lovable história potvrdila Git push opravy aj merge PR #2;
je to bežná Git synchronizácia, bez AI promptu alebo AI Build. Tento frontend
merge nie je backendový runtime commit `9e49e0e` ani verejné republish.

Nové linux/amd64 API/runner/worker obrazy runtime `9e49e0e` majú lokálny build a
non-root, read-only, network-none smoke PASS. Archív má **129 687 984 B**, SHA256
`5ae82020f5839bd00ccbf6510927e7eb0f7198abcedc11f12116538d4ae7868c`.
Všetkých 20 unikátnych layer DiffID bolo nezávisle overených. Oddelené archívy
application/worker majú 123 534 912 B a 68 808 195 B. Plán dvoch samostatných
image stores bez zdieľania vrstiev medzi daemonmi potrebuje **2 883 338 328 B
(približne 2,69 GiB)** vrátane publish a bezpečnostnej rezervy. Nový read-only
dry-run nameral 3 755 499 520 B voľných; plán sa do tohto merania zmestí.
Starý 2,15 GiB odhad jednej image store je iba historický. Skutočné využitie
filesystému treba sledovať po každom budúcom scope-limited načítaní.
V čase tohto historického 9e49 záznamu sa rootless guard/audit a inertný staging ešte dokončovali; aktuálne skutočné infra výsledky sú uvedené samostatne vyššie.
Dry-run neaplikoval zmeny; inertné uloženie archívu nie je načítanie obrazov,
inštalácia rootless daemona ani aktivácia kontajnerov.
Čerstvá záloha bola obnovená a overená; nový VPS runtime, produkčné migrácie,
verejné republish a Stripe platby **neprebehli**. Backendové služby ostávajú
predvolene vypnuté a všetkých 85 pôvodných backlog ID aj riadkov zostáva zachovaných.

Presný dôkaz: [PR22 review fixes](../deploy/lovable-github/proof/PR22-REVIEW-FIXES.json)
a [hashy nových logov](../deploy/lovable-github/proof/PR22-REVIEW-LOGS.json).

### WS-19 — pôvodný pre-review stav7f2 a prenos do editora

Oba frontend entrypointy používajú reálny statický Publish: výslovný verejný
súhlas → vlastný uložený projekt/revízia/snapshot → Hono job → existujúci compiler
→ nemenný artefakt → verejné HTML na oddelenej hostname. Job uchováva stav a chyby;
URL vzniká až po uložení a potvrdení artefaktu. Verejný listener má vlastný Host,
CSP s opaque sandboxom a zákaz sieťových API, bez auth cookies. Nie je to
fullstack hosting ani aktivovaný CDN deployment. `PUBLICPUBLISH_ENABLED` zostáva OFF.

Cloud proxy má presne tri billing routy pre stav, Checkout a Portal. Moderný
panel používa overené interné userId; receipt a neskoré odpovede chráni účet,
token aj režim. `BILLING_MODE=test|live` kontroluje provider objekty a podpísané
udalosti. Migrácia 012 pripína DB na jedno prostredie, aby výmena kľúča nezmenila
testové nároky na live. Read-only preflight overuje iba explicitnú konfiguráciu,
DB a voliteľné GET účtu/cien; žiadne Stripe objekty nevytvára. Billing zostáva OFF.

Lokálny browser overil moderné UI → Cloud BFF → Hono → skutočný compiler →
artefakt/HTTP 200 a vykreslený React; následne syntetický Checkout, podpísaný SDK
webhook → Pro a oddelený Bob účet s Free, bez JS chýb. Je to dočasná testovacia
DB a syntetická Stripe hranica, bez platby. **Historické pre-review brány WS-19 pre `7f2b923`: 1 076 passed /
181 skipped main, 159/159 PG na 16.15 aj 18.6, 175/175 moderné UI, 21/21 Docker
vrátane reálneho izolovaného publish a 22/22 React E2E.** Typy, strict graf, buildy
a lint prešli; 33 existujúcich lint upozornení zostáva. Detaily a hranice:
[historický pre-review dôkaz](../deploy/lovable-github/proof/PUBLISH-BILLING-VERIFICATION.json).

Produkčných 41 overlay súborov a automatický route tree sú v privátnom frontend
repozitári po merge [PR #1](https://github.com/erikbabcan-commits/vorkeeei/pull/1).
Merge `f7e3361` a prevádzkový refresh `96751c31` zachovali overený strom `7f9cd337`.
Clone build aj strict TypeScript v tejto pred-review fáze prešli. Viditeľný Code Editor vrátil
presné SHA TopBar a ForgePublish; oficiálny reštart live preview zobrazil nové UI,
skutočný Publish dialóg a funkčné existujúce Google prihlásenie. Hono/modely/
publish readiness sú zatiaľ nedostupné; žiadna aplikácia sa nepublikovala.
`HONO_BASIC_AUTH` v Cloud Secrets chýba; hodnoty Secrets sa nečítali.

Historické pred-review amd64 obrazy pre runtime `7f2b923` boli pripravené lokálne (archív 129 686 811 B,
unikátne rozbalené vrstvy 433 890 304 B). Read-only audit o 19:07 UTC nameral 91 %
disku a 3,50 GiB voľných; odhad načítania hotových obrazov s rezervou 2,15 GiB je
splnený. Chýba izolovaný worker daemon a migrácie 002–012. Na VPS neprebehlo
načítanie obrazov, mazanie, zmena Secrets, migrácia ani deploy.

Stripe read-only inventúra našla vhodné existujúce Pro test ceny 29 €/mesiac a
290 €/rok pre ten istý produkt, no 0 aktívnych default portálov. Návrh ich
konfigurácie sa nevykonal, Stripe zápisy ani platba neprebehli. Lovable ukazoval
0 dostupných kreditov už pred prenosom; agent neodoslal AI prompt ani AI Build.
Historickú 30-kreditovú rezervu nemožno považovať za aktuálne potvrdenú.
Verejný frontend nebol znovu publikovaný.

Kontrakt a aktivačné kroky: [WS-19](WS-19-PUBLISH-BILLING.md). Presný rozsah:
[prevádzkový dôkaz](../deploy/lovable-github/proof/PUBLISH-BILLING-ROLLOUT.json).

### Dokončené usporiadanie Git histórie

- [PR #21](https://github.com/erikbabcan-commits/LOV-DEVIL-BUILDER-2026/pull/21) je **merged** do `main`; existujúca release história zostala zachovaná.
- Nové commity: `ae82c94` — implementácia a testy; `c7542b6` — dokumentácia a dôkazy. Merge commit je `fce375d`.
- Po merge sa lokálny `main` presne zhodoval s `origin/main`, pracovný strom bol čistý a merge strom sa rovnal overenému PR stromu.
- `local/sandbox-verification` bol zelený na PR aj merge commite; nejde o výsledok GitHub Actions.
- Zastaraný PR #8 bol zavretý, pretože jeho head už je predkom `main`; nová integračná vetva bola po merge odstránená.
- Tento integračný krok nespustil CI/CD, deploy ani produkčnú migráciu a nemenil produkčné Secrets. Staršie nasadené prevádzkové opravy tým nie sú zrušené.

### Posledné úplné overenie — PR #21, pred WS-19 · 6. 11. 2026

| Kontrola | Výsledok |
|---|---|
| Hlavná testovacia sada | **1 002 passed / 157 skipped**, jeden worker; platený live smoke vylúčený, AI kľúče prázdne |
| PostgreSQL 16.15 a 18.6 | **135/135 na každej verzii**, migrácie 001–010; oba dočasné clustre zastavené a odstránené |
| Docker sandbox | **21/21**, vrátane 12 šablón a 9 izolačných/chybových scenárov |
| React E2E | **22/22** |
| Historické demo | **6/6** browser testov a **112/112** vnútorných kontrol |
| Moderný Lovable mirror | **146/146**, TypeScript a produkčný client/SSR/Workers build prešli |
| Billing po poslednej úprave testovacieho runnera | **80/80** — 61 backend + 19 UI; strict native/CLI graf a lint harnessu prešli |
| Typy, lint a build hlavného projektu | Prešli; **0 lint chýb / 33 existujúcich upozornení**, editor chunk naďalej nad Vite upozornením 500 kB |
| Mobilný billing | **390 × 844**, bez vodorovného pretečenia, dostupné a fokusovateľné CTA |

Plný hlavný beh predchádza poslednej úprave časových rozpočtov testovacieho
runnera; finálne PostgreSQL behy a cielených 80 testov prebehli po nej. SQL a
aplikačné limity ani kontrolné tvrdenia sa nemenili. Natívne/Docker vetvy sa
vykonali samostatne; testy so syntetickým providerom nepotvrdzujú kvalitu živého LLM
ani vykonanú Stripe platbu. Sú to výsledky predchádzajúceho PR #21; nové finálne
brány WS-19 sú uvedené samostatne vyššie.

Podrobný rozsah: [lokálne overenie](LOCAL-VERIFICATION-2026-11-06.md),
[aktuálny strojový záznam](../deploy/lovable-github/proof/CLEANUP-VERIFICATION.json).
Oprava fingerprintu konceptu zachová rovnaký podklad aj po IndexedDB obnove s iným
poradím súborov. Všetkých 68 hashov Lovable overlay zodpovedalo lokálnemu mirroru.
V tejto historickej fáze sa hosted Lovable nemenil a zostatok 32,8 bol dobové
meranie. Tento záznam nepotvrdzuje aktuálnu 30-kreditovú rezervu; novšie meranie
a prenos WS-19 sú uvedené vyššie. PR #21 povoľoval iba sandbox; nový explicitný test/live režim
opisuje WS-19, no platby zostávajú vypnuté. MCP oprávnenie
Read neoprávňuje vytvárať produkty, ceny ani platobné session.

### Zostávajúce aktivačné brány a budúce priority

1. Dokončiť živý Cloud → Hono priechod: chýbajúci serverový Basic transport, auth/identity binding → projekt → AI review → build → serverové uloženie. Frontend zostáva na Lovable a backend na VPS; editor už obsahuje nový kód, verejnú aktualizáciu a celý priechod ešte treba overiť.
2. Overiť nový hostovaný GitHub connector s rozsahom `public_repo`, prepare/confirm/recovery a explicitným súhlasom s verejnými súbormi. Repo upratanie cez Git nie je dôkazom exportu z aplikácie.
3. Aktivovať a overiť implementovaný Cloud billing bridge, pripraviť Stripe sandbox konfiguráciu a reconciliation nástroje; následne prejsť skutočný testovací nákup/cancel. Implementovaný live režim s DB pinom sa tým nezapína; platby, dane/faktúry, dunning a refundy majú samostatné brány.
4. Dokončiť schválenie Cloud owner väzby/Basic transportu a riadenú produkčnú promóciu už overeného STAGED API/runnera. Schéma 001–013, auth/compile/cleanup, health a oddelený TLS vstup sú hotové; pred promóciou znovu overiť aktuálne resource/backup brány, bezpečný upstream switch a service autostart/obnovu. Potom overiť celý Cloud/BFF priechod a skutočný statický Publish; syntetický publish smoke sa zatiaľ nevykonal. CDN/custom domains, retencia, rollback a produkčná tenant izolácia zostávajú otvorené; statický snapshot nenahrádza fullstack runtime.
5. Zmerať živú kvalitu, latenciu, intent a dlhý kontext na eval sete; doložiť reálne náklady a maržu. Terajších 150 promptov a offline scorer nie sú nameraná úspešnosť modelu.
6. Uzavrieť produktové brány M1: recovery účtu, plánové oprávnenia, prevádzkové monitorovanie a právne/fakturačné toky. Odložené kroky vlastníka zostávajú odložené.

Pôvodný backlog je znovu aktívny. Stav jednotlivých brán vyššie určuje ďalšiu
prácu; tento záznam nepotvrdzuje aktivované produkčné služby ani platené operácie.

### História jednotlivých prírastkov

> Nasledujúce záznamy zachovávajú rozsah, výsledky a otvorené body **v čase danej fázy**.
> Staršie počty testov ani formulácie „bez commitov“, „nenasadené“ či „nasleduje cleanup“
> nepopisujú dnešný Git stav. Neskoršie fázy niektoré z týchto bodov rozšírili;
> aktuálny stav určujú súhrn vyššie a stavové stĺpce epikov nižšie.

#### Predplatné a overený serverový plán · WS-18 · 6. 11. 2026

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
Stripe zápisov alebo Lovable kreditov. Nadväzujúci Git cleanup bol dokončený merge PR #21; v čase tohto záznamu boli nové funkcie pozastavené. Aktuálny cieľ je znovu aktívny.

#### Hlavný editor: koncepty a nemenné uloženie · WS-17 · 6. 11. 2026

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

#### Súborový editor a ručné verzie · WS-16 · 6. 11. 2026

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

#### Skutočný ZIP aktuálnej a historickej verzie · WS-15 · 6. 11. 2026

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

#### Lovable AI workspace napojený lokálne · WS-14 · 6. 11. 2026

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

#### AI oprava overená buildom · WS-13 · 6. 11. 2026

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

#### Cielené úpravy a diff pred schválením · WS-12 · 6. 11. 2026

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

#### Zámer a odpoveď bez zmien · WS-11 · 6. 11. 2026

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

#### Pamäť konverzácie a úplný snapshot · WS-10 · 6. 11. 2026

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

#### Výber modelu, retry a failover · WS-9 · 6. 11. 2026

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

#### Odhady AI nákladov · WS-8 · 6. 11. 2026

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

#### Spotreba provider volaní · WS-7 · 6. 11. 2026

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

#### Lovable hybrid a GitHub konektor · 6. 11. 2026

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

Overenie main repo v tejto fáze: **851 testov prešlo, 106 bolo preskočených**
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

#### AI limity a priebeh úloh · 6. 11. 2026

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

#### Overený prírastok WS-4 · 5. 11. 2026

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

#### Overený prírastok šablón a UX · 5. 11. 2026

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

#### Súborový diff a predchodcovia verzií · 5. 11. 2026

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

#### Lokálne projekty oddelené podľa účtu · 5. 11. 2026

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

#### Serverové projekty — API základ · 5. 11. 2026

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

#### Projektová knižnica a ručné serverové ukladanie · 5. 11. 2026

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

#### Kapacita serverových projektov · 6. 11. 2026

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
| **M1** | **Reálny engine + MVP predaj** | AI, sandbox, auth, hosting, Free/Pro | Pôvodný odhad 6–10 týždňov | **Otvorené:** lokálny základ existuje; chýba verejná bežiaca appka a overený platený zákaznícky tok |
| **M2** | **Editor + blueprinty** | editor, história, galéria, wizard a prompty | Pôvodný odhad 6–8 týždňov | **Čiastočne:** moderné editory a 12 šablón, kód prenesený do hostovaného editora; branches/merge, fullstack blueprinty a úplné živé overenie chýbajú |
| **M3** | **Fullstack & data** | DB/auth zákazníckych appiek, backend funkcie a domény | Pôvodný odhad 6–8 týždňov | **Otvorené:** historický UI prototyp; funkčný produkčný backend zákazníckych appiek nepotvrdený |
| **M4** | **Tímy & Business tier** | kolaborácia, zdieľanie, seats a RBAC | Pôvodný odhad 6–8 týždňov | **Otvorené:** demo tímového UI nie je reálna spolupráca ani Business billing |
| **M5** | **Enterprise & scale** | SSO, compliance, audit, SLA a abuse ochrana | Pôvodný odhad 8–12 týždňov | **Otvorené:** čiastkové limity/zálohy existujú; Enterprise kritériá nesplnené |
| **M6** | **Ekosystém** | komunita, marketplace, remix a affiliate | Priebežne | **Otvorené:** historické demo, bez reálneho marketplace/payout/affiliate toku |

---

## 2. Epiky & backlog

Stav sa vzťahuje k implementačnému základu po PR #21. **Lokálne overené** znamená
vykonaný ohraničený tok v lokálnom prostredí; **čiastočne** znamená implementovanú
časť kritérií; **otvorené** znamená, že vlastná akceptačná brána položky ešte
nebola splnená. Žiadny z týchto stavov sám nepotvrdzuje produkčný deploy.
Pôvodné odhady zostávajú orientačné, nie sú odhadom zostávajúcej práce.

### 🤖 Epik 1 — AI Engine (FORGE-1xx) · M1 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad | Stav k 6. 11. 2026 |
|---|---|---|---|---|
| 101 | Provider-agnostické LLM API (Mistral/OpenAI/Anthropic) + failover | výber modelu v UI reálne prepína model; fallback pri výpadku; latencia < 15 s do prvého tokenu | L | Čiastočne — adaptéry/model/retry/failover; živá kvalita a <15 s neoverené |
| 102 | Streaming odpovedí do chatu (SSE/WebSocket) | tokeny píšu priebežne, cancel tlačidlo funguje | M | Čiastočne — SSE/cancel lokálne overené; živý produkčný tok otvorený |
| 103 | Multi-file codegen (React/Vite projekt, nielen single-file HTML) | AI vráti zoznam súborov + obsah; explorer ich zobrazí | L | Lokálne overené — multi-file → VFS → review/compile; kvalita živého codegen otvorená |
| 104 | Diff-based editácie (patch existujúceho kódu, nie celá regenerácia) | zmena „pfarbu tlačidla" upraví 1 súbor; Diff tab ukazuje reálny diff | L | Čiastočne — presné patche, diff a approval; živé regresné evaly chýbajú |
| 105 | Intent klasifikácia: nová appka vs. iterácia vs. fix vs. otázka | routing presnosť > 90 % na eval sete (150 promptov) | M | Čiastočne — routing, 150 promptov a scorer; >90 % na živom modeli nenamerané |
| 106 | Retry, timeouty, usage metering per request | chyba providera = čitateľná správa + auto-retry; spotreba sa ráta do plánu | M | Čiastočne — ohraničený retry/deadline a trvalý usage/cost ledger; prevádzkové overenie chýba |
| 107 | Kontext manažment (sumarizácia konverzácie + projekt snapshot) | 20+ správ bez prerušenia; tokeny pod limitom; historky nezabudnú kód | M | Čiastočne — sumarizácia a úplný snapshot; kvalita 20+ správ neoverená |
| 108 | Attachments: obrázky/screenshots do promptu (vision) | upload → AI vidí obrázok → vygeneruje podľa neho | M | Otvorené |

### 🧩 Epik 2 — Codegen & runtime (FORGE-2xx) · M1–M3 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad | Stav k 6. 11. 2026 |
|---|---|---|---|---|
| 201 | Sandbox preview pre fullstack (WebContainers/Firecracker) — **otvorené; WS-4 dokončuje iba compile izoláciu** | `npm install`, dev server, HMR beží v prehliadači/VM izolovane | XL | Otvorené — WS-4 overuje compile-only izoláciu, nie fullstack/HMR |
| 202 | Build pipeline (Vite) + produkčný build | „Publish" najprv prejde reálnym buildom; chyby sa zobrazia v Console | L | Čiastočne — compile/repair a statický publish job so stavom/chybami; všeobecný produkčný Vite pipeline chýba |
| 203 | Závislosti: npm balíčky na želanie | „pridaj recharts" → AI prida + nainštaluje | M | Otvorené |
| 204 | Databáza ako služba (tabuľky, seed, migrácie) | AI navrhne schému, UI editor tabuliek, data browser | XL | Otvorené |
| 205 | Auth šablóny pre vygenerované appky (login/register/OAuth) | 1 klik = funkčný login nad Forge DB | L | Otvorené |
| 206 | Serverless funkcie / API routes | „pridaj endpoint /api/orders" → beží v produkcii | L | Otvorené |
| 207 | Secrets vault (env premenné, šifrované) | API kľúče sa nikdy nezobrazia AI ani v exporte | M | Otvorené |

### 🖥️ Epik 3 — Editor (FORGE-3xx) · M2 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad | Stav k 6. 11. 2026 |
|---|---|---|---|---|
| 301 | File explorer (strom súborov, add/rename/delete/upload) | plná správa súborov, drag & drop | L | Lokálne overené — textové CRUD/import/drop; kód prenesený do hostovaného editora, živý CRUD tok ešte neoverený |
| 302 | Monaco/CodeMirror editor (highlight, autocomplete, TS) | editácia = recompile náhľad; chyby inline | L | Čiastočne — CodeMirror/koncepty/inline build chyby; sémantický TS/lint/format chýba |
| 303 | Git-like verzovanie: commity, branches, merge/rollback | snapshoty sú de facto commity; restore + diff + fork vetiev | XL | Čiastočne — nemenné verzie, parent/diff/restore; branches a merge chýbajú |
| 304 | Visual Edit mode → reálne CSS patche | klik na element = AI/JSON patch, nie len hover highlight | L | Otvorené |
| 305 | Reálna Dev console (logy, chyby, sieť z preview) | Console tab = živé logy runtime, nie mock zoznam | M | Čiastočne — skutočné compile chyby/logy; plná runtime/network console chýba |
| 306 | Komponent library („insert component": navbar, footer, formulár…) | vloženie bez rozbitia layoutu | M | Otvorené |
| 307 | Breakpoints & device frames + režim „reálne zariadenie" | existujúce viewporty + otvorenie v novom tabe (mimo sandboxu) | S | Čiastočne — viewporty a mobilné panely; celý tok na reálnom zariadení neoverený |
| 308 | Linting + autoformát + TS strict check | chyby v editore, nie až pri builde | M | Otvorené |

### 🧱 Epik 4 — Blueprinty (FORGE-4xx) · M2 · **P0** *(explicitne požadované)*

Blueprint = **parameterizovateľná šablóna celej aplikácie** (nič mock — reálny projekt s DB, auth, stránkami), ktorá sa vygeneruje na 1 klik.

| ID | Položka | Akceptačné kritériá | Odhad | Stav k 6. 11. 2026 |
|---|---|---|---|---|
| 401 | Blueprint formát + runtime | metadata: stack, screens, DB schéma, env, sekcie AI promptov; verzie blueprintu | L | Čiastočne — formát 12 frontend šablón; fullstack metadata/DB/auth chýbajú |
| 402 | Štartovacia galéria (12+): SaaS starter, e-shop, blog+CMS, rezervačný systém, CRM, portfólio, members area, AI chatbot, invoicing, event registrácia, job board, recipes/fándž | každý blueprint: živý demo, zoznam funkcií, stack, čas „do appky" < 60 s | XL | Čiastočne — 12 zostaviteľných frontend projektov; živé fullstack demá chýbajú |
| 403 | Blueprint wizard | výber → parametre (brand, logo, farby, jazyk, mená entít) → AI doladí → hotovo | M | Čiastočne — názov/farba a review; logo/jazyk/entity/AI parameterizácia neúplné |
| 404 | Blueprint forking / „Remix" | remix uloží kópiu do môjho účtu ako nový projekt | S | Otvorené |
| 405 | Private blueprinty (Pro/Business) | tím si uloží vlastný blueprint + interné šablóny | M | Otvorené |
| 406 | Komunitná galéria + moderácia | publish blueprintu, hodnotenie, tagy, „trending" | L | Otvorené |
| 407 | Marketplace + revenue share (M6) | predaj platených blueprintov, 80/20 split, payouts | XL | Otvorené |
| 408 | Blueprint analýza: usage → optimalizácia konverzie | miera „blueprint → publish" per šablóna | M | Otvorené |

### 📝 Epik 5 — Prompty & AI ops (FORGE-5xx) · M1–M2 · **P0** *(explicitne požadované)*

Systémové prompty = jadro produktu. Verziované, testované, A/B.

| ID | Prompt pack | Účel / akceptačné kritériá | Odhad | Stav k 6. 11. 2026 |
|---|---|---|---|---|
| 501 | **P1 — Master Builder Prompt** | plánovanie (Agent Mode kroky), brand konzistencia, dizajn systém, slovenčina/angličtina podľa používateľa; vždy najprv plán, potom kód, potom zhrnutie | M | Čiastočne — plán/code/review workflow; celý pack a živá kvalita neoverené |
| 502 | **P2 — Iterate/Edit Prompt** | zmeny len v dotknutých súboroch, zachovať fungujúce časti, stručné vysvetlenie zmien | M | Čiastočne — source-bound iterate patche; živé regresné evaly chýbajú |
| 503 | **P3 — Fix/Debug Prompt** | dostane chybu + kontext → oprava + regresný fix; koreň príčiny, nie len symptóm | M | Čiastočne — bounded build-error repair a review; živá kvalita neoverená |
| 504 | **P4 — Explain Code Prompt** | „vysvetli tento súbor/element" — pre netechnických zákazníkov, jednoducho | S | Čiastočne — odpoveď/copy/re-run bez zmien; celý Explain pack neoverený |
| 505 | **P5 — Blueprint Parameterization Prompt** | naplní blueprint parametrami brandu (farvy, tón, jazyk, naming) konzistentne | M | Čiastočne — branding šablón; celý AI parameterization pack chýba |
| 506 | **P6 — Test Generation Prompt** | AI k vygenerovanej appke napíše unit + e2e testy; nahradí mock test suite z prototypu reálnymi testami | M | Otvorené |
| 507 | **P7 — SEO/Content Prompt** | meta tagy, OG obrázky, copy pre landing vygenerovanej appky | S | Otvorené |
| 508 | **P8 — Safety Meta-Prompt (guardrails)** | odolnosť na prompt injection, žiadne secrets do kódu, bezpečné defaults, licenčne čisté dependency | M | Čiastočne — validácia ciest/zdrojov/tajomstiev; injection/licenčné evaly chýbajú |
| 509 | Eval set (golden prompts + očakávané výstupy) + nočné regresné behy | zmena promptu nerozbije > 5 % prípadov; report do interného dashboardu | L | Čiastočne — 150 promptov a offline scorer; živé golden/nočné/dashboard behy chýbajú |
| 510 | Prompt versioning + A/B + feature flagy | prepnutie verzie promptu bez deploy | M | Otvorené |

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

| ID | Položka | Akceptačné kritériá | Odhad | Stav k 6. 11. 2026 |
|---|---|---|---|---|
| 601 | Reálny deploy na CDN + `*.forge.app` subdoména | publish z demo → reálna URL, HTTP 200, SSL, global CDN | L | Čiastočne — lokálny statický Publish z oboch UI, compiler/artefakt/HTTP 200; produkčné HTTPS, CDN a doména neaktivované |
| 602 | Custom domains + auto SSL (Let's Encrypt) | „pripoj doménu" = 2 DNS záznamy, validácia, cert automaticky | M | Otvorené |
| 603 | Preview deployments (per commit/branch) | každá verzia má vlastnú URL; produkcia sa mení len „Promote" | M | Otvorené |
| 604 | Rollback deployment na predchádzajúcu verziu | 1 klik, < 30 s | S | Otvorené |
| 605 | Export: ZIP + GitHub (push do repo) | súčasný „Export ZIP" musí vrátiť reálny projekt | M | Čiastočne — skutočný ZIP oboch UI, lokálny GitHub ledger/recovery; nový hosted/live export neoverený |
| 606 | Build statusy + logy v publish flow | súčasný modal so 4 krokmi napojený na reálny pipeline stav | S | Čiastočne — obe UI čítajú skutočný building/published/failed job a compile chyby; produkčný pipeline a prevádzkové logy neoverené |

### 🔐 Epik 7 — Auth & organizácie (FORGE-7xx) · M1 · **P0**

| ID | Položka | Akceptačné kritériá | Odhad | Stav k 6. 11. 2026 |
|---|---|---|---|---|
| 701 | Registrácia/login: e-mail+heslo, Google, GitHub | heslá bcrypt/argon2, e-mail verify, reset hesla | M | Čiastočne — cookie auth a Cloud Google login; verify/reset a celý hybrid tok otvorený |
| 702 | 2FA (TOTP) | Pro+ feature | S | Otvorené |
| 703 | Organizácie & tímy, role (owner/admin/editor/viewer) | pozvánky e-mailom, RBAC na projektoch | L | Otvorené — tímy, pozvánky a role nad rámec jednotlivého vlastníka chýbajú |
| 704 | Prenos vlastníctva projektu, mazanie s grace period | soft-delete 30 dní | S | Čiastočne — 30-dňový kôš/obnova; prenos vlastníctva a fyzická retencia chýbajú |
| 705 | SSO/SAML/SCIM (M5, Enterprise) | Okta/Entra, automated provisioning | XL | Otvorené |

### 💳 Epik 8 — Billing & predplatné (FORGE-8xx) · M1 · **P0** *(jadro obchodného cieľa)*

| ID | Položka | Akceptačné kritériá | Odhad | Stav k 6. 11. 2026 |
|---|---|---|---|---|
| 801 | Stripe: mesačné + ročné plány, 14-dňový trial | upgrade/downgrade/cancel self-service, proration | L | Čiastočne — default OFF, explicitný test/live režim s DB pinom, Cloud panel/Checkout/Portal a read-only preflight; skutočná konfigurácia, platba a portál/proration otvorené |
| 802 | Pricing page (SK/EN) + plán porovnanie | jasné limity, FAQ, „najpopulárnejší" badge | S | Čiastočne — serverové ceny/karta plánu; úplná SK/EN pricing stránka a FAQ chýbajú |
| 803 | Feature gating + usage limits (middleware) | limit dosiahnutý = upsell, nie tvrdá stena (soft limit + upozornenie) | M | Čiastočne — Free 10 / Pro 200, čerstvý DB plán, kapacita a 80 % warning; ostatné entitlements otvorené |
| 804 | Usage metering dashboard (generácie, tokeny, blueprinty, deploys) | zákazník vidí spotrebu v reálnom čase (rozšíri /editor) | M | Čiastočne — AI úlohy/tokeny a cost coverage; deploy/blueprint metering chýba |
| 805 | Fakturácie: DPH/EU B2B reverse charge, IČO/DIČ, stiahnutie faktúr | daňovo korektné pre SK/EU | M | Otvorené |
| 806 | Dunning (neúspešné platby), refund flow, legal (GDPR, ToS, DPA) | automatické e-maily, compliance | M | Otvorené |
| 807 | Seat billing pre Business plán | pridať/odobrať člena mení fakturu pro rata | M | Otvorené |
| 808 | Affiliate/partner rabaty (M6) | referral link, provízia 20 % 12 mesiacov | M | Otvorené |

**Návrh cieľových plánov — obchodný návrh, nie aktuálna dostupnosť:**

Terajší kód vynucuje AI úlohy Free 10 / Pro 200 mesačne a spoločnú prevádzkovú
kapacitu projektov 64 MiB / 100 projektov na účet. Tokenové balíky, paywall ZIP,
Business/Enterprise, private blueprinty, domény a ďalšie bunky nižšie nie sú
týmto návrhom automaticky implementované. Runtime ceny sa čítajú z explicitnej
serverovej konfigurácie; žiadne predplatné sa teraz nepredáva.

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

| ID | Položka | Akceptačné kritériá | Odhad | Stav k 6. 11. 2026 |
|---|---|---|---|---|
| 901 | Realtime multi-user edit (CRDT/Yjs) | 2+ ľudia bez konfliktov, prítomnosť (avatary) | XL | Otvorené |
| 902 | Komentáre v preview (annotácia na elemente) | klik = koment, thread, resolve; AI odpovedá na koment | L | Otvorené |
| 903 | Share linky: view / comment / edit s expiráciou | prístup bez účtu pre view | M | Otvorené |
| 904 | Activity feed + audit log | kto čo kedy (zákaz aj pre Enterprise audit) | M | Otvorené |
| 905 | Approvals: publish len so súhlasom roly | Enterprise workflow | M | Otvorené |

### 🛡️ Epik 10 — Security & compliance (FORGE-10xx) · M1 (základ) / M5 · P0/P1

| ID | Položka | Akceptačné kritériá | Odhad | Stav k 6. 11. 2026 |
|---|---|---|---|---|
| 1001 | Sandbox izolácia (žiadny prístup k dátam iných zákazníkov) — **otvorené; overený compile základ WS-4** | pentestom overené; egress filter | XL | Otvorené — compile-only Docker základ overený; tenant pentest/širší egress/fullstack chýbajú |
| 1002 | Prompt injection ochrana (P8) + content moderácia uploadov | eval: < 2 % prienik | M | Otvorené |
| 1003 | Šifrovanie secrets vault (KMS), rotácia kľúčov | audit: secrets nikdy v logoch | M | Otvorené — všeobecný KMS vault a rotácia chýbajú; OAuth session majú samostatné šifrovanie |
| 1004 | Rate limiting + abuse monitoring per účet/IP | anti-scraper, anti-mining | M | Čiastočne — rate/admission limity; úplný abuse monitoring chýba |
| 1005 | GDPR: DPA, mazanie účtu + export dát, logs retention | súlad od dňa 1 (EU trh) | M | Otvorené |
| 1006 | SOC 2 Type II cesta (M5) | 12-mesiac observačnosť, security program | XL | Otvorené |
| 1007 | Zálohy, DR, uptime statusy (99.9 % Enterprise) | RTO/RPO definované, status page | M | Čiastočne — predchádzajúce PG backup/restore overenie; celý DR, RTO/RPO a SLA otvorené |

### 🎨 Epik 11 — Product/UX & onboarding (FORGE-11xx) · M1–M2 · P1

| ID | Položka | Akceptačné kritériá | Odhad | Stav k 6. 11. 2026 |
|---|---|---|---|---|
| 1101 | Onboarding wizard + interaktívny tour | „time to first app" < 5 min; skip možný | M | Otvorené |
| 1102 | Vzorové demo projekty (bez registrácie — playground) | visitor vyskúša pred signup (konverzia) | M | Čiastočne — 12 lokálnych interaktívnych demo projektov; hosted visitor tok otvorený |
| 1103 | Prázdne stavy + errory + skeletony (jednotný systém) | žiadny „dead end" v UI | S | Čiastočne — errors/retry/recovery vo vybraných overených tokoch; audit celého produktu chýba |
| 1104 | i18n SK/EN (celá UI vrátane editora) | prekladač, fallback EN | M | Čiastočne — pôvodný SK/EN shell; úplný preklad nových tokov neoverený |
| 1105 | Templatesá „app pre mňa": AI interview (3 otázky → návrh) | warm-up preplnenie promptu | M | Otvorené |
| 1106 | Notifikácie: e-mail (publish, limit, digest týždeň) | opt-in, unsubscribe | M | Otvorené |
| 1107 | PWA / mobilná podpora editora | /editor responzívne (sidebar na mobile dopracovať) | M | Čiastočne — overené 390 px panely/fokus; PWA a celý mobilný produkt chýbajú |
| 1108 | Nápoveda/docs + AI asistent v dokumentácii | self-service podpora znižuje cost per user | M | Otvorené |

### 📊 Epik 12 — Analytics & operácie (FORGE-12xx) · M1+ · P1

| ID | Položka | Akceptačné kritériá | Odhad | Stav k 6. 11. 2026 |
|---|---|---|---|---|
| 1201 | Produktová analytika (funnel: signup → 1. appka → publish → platba) | North Star: „publikované appky / týždeň" | M | Otvorené |
| 1202 | Interný dashboard: LLM costy per user/plán | margin > 70 % na Pro pláne | M | Čiastočne — read-only CLI/offline cost dashboard; živé ceny, príjmy a >70 % marža nedoložené |
| 1203 | Zákaznícke analytiky pre ich appky (opt-in) | Forge = analytics pre end-userov (pridaná hodnota) | M | Otvorené |
| 1204 | Support: ticketing + znalostná báza + SLA per plán | < 5 % ticketov na chybu AI | M | Otvorené |
| 1205 | Feedback: in-app návrhy + roadmap voting | prioritizácia podľa zákazníkov | S | Otvorené |

---


## 3. Prioritizácia (MoSCoW pre M1 — „o čo dnes zákazník platí")

**Must (M1):** 101–107, 201–202, 103, 301 (min. read-only explorer), 501–505, 508–510, 601, 605–606, 701, 703 (solo stačí), 801–806, 1001 (základ), 1005, 1101–1103, 1201–1202
**Should (M2):** 108, 204–206, 302–306, 401–405, 506–507, 602–604, 1104–1105
**Could (M3+):** 207, 303 branches/merge, 406–407, 901–903, 1203
**Won't (pre M1):** marketplace payouts (407), SSO (705), SOC2 (1006), affiliate (808)

## 4. Kritické riziká & závislosti

1. **Živé Cloud prepojenie a verejná aktualizácia:** nový frontend je v hostovanom live preview, ale Hono je nedostupné a verejná verzia sa neaktualizovala. Celý nasadený end-to-end workflow zostáva neoverený.
2. **Runtime a publish:** izolovaný worker, schéma 001–013 a STAGED API/runner auth/compile/health sú overené. Zostáva špecificky schváliť Cloud owner/Basic transport, dokončiť produkčnú promóciu a plný Cloud/static Publish smoke; fullstack tenant izolácia, CDN/custom domains, retencia a rollback nie sú uzavreté (201, 601–606, 1001).
3. **Kvalita a náklady AI:** ledger a adaptéry existujú, ale živé evaly, latencia, aktuálny cenník a marža nie sú namerané (101–107, 509, 1202).
4. **Billing a prevádzka:** explicitný test/live režim a Cloud tok sú implementované, billing je vypnutý; nejasné externé výsledky potrebujú operátorské nástroje, skutočná konfigurácia/platba, dane a dunning sú otvorené (801–806).
5. **Produktové oprávnenia a obnova:** owner isolation nie je tímové RBAC; chýbajú niektoré plánové entitlementy, account recovery, fyzická retencia a GDPR/DR brány (701, 703–704, 803, 1005–1007).

## 5. Uzavreté a zostávajúce krátke úlohy

- [x] Nahradiť mock ZIP skutočnými zdrojmi aktuálnej a historickej verzie — lokálne overený tok v oboch UI; celý FORGE-605 zostáva čiastočný pre nový hosted GitHub export.
- [x] Doplniť lokálne mobilné projektové/review panely, fokus a recovery; presné 390 px overenie prešlo. Celý FORGE-1107 vrátane PWA zostáva otvorený.
- [x] Opraviť koncept editora po IndexedDB obnove s iným poradím súborov; obsahové a verzovacie kontroly zachované.
- [x] Rozdeliť implementáciu a dôkazy do commitov, merge PR #21, zosúladiť lokálny `main` a upratať zastaraný PR/integračnú vetvu.
- [ ] Preniesť moderné UI a overiť živý Cloud → Hono/GitHub tok podľa priorít vyššie.
- [x] Nahradiť demo Publish v oboch lokálnych UI skutočným statickým jobom, nemenným artefaktom a oddeleným verejným listenerom; finálne lokálne brány WS-19 prešli, produkčná aktivácia zostáva otvorená.
- [ ] Dokončiť SK/EN pricing stránku a plánové oprávnenia; implementovaný Cloud billing panel a test/live režim nie sú aktivovaný platobný produkt.
- [ ] Zjednotiť nápovedu klávesových skratiek a command paletu podľa oboch skutočných UI; hotový spoločný tok zatiaľ neoverený.

## 6. Definition of Done — „MVP, za ktoré sa platí"

Všetky nasledujúce brány zostávajú otvorené pre **celý živý produkt**. Lokálny
usage/retry/restore tok je čiastočný dôkaz a nenahrádza nasadenie, skutočnú platbu
alebo prevádzkové meranie.

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

> **Archív pôvodných UI zadaní:** sekcie 7–11 pochádzajú zo single-file prototypu.
> Pokyny „všetko inline“, demo backend, role, platby a tvrdenia „hotové M0–M…“
> patria historickému UI návrhu. Nie sú aktuálnym implementačným plánom ani dôkazom
> hotového míľnika. Pri ďalšej práci platia dnešné epiky, ich stavy a aktuálna architektúra.

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

**Historický UI prototyp M2 (8. 10. 2026); míľnik zostáva otvorený** — file explorer s VFS, editor so syntax highlightom, git-like history s branchmi, blueprint galéria s brand wizardom a prompt knižnica sú v workspace prototype hotové a otestované (syntax-check + smoke-test roundtrip VFS/brand; plná suite Ctrl+Shift+T v prehliadači).
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

**Historický UI prototyp M3 (8. 10. 2026); míľnik zostáva otvorený** — DB data browser, end-user auth s login injekciou do preview, serverless funkcie s testovaním a custom domény s SSL wizardom sú v workspace prototype hotové a otestované (syntax-check + smoke-test; plná suite Ctrl+Shift+T v prehliadači).
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

**Historický UI prototyp M4 (8. 10. 2026); míľnik zostáva otvorený** — tím so seatmi a RBAC, presence, komentáre v preview s AI odpoveďou, share linky s oprávnením a expiráciou. Nová záložka „👥 Tím" v `/editor`.

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

**Historický UI prototyp M5 (8. 10. 2026); míľnik zostáva otvorený** — audit log napojený na tímové akcie, SSO/SAML, GDPR export + soft-delete, SLA status a rate limiting meter v „Tím → Audit & Compliance".

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

**Historický UI prototyp M6 (8. 10. 2026); míľnik zostáva otvorený** — komunitná galéria s filtrami, moderáciou a trending, marketplace s checkout flow, remix, affiliate panel aj template contest s hlasovaním. Nová záložka „🌐 Galéria" v `/editor`.
