# WS-18 — predplatné, webhooky a serverový plán

Prírastok pridáva Stripe Checkout a zákaznícky portál pre mesačný/ročný Pro plán,
trvalú väzbu zákazníka na interný účet a spracovanie podpísaných webhookov.
Predplatné ovplyvňuje existujúcu serverovú AI kvótu. Návrat z platobnej stránky
ani údaj z browsera sám osebe nikdy nemení plán.

Integrácia je predvolene vypnutá a táto verzia povoľuje iba Stripe test/sandbox
prostredie. Kód nie je nasadený a v Stripe nebol vytvorený produkt, cena,
Checkout session, zákazník, portál ani webhook endpoint. Existujúce MCP OAuth
oprávnenie Read nie je oprávnenie zapisovať do Stripe. Testy nahrádzajú iba
provider boundary; aplikácia nemá produkčný mock fallback.

## Kontrakt a identita

- `GET /api/billing` vracia validovaný stav plánu, predplatného, nakonfigurované
  ceny v EUR a dostupnosť jednotlivých akcií. Vypnutý režim nezobrazuje vymyslené
  ceny alebo aktívne predplatné.
- `POST /api/billing/checkout` prijíma iba `interval=month|year` a UUID požiadavky.
  `POST /api/billing/portal` prijíma iba UUID. Identita vzniká z existujúceho
  overeného cookie účtu; nepoužíva customer ID, cenu, plán alebo návratovú URL
  dodanú klientom. Existujúce CSRF, origin a rate-limit pravidlá zostávajú platné.
- Jediná verejná mutácia je presná `POST /api/billing/webhook`. Overuje pôvodné
  nespracované bajty a `Stripe-Signature` oficiálnym SDK s toleranciou 300 sekúnd.
  Live udalosti a Connect account udalosti sa odmietajú. Rovnaký signing secret
  sa nepoužíva na identifikáciu používateľa.
- Používa sa existujúci interný používateľ; údaje v Stripe metadata ani email
  nesmú vytvoriť alebo zmeniť väzbu vlastníctva.
- Táto fáza ešte nerozširuje Lovable Cloud proxy allowlist o billing mutácie.
  Hlavný frontend je prvý napojený klient; hostovaný Lovable sa nemení.

## Databáza a ukladanie plánu

Lokálna migrácia `010_billing.sql` pridáva nullable `users.plan_expires_at` a
tabuľky `billing_accounts`, `billing_checkout_attempts`, `billing_portal_attempts`
a `billing_events`. Neobsahujú API kľúče, webhook secret, kartové údaje ani celé
webhook payloady. Provider session URL sú súkromné údaje daného účtu; nesmú ísť
do aplikačných logov alebo verejných dôkazov.

Väzba customer ID je jedinečná v oboch smeroch. Zápisy plánu, operácie Checkout
a canonical reconciliation sa serializujú na tom istom `users ... FOR UPDATE`
riadku, ktorý používa AI admission. Nestačí simulovať transakciu cez nezávislé
pool query; bez pripnutej transakčnej schopnosti billing zlyhá uzavreto.

Čerstvý účinný plán sa odvodzuje zo serverovej databázy vrátane expirácie.
Cookie JWT preto nemôže na ďalších sedem dní zachovať už odobrané oprávnenie.
Null expiry zachováva staršie operátorom pridelené plány; Stripe pridelenie Pro
má vždy konečný termín. Uplynutie termínu preto prestane povoľovať Pro limit
aj v prípade zmeškaného webhooku.

Zmena plánu nemaže ani neresetuje mesačný počet použitých AI úloh. Free má
naďalej 10 a Pro 200 úloh. Pri downgrade pod už vyčerpaný Free limit sa ďalšie
platené AI prijatie odmietne; existujúci projekt, zdroje a história sa nemenia.

## Idempotencia a neistý výsledok

Pred prvým externým vytvorením zákazníka sa uloží trvalá náhodná recovery
identita. Rovnaký customer idempotency key sa používa pri opakovaní. Pred
vytvorením Checkout session sa uloží celá nemenná príprava: UUID, vlastník,
interval, odtlačok app URL/cenníka, nárok na trial, čas a požadovaná expirácia.

Jeden účet má najviac jednu rozpracovanú Checkout prípravu. Súbežné požiadavky
sa zamknú; opakovanie nesmie vytvoriť ďalšiu session. Nové UUID s rovnakým
intervalom môže obnoviť existujúcu prípravu, aby strata browser relácie sama
osebe neumožnila druhý nákup. Zmena intervalu počas prípravy sa odmieta.
Rovnaké UUID s inými parametrami alebo vlastníkom sa nepoužije znovu.

Žiadosť má hodinovú expiráciu s rezervou nad Stripe minimom 30 minút. Pred
oneskoreným retry neznámej session sa kontroluje, či pôvodné parametre ešte
spĺňajú minimum. Definitívne expirovaná session uvoľní prípravu až po potvrdení
skutočného provider stavu; používateľ potom musí výslovne spustiť novú žiadosť.
Pri sieti alebo nejasnom výsledku sa UUID ani pôvodné parametre nemenia.

Po 23 hodinách sa neznámy externý výsledok automaticky neopakuje: provider
mohol po 24 hodinách zabudnúť idempotency cache. Stav
`billing_reconciliation_required` vyžaduje operátorské overenie existujúceho
zákazníka/session a lokálneho ledgeru. Prípravu neodstraňuj kvôli opakovaniu nákupu.

Ak lokálny ledger už pozná Stripe session a webhook sa nedoručil, operátor
môže opraviť jeden Checkout v databáze pripnutej na testovací Stripe režim.
Najprv over správnu konfiguráciu cez `billing:preflight`. V súkromnom prostredí
so zodpovedajúcim `DATABASE_URL` a existujúcimi billing premennými spusti:

```bash
pnpm run billing:reconcile-checkout --apply --user-id <owner> --request-id <uuid>
```

Príkaz vyžaduje explicitný `BILLING_MODE=test`. Načíta už evidovanú session
od Stripe a pod zámkom účtu opraví lokálny stav. `expired` uvoľní ukončený
pokus. Pri `complete` musí Stripe vrátiť konkrétne predplatné danej session
a plán sa prepočíta rovnakými pravidlami ako pri webhooku. `open` a už opravené
pokusy vracajú `updated: false`. Príkaz nevytvára Stripe objekty ani platby.
Neznáma session, nesúlad zákazníka alebo chýbajúce predplatné vyžadujú manuálne
overenie. Výstup neobsahuje identifikátory účtu, Stripe URL ani kľúče.

Trial má 14 dní a jeho použitie sa konzervatívne zaznamená už pri príprave
prvej Checkout session. Zrušenie, expirácia alebo neistý výsledok nepridelí
nový trial. Ide o pravidlo na interný účet, nie globálnu identifikáciu osoby.

## Canonical reconciliation a webhooky

Podpísaná udalosť je iba signál na opätovné načítanie aktuálnych provider dát.
Služba pod owner lockom načíta predplatné známeho customer ID. Starší webhook
preto nemôže znovu aplikovať starý payload a prepísať neskorší stav. Dedup ID
udalosti sa zapisuje v rovnakej transakcii ako plán. Zlyhanie provider čítania
alebo DB zápisu ponechá udalosť na opakovanie; úspešná duplicita nič neopakuje.

Pro môže vzniknúť iba pre aktívne/trialing testové predplatné známeho customer,
s jednou položkou, quantity 1, presným nakonfigurovaným price ID a budúcim
konečným obdobím. Cena sa overuje cez provider: EUR, presné centy, interval
month/year a interval count 1. Archivovaná cena môže zachovať už zaplatené
predplatné, ale nevytvorí nový Checkout. Neznáme future SDK statusy, neúplná
paginácia zákazníka alebo položiek a chybné provider dáta nevytvárajú nárok.

`past_due`, `unpaid`, `incomplete`, `incomplete_expired`, `paused`, skončené
obdobie a zrušenie nevytvárajú Pro. Naplánované zrušenie zachová prístup iba do
konečného termínu; `cancel_at` skracuje period end aj keď provider nepoužije
`cancel_at_period_end`. Pozastavený výber platby sa nepovažuje za zaplatený nárok.

Aj druhá fáza Checkout pred presmerovaním znovu načíta aktuálne predplatné.
Každé neterminálne predplatné blokuje nový Checkout, aj pri `past_due`, `unpaid`,
`incomplete`, `paused`, už uplynutom lokálnom období alebo neznámej cene/položkách.
Takýto zákazník má pokračovať cez portál; pôvodné predplatné sa ešte môže obnoviť
a znovu účtovať. Iba `canceled` a `incomplete_expired` sú terminálne stavy.
Tento stav sa uchováva v `has_open_subscription`, takže ho zrkadlí aj dostupnosť
tlačidla. Existencia neterminálneho predplatného uzatvorí lokálne čakajúce prípravy.
Neznáme Checkout ID v podpísanom signáli neviaže nový účet, ale známy customer
môže naďalej prejsť nezávislou canonical kontrolou predplatného.

## Konfigurácia a neskoršia aktivácia

`BILLING_ENABLED=0` je predvolený stav. Zapnutie vyžaduje `AUTH_ENABLED=1`,
pripravenú DB schému a explicitné hodnoty:

- `STRIPE_SECRET_KEY`: iba testový secret key pre backend.
- `STRIPE_WEBHOOK_SECRET`: podpisový secret konkrétneho sandbox endpointu.
- `BILLING_APP_URL`: jedna presná canonical HTTPS root URL s koncovým lomítkom;
  loopback HTTP sa dovoľuje iba v explicitnom test prostredí.
- `STRIPE_PRO_MONTHLY_PRICE_ID`, `STRIPE_PRO_YEARLY_PRICE_ID`: dve odlišné ceny.
- `BILLING_PRO_MONTHLY_EUR_CENTS`, `BILLING_PRO_YEARLY_EUR_CENTS`: presné kladné
  sumy v centoch, ktoré sa musia zhodovať s provider cenami.

Návratové URL vznikajú iba zo serverovej konfigurácie. Checkout presmerovanie
musí smerovať na `https://checkout.stripe.com`, portál na
`https://billing.stripe.com`; ľubovoľný redirect sa odmieta. Oficiálny SDK klient
má pevný Stripe endpoint, osemsekundový timeout a nemá automatické sieťové retry.

Neskôr treba samostatne pripraviť produkty/ceny, Customer Portal povolené zmeny,
zrušenie/proration a webhook registráciu v sandboxe. Pred živými platbami ešte
treba riešiť live režim, daňový/fakturačný kontrakt, dunning/refund/dispute tok,
produkčné overenie a obchodné/prevádzkové rozhodnutia. FORGE-801/803/804 sa týmto
posúvajú; FORGE-805/806 ani celý platený M1 nie sú dokončené.

## Overenie

Overené **1001 passed / 157 skipped** v hlavnej sade; platený live smoke je
výslovne vylúčený a všetky tri AI provider kľúče sú prázdne. Billing má
**61/61 backend unit** a **19/19 UI** scenárov. Natívny runner prešiel
**135/135 na PostgreSQL 16.15 aj 18.6**: pôvodných 88 scenárov plus 47 billing
kontraktov vrátane skutočného súbehu a rollbacku. Dočasné clustre sa zastavili
a odstránili. Prešli hlavný aj strict native/CLI TypeScript, ESLint (0 errors),
produkčný build a kontrola whitespace. Detailné logy/hashy eviduje
`deploy/lovable-github/proof/BILLING-VERIFICATION.json`.

Skutočný browser overil Free/ceny a prepnutie ročného intervalu, podpísaný
syntetický webhook → Pro/limit200, plánované zrušenie so zachovaním Pro, oddelený
Bob účet s Free, následný návrat Alice na Free a predvolene vypnutý billing bez
platobných akcií. Karta zostáva v existujúcom dialógu Moje projekty, bez redizajnu.
Browser nepoužil platobné tlačidlo na skutočnom Stripe webe; syntetický provider
v loopback fixture nenadväzuje externé HTTP. Hono/auth/CSRF, SDK podpis a DB tok
sú skutočné; vykonaná platba v Stripe tým nie je preukázaná.

Pôvodný CUA pokus nepreukázal presných 390 CSS px. Následný samostatný headless
browser test nad skutočnými komponentmi prešiel pri **390×844**: innerWidth aj
šírka dokumentu390, dialóg bez vodorovného pretečenia, ročný interval zvolený,
Checkout tlačidlo viditeľné a fokusovateľné vo viewporte. API odpovede sú riadené
fixture; nevykonal sa žiadny POST ani platobná akcia. Autoritatívny screenshot je
`deploy/lovable-github/proof/billing-mobile-headless.png`. Produkčná migrácia sa
nespustila, existujúce Secrets ani Lovable kredity sa nemenili.
Dokončenie tejto fázy predchádza používateľom vyžiadanému usporiadaniu commitov
a merge; celý M1–M6 zostáva neukončený a nové funkcie sa po usporiadaní pozastavia.

## Spoločný test návratu zo Stripe

Chromium pri 390 px prešiel návratom zo Stripe s Lovable draftom `929cefd`
a backendom `8026ec1`. Použil lokálne HTTPS, serverovú proxy Lovable, Hono,
podpísané syntetické ES256 relácie, skutočné mapovanie Cloud identity na účet
a dočasnú PostgreSQL 16 so schémou 018. Stripe gateway aj stránky Checkoutu
a portálu boli syntetické. Podpis webhooku vytvoril Stripe SDK a overila ho
skutočná webhook trasa.

- Po návrate z Checkoutu sa panel otvoril na Free. Overenie stavu poslalo iba
  GET. Výslovné pokračovanie poslalo ten istý identifikátor. Dva POSTy viedli
  k jednému vytvoreniu Checkoutu a jedinému riadku pokusu.
- Webhook s nesprávnym podpisom vrátil HTTP 400. Plán zostal Free a tabuľka
  udalostí prázdna. Platná udalosť prepla pôvodný účet na Pro, uzavrela pokus
  a po opätovnom doručení zostala v tabuľke raz. Druhý účet videl iba vlastný
  plán Free a žiadny čakajúci pokus.
- Po jednom výslovnom otvorení portálu sa po návrate zobrazilo ukončenie
  obnovovania na konci obdobia. Návraty ani obnovenia stavu neposlali ďalší POST.

Dočasná databáza a certifikát sa po teste odstránili. Živý Stripe, produkčné
prihlásenie, doručenie webhooku na VPS a stiahnuteľná faktúra zostávajú otvorené.
