# WS-15 — presný ZIP aktuálnej aj historickej verzie

Lokálny Lovable overlay už namiesto demo správy stiahne skutočný ZIP. Existujúce
rozhranie zostáva zachované: tlačidlo je na desktope v TopBare, na mobile v
editore. Dialóg zobrazí verziu, počet/bajtovú veľkosť a zoznam súborov. Vie vybrať
aktuálne lokálne zdroje aj historický snapshot bez jeho obnovy. Výsledok jasne
uvádza, že sa spustilo stiahnutie; nepredstiera dokončené uloženie na disk.

Hlavná aplikácia používa rovnaké prenosné jadro. Pri exporte sa už ticho
nevynechávajú nevyhovujúce súbory a nestráca sa `.gitignore`. Pôvodné README
zostáva bajtovo zachované; opravený je aj starší ZIP helper, ktorý ho nahrádzal
generovanými pokynmi. Všetky existujúce zdroje sa exportujú bez doplnenia alebo
prepisovania. Konverzácia, relácia, modelové či infra nastavenia nie sú vstupom.
Čakajúci AI návrh sa nezahrnie, kým ho používateľ neschváli.

## Integrita a životný cyklus

- JSZip 3.10.2 sa načíta až pri exporte. V Lovable pribudla jedna priama závislosť
  a spolu 13 položiek locku; existujúce verzie, závislosti aj integrity ostali
  nezmenené. Loopback registry URL z lokálneho package managera sa neprenášajú.
- Validácia odmietne celý archív pri absolútnej/traversal/Windows ceste, backslash,
  control/bidi znaku, neprenosnom názve, príliš dlhom UTF-8 segmente, duplicate
  či kolízii súbor/adresár. Kontroluje aj NFC/case-insensitive kolízie.
- `.env*`, `.git`, registry credentials, `node_modules` a build adresáre sú
  odmietnuté. Guard na známe tvary tokenov, privátne kľúče a niektoré priradenia
  credentials blokuje celý export. Je to heuristika, nie všeobecný detektor
  všetkých tajomstiev; nenahrádza serverový vault ani kontrolu vlastných zdrojov.
- Limity: 200 súborov, 10 MiB na súbor, spolu 50 MiB meraných v UTF-8 bajtoch.
  Hono workspace má naďalej vlastné prísnejšie limity. ZIP export ich nerozširuje.
- Vstupy sa skopírujú pred asynchrónnym načítaním knižnice. Zmena účtu/projektu/
  zdrojov alebo zatvorenie Lovable dialógu zahodí oneskorený výsledok bez downloadu.
  Hlavný store kontroluje aj persistence epoch a vybranú verziu. Export nič
  neukladá na server, nemení snapshot a nespotrebuje AI úlohu.
- Chýbajúci `package.json` alebo `index.html` má jasné upozornenie. Export zámerne
  nevyrába fiktívny manifest ani nezaručuje build ľubovoľného používateľského kódu.

## Overenie

| Kontrola | Výsledok |
|---|---|
| Hlavná suite | 891 passed / 108 skipped; platený live smoke vylúčený |
| Lovable suite | 125/125 v 13 testovacích súboroch |
| Nové testy | 33 archive integrity/validation, 6 React dialog, 6 main store, 1 legacy README; core scenáre bežia v oboch projektoch |
| TypeScript | hlavný, strict native/CLI graf aj Lovable prešli |
| Build | hlavný frontend aj Lovable klient/SSR/Workers prešli |
| ESLint | hlavný 0 chýb / 34 existujúcich warnings; nové Lovable súbory čisté |
| Skutočný export/build | 12/12 pribalených šablón, oba ZIP entrypointy |

Testy otvárajú skutočné archívy s CRC kontrolou a overujú presné UTF-8/CRLF,
prázdne súbory, Unicode názvy, README a `.gitignore`. Nežiaduci obsah nevedie
k čiastočnému archívu. React testy používajú skutočný controller a ZIP builder;
interceptuje sa až browser download. Overujú aktuálnu/historickú verziu,
zavretie/unmount/zmenu zdrojov počas čakania a chybu s explicitným retry.
Hlavný store pokrýva oneskorený export po zmene identity, projektu, verzie a VFS.

Samostatný verifier vytvoril ZIP-y oboma produkčnými buildermi pre všetkých
12 dôveryhodných šablón z registra. Porovnal úplný zoznam/obsah každého súboru,
rozbalil Lovable ZIP do nového dočasného adresára mimo repozitára a spustil
skutočný `npm run build` (TypeScript + Vite). Prvá šablóna dostala čerstvý
`npm install --ignore-scripts`; ostatné zdieľali tú istú inštaláciu až po kontrole
identických dependency/script deklarácií. Názvy projektov sa prirodzene líšia.
Používateľské `.npmrc` ani secrets sa nečítali; build subprocess má obmedzené env.
Dočasný adresár bol odstránený. Toto spúšťa len vlastné pribalené šablóny, nie
ľubovoľný generovaný kód alebo jeho install skripty.

Browser lokálnej podpísanej Cloud fixture na desktope a 390×844 mobile skutočne
stiahol v2 a v1. Obe majú päť presných zdrojových súborov, po 939 nekomprimovaných
bajtoch. Následná nezávislá Python ZIP/CRC kontrola potvrdila rozdiel iba v CSS:
hlavné tlačidlo v1 `#2563eb`, v2 `#dc2626`; vedľajšie v oboch `#64748b`.
História ani serverová revízia sa exportom nemenili. Minimálny manifest tejto
browser fixture nie je dôkazom standalone buildu; ten pokrýva samostatných
12 šablón vyššie. Screenshoty a stiahnuté testovacie ZIP-y sú v
`deploy/lovable-github/proof/zip-export-*`, presné hashe v
`ZIP-DOWNLOAD-VERIFICATION.json` a `ZIP-EXPORT-VERIFICATION.json`.

Dialóg mal na mobile šírku 358 px, dokument 390 px, bez horizontálneho pretečenia.
Escape vrátil fokus na Export ZIP na oboch veľkostiach. Bob nevidel Alice zdroje
a nemohol ich exportovať; návrat Alice obnovil jej vlastnú prácu. Browser nemal
warning/error záznamy. Vlastná karta 20 bola zatvorená, viewport resetovaný a
QA servery 5191/8789 zastavené. PostgreSQL sa nemenil; posledný WS-14 dôkaz
86/86 na verziách 16.15/18.6 ostáva platný pre svoj pôvodný rozsah a nebol
prezentovaný ako nový databázový test.

## Opakovanie a prenos

Zo `source`, s lokálnym Node v PATH:

```sh
npm run zip:verify -- --fresh-install
```

Bez `--fresh-install` verifier použije už nainštalovaný lokálny toolchain.
Browser fixture sa spúšťa podľa `docs/WS-14-LOVABLE-AI.md`. Tento prírastok má
45 zdrojových/unit súborov, 17 QA súborov a `package.json`/`bun.lock`, spolu
64 položiek manifestu. Package súbory patria k označenej exportnej báze; pri
budúcom prenose treba zachovať prípadné novšie hosted dependencies.

Žiadny commit, deploy, produkčná schéma/env ani hosted Lovable build/zmena.
Žiadne platené inference alebo Lovable kredity. Pôvodných desať exportných
hashov zostáva nezmenených. FORGE-605 má reálny lokálny ZIP tok v oboch UI;
hosted prenos a živá aktivácia GitHub exportu zostávajú otvorené. Billing,
publish/CDN, fullstack runtime a celý M1–M6 cieľ ešte nie sú hotové.

API dokumentácia použitá pri implementácii:
[JSZip generateAsync](https://stuk.github.io/jszip/documentation/api_jszip/generate_async.html),
[JSZip file/createFolders](https://stuk.github.io/jszip/documentation/api_jszip/file_data.html),
[JSZip loadAsync/CRC](https://stuk.github.io/jszip/documentation/api_jszip/load_async.html).
