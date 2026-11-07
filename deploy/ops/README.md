# Prevádzkové zálohy LOV-DEVIL

Tieto skripty zálohujú PostgreSQL databázu služby `lov-postgres`. Neobsahujú
zálohu celého VPS, `.env`, SSH kľúčov ani projektov uložených v IndexedDB
prehliadača. Platené Hetzner Backups zostávajú vypnuté.

## VPS

`backup-database.py` je nainštalovaný v
`/usr/local/libexec/lov-devil/backup-database.py`. Číta iba potrebné údaje
z `/opt/lov-devil/.env`; hodnoty tajomstiev nevypisuje. Pripája sa cez lokálny
socket PostgreSQL v kontajneri `lov-postgres` ako používateľ z `DATABASE_URL`.

Každý beh vytvorí custom-format dump, overí jeho čitateľnosť a obnoví ho do
samostatnej dočasnej databázy. Po kontrole aspoň troch tabuliek dočasnú databázu
odstráni a atomicky zverejní snapshot s manifestom a SHA-256. Neúspešný beh
neprepíše poslednú úspešnú zálohu. Zámok zabraňuje súbehu tohto skriptu.

Úspešné snapshoty sú v `/root/lov-devil-backups/YYYYMMDDTHHMMSSZ/`, adresáre
majú práva `0700`, súbory `0600`. Uchováva sa posledných 14 snapshotov vytvorených
týmto skriptom. Staršia ručná záloha bez manifestu sa automaticky neodstraňuje.

Systemd timer spúšťa zálohu denne o 04:00 v časovej zóne Europe/Bratislava
s náhodným oneskorením najviac päť minút. `Persistent=true` dobehne vynechaný
termín po spustení servera. Jednotky sú v `/etc/systemd/system/`.
Pri chybe služba zopakuje pokus po minúte, najviac tri spustenia počas 15 minút;
to pokrýva napríklad dobiehajúci štart PostgreSQL po reštarte VPS.

```bash
ssh hetzner-vps 'systemctl list-timers lov-devil-backup.timer --no-pager'
ssh hetzner-vps 'systemctl start lov-devil-backup.service'
ssh hetzner-vps 'journalctl -u lov-devil-backup.service -n 10 --no-pager'
ssh hetzner-vps 'python3 /usr/local/libexec/lov-devil/backup-database.py --latest'
```

Obnovenie produkčných dát je samostatný úkon: najprv zastaviť zápisy aplikácie,
urobiť aktuálnu zálohu a overiť zvolený snapshot v oddelenej databáze. Dump
neobnovovať naslepo do živej databázy.

## Mac: kópia mimo VPS

`fetch-backup.py` je nainštalovaný v
`/Users/vorkei/.local/share/lov-devil/bin/fetch-backup.py`. Používa existujúci
SSH alias `hetzner-vps` v režime `BatchMode` a nemení prihlasovacie údaje.
Preberá najnovší úspešný snapshot, overí veľkosť aj SHA-256 a až potom ho
zverejní v `/Users/vorkei/.local/share/lov-devil/backups/`.

Uchováva posledných 30 overených kópií. Záloha servera staršia než 36 hodín
sa vyhodnotí ako chyba; existujúce kópie ostanú zachované. Výsledok je v
`/Users/vorkei/.local/share/lov-devil/backup-status.json`, logy v susednom
adresári `logs/`.

LaunchAgent `local.lov-devil.backup-fetch` beží pri načítaní a každú hodinu
v 15. minúte. Používa `StartCalendarInterval`, ktorý po prebudení dobehne
vynechaný termín. Mac musí byť prihlásený, zapnutý a mať sieťový prístup k VPS.
Nejde o zálohu v ďalšej cloudovej službe ani o automatické e-mailové upozornenia.

```bash
/usr/bin/python3 /Users/vorkei/.local/share/lov-devil/bin/fetch-backup.py
launchctl print gui/$(id -u)/local.lov-devil.backup-fetch
cat /Users/vorkei/.local/share/lov-devil/backup-status.json
```

Plist je v
`/Users/vorkei/Library/LaunchAgents/local.lov-devil.backup-fetch.plist`.
Pri zmene skriptov v repozitári ich treba znovu skopírovať do uvedených
nainštalovaných ciest. Bežný redeploy API nemení tieto jednotky ani zálohy.

V overení z 5. 11. 2026 prešli reálny beh systemd služby, obnova troch tabuliek,
spustenie LaunchAgenta a zhoda kontrolných súčtov na Macu.

## Načítanie produkčných OAuth údajov

`apply-oauth-env.py` je nainštalovaný v `/usr/local/libexec/lov-devil/`.
Zo štandardného vstupu prijíma súkromný JSON s OAuth env hodnotami. Cieľové
URL sú obmedzené na túto produkciu; nikdy nevypisuje vstup ani plný inspect.
Existujúci platný session secret zachováva, chýbajúci vytvorí. Default scope
je `public_repo`; `repo` sa použije až po schválení širšieho prístupu.

Skript zachytí aktuálny kontajner, zachová jeho image ID, runtime konfiguráciu
a named volume. Pred výmenou odhalí zmenu container ID alebo `.env` spôsobenú
súbežným nasadením. Pôvodnú `.env` a inspect uloží s právami `0600` pod
`/root/lov-devil-env-rollback/`. Kontajner sa vymení bez buildovania kódu;
pri chybe sa obnoví pôvodný env a spustí pôvodný kontajner. Po úspechu ostáva
zastavený rollback kontajner na kontrolu; po overení možno odstrániť iba tento
konkrétny kontajner bez mazania volumes.

Overené boli scenáre úspechu aj zlyhania štartu s návratom k pôvodnému env.
Pri skutočnom nasadení z 5. 11. 2026 zostali image, porty, limity, restart policy,
volumes a ostatné env zachované. API je healthy a GitHub prijal aktívne client
credentials. Šifrovaný testovací session záznam bol úspešne načítaný v novom
procese a následne odstránený. Následne prešiel skutočný browser OAuth súhlas
pre účet `erikbabcan-commits` s používateľom schváleným rozsahom `public_repo`.
Pripojenie prežilo reštart API kontajnera a obnovenie stránky.

Frontendový export bol opravený pre tento rozsah: ponúkne verejný repozitár
s výslovným upozornením na zverejnenie zdrojových súborov. Potvrdenie a jeho
zrušenie sa overili v produkcii; nový repozitár sa pri teste nevytvoril.
Prešlo 395 testov (jeden preskočený, platený live smoke vylúčený) a build
vrátane TypeScript kontroly. Frontend bol nasadený výmenou indexu až po prenose
nových assets; staršie assets zostali dostupné otvoreným kartám. Predchádzajúci
build je v `/root/lov-devil-frontend-rollback/20261105-public-export/dist/`.

## Obnova staging API a runnera

`lov-devil-staging.timer` skúsi obnovu po štarte hosta a následne každých
30 sekúnd od skončenia poslednej kontroly. Docker restart politika oboch
staging kontajnerov ostáva `no`. Helper pred štartom kontroluje obraz, rolu,
loopback porty a rootless socket. API štartuje až po zdravej odpovedi runnera.
Bežiaci kontajner pri kontrole nezastavuje ani nereštartuje.

Súkromný root-owned `/etc/lov-devil/staging.env` obsahuje iba tieto názvy a
odtlačky. Použi presné nasadené názvy a celé image ID.

```dotenv
LOV_STAGING_ROOTLESS_UID=987
LOV_STAGING_RUNNER=lov-sandbox-runner-013-<release>
LOV_STAGING_RUNNER_IMAGE=sha256:<image-id>
LOV_STAGING_API=lov-devil-api-013-<release>
LOV_STAGING_API_IMAGE=sha256:<image-id>
```

Pri plánovanej odstávke najprv zastav časovač a počkaj na skončenie služby.
Pri výmene staging obrazu aktualizuj oba príslušné údaje v konfiguračnom súbore
pod zámkom `/run/lock/lov-devil-stage-switch.lock`. Odložený beh pri obsadenom
zámku dobehne pri ďalšej kontrole.

```bash
systemctl stop lov-devil-staging.timer
systemctl is-active lov-devil-staging.service
systemctl start lov-devil-staging.timer
systemctl list-timers lov-devil-staging.timer --no-pager
journalctl -u lov-devil-staging.service -n 20 --no-pager
```

## Týždenný produktový report

`product:weekly-report` berie pondelok v UTC a vracia iba agregované JSON.
Pri spustení z repo použi `DATABASE_URL` alebo explicitný súkromný súbor s právami
`0600`. Report použije read-only pripojenie s časovým limitom dotazu.

```bash
npm run --silent product:weekly-report -- --week 2026-11-02 --env-file /path/to/private.env
```

`publishedApps` počíta rôzne dvojice účet/projekt s úspešnou publikáciou v týždni.
`successfulPublications` zahŕňa aj opakované publikácie. Cohort vychádza z nových
backendových účtov. Prvý stupeň aplikácie používa uložený snapshot, ktorý je dostupný
v čase čítania, alebo úspešnú publikáciu v týždni. Preto sa môže zmeniť aj spätne.
Účet, ktorý existuje iba v Lovable Cloud, sa do cohortu dostane až cez backendový
záznam. Pri Stripe mimo live režimu je ukazovateľ `invoice.paid` nedostupný.
V live režime ide o spracovanú udalosť po publikovaní v danom týždni. Report
neobsahuje sumu, potvrdenie platby kartou, mená, e-maily ani ID účtov.
