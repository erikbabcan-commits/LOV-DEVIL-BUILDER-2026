# WS-11 — zámer požiadavky a odpoveď bez zmien

6. 11. 2026. Lokálne implementované, necommitnuté a nenasadené. Prírastok
FORGE-105/102/504/509/1103; celý backlog ani uvedené kvalitatívne brány nie sú
vyhlásené za dokončené. Žiadne živé inference, Lovable kredity alebo produkčné
migrácie/credentials sa nepoužili.

## Routing

Hlavné AI UI posiela `mode:auto`. `Forge Intent Router (forge-intent-v1)` volá
zvolený model s pevným JSON kontraktom a rozlíši create/iterate/fix/explain.
Posudzuje celý aktuálny prompt a boolean hasProject, nie pokyny vložené v kóde
alebo v histórii. Zdvorilá otázka žiadajúca zmenu môže byť iterate/fix; hypotetická
otázka alebo „nič nemeň, len vysvetli“ má byť explain. Rozhodnutie modelu je
validované a ohraničené. Neplatný/truncated výsledok zastaví run, nevynúti
fallback na generovanie a neodošle raw výsledok do chatu. Semantická presnosť
rozhodnutia zostáva závislá od konkrétneho modelu a potrebuje samostatný eval.

Existujúce API požiadavky môžu stále výslovne zvoliť create/iterate/fix;
nové `explain` je výslovne bez zmien. Vynechané mode ostáva create pre starých
klientov. Auto používa aktuálne UI na landingu aj vo workspace. Žiadosť o opravu
alebo iteráciu bez zdrojových súborov skončí vysvetlením/žiadosťou o podklady,
nevymyslí náhradné súbory namiesto chýbajúceho projektu.

Classifier je normálne fyzicky merané completion volanie (max output 256), nie
neviditeľný pomocný request. Po klasifikácii pokračuje existujúca memory z WS-10,
potom buď plán/generovanie alebo odpoveď. Každé volanie má usage/cost záznam,
kontextový guard, provider deadline/cancel a rovnakých povolených fallback
príjemcov. V existujúcej DB sa aj tieto úlohy zapisujú pod kompatibilným kind `generation`;
nevzniká nový billing plán alebo typ migrácie. Celá prijatá úloha čerpá mesačný čítač raz, vrátane otázok a prípadov,
keď model spotrebuje volanie, ale vráti neplatný classifier výsledok.

## Vysvetlenie a streaming

Vetva explain používa skutočný `provider.stream`, vracia bounded `text_delta`
a done, bez plan/validation/stage/file udalostí. Nespúšťa compiler, publish ani
mutáciu projektu. Súbory a zhrnutie chatu slúžia iba ako podklady; systémový
prompt zakazuje tvrdiť, že sa niečo aplikovalo či otestovalo. JSON, ktorý model
prípadne vypíše ako text, sa v tejto vetve neparsuje na súbory.

Odpoveď má max 12000 znakov / output budget 2048. Chybný, prázdny, useknutý alebo
prerušený stream sa nevydáva za hotovú odpoveď. Pred každým uvoľnením sa skenuje
celý doterajší prefix; 256-znakový tail bráni úniku známych credential prefixov
rozdelených medzi chunkmi. Finálna odpoveď sa skenuje ešte raz. Je to doplnok
existujúceho high-confidence secret guardu, nie všeobecná DLP garancia.

Read-only UI vetva spojí skutočné streamované delty a dokončí správu bez review.
Pri cancel alebo prerušení zachová prijatý text ako výslovne neúplný. Review
invarianty pre mutačné návrhy ostávajú. Existujúci pending návrh treba aj naďalej
najprv schváliť alebo odmietnuť pred ďalšou AI úlohou; vysvetľovanie neaplikovaných
návrhov nie je samostatne implementované. Aktuálny kód je stále jediný zdroj
pravdy o vykonaných zmenách.

Kontextový preflight pri auto/explain rezervuje menší odpovedný výstup. Po
rozhodnutí sa overí aj rozpočet konkrétnej vetvy. Ak až po classifieri vyplynie,
že generovanie nezvládne kapacitu, spotrebované classifier volanie zostane v
ledgeri; nevykoná sa ďalšie volanie alebo tiché orezanie zdrojov.

## Decentné UI opravy

Composer už pripomína možnosť položiť otázku. Merač výslovne uvádza, že otázky
čerpajú AI limit. Re-run opakuje otázku patriacu ku konkrétnej odpovedi cez
zvolený AI model/auto routing; predtým opakoval posledný ľubovoľný prompt cez
Instant Draft šablónu. Kopírovanie teraz skutočne zavolá Clipboard API a úspech
hlási až po splnení Promise. Zamietnutie/nedostupnosť kopírovania je viditeľná.
Farby a rozloženie zostali zachované; frontend prešiel checklistom
`react-best-practices` (typy, existujúce accessible controls, žiadne nové
subscriptions/listeners, žiadna nová klientská knižnica). Existujúca Fork demo
akcia ani ďalšie simulované časti sa týmto nevyhlasujú za hotové.

## 150 označených eval promptov

`server/evals/intent-cases.json`: 75 SK / 75 EN unikátnych scenárov, 40 create,
40 iterate, 36 fix a 34 explain. Obsahuje zdvorilé otázky žiadajúce zmenu,
hypotetické opravy, negácie, kombinované zámery a vložené falošné router pokyny.
Ide o počiatočné ručne napísané označenia; nezávislá ľudská kontrola je otvorená.

`pnpm run ai:intent-eval` je **offline** nástroj. Nečíta dotenv, kľúče alebo DB,
nevolá API, nevykonáva inference a nič neplánuje. Vie exportovať presné modelové
vstupy na neskorší vedome povolený beh a skórovať importované pozorovania.

```sh
pnpm run ai:intent-eval -- --export-requests --output /private/intent-requests.json
pnpm run ai:intent-eval -- --predictions /private/predictions.json --output /private/intent-report.json
pnpm run ai:intent-eval -- --predictions /private/new.json --baseline /private/old-report.json
```

Export má odtlačok datasetu aj skutočného classifier promptu/verzie. Budúci
zberač výsledkov odošle modelu iba messages/options, nie case ID obsahujúce
label, očakávaný label alebo datasetový report. Chybná modelová odpoveď musí byť
prediction `null`, nesmie sa vynechať z menovateľa. Import kontroluje odtlačky,
známe/unikátne ID a formát. Vždy skóruje všetkých 150 prípadov, uvádza confusion
matrix, recall per intent a výsledky podľa jazyka. Presnosť musí byť **striktne
>90 %**. Výsledok 135/150 neprejde, 136/150 prejde. Ako baseline použi úplný
report z toho istého datasetu, s rovnakým druhom pozorovaní, poskytovateľom a
modelom. Pri zmene odtlačku promptu musí byť jeho verzia odlišná. Nový report
uvádza verziu a odtlačok promptu v baseline. Viac ako 5 % nových regresií
(8 zo 150) neprejde. Správnosť baseline sa znovu vypočíta z predicted/expected.

Exit 0 = metrické brány prešli/export sa podaril, 2 = metrická brána neprešla,
1 = chybné vstupy/IO. Voliteľný výstup je nový súbor 0600, bez prepisovania.
`--live` sa odmietne. Report vždy uvádza `inferenceVerified:false`; ani deklarované
recorded pozorovania nepredstavujú nezávisle overený modelový benchmark.
Syntetické dáta sú označené synthetic-only, nikdy sa nevydávajú za presnosť LLM.

Ukážka v `deploy/lovable-github/proof/intent-eval-fixture-report.json` má zámerne
syntetických 135 správnych / 15 chýbajúcich, takže >90 % gate **neprejde**. Dokazuje
správne fungovanie scoreru, nie kvalitu classifiera. Zodpovedajúce predictions
a export 150 vstupov sú vedľa reportu. Žiadny z týchto vstupov sa neodoslal modelu.

## Overenie a zostávajúca práca

Hlavná sada: 816 passed / 100 skipped, paid live smoke vylúčený, tri API kľúče
prázdne. TypeScript, strict native/CLI graf vrátane nového scoreru, produkčný
build a lint (0 errors / 41 baseline warnings). Finálnu úpravu quota copy navyše
pokrýva cielená UI/project-sync sada. Presné logy a SHA sú v
`AI-INTENT-VERIFICATION.json` v proof adresári.

PG 16.15 aj 18.6: 78/78 na každej verzii. Dva nové scenáre oproti WS-10 overujú
actual Mistral adapter/protokol cez syntetický HTTP transport, classifier +
streamed answer (55 input/32 output, 2 reported calls, 1 monthly task), nezmenený
DB workspace/revíziu a failed run bez generovania po chybnom intent výsledku.
Clustre boli loopback/SCRAM/private temp a zastavené/odstránené. Migrácie 001–009
sa nemenili. Unit testy pokrývajú streaming/holdback/secrets/cancel, read-only
invarianty, generovacie vetvy, prehliadačové odoslanie/Re-run/kopírovanie a presné
metrické hranice vrátane reálneho offline CLI v inom cwd.

IAB desktop a CSS390×844: otázka k existujúcemu Kanbanu → odpoveď bez review,
úkon kopírovania úspešný → Re-run ostáva otázkou. Stále verzia v1, Console dvakrát
„odpoveď bez zmien“, žiadny návrh súborov. Dve úlohy = 4 reported calls,
120 input + 70 output = 190 syntetických tokenov. Bez browser warn/error alebo
horizontálneho pretečenia. Mock classifier a text sú jasne testovacie, nie live
eval. Owned QA servery a tab boli po kontrole zastavené/zatvorené.

FORGE-105 ostáva čiastočné: reálna >90 % presnosť nie je nameraná. FORGE-102/504
potrebujú živé overenie kvality/latencie; nevyhlasuje sa <15s first-token brána.
FORGE-509 ostáva čiastočné: nie je zavedený platený zberač pozorovaní, nočný CI
beh alebo interný eval dashboard. FORGE-510 A/B/feature flags a širšie prompt
packy nie sú dokončené. Lovable hosted wiring sa nemenilo, rezerva 30 kreditov
platí. Zostáva celý rad M1 a M2–M6 položiek vrátane auth, billing a publish.
