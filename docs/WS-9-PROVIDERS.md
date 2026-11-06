# WS-9 — providery, výber modelu a ohraničený retry

Stav 6. 11. 2026: lokálne implementované, necommitnuté a nenasadené. Čiastočný
prírastok FORGE-101/106/1103. Latencia do prvého tokenu a kvalita živých modelov
nie sú zmerané; FORGE-101 ani celý M1 týmto nie sú dokončené.

## Konfigurácia a hlavné UI

`server/providers/runtime.ts` skladá Mistral Chat Completions, OpenAI Responses
alebo Claude Messages do spoločného rozhrania. Existujúci Mistral kľúč zachováva
pôvodné správanie; `AI_MISTRAL_ENABLED=0` ho vypne. Nové služby sú default vypnuté
aj pri prítomnosti globálnych kľúčov: OpenAI vyžaduje `AI_OPENAI_ENABLED=1`,
`OPENAI_API_KEY`, `OPENAI_MODEL`; Claude obdobne `AI_ANTHROPIC_ENABLED=1`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`. Model určuje operátor, nový model ID sa
neháda ani automaticky nevyberá. Toto overenie nezaplo žiadneho nového providera.

Serverový `AI_DEFAULT_MODEL` je ID zapnutého providera (`mistral`, `openai`,
`anthropic`). `AI_FALLBACK_MODELS` je najviac dvojica zapnutých ID oddelených
čiarkou; default je prázdny. Konfigurácia je v `server/.env.example` a
`deploy/.env.example`. Kľúče a voliteľné dôveryhodné `*_BASE_URL` patria iba na
server. Transport vyžaduje HTTPS bez userinfo, query a fragmentu a odmieta
presmerovanie. `PROVIDER_TIMEOUT_MS` je 100–120000 ms, default 120000; zároveň
platí celkový request deadline.

Autentifikovaný `GET /api/ai-models` vracia validovaný no-store katalóg bez
Secrets alebo endpointov. Existujúci model chip hlavného UI načíta skutočné
zapnuté modely. Instant Draft zostáva dostupný bez AI. Neplatný/starý výber
zlyhá pred mesačnou kvótou. Pri prepnutí účtu sa výber a súhlas vyčistia.

Fallback je osobitný opt-in, default off. UI pred súhlasom uvedie konkrétnych
záložných príjemcov a ďalšiu spotrebu. Požiadavka musí niesť presný aktuálny
usporiadaný zoznam `fallbackIds`; chýbajúci, zmenený alebo preusporiadaný zoznam
sa odmietne pred prijatím úlohy. Zmena modelu súhlas vymaže.

## Retry a účtovanie

Každá completion má najviac štyri fyzické pokusy: zvolený provider, jedno
opakovanie, potom najviac dvaja vopred povolení záložní príjemcovia. Úspešná
záloha zostáva aktívna v ďalších dávkach tej istej úlohy. Celá úloha má najviac
šesť dodatočných pokusov a 128 fyzických volaní. Retry používa jitter 250–375 ms
a rešpektuje Retry-After najviac do 5 s. Dlhšie čakanie sa neobíde skorým
opakovaním; môže sa použiť povolená iná služba.

Automaticky sa opakujú iba rozpoznané prechodné HTTP odmietnutia (500/502/503/
529 a 429 s platným Retry-After). Auth, kvóta/billing, refusal, 429 bez Retry-After,
nejednoznačné sieťové chyby/time-outy, chybný protokol, chybný modelový výstup
a zlyhanie účtovania sa automaticky neopakujú. Po akomkoľvek zverejnenom stream
chunku sa stream nikdy neprehráva znova. Cancel preruší aj backoff. Request
časový limit sa v chate zobrazí bezpečnou správou, manuálne zrušenie zvlášť.
Bezpečné SSE `provider_update` udalosti ukazujú retry/fallback aj v Console.

Orchestrácia leží mimo fyzického meteringu: každý skutočný pokus má vlastný
trvalý call záznam ešte pred sieťou, skutočný provider/model a známe alebo
neznáme tokeny. Celá prijatá úloha čerpá mesačný čítač iba raz. Všetky providery
zdieľajú zdravie ledgeru; zlyhanie zápisu zastaví celý fallback reťazec.
Cost snapshot z WS-8 ostáva viazaný na prijatie úlohy; ceny podľa skutočného
provider/modelu. Neznámy usage alebo sadzba sa neprezentujú ako nula.

## Protokoly a hranice

OpenAI používa Responses (`store:false`, developer role, všetky textové output
bloky a sémantické SSE udalosti). Claude používa Messages s top-level system,
aktuálne overenou hlavičkou `anthropic-version: 2026-10-21`, Bearer auth,
textovými blokmi, stop dôvodmi a kumulatívnym stream usage. Zdroje:
[OpenAI text](https://developers.openai.com/api/docs/guides/text),
[OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses),
[Claude Messages](https://platform.claude.com/docs/en/api/messages/create),
[Claude errors](https://platform.claude.com/docs/en/api/errors),
[Claude streaming](https://platform.claude.com/docs/en/build-with-claude/streaming),
[Mistral Chat](https://docs.mistral.ai/api/endpoint/chat).

Bez SDK so skrytými retry; transport robí jeden HTTP pokus. Používa ohraničené
JSON/SSE čítanie a cleanup readeru. Ide o stateless text; vision, tool use,
persistentné konverzácie a širšie modelové funkcie zostávajú otvorené. Vstupné
Claude tokeny zahŕňajú aj nahlásené cache creation/read tokeny. Aktuálna cena
má iba uncached-text basis, preto nezohľadní rozdielne cache ceny, reasoning,
provider poplatky ani finálnu faktúru. Ceny nie sú nakonfigurované živými dátami.

V lokálnom Lovable overlay pribudla iba pevná GET proxy `/api/ai-models`.
Lovable TopBar/generovanie zostávajú demo; tento prírastok ich nevydáva za
prepojenú AI. Hosted transfer, Secrets, identity binding a živé prepojenie
zostávajú otvorené. Žiadny hosted build ani kredit sa neminul; platí rezerva 30.

## Overenie

- Hlavná sada: 766 passed / 95 skipped, jeden worker; platený live smoke výslovne
  vylúčený a všetky tri API kľúče prázdne. TypeScript a produkčný build prešli.
  Lint: 0 errors / 41 existujúcich warnings; nové provider súbory čisté.
- Reálny PostgreSQL 16.15 aj 18.6: 73/73 na každej verzii; migrácie 001–009,
  loopback/SCRAM/private temp a potvrdené zastavenie/odstránenie clustrov.
  Päť nových scenárov preveruje skutočné Hono/adaptér protokoly cez falošný
  HTTP transport, per-attempt token/cost rows, sticky backup, priamy Claude,
  nesúhlas, chybu ledgeru a zrušenie počas backoff. Žiadne živé inference.
- Lokálna Lovable kópia: 68/68, TypeScript, cielený lint, client/SSR/Workers build.
  Overené zhodné SHA-256 všetkých 27 overlay súborov a 10 pôvodných fingerprintov.
- IAB hlavné UI desktop a 390×844: Mistral výpadok → retry → explicitne povolený
  OpenAI fallback → návrh 5 súborov → odmietnutie bez úpravy projektu. Console
  zobrazuje pokusy; jedna úloha pridala štyri fyzické calls, z toho dve unknown.
  Priamy výber OpenAI pridal ďalšiu úlohu/dve calls bez fallback. Výsledok fixture:
  10/10 úloh, šesť calls, štyri reported/dve unknown, 2400 reported tokenov.
  Ide o syntetické dáta/mocked provider, skutočné protokoly pokrývajú testy vyššie.
  Mobilné menu má x=12–342 v 390px viewporte; Escape vracia fokus na model chip.

Dôkazy: `deploy/lovable-github/proof/AI-PROVIDERS-VERIFICATION.json`, screenshoty
`ai-models-*` a `ai-failover-*`, príslušné PostgreSQL logy. Lokálne QA servery
boli zastavené. Docker image sa neprebuildoval, produkčná DB/env sa nečítali
ani nemenili. Bez commitov, deployu, platených inference alebo nákupu kreditov.
