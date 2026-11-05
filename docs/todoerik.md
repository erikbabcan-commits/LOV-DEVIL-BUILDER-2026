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

### 1.2 GitHub OAuth — používateľ nastavenie preskočil

Export cez OAuth zostáva nenakonfigurovaný. Chýbajú `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` a `GITHUB_SESSION_SECRET`. `GITHUB_SESSION_DIR=/data/sessions` je už nastavený a trvalý volume je pripojený. Práva session adresára boli opravené z `0755` na `0700`; tieto práva treba zachovať. Budúci postup je v bode 3.2.

### 1.3 Disk VPS a pravidelné zálohy

- Disk je obsadený na **86 %**, voľných je približne **5,2 GB z 38 GB** dostupného súborového systému. Na serveri beží **14 kontajnerov**.
- Prečistenie build cache staršej než 168 hodín uvoľnilo **0 B**. `docker image prune` sa nevykonal. Pred odstránením ďalších dát treba posúdiť ich použitie ostatnými projektmi.
- Hetzner konzola uvádza server **CPX12, 1 vCPU, 2 GB RAM, 40 GB disk** a aktuálnu zobrazenú cenu **14,13 €/mes.**
- **Hetzner Backups: používateľ platené zálohy teraz odmietol.** Zostávajú vypnuté. Zobrazený príplatok je 20 %, približne **2,83 €/mes.**, bez aktivácie nového plateného záväzku.
- Jednorazová overená záloha databázy už existuje; nenahrádza pravidelnú zálohu ani zálohu celého VPS. Podrobnosti sú v bode 4.2.

### 1.4 Heslá, MFA a osobné zálohy

Basic Auth heslo sa nesmie ukladať do dokumentácie ani posielať do chatu. Jeho hodnota bola z oboch kópií tohto manuálu odstránená; **heslo tým nebolo zmenené ani rotované**. Uloženie do správcu hesiel sa v tomto kole neoverovalo.

- Appka: [https://lov.2.29.52.59.sslip.io](https://lov.2.29.52.59.sslip.io), Basic Auth používateľ `vorkei`.
- SSH: `ssh hetzner-vps`, identita `~/.ssh/hetzner_ed25519`. Súkromný kľúč zálohovať do chráneného úložiska, nie do repozitára.
- GitHub účet `erikbabcan-commits`: v UI overené zapnuté 2FA, nakonfigurovaný passkey aj authenticator. Starý GitHub účet nebol overený.
- Hetzner účet: UI ponúka `Enable 2FA`, teda 2FA nie je zapnutá. Aktivácia sa nevykonala; vyžaduje používateľa a podľa UI odhlási existujúce sessions.
- Uloženie údajov do správcu hesiel a záloha Macu neboli overené. Existujúce MFA nastavenia sa nemenili.
- Účty: [GitHub security](https://github.com/settings/security), [Hetzner konzola](https://console.hetzner.cloud), [Mistral konzola](https://console.mistral.ai).

## 2. Čo vyžaduje používateľa alebo ďalšie zadanie

Prihlásenie cez MFA, biometriku či obnovovacie kódy vykonáva používateľ vo vlastnom rozhraní. Tajomstvá zadáva priamo na príslušnom mieste. Pri prístupe do prihlásenej konzoly možno vykonať autorizované technické kroky vrátane nastavenia OAuth; nie sú automaticky obmedzené len na ručné vykonanie človekom.

Používateľ platené Hetzner Backups v tomto kole výslovne odmietol; zostávajú vypnuté. Zmeny DNS, serverového plánu, platieb, starých prihlasovacích údajov a právne alebo obchodné dokumenty nie sú výsledkom tohto overenia. GitHub OAuth aj Mistral rotácia sú výslovne preskočené, nie dokončené.

## 3. Technický postup pre budúce úpravy

### 3.1 Lokálny vývoj a overenie

Pracovný repozitár: `/Users/vorkei/Documents/projects/LOV-DEVIL-RELEASE/source`.

```bash
npm ci
npm run server:dev
npm run dev
```

Backend používa port 8787 a UI port 5173. Existujúci `.env` neprepisovať šablónou; pri novom prostredí vychádzať zo `server/.env.example` a doplniť údaje priamo do súkromného súboru.

Na overenie kódu sú dostupné `npm run typecheck`, `npm test`, `npm run build` a `npm run test:e2e`. **V tomto kole sa testy, typecheck ani build nespúšťali.** Test `tests/unit/server/liveSmoke.test.ts` môže pri prítomnom `MISTRAL_API_KEY` vykonať platenú inferenciu; pri overovaní bez generácie ho treba vylúčiť a testom neposkytnúť živý kľúč. Staršie počty úspešných testov nedokazujú stav aktuálneho HEAD.

### 3.2 Budúce nastavenie GitHub OAuth

Tento krok je teraz preskočený. Pri neskoršom nastavení použiť [GitHub Developer settings](https://github.com/settings/developers) a OAuth App s údajmi:

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
| GitHub OAuth | Client ID, client secret a session secret chýbajú; integrácia je nenakonfigurovaná a používateľ ju preskočil. |
| Session volume | `/data/sessions` je pripojený; opravené práva adresára sú `0700`. |
| Disk a kontajnery | 86 % obsadených, približne 5,2 GB voľných z 38 GB; 14 bežiacich kontajnerov. |
| Git | Lokálny branch `release/p0-five-blockers-20261031`, HEAD `dc6b102`, čistý strom pred úpravou tohto manuálu. Je 4 commity pred lokálne uloženou upstream referenciou; bez `fetch` nejde o potvrdenie aktuálneho vzdialeného stavu. |
| Testy a sandbox | Testy, typecheck, build ani sandbox kompilácia sa v tomto kole nespúšťali. |

### 4.2 Jednorazová databázová záloha

Vytvorená PostgreSQL záloha `database.dump`:

- VPS: `/root/lov-devil-backups/20261105T184433Z/database.dump`
- Mac: `/Users/vorkei/.local/share/lov-devil/backups/20261105T184433Z/database.dump`
- Veľkosť: **5 552 B**, súkromné práva súboru **0600**. Serverová a lokálna kópia majú zhodný SHA-256.
- `pg_restore --list` načítal **14 položiek**.
- Skutočná obnova do samostatnej dočasnej databázy prešla; overené boli **3 tabuľky**. Dočasná databáza bola následne odstránená.

Ide o **jednorazovú zálohu databázy**, nie celého VPS, pravidelnú zálohu ani zálohu projektov uložených v prehliadači v IndexedDB. Pravidelnosť, retencia a zálohy ostatných projektov zostávajú otvorené.

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

Mistral rotácia a GitHub OAuth zostávajú preskočené podľa rozhodnutia používateľa. Platené Hetzner Backups používateľ v tomto kole odmietol. Pravidelné zálohovanie preto zostáva nevyriešené; jednorazový DB dump nie je náhradou. Ďalšie prevádzkové kroky sú zapnutie Hetzner 2FA používateľom a riešenie miesta na zdieľanom VPS podľa skutočnej spotreby.

WS-1 auth a trvalé kvóty sú už implementované a v produkcii zapnuté. Ďalšie vývojové oblasti sú uložené v `source/docs/MEGA-PROMPT-LOVABLE.md`, `source/docs/WS-1-AUTH.md` a `source/docs/BACKLOG.md` vzhľadom na koreň release balíka. V samotnom repozitári začínajú tieto cesty adresárom `docs/`.

PR, merge, push a nasadenie ďalších commitov sa v tomto kole nevykonali. Po zmene domény, auth, záloh alebo konfigurácie tento manuál znovu aktualizovať podľa merania.
