# 📋 TODOERIK — manuál pre človeka (všetko, čo potrebuje TVOJE ruky)
> Napísal AI agent 5. 11. 2026 · projekt: LOV-DEVIL BUILDER 2026
> Diagnostika zobrazená dole je z reálneho stavu (nie odhad).

---

## 🔴 1. UROB URČITE HNEŽ (v poriadí dôležitosti)

### 1.1 Vymeň (rotuj) Mistral API kľúč — **najdôležitejšie**
Tvoj kľúč `mstrl_whAt...qii` bol zadaný v chate a existuje na viacerých miestach (chat história, `.env` na Macu, `.env` na serveri, docker env). Chat môže zhliadnuť niekto cudzí — kľúč rotuj.
1. https://console.mistral.ai → API Keys → **deaktivuj starý kľúč, vytvor nový**
2. Nový kľúč pošli mne (alebo ho doplň sám):
   - Mac: `nano /Users/vorkei/Documents/projects/LOV-DEVIL-RELEASE/source/.env`
   - VPS: `ssh hetzner-vps` → `nano /opt/lov-devil/.env` → potom `./deploy/vps-redeploy.sh`

### 1.2 Ulož heslá do password manažéra
```
Appka (basic auth):  https://lov.2.29.52.59.sslip.io
  meno:   vorkei
  heslo:  5PxI/DOottthmIXh
SSH na VPS:          ssh hetzner-vps (kľúč ~/.ssh/hetzner_ed25519 — zálohuuj!)
Mistral konzola:     https://console.mistral.ai
GitHub OAuth:        (doplníš v bode 3.2)
```

### 1.3 Zapni 2FA všade, kde ešte nie je
- https://github.com/settings/security (účet `erikbabcan-commits` aj starý `youh4ck3dme`)
- https://console.hetzner.cloud → Security
- https://console.mistral.ai → account settings

### 1.4 Vyčisti disk na VPS (92 % — nech to neskončí plným diskom)
Čoskoro treba: `ssh hetzner-vps "docker builder prune -f && docker image prune -f"` (AI to vie spraviť, súde o starých obrazoch iných projektov musíš potvrdiť ty). Trvalejšie riešenie: kúpiť väčší disk v https://console.hetzner.cloud (CX22 → väčší server).

### 1.5 Zapni zálohy Hetzner servera
https://console.hetzner.cloud → tvoj server → **Backups** (~20 % ceny servera/mes). Beží tam 13 projektov (icoatlas, forenx, whoiswho...) — nemajú všetky zálohu **SI IBA TY vieš**.

---

## 🙋 2. ČO JA (AI) NEMôŽEM SPRAVIŤ — potrebojem tvoje ruky

| # | Úkon | Prečo nemôžem | Kde |
|---|------|---------------|-----|
| 2.1 | **Vytvárať/ryotovať účty a prihlasovať sa cez MFA** — Mistral, GitHub, Hetzner, Railway | Vyžaduje tvoju identitu, telefón, biometriku, súhlas s podmienkami | URL v bode 1 |
| 2.2 | **Platiť / pridať kartu** (Hetzner backup, platené API kredity) | Nikdy nezadávam platobné údaje | billing stránky jednotlivých služieb |
| 2.3 | **Meniť DNS záznamy** (kto spravuje whoiswho.at / vorkei.com) | Na DNS správu tvojho registratora nemám prístup — login je tvoj | pozri 3.3 |
| 2.4 | **Vytvoriť GitHub OAuth App** — z web UI sa nedá cez API ani CLI | OAuth Apps sa zakladajú len ručne v UI | pozri 3.2 |
| 2.5 | **Zálohovať tvoj Mac** a heslá v keychaine (vrátane starého GitHub účtu `youh4ck3dme` v keychaine — zmeň/vyčisti) | Keychain prístup vyžaduje tvoje prihlásenie do macOS | System Settings → Passwords |
| 2.6 | **Právne a obchodné** — `s.r.o.` v pätičke generovaných stránok, GDPR, obchodné podmienky zákazníkom | Právna zodpovednosť je vždy na človeku | — |
| 2.7 | **Fyzické veci** — reštart Macu, domáci router, pripojenie na internet, **záloha SSH kľúčov** (bez nej sa na server nedostaneš!) | Fyzický svet | — |

---

## 📖 3. KOMPLETNÝ NÁVOD — nastavenie celého projektu od nuly
(pokiaľ by si niekedy obnovoval/presúval — presný postup, aký sme robili)

### 3.1 Lokálny vývoj (Mac)
```bash
git clone https://github.com/erikbabcan-commits/LOV-DEVIL-BUILDER-2026.git
cd LOV-DEVIL-BUILDER-2026
npm ci                    # závislosti
cp server/.env.example .env   # doplň MISTRAL_API_KEY
npm run server:dev        # backend http://localhost:8787 (watch)
npm run dev               # UI http://localhost:5173
npm test                  # 379 testov, všetky musia byť zelené
```

### 3.2 GitHub OAuth App (pre export projektov do repa z UI) — CHÝBA
1. Otvor https://github.com/settings/developers → **New OAuth App**
2. Vyplň:
   - Application name: `LOV-DEVIL Forge`
   - Homepage URL: `https://lov.2.29.52.59.sslip.io/`
   - Callback URL: `https://lov.2.29.52.59.sslip.io/api/github/auth/callback`
3. Vytvor **Client Secret** → pošli mi ho (alebo ho dopeľ do `/opt/lov-devil/.env`):
   ```
   GITHUB_CLIENT_ID=...      (dostaneš hneď)
   GITHUB_CLIENT_SECRET=...  (vygeneruj v UI)
   GITHUB_CALLBACK_URL=https://lov.2.29.52.59.sslip.io/api/github/auth/callback
   LOV_APP_URL=https://lov.2.29.52.59.sslip.io/
   GITHUB_ALLOWED_ORIGINS=https://lov.2.29.52.59.sslip.io
   GITHUB_SESSION_SECRET=(vygeneruj: openssl rand -hex 32)
   ```
4. Potom `ssh hetzner-vps "docker rm -f lov-devil-api"` + znovu spustiť (alebo `./deploy/vps-redeploy.sh`)

### 3.3 Krajšia doména (namiesto sslip.io) — CHÝBA, treba len DNS
Zistenie: `lov.whoiswho.at` UŽ existuje, ale smeruje na **iný server** (37.9.175.196 — niekam, kde niečo iné beží).
1. Prihlás sa k DNS správcovi, kde spravuješ `whoiswho.at` (registrator/defaultns — zistiť vo WHOIS: https://www.nic.at/whois)
2. Uprav/zmeň A záznam: `lov.whoiswho.at → 2.29.52.59` (alebo vytvor nový, napr. `forge.whoiswho.at`)
   ⚠️ Najprv skontroluj, čo beží na 37.9.175.196 — neraz pri existujúcom zázname!
3. Povedz mi — prepnem nginx + certbot a upravím `.env` (to už viem spraviť ja)

### 3.4 Server (VPS) od nuly — aj toto už viem spraviť ja, pre referencu
1. Helsinki VPS v https://console.hetzner.cloud (CX22, ~€3,8/mes)
2. `curl -fsSL https://get.docker.com | sh`
3. Nastavenie SSH kľúča do `~/.ssh/config`:
   ```
   Host hetzner-vps
     HostName 2.29.52.59
     User root
     IdentityFile ~/.ssh/hetzner_ed25519
   ```
4. `/opt/lov-devil/.env` (šablóna v `server/.env.example`)
5. `./deploy/vps-redeploy.sh` — hotovo

---

## 🩺 4. DIAGNOSTIKA CELOVÁ (aktuálny reálny stav — 5. 11. 2026, 03:30)

### ✅ Čo funguje
| Súčasť | Stav | Odkaz/Príkaz |
|---|---|---|
| **Produkčná appka** | 🟢 beží, basic auth aktívny (401/200 overené) | https://lov.2.29.52.59.sslip.io |
| **AI generovanie** | 🟢 reálny Mistral, ~21 súborov / 55 kB na generáciu | v appke |
| **Sandbox kompilácia** | 🟢 overená (`ok:true`, CSP izolácia) | /api/sandbox/build |
| **SSL certifikát** | 🟢 Let's Encrypt ECDSA, **platnosť do 3. 2. 2027** (90 dní, auto-obnova cez certbot timer — over: `ssh hetzner-vps "systemctl list-timers | grep certbot"`) | — |
| **Docker kontajner** | 🟢 `lov-devil-api: Up 5 hours (healthy)` (RAM limit 700 MB, auto-restart) | `ssh hetzner-vps "docker ps"` |
| **GitHub repozitár** | 🟢 branch `release/p0-five-blockers-20261031` pushovaná, lokál = remote | [repo](https://github.com/erikbabcan-commits/LOV-DEVIL-BUILDER-2026/tree/release/p0-five-blockers-20261031) |
| **Testy** | 🟢 379 prechádza, typecheck OK | `npm test` |
| **Lokálny vývoj (Mac)** | 🟢 server:dev + vite stále bežia | http://localhost:5173 |
| **Redeploy skript** | 🟢 odskúšaný naostro | `./deploy/vps-redeploy.sh` |

### ⚠️ Riziká / obmedzenia pilotu (porozumie, ale nepanikár)
| Riziko | Detail | Závažnosť |
|---|---|---|
| **Disk VPS 92 % plný** (voľné 3,1 GB z 38 GB) — 13 bežiacich kontajnerov. Ak sa zaplní, všetko na serveri spadne. Nie len LOV-DEVIL. | Čistenie: bod 1.4. Trvalé riešenie: väčší server (need tvoja karta) | 🔴 vysoké |
| **Bez auth pre návštevníkov** — basic auth bráni prístup, ale je to 1 používateľ (ty). Nie je tu multi-user login, GDPR, platby — to je M1-M5 roadmap v `docs/BACKLOG.md` | Nezverejňuj URL širšie / nezdieľaj heslá | 🟡 stredné pre pilot |
| **Rate limit je v operačnej pamäti** — 30 generácií/deň sa resetuje pri reštarte kontajnera. Kvóty nie sú trvalé (nedajú sa fakturovať, nevydržia multi-instance). | Durable kvóty = roadmap M1 | 🟡 stredné |
| **Sandbox compile beží v host procese** — bez izolácie (bez CPU/RAM/čas hard-limít). Na VPS bežia aj iné projekty, teoreticky ich môže vytiežiť. | Sandbox izolácia = roadmap M1 | 🟡 stredné |
| **VPS RAM 1,9 GB, obsadené 987 MB, 13 kontajnerov** — posledné generácie (55 kB kódu) bežali OK, ale pri veľkých projektách môže dôjsť k OOM celého servera. | monitoring: `ssh hetzner-vps "free -h"` | 🟡 stredné |
| **GitHub OAuth export nechodí** — nemá Client ID/Secret — pozri 3.2 | Funkcia UI len vyzerá, volanie skončí chybou | 🟢 nízke |
| **Starý GitHub účet v keychaine Macu** (`youh4ck3dme`) blokoval push — vyčisti heslo viac informácií v 2.5 | | 🟢 nízke |
| **Bez uptime monitora** — ak server padne, nikto sa to nedozvie. Zapni si zdarma https://uptimerobot.com na URL `https://lov.2.29.52.59.sslip.io/api/health` (monitoru nastav aj heslo z basic authu) | | 🟡 stredné |

### 💰 Aktuálne mesačné náklady tohoto setupu
| Položka | Cena |
|---|---|
| Hetzner CX22 (zdieľaný s 13 projektmi) | ~3,79 €/mes |
| sslip.io doména | 0 € |
| Let's Encrypt certifikát | 0 € |
| Mistral API | pay-per-use (závisí od tvojich generácií) |
| GitHub / zálohy / monitoring (ak zapneš Uptime Robot free + Hetzner backups) | +~0,76 €/mes |
| **Celkom** | **~4,5 €/mes + Mistral spotreba** |

---

## 🎯 Ďalší logický krok (keď budeš chcieť)
1. Rotácia Mistral kľúča → povedz mi, prepnem `.env` na VPS + Mac + redeploynem
2. GitHub OAuth App (3.2) → povedz mi ID/secret, nastavím env
3. DNS domény (3.3) → povedz mi, prepnem nginx+certbot
4. **PR do `main`?** Branch má 9 commitov; review a mergemain je na tvoje rozhodnutie
5. Auth pre reálnych zákazníkov — to už je vývoj (roadmap M1 v `docs/BACKLOG.md`)

> ## Poznámka od AI
> Tento manuál nie je nemenný — po zmenách na serveri/doméne/auth si povedz „prehodnoť todoerik.md".

---

## 🚀 5. MEGA PROMPT — posunutie editora na úroveň Lovable
Kompletný prompt (WS-1 až WS-5: auth, editor UX, šablóny, izolovaný sandbox, billing + DoD + env premenné) je uložený samostatne:
**→ [docs/MEGA-PROMPT-LOVABLE.md](./MEGA-PROMPT-LOVABLE.md)**
Skopíruj ho celý do AI agenta (Mistral Vibe/editor), keď budeš chcieť spustiť ďalšiu vývojovú fázu.
