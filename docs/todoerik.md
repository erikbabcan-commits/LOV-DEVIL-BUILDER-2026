# 📋 TODOERIK — prevádzkový manuál

> Aktualizované 5. 11. 2026 (Europe/Bratislava) · LOV-DEVIL BUILDER 2026.
> Nižšie sú výsledky tohto overenia. Historické testy ani generácie nie sú nové merania.

## 1. Rozhodnutia a najbližšie kroky

### 1.1 Mistral kľúč — používateľ rotáciu preskočil

Rotácia sa v tomto kole nevykonala. Existujúci kľúč bol overený samostatne na Macu aj vo VPS cez `GET https://api.mistral.ai/v1/models`: HTTP 200, 64 modelov, nakonfigurovaný model je dostupný. Nevykonala sa inferencia ani generovanie aplikácie. Úspešný zoznam modelov nie je test celej generácie.

Ak sa rotácia vykoná neskôr:

1. V [Mistral konzole](https://console.mistral.ai) vytvoriť nový kľúč a starý zatiaľ ponechať aktívny.
2. Nový kľúč uložiť priamo do súkromného úložiska a do príslušných `.env` na Macu a VPS; neposielať ho do chatu ani ukladať do dokumentácie.
3. Nasadiť nový kľúč do serverového procesu podľa bodu 3.3 a overiť ho zo skutočne bežiaceho prostredia.
4. Až po úspešnom overení zrušiť starý kľúč a odstrániť jeho nepotrebné lokálne kópie.

Cesty: Mac `/Users/vorkei/Documents/projects/LOV-DEVIL-RELEASE/source/.env`, VPS `/opt/lov-devil/.env`. Serverové tajomstvá patria len na server, nie do frontend premenných.

### 1.2 GitHub OAuth — overené prepojenie verejných repozitárov

Používateľ vytvoril produkčnú aplikáciu **LOV-DEVIL Forge**. Client ID a Secret sú uložené v súkromnom `/opt/lov-devil/.env` a načítané v bežiacom API. GitHub ich prijal pri kontrole tokenu: zámerne neplatný testovací token dal 404, kontrolný nesprávny client secret dal 401. Tieto kontroly nevytvorili používateľský token ani repozitár.

Nastavený je obmedzený rozsah `public_repo`; širší `repo` vyžaduje výslovnú voľbu používateľa a OAuth súhlas. Doplnený je náhodný `GITHUB_SESSION_SECRET` (64 hex znakov), `GITHUB_SESSION_DIR=/data/sessions` používa trvalý volume s právami `0700`. Šifrovaný testovací session záznam sa úspešne načítal aj v novom procese a potom bol odstránený. API kontajner bol vytvorený z rovnakého aktuálneho image; porty, limity, siete, volumes a ostatné env zostali zachované. Health je zelený a externá Basic Auth ochrana naďalej vracia 401 bez prihlásenia.

Používateľ schválil **iba `public_repo`**. Reálny browser flow prešiel výberom účtu, GitHub súhlasom aj callbackom. Editor zobrazuje `GitHub: erikbabcan-commits`; prepojenie zostalo aktívne aj po reštarte API kontajnera a obnovení stránky.

Opravený a nasadený je aj export: pri oprávnení iba `public_repo` vyberá verejný repozitár a pred publikovaním výslovne upozorní, že repozitár aj zdrojové súbory budú verejné. Pri širšom `repo` zostáva predvolený súkromný export. V produkcii sa overilo potvrdenie `PUBLIC repository` a jeho zrušenie; súbory sa neodoslali a nový repozitár nevznikol. Skutočné vytvorenie a naplnenie repozitára preto tento test nepotvrdzuje.

Prešlo **395 testov**, jeden bol preskočený; platený `liveSmoke.test.ts` bol výslovne vylúčený. `npm run build` vrátane TypeScript kontroly prešiel. Päť nových testov pokrýva viditeľnosť repozitára podľa scope a zákaz odoslania pri zrušení potvrdenia.

### 1.3 Disk VPS a pravidelné zálohy

- Disk je obsadený na **86 %**, voľných je približne **5,2 GB z 38 GB** dostupného súborového systému. Na serveri beží **14 kontajnerov**.
- Prvý prune cache staršej než 168 hodín uvoľnil 0 B. Následné čistenie nepoužívanej build cache odstránilo **786,9 MB**. Obrazy ani dáta projektov sa nemazali. Súbežne prebehlo ďalšie nasadenie a posledné meranie disku bolo **87 %, približne 4,9 GB voľných**; odstránená cache preto neznamená vyriešenie kapacity.
- Hetzner konzola uvádza server **CPX12, 1 vCPU, 2 GB RAM, 40 GB disk** a aktuálnu zobrazenú cenu **14,13 €/mes.**
- **Hetzner Backups: používateľ platené zálohy teraz odmietol.** Zostávajú vypnuté. Zobrazený príplatok je 20 %, približne **2,83 €/mes.**, bez aktivácie nového plateného záväzku.
- Pravidelné PostgreSQL zálohy sú zapnuté: denne 04:00–04:05 Europe/Bratislava, overenie reálnou obnovou a retencia 14 snapshotov na VPS. Mac ich preberá automaticky každú hodinu v 15. minúte a uchováva 30 kópií. Podrobnosti sú v bode 4.2; nejde o zálohu celého VPS.

### 1.4 Heslá, MFA a osobné zálohy

Basic Auth heslo sa nesmie ukladať do dokumentácie ani posielať do chatu. Jeho hodnota bola z oboch kópií tohto manuálu odstránená; **heslo tým nebolo zmenené ani rotované**. Uloženie do správcu hesiel sa v tomto kole neoverovalo.

- Appka: [https://lov.2.29.52.59.sslip.io](https://lov.2.29.52.59.sslip.io), Basic Auth používateľ `vorkei`.
- SSH: `ssh hetzner-vps`, identita `~/.ssh/hetzner_ed25519`. Súkromný kľúč zálohovať do chráneného úložiska, nie do repozitára.
- GitHub účet `erikbabcan-commits`: v UI overené zapnuté 2FA, nakonfigurovaný passkey aj authenticator. Starý GitHub účet nebol overený.
- Hetzner účet: UI ponúka `Enable 2FA`, teda 2FA nie je zapnutá. Používateľ aktiváciu aj v nadväzujúcom kroku ponechal na neskôr; podľa UI by odhlásila existujúce sessions.
- Uloženie údajov do správcu hesiel a záloha Macu neboli overené. Existujúce MFA nastavenia sa nemenili.
- Účty: [GitHub security](https://github.com/settings/security), [Hetzner konzola](https://console.hetzner.cloud), [Mistral konzola](https://console.mistral.ai).

## 2. Čo vyžaduje používateľa alebo ďalšie zadanie

Prihlásenie cez MFA, biometriku či obnovovacie kódy vykonáva používateľ vo vlastnom rozhraní. Tajomstvá zadáva priamo na príslušnom mieste. Pri prístupe do prihlásenej konzoly možno vykonať autorizované technické kroky vrátane nastavenia OAuth; nie sú automaticky obmedzené len na ručné vykonanie človekom.

Používateľ platené Hetzner Backups v tomto kole výslovne odmietol; zostávajú vypnuté. Zmeny DNS, serverového plánu, platieb, starých prihlasovacích údajov a právne alebo obchodné dokumenty nie sú výsledkom tohto overenia. Mistral rotácia a Hetzner 2FA zostávajú na výslovné želanie používateľa odložené. GitHub OAuth je prepojený s účtom `erikbabcan-commits` v schválenom rozsahu `public_repo`; súkromné repozitáre nie sú v schválenom rozsahu.

## 3. Technický postup pre budúce úpravy

### 3.1 Lokálny vývoj a overenie

Pracovný repozitár: `/Users/vorkei/Documents/projects/LOV-DEVIL-RELEASE/source`.

```bash
npm ci
npm run server:dev
npm run dev
```

Backend používa port 8787 a UI port 5173. Existujúci `.env` neprepisovať šablónou; pri novom prostredí vychádzať zo `server/.env.example` a doplniť údaje priamo do súkromného súboru.

Na overenie kódu sú dostupné `npm run typecheck`, `npm test`, `npm run build` a `npm run test:e2e`. Pri nadväzujúcej oprave verejného exportu prešlo 395 testov a jeden bol preskočený; platený live smoke bol vylúčený. Build vrátane TypeScript kontroly prešiel. Test `tests/unit/server/liveSmoke.test.ts` môže pri prítomnom `MISTRAL_API_KEY` vykonať platenú inferenciu; pri overovaní bez generácie ho treba vylúčiť a testom neposkytnúť živý kľúč. Staršie počty úspešných testov nedokazujú stav aktuálneho HEAD.

### 3.2 Budúce nastavenie GitHub OAuth

Produkčná aplikácia je už vytvorená a konfigurácia nasadená. Pri obnove nastavenia použiť [GitHub Developer settings](https://github.com/settings/developers) a OAuth App s údajmi:

- Application name: `LOV-DEVIL Forge`
- Homepage URL: `https://lov.2.29.52.59.sslip.io/`
- Callback URL: `https://lov.2.29.52.59.sslip.io/api/github/auth/callback`

Client secret uložiť priamo do súkromného prostredia; neposielať ho do chatu. Na VPS sú potrebné:

```dotenv
GITHUB_CLIENT_ID=<client ID z OAuth App>
GITHUB_CLIENT_SECRET=<tajomstvo uložené súkromne>
GITHUB_CALLBACK_URL=https://lov.2.29.52.59.sslip.io/api/github/auth/callback
LOV_APP_URL=https://lov.2.29.52.59.sslip.io/
GITHUB_ALLOWED_ORIGINS=https://lov.2.29.52.59.sslip.io
GITHUB_SESSION_DIR=/data/sessions
GITHUB_SESSION_SECRET=<presne 64 hex znakov, teda 32 náhodných bajtov>
```

`GITHUB_SESSION_DIR` musí byť absolútna cesta v pripojenom trvalom volume s právami `0700`. Existujúci platný session secret sa pri ďalších úpravách zachováva; jeho zmena zneplatní existujúce sessions. `GITHUB_ALLOWED_ORIGINS` je zoznam presných originov. Scope `public_repo` umožňuje verejné repozitáre; predvolený `repo` umožňuje aj súkromné a udeľuje širší prístup. Zvoliť rozsah podľa potrebného exportu.

Konfiguráciu overuje `GET /api/github/status`. Samotný tento endpoint neoverí správnosť client secretu voči GitHubu. Úplné overenie prihlásenia prebieha cez `/api/github/auth/start` v prehliadači; vytvára session. Pri výpise odpovede `/api/github/auth` nezverejňovať `csrfToken`. Export do nového repozitára je samostatná zápisová operácia.

### 3.3 Zmena `.env` a opätovné vytvorenie API kontajnera

Samotný `docker restart` **nenačíta zmenené hodnoty zo súboru `--env-file`**. Po zmene env treba kontajner znovu vytvoriť:

1. Súkromne zálohovať `.env` a konfiguráciu existujúceho kontajnera; plný `docker inspect` obsahuje tajomstvá a nesmie sa vypisovať do chatu či verejných logov.
2. Zachovať pôvodný image ID, príkaz a entrypoint, porty, siete, limity, restart policy, mounty a existujúce env vrátane auth/DB konfigurácie. Zmeniť iba zamýšľané premenné.
3. Pripraviť nový kontajner a návrat k pôvodnému stavu; pôvodný kontajner pri výmene zastaviť a ponechať na rollback do úspešného overenia. Nezačínať jeho zmazaním.
4. Overiť health, prístup cez proxy a dotknutú integráciu. Až potom uzavrieť výmenu.

`deploy/vps-redeploy.sh` synchronizuje kód, zostavuje image a vymieňa API kontajner. Nie je to samotné načítanie env a nezabezpečuje nasadenie nového UI. Pre zmenu kľúča alebo OAuth ho nespúšťať automaticky: v lokálnom branche sú aj novšie commity, ktorých nasadenie musí byť samostatne posúdené.

### 3.4 Doména a obnova VPS

Aktuálne overená adresa je [https://lov.2.29.52.59.sslip.io](https://lov.2.29.52.59.sslip.io). DNS sa v tomto kole nemenilo. Starší údaj, že `lov.whoiswho.at` smeruje na inú IP, nebol pri tomto overení znovu potvrdený. Pred zmenou A záznamu preveriť aktuálne DNS aj službu na pôvodnom cieli; potom spolu upraviť proxy, TLS a URL/allowlist OAuth.

Existujúci SSH alias:

```sshconfig
Host hetzner-vps
  HostName 2.29.52.59
  User root
  IdentityFile ~/.ssh/hetzner_ed25519
```

Obnova VPS musí zahŕňať aj PostgreSQL dáta, pripojené volumes, sieť `lov-net`, súkromné env, proxy a TLS konfiguráciu. Samotné spustenie redeploy skriptu nie je úplný postup obnovy servera so 14 kontajnermi.

## 4. Výsledky overenia z 5. 11. 2026

### 4.1 Dostupnosť a konfigurácia

| Súčasť | Overený stav |
|---|---|
| API kontajner | `lov-devil-api` je healthy; interný `/api/health` vracia `{"ok":true,"ai":"mistral"}`. |
| Verejný prístup | Externý `/api/health` bez Basic Auth vracia HTTP 401; ochrana je aktívna. |
| TLS | Certifikát verejnej adresy je platný do 3. 2. 2027; overené aj verejným TLS spojením. |
| Lokálny vývoj | UI aj backend odpovedajú HTTP 200. |
| Mistral | `/v1/models` odpovedal HTTP 200 pre Mac aj VPS; 64 modelov, nakonfigurovaný model dostupný. Inferencia sa nevykonala. |
| Používateľské auth | V produkcii je `AUTH_ENABLED=1`, beží `lov-postgres`, `DATABASE_URL` a `JWT_SECRET` sú nastavené; `/api/auth/me` bez prihlásenia vracia HTTP 401. |
| Kvóty | Pri zapnutom auth používa backend Postgres kvóty. Projekty a snapshots zostávajú v IndexedDB. |
| GitHub OAuth | Účet `erikbabcan-commits` je pripojený so schváleným `public_repo`; prihlásenie prežilo reštart API. Verejné potvrdenie exportu aj zrušenie prešli; nový repozitár sa pri teste nevytvoril. |
| Session volume | `/data/sessions` je pripojený; opravené práva adresára sú `0700`. |
| Disk a kontajnery | 86 % obsadených, približne 5,2 GB voľných z 38 GB; 14 bežiacich kontajnerov. |
| Git | Lokálny branch `release/p0-five-blockers-20261031`, HEAD `dc6b102`, čistý strom pred úpravou tohto manuálu. Je 4 commity pred lokálne uloženou upstream referenciou; bez `fetch` nejde o potvrdenie aktuálneho vzdialeného stavu. |
| Testy a build | 395 testov prešlo, jeden preskočený; platený live smoke vylúčený. TypeScript a Vite build prešli. Nový produkčný sandbox build sa v tomto kroku nespúšťal. |

### 4.2 Jednorazová databázová záloha

Vytvorená PostgreSQL záloha `database.dump`:

- VPS: `/root/lov-devil-backups/20261105T184433Z/database.dump`
- Mac: `/Users/vorkei/.local/share/lov-devil/backups/20261105T184433Z/database.dump`
- Veľkosť: **5 552 B**, súkromné práva súboru **0600**. Serverová a lokálna kópia majú zhodný SHA-256.
- `pg_restore --list` načítal **14 položiek**.
- Skutočná obnova do samostatnej dočasnej databázy prešla; overené boli **3 tabuľky**. Dočasná databáza bola následne odstránená.

Ide o **jednorazovú zálohu databázy**, nie celého VPS, pravidelnú zálohu ani zálohu projektov uložených v prehliadači v IndexedDB. Na túto jednorazovú kópiu nadväzuje pravidelné zálohovanie nižšie. Zálohy ostatných projektov a celého VPS zostávajú mimo tohto nastavenia.

### 4.2a Pravidelné zálohovanie — dokončené v nadväzujúcom kroku

- VPS: `lov-devil-backup.timer`, denne 04:00–04:05 Europe/Bratislava, `Persistent=true`; uchováva 14 overených snapshotov v `/root/lov-devil-backups/`.
- Každý nový dump prejde `pg_restore --list` aj skutočnou obnovou do oddelenej dočasnej databázy. Overená databáza sa potom odstráni; posledná úspešná záloha sa pri chybe neprepíše.
- Mac: LaunchAgent `local.lov-devil.backup-fetch`, pri načítaní a každú hodinu v 15. minúte; preberá overený dump cez existujúce SSH a overí veľkosť/SHA-256. Retencia je 30 kópií. Vynechaný kalendárny termín dobehne po prebudení.
- Obe služby prešli reálnym spustením; obnovené boli 3 tabuľky. LaunchAgent skončil s kódom 0, stav v `/Users/vorkei/.local/share/lov-devil/backup-status.json` je `ok: true`.
- Výsledky a postup správy/obnovy: `source/deploy/ops/README.md` vzhľadom na koreň release balíka (v samotnom repozitári `deploy/ops/README.md`).
- Mac musí byť zapnutý, prihlásený a pripojený. Tieto zálohy pokrývajú PostgreSQL, nie celé VPS, IndexedDB ani tajomstvá v `.env`. Automatické upozornenia na výpadok nie sú nastavené.

### 4.3 Zostávajúce obmedzenia

| Oblasť | Stav a dôsledok |
|---|---|
| Izolácia sandboxu | Kompilácia stále beží v host procese; auth ani Postgres ju neizolujú od ostatných projektov. |
| Zdieľaný VPS | 1 vCPU a 2 GB RAM obsluhujú 14 kontajnerov; sledovať disk a pamäť. |
| Projekty | Dáta v IndexedDB nie sú pokryté vytvoreným PostgreSQL dumpom. |
| Rate limit a budget | Per-user kvóty sú v Postgrese; to neznamená, že každý limiter a concurrency guard je trvalý alebo distribuovaný. |
| Uptime monitoring | Nastavenie externého monitora nebolo potvrdené; pri chránenom health URL potrebuje bezpečne uložené Basic Auth údaje. |
| Verejná prevádzka | Aktívny login a DB kvóty samy nepotvrdzujú pripravenosť billing, obnovy hesiel, právnych dokumentov ani izolovaného multi-user hostingu. |

### 4.4 Náklady podľa aktuálne zobrazenej konzoly

| Položka | Stav |
|---|---|
| Hetzner CPX12, zdieľaný server | Zobrazená aktuálna cena 14,13 €/mes. |
| Hetzner Backups | Voliteľný príplatok 20 %, približne 2,83 €/mes.; používateľ odmietol zapnutie, služba zostáva vypnutá. |
| Mistral API | Podľa spotreby; v tomto overení sa nevykonala generácia. |
| sslip.io / Let's Encrypt | Bezplatná doména služby / certifikát. |

Cena servera je zobrazená hodnota z konzoly, nie nový odhad ceny iného serverového plánu. Používateľ Backups nezapol, preto sa ich príplatok nepovažuje za aktívny náklad.

## 5. Ďalší vývoj

Mistral rotácia a Hetzner 2FA zostávajú odložené podľa rozhodnutia používateľa. GitHub OAuth prepojenie v rozsahu `public_repo` je overené vrátane zachovania po reštarte API. Verejný export má správne potvrdenie a zrušenie; reálne vytvorenie repozitára sa pri teste nevykonalo. Platené Hetzner Backups používateľ v tomto kole odmietol. Pravidelné PostgreSQL zálohy sú už nastavené: denne 04:00–04:05 Europe/Bratislava, 14 overených snapshotov na VPS; Mac automaticky preberá posledný úspešný snapshot každú hodinu v 15. minúte a uchováva 30 kópií. Mac musí byť zapnutý, prihlásený a pripojený k sieti. Nejde o zálohu celého VPS. Ďalšie prevádzkové kroky sú zapnutie Hetzner 2FA používateľom a riešenie miesta na zdieľanom VPS podľa skutočnej spotreby.

WS-1 auth a trvalé kvóty sú už implementované a v produkcii zapnuté. Ďalšie vývojové oblasti sú uložené v `source/docs/MEGA-PROMPT-LOVABLE.md`, `source/docs/WS-1-AUTH.md` a `source/docs/BACKLOG.md` vzhľadom na koreň release balíka. V samotnom repozitári začínajú tieto cesty adresárom `docs/`.

Pri oprave verejného exportu sa nasadil overený frontendový build. Súbory prechádzajúceho frontendového buildu ostali ako záloha na VPS; API image a jeho env sa pri tomto frontendovom nasadení nemenili. PR, merge ani push neboli súčasťou tohto kroku. Po zmene domény, auth, záloh alebo konfigurácie tento manuál znovu aktualizovať podľa merania.
