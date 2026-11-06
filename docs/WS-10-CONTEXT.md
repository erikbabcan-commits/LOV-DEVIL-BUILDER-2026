# WS-10 — pamäť konverzácie a úplný snapshot

6. 11. 2026, lokálna implementácia FORGE-107/1103 a súvisiacich hraníc FORGE-106.
Bez commitov, nasadenia, produkčných migrácií, živých AI volaní alebo hosted
Lovable zmien. Celý backlog/M1 zostáva otvorený.

## Čo sa zmenilo

AI doteraz dostávala posledné snapshot prompty, nie celý chat, a každý aktuálny
aj už vygenerovaný súbor sa potichu orezal na 3000 znakov. Po novom klient posiela
predošlé používateľské/asistentské správy a celý obsah aktuálne zobrazených
súborov. Nový prompt sa neposiela druhý raz v histórii; prázdna rozpracovaná
odpoveď sa neposiela. Najnovších osem správ zostáva v plnom znení. Staršie správy
prechádzajú v pôvodnom poradí sémantickou rolling sumarizáciou s pevným JSON
kontraktom: summary, decisions, openQuestions. Počet nových AI volaní ukáže
`context_update` v Console. Kratší chat nepotrebuje žiadne sumarizačné volanie.

Zhrnutie používa ten istý vybraný provider/fallback reťazec, fyzický usage/cost
meter, cancellation, deadline a retry pravidlá ako plán a generovanie. Jeho
volania sú dodatočná spotreba; mesačný čítač celej úlohy sa zvýši iba raz.
Nie je to samostatná neúčtovaná inference a nepridáva nového príjemcu dát.

Všetky staršie správy sa spracujú, nevykoná sa tiché odrezanie začiatku chatu.
Ak sa celý prefix nezmestí do jedného volania, spracuje sa po dávkach s predošlým
zhrnutím. Malformed, truncated alebo credential-bearing memory zastaví plán aj
generovanie bez náhradného poslania celého chatu. Pred sumarizáciou sa skenuje
aj pôvodný celý vstup. Aktuálny snapshot je dôkaz aplikovaného kódu; história,
asistentský návrh aj zhrnutie sú neoverené dáta. Novší prompt má prednosť.
Nevykonané návrhy sa nevydávajú za vykonané zmeny.

## Rozpočet kontextu

`*_CONTEXT_WINDOW_TOKENS` v serverovej konfigurácii prijíma celé číslo
8192–2000000. Default 65536 je aplikačný strop, **nie objavená schopnosť modelu**.
Operátor ho musí overiť podľa konkrétneho modelu. Pre explicitne povolený fallback
sa uplatní najmenšie okno všetkých príjemcov, takže payload pripravený pre hlavný
model nesmie prekročiť limit zálohy. Konfigurácia neobsahuje tajomstvá v UI.

Každé fyzické odoslanie má kontrolu UTF-8 veľkosti serializovaných textových
správ, protokolovej rezervy a rezervovaného výstupu. Je to konzervatívny rozpočet,
nie tokenizer alebo billing usage. Plán a memory rezervujú 2048 výstupných tokenov;
batch má najviac min(24000, floor(window/3)). Kontrola platí aj pri pokračovaní
useknutého JSON a pri raste už vygenerovaných súborov medzi dávkami. Sedí pred
resilience a fyzickým meteringom: lokálny overflow nevolá sieť, nerezervuje call
ani nespúšťa retry. Transport/provider môže mať ďalšie vlastné limity.

Preflight už veľkého snapshotu a nedávnych správ prebehne pred prijatím mesačnej
úlohy; HTTP 413 je čitateľný `context_limit`. Preflight rezervuje miesto pre
systém, plán a memory. Autoritatívna je následná presná kontrola každého
zostaveného payloadu; zhrnutie či neskoršie generated files/continuation môžu
vyčerpať kapacitu až počas už prijatej úlohy. Vtedy sa run zastaví, minuté volania
ostanú v spotrebe a zdroje sa neaplikujú. Súbory sa nikdy neskrátia kvôli limitu.

## Uloženie a drobné UI úpravy

Plain transcript sa ukladá v účtom oddelenom IndexedDB a pri ručnom serverovom
save aj v existujúcom owner/CAS JSONB dokumente projektu. Aj projekt obsahujúci
iba chat sa lokálne uloží. Po refreshe sa používateľ vráti do chatu; predošlé
pending review sa neobnoví ako platný súhlas. Jeho správa výslovne uvedie, že
aplikovanie nebolo potvrdené. Odmietnutý alebo použitý návrh prepíše pôvodnú
„čaká na schválenie“ správu. Toto bráni nesprávnej pamäti o aplikovanom kóde.

Kontrakt je voliteľný pre staré dokumenty, bez novej DB migrácie alebo zmeny IDB
indexov. Najviac 512 správ po 4000 znakov; nový prompt má existujúci 4000-znakový
limit. Dokument stále podlieha existujúcim owner, byte/storage a request limitom.
Transkript sa nestrihá na konci, nadmerný vstup sa odmietne. Nezavádza sa neobmedzená
archivácia, šifrovanie konverzácií ani serverový cache modelovej pamäte.

Správy sa vykresľujú ako text vrátane HTML-shaped vstupu, bez HTML vykonávania.
Pôvodný nepravdivý pevný štítok „200k ctx“ nahradí „kontext podľa modelu“.
Layout, farby a komponenty sa nemenili. Serverové uloženie skenuje tajomstvá
aj v transkripte; owner iného účtu k nemu nepristúpi. Chat je súčasťou kapacity
projektu, nie telemetrie alebo tokenového ledgeru. Neexportuje sa ako zdrojový
súbor do GitHubu/ZIP.

## Overenie a otvorené brány

- Hlavná sada: **787 passed / 98 skipped**; presné log SHA-256 sú v
  `deploy/lovable-github/proof/AI-CONTEXT-VERIFICATION.json`. Platený live smoke
  je vylúčený a všetky tri provider kľúče prázdne. TypeScript, strict native/CLI
  graf, build a lint sa overujú nad konečnými zdrojmi.
- PostgreSQL 16.15/18.6: 76/76 na každej verzii. Tri nové scenáre navyše oproti
  WS-9 pokrývajú owner-only transcript/credential refusal, úplný IDB↔Hono↔PG
  round-trip a metered memory+plan+batch (tri calls, jedna mesačná úloha).
  Nadmerný snapshot nezvýši kvótu ani ledger. Migrácie stále 001–009, clustre
  loopback/SCRAM/private temp, potvrdené zastavenie a odstránenie.
- Unit testy: 26 správ, úplný kód za pôvodnou hranicou 3000 znakov; všetky staršie
  správy naprieč viacerými memory dávkami; invalid/truncated/secret memory;
  cancel počas sumarizácie; UTF-8 a výstupná rezerva; najmenší fallback limit;
  accumulated generated code a continuation overflow bez ďalšieho volania;
  HTML ako text; chat-only persistence, account scope a výsledky review.
- IAB lokálna syntetická fixture: načítanie 26 správ zo servera, generovanie,
  refresh obnoví 28 správ bez platného pending súhlasu, druhá úloha, odmietnutie.
  Console ukáže zhrnutie 20 starších správ/jedno extra volanie. Finálny meter:
  dve nové mesačné úlohy, šesť reported calls, 460 input + 2040 output = 2500
  tokenov. Testovací provider/memory sú mock, nie dôkaz kvality živého modelu.
  Desktop a CSS390×844 bez horizontálneho pretečenia, bez warn/error v Console.
- Lovable overlay ani pracovná kópia sa v tejto fáze nemenili; 27 odtlačkov
  porovnaných, 10 pôvodných fingerprintov zachovaných. Predchádzajúcich 68 UI
  testov/build platí pre nezmenenú kópiu. Hosted AI wiring stále nie je hotové.

FORGE-107 ostáva čiastočné: faktická kvalita sumarizácie a dlhé reálne sessions
potrebujú golden eval set a vedome povolené živé inference. Nie je overená
<15s latencia, provider-specifická tokenizácia alebo celá škála modelov. Zhrnutie
môže vynechať či skresliť rozhodnutie; považuje sa za neoverenú pomôcku, nie zdroj
pravdy. Súčasťou ďalšej práce je inkrementálna/cache pamäť (dnes sa prefix zhrnie
pri každej dlhšej úlohe), správa veľmi dlhých transkriptov a kontext pre väčšie
projekty. Billing, auth verify/reset, reálny publish/fullstack runtime a M2–M6
zostávajú otvorené. Žiadny Lovable kredit sa nespotreboval; rezerva 30 platí.
