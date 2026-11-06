# WS-13 — cielená AI oprava overená buildom

6. 11. 2026. Lokálny prírastok FORGE-104/202/503/106/1103. Bez commitov,
nasadenia, produkčných migrácií/env zmien, platených inference alebo Lovable kreditov.

## Oprava servera

`/api/sandbox/autofix` už nežiada model o celé prepísané súbory a neskracuje kód
na 4000 znakov. Po skutočnom neúspešnom compile pošle celý aktuálny zdroj s
SHA-256 a redaktované diagnostiky. `Forge Build Repair (forge-build-patch-v1)`
používa rovnaký strict JSON patch kontrakt ako WS-12: presný hash a jedinečný
search voči pôvodnému obsahu, neprekrývajúce sa rozsahy a atomická validácia.
Model si vyberá dotknuté súbory podľa diagnostík; nie je zavedené ďalšie platené
volanie plánovača. Žiadny full-file fallback pri konflikte alebo chybnom JSON.

Pracovná kópia sa skompiluje cez ten istý injektovaný executor ako prvý build.
Ak stále obsahuje compiler chybu, dovolí sa druhá presná oprava s čerstvým kódom
a hashmi. Najviac dva modelové repair kroky a tri kompilácie. HTTP retry/failover
z WS-9 môže v rámci týchto krokov znamenať viac fyzických provider pokusov;
každý sa meria. Chybný, useknutý alebo konfliktný patch nespúšťa ďalší repair.
Infraštruktúrna chyba nikdy nie je dôvodom na platenú AI opravu.

Povolené cesty, jedinečnosť, UTF-8 veľkosti, počet súborov a dependencies sa
kontrolujú pred buildom aj pred prijatím výsledného kandidáta. Nový lokálny
súbor je možný pre chýbajúci import; traversal/zakázané znaky alebo neschválená
dependency odmietnu celý návrh. To nezavádza npm install, nový runtime ani širší
compiler whitelist. Prázdny/nesprávny vstup a credential guard zastavia build aj
AI. Diagnostiky sa redaktujú pred odoslaním modelu; do podkladov vstupuje najviac
20 chýb a výslovný počet ostatných. Zdrojový kód sa neorezáva.

Kontextový preflight s rezervou výstupu je pred mesačným admission hookom.
Priveľký prvý kontext vráti HTTP 413 bez mesačného čerpania alebo AI run/call
záznamu. Čistý build takisto nespotrebuje AI kvótu. Prijatá oprava čerpá jednu
mesačnú úlohu aj pri dvoch repair krokoch; ledger zaznamená každý fyzický request.
Admission, context a ledger chyby sa neschovávajú za chybný modelový patch.
Cancel nepoužije výsledok providera, ktorý sa dokončí až po zrušení.

API zachováva `AutofixResult` vrátane celého `finalFiles`, počtov a histórie;
pridáva voliteľné zhrnutie. `patchesApplied` je existujúci názov počtu súborových
operácií v **serverovej pracovnej kópii**, nepotvrdzuje schválenie klientom.
Neúspešný kandidát sa môže v API vrátiť na diagnostiku, UI ho nikdy nestageuje.
Žiadny project row, používateľov snapshot alebo workspace sa týmto endpointom nemení.

## Používateľský tok

Pri chybe náhľadu je v editore aj vo workspace tlačidlo „Navrhnúť AI opravu“.
Zreteľne uvádza čerpanie AI limitu a potrebu schválenia. Build sám opravu nikdy
nespustí. Výber modelu a výslovné fallback súhlasy sa prenášajú rovnako ako pri
bežnej AI úlohe; nový request nemá automatické sieťové opakovanie.

Klient overí tvar a hranice odpovede a odvodí iba skutočne zmenené/create/delete
súbory z úplného výsledku. Iba úspešný kontrolný build môže vytvoriť pending
review. Návrh otvorí existujúci Diff; na mobile „Späť ku schváleniu“ otvorí Chat.
Opravené je prepínanie cez existujúci `setMview`, aby stav, zvýraznená záložka a
CSS viditeľnosť vždy súhlasili. Vzhľad a farebná paleta zostávajú zachované.

Používateľ stále vidí pôvodnú verziu, kým neschváli návrh. Approval vytvorí nový
snapshot a bežná kompilácia zobrazí výsledok. Manuálna editácia, prepnutie projektu
alebo zrušenie počas requestu zneplatní neskorý výsledok. Historická verzia,
neuložený edit, existujúci review alebo ďalšia bežiaca úloha blokujú nový request.
Zlyhanie/kvóta/nesprávna odpoveď zanechá pôvodné zdroje bez zmien.

React kontrola: malé spoločné ovládanie, typované kontrakty, derived boolean
subscriptions, žiadne nové globálne listeners alebo knižnice, disabled gate,
textové vykreslenie modelového obsahu a čitateľné chyby. Existujúci quota refresh
číta stav zo servera a neprenáša autorizačné rozhodnutia v browser evente.

## Overenie

- **851 passed / 106 skipped** v hlavnej sade, paid live smoke vylúčený; všetky
  tri provider kľúče prázdne. TypeScript hlavnej aplikácie aj strict native/CLI
  graf, produkčný build, lint **0 errors / 40 existujúcich warnings**.
- **84/84 PostgreSQL 16.15 aj 18.6**: tri nové scenáre používajú skutočný lokálny
  compiler, skutočný Mistral adapter a syntetický HTTP transport. Overujú opravu
  jedným krokom, dva compile/patch kroky s novými hashmi a jednou mesačnou úlohou,
  aj HTTP 413 bez prijatia/čerpania. Clustre loopback/SCRAM/private temp boli
  zastavené a odstránené. Migrácie 001–009 sú bez zmien.
- Unit/UI overenie zahŕňa zdroj za 4000 znakov, Unicode/CRLF, atómové odmietnutie
  cesty/dependency/konfliktu, useknutie, bounded loop, cancel, vyčerpanie kvóty,
  celú review/approval cestu, stale source a mobilnú CSS/state väzbu.

IAB desktop 1280×720 a mobil 390×844: testovací React projekt mal syntetickú
syntax chybu `const broken = ;`. Reálny compiler vrátil chybu, explicitné AI
tlačidlo spustilo deterministický testovací patch, kontrolný build prešiel a Diff
ukázal iba `src/App.tsx`, +0/−1 riadok. Pred approval stále v1. Po schválení v2,
funkčný iframe, hlavné tlačidlo modré `rgb(37,99,235)` a druhé sivé `rgb(100,116,139)`.
Uloženie revision 2 → otvorenie zo servera → ďalšia skutočná kompilácia zachovali
výsledok a obe farby. Jedna mesačná úloha, jedno nahlásené volanie, 60 input + 25
output = 85 **syntetických** tokenov; seeded quota 8 → 9. Bez browser warn/error
a horizontálneho pretečenia dokumentu. Viewport, vlastné karty a QA servery upratané.

Presné odtlačky, logy a snímky sú v
`deploy/lovable-github/proof/AI-BUILD-REPAIR-VERIFICATION.json`.
Lovable mirror/overlay sa nemenili: 27 zhodných odtlačkov a 10 pristine súborov
exportu znovu overených. Jeho 68 UI testov/build sú skoršie overenie nezmeneného
kódu; neopakovali sa. Hosted Lovable AI wiring ostáva otvorené.

## Limity

Syntetická oprava dokazuje funkčný protokol/UI/compile/accounting, nie úspešnosť
reálneho LLM pri ľubovoľnej chybe. Úspešný compile nezaručuje zachovanie správania
aplikácie, regresné testy alebo správnosť koreňovej opravy; preto zostáva review.
FORGE-503/104 potrebujú živé golden evaly a regresné testy generovaných aplikácií.
FORGE-202 stále nie je produkčný Vite publish pipeline. Lokálny dôveryhodný test
cez HostExecutor nepotvrdzuje produkčnú izoláciu; WS-4 má samostatné Docker dôkazy.
M1 a ďalšie M2–M6 požiadavky zostávajú otvorené. Rezerva 30 Lovable kreditov platí.
