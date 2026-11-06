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
