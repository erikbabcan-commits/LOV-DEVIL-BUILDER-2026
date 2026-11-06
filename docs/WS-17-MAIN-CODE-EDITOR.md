# WS-17 — hlavný editor kódu, koncepty a nemenné verzie

Hlavný frontend teraz používa lokálne pribalený CodeMirror v záložke Code.
Uloženie ručných zmien vytvorí novú verziu projektu, zachová pôvodné zdroje
a pri React projekte spustí existujúcu kompiláciu náhľadu. Rozpracované texty
majú obnoviteľnú zálohu oddelenú od schválenej verzie.

Tento prírastok mení hlavný frontend v `source`. Lokálna Lovable kópia ani jej
zdrojový overlay sa v tejto fáze nemenia; ich samostatný editor je zdokumentovaný
vo [WS-16](WS-16-FILE-EDITOR.md). Nejde o hostovanú Lovable úpravu alebo nasadenie.

## Čo opravuje

Starší CodePane načítaval Monaco cez externý loader. Textový fallback nebol
spoľahlivo dostupný, koncepty sa zapisovali do neoddelených `sessionStorage`
kľúčov a skutočné uloženie cez `applyStagedFiles` prepisovalo existujúci snapshot
a VFS. To odporovalo nemennej histórii v IndexedDB aj serverovému CAS kontraktu.
Globálny Ctrl+S navyše mohol vytvoriť checkpoint bez použitia upraveného textu.

Teraz je `applyStagedFiles` asynchrónna operácia, ktorá overí celú dávku, aktuálny
podklad a limity projektu pred zmenou stavu. Úspešná zmena pridá jediný nový
snapshot s `kind=manual`, rodičom, vyšším číslom verzie a úplnými `sourceFiles`.
Pôvodné snapshoty aj ich VFS zostávajú nezmenené. No-op nepridáva verziu;
neplatná cesta, kolízia, chýbajúci cieľ alebo rozpoznaný credential odmietne celú
dávku. Kontrola známych tvarov kľúčov zostáva heuristikou.

## Koncepty a hranica účtu

Pri záverečnom usporiadaní repozitára sa doplnilo kanonické poradie názvov v
odtlačku podkladu. IndexedDB môže pri obnove zoradiť tie isté súbory inak; samotná
zmena ich poradia už nevytvorí falošný stale konflikt. Regresia používa skutočnú
šablónu, persist/restore a súkromný CSS koncept, bez zmeny schválených zdrojov.
Staršie uložené odtlačky sa automaticky neprepisujú; prípadný nesúlad ostáva
obnoviteľný v read-only kontrole. Presný obsah, účet, epocha a verzia sa overujú
naďalej. Finálny výsledok tohto fixu patrí cleanup dôkazu, nie pôvodným WS-17
počtom nižšie.

CodePane drží otvorené taby, aktívny súbor a rozpracovaný text mimo schváleného
VFS. Zmeny zálohuje priebežne pri editácii do existujúceho IndexedDB store
`meta`; nečaká na pôvodný tridsaťsekundový interval. Databáza je vybraná podľa
overeného účtu a každý koncept patrí projektu aj zdrojovej verzii.

- Kľúč `code-draft:v1:<project>:<snapshot>` používa pri serverových projektoch
  vzdialené ID snapshotu cez `remoteSnapshotIds`. Lokálne remapovanie ID pri
  opätovnom otvorení preto samo osebe nezruší identitu konceptu.
- Podklad obsahuje presný serializovaný zdroj, projekt, snapshot, aktívnu verziu,
  historický pohľad, vetvu a epochu účtu. Pred použitím sa porovnáva celý podklad,
  nie iba názov súboru alebo číslo verzie.
- Každé asynchrónne čítanie a zapisovanie drží zachytený názov databázy.
  Zmena účtu alebo zamknutie okamžite skryje predchádzajúci editor; neskorý
  výsledok sa nemôže aplikovať na workspace nového účtu.
- Kým sa záloha načíta, rozšírený aj jednoduchý editor sú iba na čítanie.
  Obnovenie nemôže prepísať text napísaný do nehotového editora.
- Ak sa zdroje medzičasom zmenili, starý koncept ostáva dostupný na kontrolu
  a kopírovanie v režime iba na čítanie. Použitie je zablokované. Explicitné
  otvorenie aktuálnych zdrojov obnoví čerstvý podklad a po potvrdení zruší koncept.
- Zatvorenie zmeneného tabu vyžaduje potvrdenie; zamietnutie zachová text.
  Chyba zálohy sa zobrazí a schválené súbory sa nemenia.

Staré neoddelené `sessionStorage` záznamy sa nečítajú, nemažú ani nemigrujú.
Bez známeho vlastníka ich nemožno priradiť novému účtu. IndexedDB záloha je
lokálne obnovenie konceptu, nie šifrovaný secrets vault alebo serverová história.

## Uloženie a konkurenčné akcie

Tlačidlo Uložiť aj Ctrl+S v Code najprv zapíšu obnoviteľnú zálohu. Po tomto
asynchrónnom kroku znovu overia podklad a až potom vytvoria novú verziu.
Globálna klávesová skratka rešpektuje spracovanú udalosť, takže nepridá druhý
checkpoint. Serverové uloženie zostáva samostatným explicitným CAS krokom.

Po úspešnom lokálnom uložení sa záloha pôvodného konceptu vyčistí. Ak nová verzia
obsahuje `src/main.tsx`, zavolá sa existujúci build endpoint; oneskorený výsledok
sa viaže na účet, projekt a vytvorenú verziu. Týmto sa nespúšťa platená AI oprava.
Statické HTML projekty používajú existujúce zloženie HTML zo súborov.

Zlyhanie zápisu projektu po vytvorení snapshotu je osobitný stav: nový snapshot
môže zostať iba v pamäti, návratová hodnota je neúspech a pôvodná záloha sa
nevyčistí. UI preto nemá tvrdiť, že verzia bola trvalo uložená. Pôvodný snapshot
sa ani pri tejto chybe neprepisuje; pred zatvorením aplikácie treba zachovať text
alebo obnoviť úspešné lokálne ukladanie.

Rozpracovaný koncept blokuje AI generovanie a opravu, ďalšie pripravené zmeny,
kompiláciu starších zdrojov, ZIP/GitHub export, serverové uloženie a prepnutie
projektu. Blokuje aj konkurenčný ručný checkpoint, uloženie cez starší dashboard
a restore histórie. Strážny stav ostáva zachovaný po odchode zo záložky Code
aj pri prezeraní histórie; samotné skrytie editora koncept nezahodí. Projektové
operácie po asynchrónnom čakaní znovu kontrolujú, či sa nezačalo editovať.

Projekt obnovený z IndexedDB sa otvorí v pracovnom priestore aj vtedy, keď má
zdroje a históriu, ale žiadnu konverzáciu. Hlavička rozlišuje „Koncept kódu“
a „Pracovná verzia“ namiesto nepodloženého všeobecného „Uložené“.

## Rozhranie a diagnostika

Zachované sú existujúce panely, tmavá téma a rozloženie. Pribudli jasné stavy
načítania, zálohy a zastaraného podkladu, ovládateľné súborové taby a dostupný
prepínač jednoduchého editora. Na úzkom displeji je zoznam súborov kompaktný
a editor využíva dostupnú šírku. Ide o decentné doladenie existujúcich komponentov.

CodeMirror sa načíta až pri otvorení Code a nepoužíva CDN. Má jazykové rozšírenia
pre TS/JS/JSX, CSS, HTML a JSON, zvýrazňovanie, číslovanie riadkov, vyhľadávanie
a základné lokálne dopĺňanie. Tab zostáva dostupný na presun fokusu. Tlačidlo
jednoduchého editora aj fallback pri chybe načítania zachovajú prístup k textu.

Chyby posledného buildu sa zobrazujú pri zodpovedajúcom súbore a v editore.
Ak správa obsahuje riadok/stĺpec, označí sa zodpovedajúci rozsah; inak začiatok
súboru. Po zmene príslušného obsahu sa stará diagnostika nevydáva za aktuálnu.
Nejde o samostatnú priebežnú TypeScript semantic diagnostiku.

## Overovanie a limity rozsahu

Overené **921 passed / 110 skipped** v hlavnej sade, platený live smoke výslovne
vylúčený a všetky tri provider kľúče prázdne. Natívny kontrakt: **88/88** na
PostgreSQL **16.15 aj 18.6**, dočasné clustre zastavené a odstránené. Prešli hlavný
aj strict native/CLI TypeScript, ESLint (0 errors / 33 existujúcich warnings),
produkčný build a `git diff --check`. Dôkazy a SHA-256 sú v
`deploy/lovable-github/proof/MAIN-CODE-EDITOR-VERIFICATION.json`.

Skutočný CodeMirror aj jednoduchý editor sa overili cez browser na desktope
a 390×844. Ručná CSS zmena vytvorila v2, kompilovaný primary button mal
`rgb(22,163,74)` a secondary ostal `rgb(100,116,139)`. Serverové uloženie rev2
a reopen zachovali obe verzie a zdroje. Samostatný dočasný koncept prežil reload
a prepnutie Alice → Bob → Alice; Bob ho nevidel. Po kontrole sa testovací komentár
odstránil bez ďalšej verzie. Dokument mal šírku 390 px pri viewport390 a konzola
finálnej relácie nemala warn/error. AI meter zostal 8/10, nové volania0.
Browser používal syntetické účty a loopback pg-mem server; natívny databázový
kontrakt je samostatný dôkaz. Jedna pôvodná 1s UI čakacia lehota pri súbežnom
zaťažení vypršala. Natívna UI suite má teraz 5s asynchrónny wait a finálne PG
behy prešli sekvenčne; pôvodný timeout zostáva zaznamenaný v dôkazoch.

Historický výsledok Lovable UI **146/146** patrí WS-16; tento prírastok jeho suite
neopakuje a nepovažuje ho za nový beh. Všetkých 68 hashov overlay zodpovedá
mirroru a 10 kontrolovaných súborov pôvodného exportu zostáva nezmenených.

Cielené scenáre pokrývajú oddelenie účtov, obnovu zálohy, remapovanie vzdialeného
ID, presný stale podklad, skoré a oneskorené akcie, Ctrl+S, nemenného rodiča,
zlyhanie zálohy/persistencie a blokovanie konkurenčných operácií. React testy
môžu nahrádzať CodeMirror textarea; skutočný editor a náhľad treba posudzovať
podľa samostatného browser dôkazu. Natívny projektový kontrakt overuje ručnú
novú verziu aj následné CAS uloženie a opätovné otvorenie na PostgreSQL.

Lokálne editorové závislosti nahradili Monaco. Produkčný build zatiaľ hlási
odložený chunk SourceEditor približne **582 kB minifikovaný / 200 kB gzip**,
teda nad predvoleným 500 kB upozornením Vite. Chunk sa načíta až pri otvorení
editora; upozornenie nie je vypnuté. Ďalšie delenie jazykových balíkov ostáva otvorené.

Prírastok posúva FORGE-302/303/1103. Plná TypeScript language service,
priebežný strict/lint/format flow z FORGE-308, branches/merge a úplný M1–M6
zostávajú otvorené. Hlavný CodePane v tejto fáze nedostáva nové add/rename/delete
ani upload ovládanie z lokálneho Lovable editora. Compile-only náhľad nie je
fullstack runtime s ľubovoľnými npm balíčkami a HMR.

Bez commitov, deployu, zmien produkčnej schémy či Secrets, platených inference
alebo čerpania Lovable kreditov. Pracovné zmeny zostávajú pripravené na neskoršie
rozdelenie do commitov spolu s ostatným rozpracovaným backlogom.
