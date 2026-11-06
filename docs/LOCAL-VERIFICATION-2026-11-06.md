# Lokálne overenie a usporiadanie Git histórie · 6. 11. 2026

Tento záznam patrí finálnemu lokálnemu integračnému stavu WS-3 až WS-18 pred
používateľom vyžiadanou pauzou v nových funkciách. Testovanie prebehlo na tomto
počítači v dočasných databázach, lokálnych browser fixture a Docker sandboxoch.
GitHub Actions ani CI/CD sa na tieto brány nepoužili. Dokončenie M1–M6 ani
produkčný deploy sa tým nepotvrdzuje.

## Výsledky

| Brána | Výsledok a rozsah |
|---|---|
| Hlavný Vitest | **1002 passed / 157 skipped**,78 súborov passed,5 skipped,jeden worker; platený `liveSmoke` vylúčený, všetky tri AI kľúče prázdne |
| Hlavný TypeScript | Prešiel `tsc --noEmit` |
| Natívny/CLI/fixture TypeScript | Prešiel samostatný strict graf |
| ESLint | **0 errors / 33** existujúcich warnings; warnings sa neskrývali |
| Produkčný Vite build | Prešiel s `NODE_ENV=production`; odložený editor chunk zostáva nad upozornením500kB |
| PostgreSQL16.15 | **135/135** vo finálnom sériovom behu25,58s; cluster zastavený a odstránený |
| PostgreSQL18.6 | **135/135** vo finálnom sériovom behu22,75s; cluster zastavený a odstránený |
| Docker sandbox | **21/21**,12 blueprintov a9 izolačných/chybových/runner scenárov |
| React Playwright | **22/22**,jeden worker, reálny browser/headless Chromium, bez skipov |
| Historické demo | **6/6** browser testov vrátane **112/112** vnútorných kontrol; oba inline skripty prešli syntax kontrolou |
| Moderný Lovable mirror | **146/146** v15 súboroch; TypeScript a produkčný client/SSR/Workers build prešli |
| Billing mobile | **390×844**,šírka dokumentu390, bez horizontálneho pretečenia, ročný interval zvolený, CTA fokusovateľné vo viewporte |

Billing backend má61 unit scenárov, jeho UI19 a natívna DB vetva47. Databázové
brány celkovo zahŕňajú135 kontraktov a migrácie001–010. Preskočené hlavné testy
zahŕňajú explicitne opt-in natívne a Docker vetvy, ktoré sa spúšťajú samostatne;
nie sú dôkazom vykonania plateného provider smoke testu.

## Posledné integračné opravy

Fingerprint podkladu ručného konceptu teraz zoradí zdrojové súbory podľa názvu.
Identický kód obnovený z IndexedDB preto nevyzerá ako iný podklad len pre iné
poradie polí. Regresný test používa skutočný Kanban approval, persist, CSS koncept
a obnovu projektu. Presný obsah, snapshot a epoch kontroly sa zachovali.

Súbežný plný a databázový beh na zaťaženom stroji prekročil limity štartu CLI a
natívneho fixture. Samostatný GitHub preflight následne prešiel4/4 a celá hlavná
sada1002/157. Záverečné brány sa preto spúšťajú po sebe s jedným workerom.
Rozpočet natívneho billing setup hooku je60s; test nákladového CLI má rozpočet55s
na tri samostatné procesy po15s a SQL setup. Runner má test timeout15s, setup
hook60s a celkový limit300s; tým pokrýva aj pomalý štart prvého natívneho
projektového scenára, ktorý pri zaťažení hosta prekročil pôvodných5s. SQL
connection/statement limity5s, aplikačné/provider timeouty aj kontrolné tvrdenia
sa nemenia. Obe finálne DB brány prešli135/135. Hlavný plný beh1002/157
predchádza týmto úpravám rozpočtu testov. Následne prešlo aj **80/80** cielených
billing testov (61 backend +19 UI), strict native/CLI/fixture TypeScript a lint
zmeneného testovacieho harnessu. Samostatná cost unit sada sa tu neopakovala;
tri procesy nákladového CLI pokrývajú oba finálne natívne PostgreSQL behy.

React E2E pôvodne obsahovali šesť zastaraných UI očakávaní. Aktualizované testy
prechádzajú aktuálnym wizard/review/approval tokom a immutable históriou; scenáre
sa nepreskočili. `.dockerignore` vylučuje vnorené lokálne env/session súbory z
build kontextu. Verzie ani integrity už existujúcich závislostí sa nemenili;
oficiálny `stripe`23.1.0 je jediná nová runtime závislosť.

## Rozsah prostredia a dôkazov

Docker brána použila lokálny UNIX OrbStack endpoint, Docker29.8.2,linux/aarch64,
cgroupv2 a seccomp/cgroupns. Nie je to tvrdenie o rootless ani vyhradenom
produkčnom daemone. Vlastné WS-4 worker/runner kontajnery po teste nezostali;
cache obrazov sa ponechala. Cudzie projektové kontajnery sa nemenili. Natívne
PostgreSQL používa súkromné dočasné loopback SCRAM clustre; ich zastavenie a
odstránenie musí potvrdiť koniec každého finálneho logu.

Moderný Lovable mirror má125 nezmenených zdrojových súborov. Všetkých68 hashov
prenosného overlay súhlasí s mirrorom a10 sledovaných pôvodných hashov zostalo
nezmenených. Hlavný React frontend a moderný Lovable frontend sa naďalej spúšťajú
samostatne; tento cleanup ich nezjednocuje do jedného entrypointu. Hosted Lovable
editor sa nemenil, nevytváral sa nový cloud build a neminuli sa Lovable kredity.

Billing zostáva predvolene vypnutý a povoľuje iba sandbox. Browser používa
syntetický provider boundary s reálnym Hono/auth/CSRF/SDK podpisom a testovacou
DB; mobilný GET-only scenár nevykonal platobnú mutáciu. Neboli vytvorené skutočné
Stripe produkty, ceny, zákazníci, Checkout/Portal session ani webhook endpointy.
Nevykonal sa deploy, produkčná migrácia alebo zmena env/Secrets.

Finálny strojový záznam je
[`CLEANUP-VERIFICATION.json`](../deploy/lovable-github/proof/CLEANUP-VERIFICATION.json).
Obsahuje commit testovaného runtime, odtlačky zdrojov, presné počty a odkazy na
verejné logy. [`PUBLIC-LOGS.json`](../deploy/lovable-github/proof/PUBLIC-LOGS.json)
mapuje pôvodný hash na publikovanú kópiu s odstránenými lokálnymi cestami.
Surové `.log` súbory, env, session a build adresáre sa do Git nepridávajú.
Staršie WS receipts zachovávajú výsledky a odtlačky svojich historických fáz;
nie sú automaticky overením aktuálneho stromu. Pôvodné CUA screenshoty billing
majú opravené rozmery podľa skutočného JPEG formátu. Presný mobilný gate používa
samostatný PNG [390×844](../deploy/lovable-github/proof/billing-mobile-headless.png).

## Git postup a zostávajúca práca

Integračná vetva zachováva existujúce publikované commity. Runtime a dokumentácia
s dôkazmi sa usporiadajú do samostatných commitov, potom PR do `main` a merge bez
prepisovania histórie. Úspešný status `local/sandbox-verification` smie vzniknúť
až po všetkých finálnych bránach a patrí ku konkrétnemu testovanému stromu;
nenahrádza výsledok GitHub Actions. Merge strom musí byť identický s overeným
PR stromom a lokálny `main` musí zodpovedať vzdialenému.

M1–M6 zostáva otvorený. Naďalej chýba najmä produkčná izolácia a publish runtime,
živé evaly providerov, finálna aktivácia billing/Cloud bridge a prevádzkové kroky
uvedené v [backlogu](BACKLOG.md) a [WS-18](WS-18-BILLING.md). Po Git uprataní sa
nové kódovanie pozastaví podľa zadania používateľa.
