# WS-3 — funkčné šablóny a použiteľný prvý krok

Overený prírastok na vetve `codex/ws4-sandbox-isolation`, bez commitov a bez nasadenia.
Ide o frontend šablóny a opravy prvého používateľského toku; celý backlog zostáva otvorený.

## Implementácia

- `src/templates/registry.ts`: 12 React/TypeScript projektov po 13 súborov,
  samostatné funkčné aplikácie v `src/templates/blueprints/`.
- SaaS landing, Kanban, nastavenia, analytika, blog, úlohy, chat, katalóg,
  portfólio, CRM, kalendár, prihlasovací tok. Ukážkové dáta a nenapojené služby
  sú označené v samotných aplikáciách aj README exportu.
- Spoločné CSS a projektová štruktúra, 3 follow-up prompty ku každej šablóne.
  Bez sieťového AI volania, inštalácie používateľských balíčkov alebo nových závislostí Forge.
- Galéria: vyhľadávanie aj bez diakritiky, kategórie, názov a farba značky.
  Názov sa serializuje do TS a escapuje v HTML; farba prijíma iba šesťmiestny hex.
- Šablóny používajú existujúci staging/compare-and-apply mechanizmus.
  Viditeľný `ReviewPanel` umožní skontrolovať súbory, odmietnuť alebo schváliť.
  Nová verzia zachová predchádzajúci snapshot; starý návrh nemôže prepísať zmenený projekt.
- Prompt knižnica a follow-up tlačidlá skutočne predvyplnia zdieľaný composer.
  Samotný výber promptu nič negeneruje a nespotrebuje AI kvótu.
- Historické React zdroje sú voliteľný skalárny `sourceFiles` payload snapshotu.
  IndexedDB zostáva na verzii 2; staršie HTML snapshoty sa stále dajú obnoviť.
- Build odpoveď je viazaná na projekt/snapshot/obsah; stará alebo zrušená odpoveď
  sa nezobrazí v novom projekte. Zrušenie aktívneho fetchu sa prenáša runneru.
- Zdieľaný virtuálny resolver podporuje `../` importy medzi súbormi, ale odmietne
  výstup nad koreň projektu. Bez toho nešlo skompilovať zdieľaný Header.
- Obnovenie náhľadu znovu namountuje rovnaký dokument namiesto vymazania `srcdoc`.
  Kompilovaný iframe povoľuje lokálne React submit handlery (`allow-forms`),
  jeho CSP stále obsahuje `form-action 'none'` a `connect-src 'none'`.
  Nepovoľuje `allow-same-origin`, navigáciu rodiča ani popupy. Staré HTML demo
  má naďalej iba `allow-scripts`.
- Pri svetlej farbe značky sa vypočíta čitateľná farba textu tlačidla a tmavší
  textový akcent; šesťmiestna farba sa nevkladá do vykonateľného kódu.

## Obnova prihlásenia

Neúspešné login/register volanie uvoľní submit tlačidlo a ponúkne opakovanie.
Kontrola relácie má počiatočný loading stav, timeout a čitateľnú chybu pri
výpadku alebo neplatnom JSON. Výpadok, HTTP 500 ani chýbajúca auth route
sa už nepovažujú za vypnuté prihlasovanie. IndexedDB sa neobnovuje pred
úspešným overením prístupu.

Pilot bez prihlasovania vyžaduje výslovné `{ok:true,auth:'disabled'}` z
`/api/health`; health teraz uvádza `auth:'enabled'|'disabled'`. Pri upgrade
pilota treba aktualizovať aj API. Tento prírastok nemení serverové auth/CSRF
pravidlá. Následné oddelenie lokálnej IndexedDB je opísané na konci dokumentu.

## UI a overenie

Jemné doladenie zachováva pôvodný tmavý shell a modrý akcent. Nové sú stavy
načítania, chyby a opakovania náhľadu, dostupný mobilný panel projektov,
zrozumiteľnejšie úvodné texty a zjednotené detaily komponentov. Kontrastové
hranice pôvodných controls sa neznižujú pod existujúce testované limity.

Samostatný návrh [LOV-DEVIL - UI Polish](https://lovable.dev/projects/21fdbb9f-3bac-49a3-8479-875cc9734777)
vznikol v používateľom potvrdenej Chrome relácii. Konektor Lovable používal iný
účet bez kreditov. Návrh zachováva tmavý shell a modrý akcent; obsahuje Domov,
Workspace, Editor, galériu 12 ukážok, prispôsobovací modal a kontrolu zmien.
Ide o oddelený návrh s označenými ukážkovými dátami, bez napojenia na tento backend.
Obsah šablón v Lovable preto nie je totožný s funkčnou lokálnou registry.
Projekt sa nepublikoval a existujúce projekty sa neupravovali.

Priamo boli skontrolované hlavné obrazovky, galéria, branding modal a panel
schvaľovania. Následné doladenie Lovable opravilo mobilné vyhľadávacie pole;
mobilná galéria bola potom znovu vizuálne skontrolovaná. Screenshoty sú uložené
v artefaktoch tohto chatu. Export, billing a backend tohto návrhu neboli overované.

Lokálne klikacie overenie na šírke 390 px potvrdilo výber Kanban šablóny,
značku Studio Board, kontrolu 13 súborov, schválenie, skutočnú kompiláciu,
pridanie aj presun úlohy. Obnovenie preview znovu zobrazí aplikáciu.
Mobilný panel projektov drží fokus, Shift+Tab sa vracia na posledný ovládací
prvok, Escape ho zatvorí a vráti fokus. Šírka dokumentu aj viewportu bola 390 px.
Po reload sa obnovil snapshot a React súbory. Pri vypnutom mock API sa editor
nezobrazil; po štarte API a kliknutí na opakovanie sa prístup obnovil.

## Výsledky kontrol · 5. 11. 2026

| Kontrola | Výsledok |
|---|---|
| Úplná lokálna sada bez plateného live smoke | **455 passed, 22 skipped**, 33 úspešných testovacích súborov |
| Význam skipov | 21 opt-in Docker scenárov spustených osobitne + 1 pôvodný skip |
| Samostatné exportované projekty | **12/12 TypeScript + produkčný Vite build** na testovacom Linuxe |
| Skutočný rootless Linux Docker | **21/21 passed**, 58.78 s; 12 projektov + pôvodných 9 izolačných scenárov |
| TypeScript a produkčný build aplikácie | úspech; hlavný JS 367.02 kB, galéria lazy chunk 43.33 kB |
| ESLint dotknutého rozsahu | 0 chýb; 3 existujúce unused-variable warnings v `server/index.ts` |
| Git diff whitespace kontrola | úspech |

V testoch bol `MISTRAL_API_KEY` prázdny a `liveSmoke.test.ts` výslovne vylúčený.
Žiadna `.env` konfigurácia sa neprenášala na testovací Linux. Plná sada používala
dva workery bez oslabovania asercií alebo predlžovania timeoutov. Prvý lokálny
samostatný template build na vyťaženom Macu prekročil timeout; za dôkaz 12/12
sa počíta úspešný následný beh na Linuxe. Prvý rozšírený Docker test nesprávne
posielal UI pole `action` do striktného protokolu; po oprave test používa rovnaké
`{path,content}` payloady ako aplikácia a všetkých 21 scenárov prešlo.

Logy Linuxu: `/home/vorkei/.cache/lov-devil-backlog/run-20261105/`
(`docker-final.log`, `templates-final.log`, `tests-final2.log`, `build-final.log`).
Linuxová plná sada pred poslednou auth opravou mala 446 passed/22 skipped;
konečná lokálna sada 455 už zahŕňa aj 9 nových auth testov.
Následne na Linuxe prešiel aj finálny typecheck a 41 cielených testov auth,
obnovy loginu, preview a serverových auth guardov (`auth-final.log`).

```sh
NODE_ENV=test MISTRAL_API_KEY= npm test -- --exclude '**/liveSmoke.test.ts' --maxWorkers=2
MISTRAL_API_KEY= npm run typecheck
NODE_ENV=production MISTRAL_API_KEY= npm run build
MISTRAL_API_KEY= npm run templates:verify
# Len oddelený neprodukčný Linux Docker daemon:
SANDBOX_TEST_DAEMON=1 bash deploy/test-sandbox.sh
```

`templates:verify` pracuje iba s dôveryhodnou registry, vytvára vlastné dočasné
adresáre, použije nainštalované schválené dependencies a priamo spustí tsc/Vite.
Neinštaluje balíčky a nespúšťa scripts z používateľského projektu.

## Zostávajúci rozsah

Šablóny sú frontend základ, nie hotový hostovaný fullstack produkt. Nepripájajú
databázu, autentifikáciu zákazníckej aplikácie ani platby. Tento prírastok
neuzatvára backend, billing, serverovú synchronizáciu projektov, tenant pentest
ani celé MVP kritériá. FORGE-401 až 403 sú čiastočné: chýbajú fullstack metadata,
DB/auth, logo/jazyk a ďalšie parametre wizardu. FORGE-303 stále nemá branches
a merge; FORGE-701 nemá všetky identity/recovery flow.
Produkcia sa nemení a logické commity sa rozdelia neskôr.

## Následný prírastok: skutočný súborový diff

`ProjectDiff` nahrádza pôvodné porovnanie pridaných HTML riadkov. Zoznam zmien
zahŕňa vytvorenie, úpravu a zmazanie súboru; detail zachová poradie a duplicity
riadkov, obe čísla riadkov a viditeľné znamienka +/−. Používateľ vyberie obe
verzie aj súbor; prvú verziu môže porovnať s prázdnym projektom. Z History
otvorí konkrétnu verziu, nie vždy posledné dva snapshoty.

Nové snapshoty majú voliteľný `parentId` (ručná zmena, checkpoint aj schválenie
návrhu). Obnovenie staršej verzie a následná úprava preto neporovnáva proti
nesúvisiacemu poslednému snapshotu. Staré záznamy bez tejto informácie majú
chronologický fallback; chýbajúci známy predchodca alebo chybný source payload
sa oznamuje používateľovi. Nejde o implementáciu vetiev alebo merge.

Výpočet porovnania riadkov má limit veľkosti tabuľky; rozsiahla zmena zobrazí
celý zmenený blok namiesto drahého hľadania minimálneho diffu. Detail zobrazuje
najprv 400 riadkov s možnosťou načítať ďalšie. Zdroj sa renderuje ako text.

Overenie: 8 nových testov (vrátane 100 deterministických rekonštrukcií oboch
originálov, rozsiahlej zmeny, opakovaných riadkov, poškodených zdrojov,
UI výberu a persistence po restore); plná sada **463 passed/22 skipped**.
TypeScript a produkčný build prešli; ESLint dotknutých diff súborov bez chýb
aj warnings. Klikacie overenie upravilo `src/brand.ts` cez Súbory, uložilo v2
a cez History otvorilo správny diff v1→v2 (+1/−1). Šírka dokumentu aj viewportu
bola 474 px, riadky sa posúvajú iba v rámci detailu. Bez nových dependencies.

## Následný prírastok: lokálna perzistencia podľa účtu

`db.ts` vyberá databázu podľa serverom overeného user ID. Pôvodný názov
`forge-builder` zostáva pilotovi, účet používa oddelený názov s URI escapovaným
ID. Schema version zostáva 2. Neprihlásený/neoverený stav úložisko uzamkne;
zlyhanie otvorenia účtovej databázy nespúšťa fallback na pilota.

Transakcia zachytí databázu pred prvým await. Viackrokový restore explicitne
posiela rovnaký názov do všetkých read operácií. Epoch hranice bráni aplikovať
starý restore aj po prepnutí A→B→A; projektový guard bráni prekrytiu nového
projektu rozpracovaným čítaním. Pri zmene hranice sa ruší čakajúci autosave
a resetuje počítadlo revízií; obnova ho posunie za uložené revízie daného účtu.

AppShell nezobrazí workspace pred výberom správneho úložiska a dokončením
obnovy. Pri zmene identity zruší AI aj sandbox, vyčistí projekt, prompt,
konzolu, súkromné UI stavy a GitHub indikátor; nový projekt začína súkromný.
Kontrola pri focus/visibility návrate karty používa najnovší auth request;
staršia neskorá odpoveď nemení identitu. Rovnaká identita pri bežnom focus
nespúšťa obnovu projektu. Starý GitHub auth response tiež nepremení indikátor.

9 nových testov používa skutočné persistence operácie nad fake-indexeddb a
AppShell: rovnaké IDs medzi účtami, izolácia všetkých typov záznamov, rozbehnutý
zápis/čítanie, A→B→A restore, nový projekt počas čítania, autosave cancellation,
locked režim, zachovanie pilota, prepnutie účtu cez session revalidáciu a
oneskorená auth odpoveď. Plná sada: **472 passed/22 skipped**. TypeScript,
produkčný build a cielený ESLint prešli. Priamo v prehliadači sa po reload
zachovala pôvodná pilotná v2 vrátane značky Studio Board Plus.

Tieto databázy nie sú šifrované ani serverovo synchronizované. Skript s právami
rovnakého origin alebo používateľ s prístupom k browser profilu môže pristupovať
k lokálnym databázam; nejde o náhradu serverového tenant authZ. Relácia sa
znovu overuje pri návrate na kartu, nie nepretržitým pollingom. Staré záznamy
bez vlastníka sa nemažú a nepriraďujú prvému účtu, ani keď vznikli v staršej
prihlásenej relácii. Budúci explicitný import potrebuje potvrdené vlastníctvo.
Nasadenie do produkcie sa nevykonalo.
