# GitHub konektor — stav a ďalší krok

Stav k 6. 11. 2026. Prihlásenie do Lovable aplikácie funguje. GitHub tlačidlo
v jej hostovanej verzii `EditorView.tsx` však iba vypíše „GitHub pripojenie nie je v ukážke napojené.“
Hono používa skutočný `githubSecure.ts`; starší `github.ts` nie je pripojený.
Cloud bridge GitHub routy zámerne odmieta. Preto samotný fungujúci Google login
ešte neznamená GitHub export z Lovable.

Lokálny checkout smeruje na
https://github.com/erikbabcan-commits/LOV-DEVIL-BUILDER-2026 . GitHub konektor
Codexu potvrdil účet `erikbabcan-commits` skutočným read-only volaním. Tento
konektor nedáva používateľskej aplikácii OAuth reláciu ani oprávnenia. Prepojenie
zdrojového projektu Lovable s GitHubom je tiež samostatná funkcia; nedáva
zákazníkom Forge možnosť exportovať ich vygenerované projekty.

## Implementované lokálne

- Pending OAuth aj prihlásená GitHub relácia nesú interné `ownerId` z overenej
  Hono identity. Iný účet nemôže čítať username/CSRF token, exportovať ani odpojiť
  prepojenie. Cudzí callback nevymení kód a nespotrebuje vlastníkovo pending state.
- Anonymný pilot má explicitné `ownerId=null`; jeho relácia sa nikdy automaticky
  neprevedie na prihláseného používateľa. Staré uložené relácie bez `ownerId`
  sa odmietnu: po budúcom nasadení je potrebné GitHub znovu pripojiť.
- Predvolený scope je `public_repo`; preklep v konfigurácii integráciu vypne.
  Explicitný `repo` zostáva kompatibilnou možnosťou operátora, nebol zapnutý.
  Aktívny limit konfigurácie sa uplatňuje aj na starší širší token.
- Granted scopes sa neodhadujú z requested scopes. Chýbajúce oprávnenie blokuje
  odoslanie projektu aj vo frontende. Verejný export má výslovné potvrdenie
  zverejnenia zdrojov; server vyžaduje session CSRF aj povolený Origin.
- GitHub odpovede vracajú `Cache-Control: no-store`. Token zostáva iba na serveri
  a existujúci produkčný store ho ukladá šifrovane.
- Klient viaže potvrdenie exportu aj na aktuálny účet/projekt a konkrétny CSRF
  identifikátor GitHub relácie. Po asynchrónnom overení sa väzba znova skontroluje
  pred odoslaním súborov. Prepnutie účtu alebo prepojenia vyžaduje nové potvrdenie;
  neskorá odpoveď starého exportu nemení stav nového projektu. Už prijatý zápis
  na GitHube tým nie je možné spätne zrušiť.

Testy používajú syntetické GitHub odpovede a dve skutočne podpísané aplikačné
relácie cez pripojený Hono middleware. Overujú account switch, callback, pilot,
rozsah, legacy šifrované záznamy, potvrdenie a verejný export s overením blob SHA.
Nevytvorili sa živé repozitáre. Zmeny zatiaľ nie sú nasadené ani commitnuté.

## Serverová Cloud služba a zostávajúce napojenie

Prvý serverový stavebný prvok je už implementovaný lokálne:
`server/integrations/githubPending.ts` a migrácia `004_github_pending.sql`.
V databáze je najviac jeden pending stav na interný účet. Nový začiatok nahradí
starší; state aj browser nonce sú uložené len ako SHA-256 odtlačky. Expiráciu
10 minút vyhodnocuje databáza. Jediný UPDATE consumed=false → true s kontrolou účtu, oboch odtlačkov
a expirácie spotrebuje stav pred výmenou kódu; nesprávny účet/nonce ho nespotrebuje.
Zmazanie účtu odstráni pending záznam. Helper nie je HTTP endpoint a zatiaľ nie
je zapojený do Cloud allowlistu. V rovnakom riadku sú šifrovaný PKCE verifier
a prípadné šifrované prepojenie; state a nonce zostávajú iba ako odtlačky.

`server/integrations/githubCloud.ts` implementuje začatie OAuth s PKCE S256,
jednorazovú výmenu kódu a overenie identity cez GitHub `/user`, stav a odpojenie.
Má samostatnú explicitnú konfiguráciu s pevným HTTPS callbackom `/github/callback`;
existujúcu produkčnú OAuth aplikáciu nemení. Žiada iba `public_repo`, rovnaký
limit vracia aj pri širšom staršom grante. Chýbajúci grant sa neodhaduje.
PKCE a prístupový token sú šifrované AES-256-GCM s owner/purpose AAD a samostatným
serverovým kľúčom. Token sa nevydáva klientovi; lokálna platnosť prepojenia je
najviac 24 hodín alebo kratšia expirácia GitHub tokenu. Refresh zatiaľ nie je
implementovaný; po expirácii treba pripojiť znova. Provider operácie majú spoločný
10s deadline, abort, zákaz redirectov a response limit 16 KiB. Chyby providera
neprenášajú jeho odpoveď do klienta.

Uloženie výsledku kontroluje pôvodný state aj consumed flag. Nový štart alebo
odpojenie počas výmeny zamedzí uloženiu starého výsledku. Nový štart ponechá
predošlé platné prepojenie až do úspešného dokončenia. Odpojenie vymaže aj pending
stav; ide o lokálne odpojenie, nie odvolanie OAuth súhlasu na GitHube.
HTTP router je pripravený v `server/routes/githubCloud.ts`. Aktivuje sa iba
explicitnou `opts.auth.cloudGitHub` konfiguráciou a vyžaduje Cloud validátor.
Štandardný startup ho predvolene nezapína; explicitný prepínač používa runtime
factory a kontrolu schémy podľa `docs/GITHUB-ACTIVATION.md`. Samostatné routy vyžadujú overený Cloud
JWT aj ďalší serverový bridge key; lokálna cookie nestačí. Owner sa berie výlučne
z overenej identity, nie z tela. Povolené sú presne GET status a POST start,
finish, disconnect pod `/api/cloud-github/`; JSON limit 2 KiB, strict schémy,
per-owner limiter a no-store. Generická Cloud proxy ani legacy GitHub routy
neboli pre tento účel sprístupnené. Širšia Cloud výnimka existuje iba keď je
explicitne zapojený tento router; ďalší bridge key sa nepovoľuje cez CORS.

Serverová BFF factory `server/integrations/githubBff.ts` obsluhuje štyri OAuth
akcie a šesť exportných akcií pod `/api/github-connect/`. Overí pôvodný Cloud Bearer, same-origin JSON
mutácie a pevné HTTPS adresy. Nonce generuje server a ukladá do 10-minútovej
`__Host-` HttpOnly/Secure/Lax cookie (Path=/, bez Domain). Browser nesmie dodať
nonce, owner ani transportný key. BFF pridá bridge key a podľa konfigurácie
existujúci Basic/Cloud transport, bez klientskych cookies či voľných hlavičiek.
Má 15s deadline (75s pre potvrdený export, 35s pre reconcile), 2 KiB request a 16 KiB response limit
(64 KiB pre kontrolu 40 dlhých Unicode názvov súborov) a whitelist výstupov;
nepreberá upstream cookies, hlavičky ani JSON secrets. Autorizačnú URL kontroluje
voči GitHubu, očakávanému client ID, callbacku a public-only scope.

Štrnásť HTTP/BFF testov zahŕňa podpísaný Cloud JWT → BFF → skutočný Hono → OAuth
service so simulovaným GitHubom → pg-mem → status/odpojenie. Overené sú aj
cudzí callback, key/cookie hranice, cross-site požiadavky, injection, limity,
vypnutý default, chyby a odstránenie upstream tajomstiev. Nie je to dôkaz živého
prehliadača, hostovaného Lovable ani reálneho PostgreSQL súbehu.
BFF zatiaľ nie je uložená v hostovanom Lovable. Route wiring a callback UI sú
pripravené v samostatnej lokálnej kópii `../lovable-github-local`; prenosný balík
je `deploy/lovable-github` s testami a SHA-256 manifestom. Pôvodný export sa
nemenil. Karta nahradí ukážkové tlačidlo, zobrazí iba public-only stav a má retry
aj potvrdenie odpojenia. Callback odstráni code/state z adresy a čaká na akciu
prihláseného používateľa. Zmena účtu ignoruje predchádzajúce odpovede.
60/60 UI testov, TypeScript, cielený lint a client/SSR/Workers build prešli lokálne;
serverové bridge markery neboli vo verejných assetoch. Lokálna browser kontrola
overila desktop aj 390px mobil, dlhý username, callback a jeho query sanitizáciu.
Mobilný panel projektov prešiel na existujúci Sheet bez zmeny rozloženia;
overený vstup fokusu, Shift+Tab trap a návrat na trigger po Escape.
Dokument na mobile nepretečie horizontálne. Dôkazy sú v prenášacom balíku
`deploy/lovable-github/proof`. Serverová konfigurácia, prenos do Lovable
a živý GitHub test zostávajú otvorené.
Nie je to hotový živý konektor; lokálne HTTP/UI napojenie exportu je pripravené,
ale hostovaná konfigurácia a živý súhlas/zápis ešte neprebehli.

Štyri pg-mem testy pokrývajú odtlačky, obnovenie helpera, replay, oddelenie účtov,
nonce, nahradenie, expiráciu a cascade. Samostatný real-PG scenár s ôsmimi
súbežnými spotrebovaniami je v `cloudBridgePostgres.test.ts` a prešiel na
skutočnom PostgreSQL 16.15 aj 18.6. Celkovo **30/30 PG testov** na každej verzii:
projekty, UI sync, identity, GitHub state race, neskorá výmena po novom štarte/
odpojení, podpísaný Cloud JWT → BFF → Hono → simulovaný GitHub → šifrovaný PG
záznam, výber historických exportných súborov a súbežné potvrdenie exportu.
Migrácie 001–007 sa prehrali
dvakrát v každom scenári. Samostatne sa overil upgrade naplneného v005 ledgeru,
súbeh uvoľnených názvov a zrušenie/expirácia bez znovuaktivovania UUID. DB klienti
pretekali súbežne; GitHub bol simulovaný.
Testovací Linux bol offline, preto sa použili samostatné natívne clustre na Macu,
SCRAM, súkromný dočasný adresár a loopback. Oba clustre sa zastavili a odstránili.
Produkčné migrácie sa nemenili. Logy sú v `deploy/lovable-github/proof/`.
Runner: `deploy/test-projects-native.py --bin-dir <cesta-k-dôveryhodným-binárkam>`.
Cache obsahuje presné NPM platformové balíky @embedded-postgres/darwin-arm64
16.15.0-beta.19 a 18.6.0-beta.19; runner sám nič nesťahuje ani neinštaluje.
Osem ďalších testov služby pokrýva celý simulovaný PKCE cyklus, šifrovanie,
obnovenie stavu, odpojenie/nový štart počas výmeny, scope, tampering, provider
chyby, veľkosť odpovede a abort. Živé GitHub volania sa nevykonali.

Lokálne pripravený prírastok je jednosmerný export nového verejného repozitára (FORGE-605).
`server/integrations/githubSnapshot.ts` už pripravuje serverový vstup pre tento
export: strict výber projectId/snapshotId/expectedRevision, owner-scoped DB read,
odmietnutie koša/stale revision a výhradne historické snapshot sourceFiles.
Žiadny fallback na aktuálne rozpracované workspace files; skutočný legacy HTML
snapshot sa exportuje presne ako index.html. Prázdne/poškodené zdroje, nebezpečné
cesty a rozpoznané tajomstvá sa odmietnu. Súbory majú stabilné poradie a SHA-256
fingerprint viazaný na ownera, výber a obsah. Osem unit testov a jeden real-PG
scenár prešli. Helper ešte nie je HTTP export endpoint ani publikovanie na GitHub.

## Implementovaný zápis a evidencia exportov — lokálna serverová časť

`githubWriter.ts` vytvára výhradne nový verejný repozitár. Predtým znovu overí
GitHub user ID/login a existenciu názvu; nejednoznačná odpoveď nepovolí vytvorenie.
Zachová počiatočný strom, vytvorí tree/commit, overí commit → tree aj rodiča,
posunie branch bez force a následne skontroluje ref aj blob SHA každého UTF-8
súboru. Nezapisuje workflowy, existujúce repozitáre ani nemaže dáta. API má pevný
host, zákaz redirectov, 60s deadline, response limit 128 KiB a kontrolu platného
prepojenia pred každou operáciou. Inicializačný ref môže dostať tri bezpečné GET
pokusy; zápisy sa automaticky neopakujú. Chyby providera ani token sa nevracajú.

`githubExporter.ts` a migrácia `005_github_exports.sql` tvoria prepare/confirm
pipeline. Prepare načíta historické zdroje a uloží iba metadáta, nie obsah či token.
Súhlasový fingerprint viaže ownera, request UUID, normalizovaný názov repozitára,
verejnú viditeľnosť, zdroje a konkrétne GitHub prepojenie. Potvrdenie vyžaduje
`publicConfirmed:true`, zhodný fingerprint a neexpirovanú 10-minútovú prípravu.
Pred zápisom sa znova overí revízia, obsah a prepojenie. Atómový prepared → running
claim prepustí jedinú požiadavku; ostatné čítajú stav/výsledok. Rovnaký request ID
s iným obsahom alebo ďalší request pre rezervovaný názov sú konflikt.

Súčasťou testov je 8 súbežných potvrdení na skutočnom PG: writer sa spustil raz,
výsledok sa uchoval a retry ho znovu nezapísalo. Celkovo 26 nových writer/pipeline
unit testov overuje verejnosť, konflikty, integritu, odpojenie, zmenu revízie,
expiráciu, väzbu súhlasu na cieľ a terminálne zlyhania. GitHub HTTP je simulovaný.

Limity: timeout alebo pád procesu môže ponechať running job alebo už vytvorený
repozitár. Taký výsledok vyžaduje zosúladenie s GitHubom; nenastáva blind retry,
automatický rollback či mazanie. Názov zostáva rezervovaný pre running, failed
a succeeded joby. Read-only recovery je opísané nižšie; neúplné/staršie dôkazy
a retencia ledgeru ešte potrebujú operátorský postup. Odpojenie
zastaví nasledujúcu operáciu; už prijatý GitHub zápis nemôže spätne odvolať.
Pipeline má samostatné POST `/api/cloud-github/export/prepare`, `/confirm`,
`/status`, `/review`, `/cancel`, `/reconcile` (celé prefixy sú `/api/cloud-github/export/...`). Vyžaduje overeného
Cloud ownera, BFF key a explicitne zapojený `wiring.exporter`; bez neho vracia 503.
Štandardný startup ju necháva vypnutú, kým nie sú zapnuté oba Cloud GitHub
prepínače a neprejde kontrola schémy. Browser ide iba cez príslušné
`/api/github-connect/export/...` akcie. Status berie UUID v JSON tele, nie v URL.
Strict schémy a whitelist odpovedí sú v `shared/githubExportProtocol.ts`;
rovnaký kontrakt je v lokálnom UI, bez Hono/JOSE/Node Buffer závislosti BFF.

Lokálny `GitHubExport` používa skutočný projektový zoznam cez Hono proxy,
stránkovanie, serverovú revíziu a historickú verziu. Ukážkové editorové projekty
do výberu nevkladá. Kontrola ukáže pôvodný GitHub účet, verejný cieľ, vybranú verziu
a mená/veľkosti súborov. Súhlas je predvolene vypnutý; až potom sa pošle confirm.
Po timeoute sa číta stav toho istého UUID, nie nový zápis. Session storage drží
iba UUID oddelene podľa app účtu; po reload sa obnoví stav. Obnovený nepotvrdený
pokus bez kontroly súborov sa nedá publikovať naslepo. Ledger uchováva pôvodný
GitHub username, takže výpis výsledku neprevezme meno z novšieho pripojenia.

Migrácia `006_github_export_lifecycle.sql` dopĺňa terminálne stavy `cancelled`
a `expired`. Iba návrh v `prepared` možno zrušiť; cancel berie UUID a fingerprint,
atómovým podmieneným UPDATE súperí s confirm a nikdy nezastaví už začatý zápis.
Status/review/prepare/confirm/cancel používajú databázový čas na expiráciu
nepotvrdených 10-minútových návrhov. Partial unique index uvoľní názov iba po
zrušení či expirácii. Pôvodný UUID záznam zostáva: starý confirm ani opakovaný
prepare ho neaktivuje. Nový pokus musí mať nové UUID, fingerprint a nový súhlas.
Retencia týchto tombstone záznamov zatiaľ nie je zavedená.

`review` berie iba UUID. Znovu načíta historickú verziu z vlastnej DB a overí
revíziu, zdrojový hash aj pôvodné GitHub prepojenie; vracia titul, číslo verzie,
výber a zoznam ciest/veľkostí, nikdy zdroje alebo token. Po reload UI ponúkne
„Obnoviť kontrolu súborov“, zachová rovnaký cieľ a vyžaduje nový nezaškrtnutý
súhlas. Zrušený/vypršaný návrh ukáže terminálny stav a možnosť nového exportu.
Ak súbeh vyhrá confirm, cancel vracia `export_already_started` a UI prejde na
kontrolu existujúceho jobu. Zatvorenie dialógu nie je zrušenie exportu.

Jedenásť nových UI testov pokrýva výber historickej verzie, výslovný súhlas, timeout/
status, obnovu UUID a kontroly súborov, zrušenie, expiráciu a oddelenie účtov. Päť ďalších overuje klientsky kontrakt,
odstránenie nadbytočných polí a bezpečné URL/chybové správy. Lokálny browser
overil desktop aj 390px mobile: deaktivované publikovanie pred súhlasom,
potvrdenie a simulovaný výsledok bez horizontálneho pretečenia. Dôkazy sú v
prenášacom balíku. Reálny PG scenár zahŕňa aj BFF prepare/confirm/status a cached
retry s jediným writer volaním; GitHub provider aj writer boli simulované.
Živý zápis sa nevykonal. Retencia a operátorské zotavenie neúplných/starších jobov
zostávajú otvorené.

### Obnovenie výsledku po strate odpovede alebo páde procesu

Migrácia `007_github_export_checkpoint.sql` pridáva serverový `checkpoint` JSONB
a čas úspešného zosúladenia. Writer najprv uloží overené repo ID/owner ID/branch
po vytvorení repozitára. Pred PATCH vetvy musí uložiť `commit_ready`: presný
commit, tree, rodič a cesty/SHA-1 blobov pôvodných zdrojov. Ukladanie dôkazu
kontroluje pôvodný job aj obsah a zlyhanie zastaví nasledujúci zápis. Neobsahuje
zdrojový obsah, OAuth token ani iný Secret; checkpoint sa nikdy nevydáva browseru.

`githubRecovery.ts` cez pevný GitHub API host vykoná iba GET: znovu overí user ID,
pôvodné repo ID, verejnosť a vlastníka, presný branch tip, commit/tree/rodiča
a každý exportovaný blob vrátane bežného file mode. Odmietne iný repozitár
s rovnakým názvom, prenesený/súkromný repozitár, zmenený branch tip, symlink,
neúplný/truncated strom či nesprávny obsah. Má 20s deadline, 128 KiB limit
odpovede, zákaz redirectov a opätovnú kontrolu platného pripojenia pred každým
requestom aj po poslednom čítaní. Nevykoná POST, PATCH, DELETE ani write retry.

POST `/export/reconcile` prijíma iba UUID vlastného jobu. Pri úplnom zhode sa
running/failed zmení na succeeded a uloží sa overený výsledok s časom obnovy.
CAS kontroluje aj nezmenený checkpoint; oneskorený finish pôvodného writeru
neprepíše úspešne obnovený výsledok. Opakovaný reconcile dokončeného jobu číta
cache. Nové pripojenie môže overovať iba ten istý nemenný GitHub user ID; samotné
zhodné meno nestačí. Obnova funguje aj po zmene či zmazaní pôvodného projektu,
pretože dôkaz viaže už odoslanú verziu. Názov repozitára zostáva rezervovaný.
BFF má pre reconcile 35s deadline a ostatné owner/origin/bridge hranice platia.

UI ponúka „Overiť výsledok na GitHube“ pri running/failed. Známy čiastočne
vytvorený repozitár má priamy odkaz na ručnú kontrolu. Bez `commit_ready`, pri
premenenom účte/repozitári alebo neskôr posunutej vetve sa úspech neodhaduje;
stav zostane zachovaný a používateľ dostane čitateľnú chybu. Pád po vytvorení
repozitára, ale pred uložením jeho odpovede, stále vyžaduje ručné zosúladenie.
Stromy/commity bez známeho ID sa nevyhľadávajú podľa podobnosti a nič sa nemaže.

Overenie: 19 reader testov vrátane nesprávnej identity/ID, módu a obsahu, limitov,
cancellation a zastaveného streamu; 2 nové writer testy poradia/odolnosti checkpointu;
4 pipeline testy straty PATCH odpovede, reštartu, zmeny identity a oneskoreného
finish; HTTP/BFF test vlastníctva/injection a recovery bez nového zápisu.
Reálny PG zahŕňa osem súbežných obnov, refresh pripojenia, zmazanie projektu
a podpísaný JWT → BFF → writer → PG → read-only recovery. GitHub je simulovaný.
Lokálne mobilné UI overenie prešlo: neistý výsledok → explicitná kontrola →
overený výsledok; oba screenshoty sú v `deploy/lovable-github/proof/`.

Použitý REST kontrakt: [Git references](https://docs.github.com/en/rest/git/refs#get-a-reference),
[commit objects](https://docs.github.com/en/rest/git/commits#get-a-commit-object),
[trees](https://docs.github.com/en/rest/git/trees#get-a-tree). Transport zostáva
pripnutý na podporovanú verziu `2022-11-28` (podpora podľa
[GitHub API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
do 10. 3. 2028); upgrady verzie sa majú overovať samostatne.

API kontrakty použité pri implementácii:
- https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user
- https://docs.github.com/en/rest/git/trees#create-a-tree
- https://docs.github.com/en/rest/git/refs#update-a-reference
Existujúci OAuth cookie flow nemožno jednoducho vložiť do Cloud proxy: browser
na inej doméne nemá Hono cookie a top-level callback neposiela Cloud Bearer.
Nginx Basic Auth sa zachová. Nenavrhuje sa výnimka, ktorá by sprístupnila celé API.

1. Po overení živého Cloud → Hono bridge zaviesť samostatný same-origin BFF flow.
   Klik na „Pripojiť GitHub“ odošle autentifikované POST, server overí Cloud token
   a jeho väzbu na interný účet. Vytvorí sa jednorazové state s owner ID, pevným
   callbackom a krátkou expiráciou, viazané aj na náhodný HttpOnly/Secure/Lax
   browser nonce. Povolený scope zostáva `public_repo`.
2. Callback bude na pevnej Lovable doméne. Callback stránka odstráni code/state
   z adresy bez analytiky a obnoví Cloud reláciu. Dokončenie vyžaduje znova
   overený Bearer rovnakého vlastníka aj serverové overenie nonce; pri prepnutí
   účtu sa zamietne. State sa atómovo spotrebuje pred výmenou kódu. Kód, state,
   JWT ani GitHub token nepatria do logov, chatov alebo URL ďalších presmerovaní.
3. Hono bude mať serverové prepojenie uložené podľa interného owner ID a novú
   oddelenú Cloud API sadu pre stav/export/odpojenie. BFF posiela pôvodný Cloud
   JWT cez existujúci Basic transport. Do klienta ide len stav, GitHub login
   a efektívne oprávnenia. Staré cookie endpointy zostanú oddelené.
4. Export vezme potvrdený konkrétny snapshot; zobrazí účet, názov, PUBLIC,
   počet súborov a upozornenie na verejnosť. Vytvorenie repozitára je explicitná
   akcia používateľa. Uloží sa výsledný commit SHA a repository ID; opakovaný
   request sa musí deduplikovať. Existujúci repozitár sa neprepíše.

Databázový súbeh aj BFF/HTTP transport sú lokálne overené. Pred aktiváciou treba
zapojiť hosted konfiguráciu, obnovu po zlyhaní a registráciu presného callbacku.
Existujúca OAuth aplikácia má iný callback; jeho zmenu nemožno považovať za
hotovú ani ticho rozbiť aktuálnu produkciu. Konkrétne registračné údaje a prístupy
budú pripravené na posúdenie až po implementácii a lokálnych testoch.

Akceptácia: účet A pripojí GitHub a po potvrdení exportuje verejný projekt;
účet B nič nevidí ani nespotrebuje A-čkov flow; odmietnutý súhlas a expirované
state majú retry; callback replay a cross-site požiadavky zlyhajú; account switch
počas exportu nezverejní projekt druhého účtu; odpojenie zastaví ďalšie zápisy.
Mockované testy doplní jeden autorizovaný živý export s kontrolou obsahu a SHA.

## Neskorší import a synchronizácia

Pre vybrané súkromné repozitáre a pravidelnú synchronizáciu navrhujem GitHub App
s výberom repozitárov a minimálnymi Contents oprávneniami. Je to nový prístup,
ktorý používateľ zatiaľ neschválil. Nahradenie existujúceho `public_repo` širokým
`repo` nie je súčasťou práce. Budúca synchronizácia pôjde cez vetvu a PR,
bez force push; webhooky s podpisom, deduplikáciou a kontrolou inštalácie.

Aktuálne GitHub odporúča Apps pre jemnejšie práva, výber repozitárov a krátke
tokeny. OAuth `public_repo` povoľuje zápisy do verejných repozitárov, nie iba
jedného vybraného. Zdroje:

- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps

Lovable zostatok naposledy 32,8 a záväzná rezerva 30: toto je lokálna príprava,
bez ďalších Lovable generácií, hosted buildov, nákupov alebo zmien oprávnení.
