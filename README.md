# 🔥 LOV-DEVIL BUILDER 2026

> Lovable-style AI App Builder — od promptu cez Agent Mode až po publikovanú aplikáciu s mesačným predplatným.

![status](https://img.shields.io/badge/stav-prototyp%20M0-2563eb) ![tests](https://img.shields.io/badge/testy-~60-38bdf8) ![UI](https://img.shields.io/badge/UI-SK%2FEN-101b33) ![repo](https://img.shields.io/badge/prístup-súkromné-f4502a)

*Interný kódový názov prototypu: **Forge** (tak sa volá agent a branding v demo appke).*

## 📖 O projekte

LOV-DEVIL BUILDER 2026 je plnohodnotný AI editor aplikácií v štýle Lovable — používateľ napíše ideu, Agent Mode ju naplánuje, vygeneruje a nasadí. Toto repo obsahuje **funkčný prototyp (míľnik M0)** a **kompletný produktový backlog** (~90 položiek, 12 epikov) na ceste k predplatnému modelu.

## ✨ Funkcie prototypu (M0 — hotovo)

| Oblasť | Popis |
|---|---|
| **Landing** | „Čo chceš postaviť?“ — prompt, rýchle šablóny (SaaS, Kanban, Settings, Dashboard), public toggle |
| **Chat + Agent Mode** | plán v 4 krokoch (analyzuj → naplánuj → generuj → ulož), streaming odpovede, kópia kódu, fork, re-run |
| **Canvas** | Preview / Code / Console / Diff, zoom 50–150 %, breakpointy desktop/tablet/mobile, Edit mode s vizuálnym výberom elementov |
| **/editor dashboard** | sidebar s projektmi + fulltext, connectors, live preview prepojený s canvasom, Publish/Share flow |
| **História verzií** | snapshots, pin, restore, read-only rewind, diff medzi verziami |
| **Publish** | build → optimalizácia → deploy na CDN → URL (v prototypu demonštračný flow) |
| **Test suite** | ~60 testov, spustenie Ctrl+Shift+T, priebežný panel, plný restore stavu |

## 🚀 Rýchly štart

```bash
git clone https://github.com/erikbabcan-commits/LOV-DEVIL-BUILDER-2026.git
cd LOV-DEVIL-BUILDER-2026
```

Otvor **demo/index.html** v prehliadači — žiadna inštalácia ani build nie je potrebný (single-file app).

Ovládanie: píš prompt → **Ctrl+Enter** odoslať · **Ctrl+K** zamerať prompt · **Ctrl+S** uložiť verziu · **Ctrl+Shift+T** spustiť testy.

## 🧭 Roadmapa — míľniky

| # | Míľnik | Cieľ |
|---|---|---|
| M1 | Reálny engine + MVP | LLM API, multi-file codegen, auth, hosting, billing Free/Pro — **prvý platiaci zákazník** |
| M2 | Editor + blueprinty | file explorer, Monaco, git-like history, galéria 12+ blueprintov, prompt knižnica |
| M3 | Fullstack & data | DB, auth pre end-userov, backend funkcie, custom domény + SSL |
| M4 | Tímy & Business | realtime kolaborácia, komentáre v preview, seat billing, RBAC |
| M5 | Enterprise | SSO/SAML, audit log, GDPR/SOC2 cesta, SLA |
| M6 | Ekosystém | komunitná galéria, marketplace blueprintov, affiliate |

➡️ **Kompletný backlog (epiky, prompt packy, blueprinty, cenník, riziká, DoD): [docs/BACKLOG.md](docs/BACKLOG.md)**

## 💳 Plány predplatného (návrh)

| | Free | Pro ~20 €/mes | Business ~50 €/mes | Enterprise |
|---|---|---|---|---|
| Generácie/mes | 10 | 200 | fair-use | custom |
| Blueprinty | 3 základné | celá galéria | + tím šablóny | + SSO, DPA |
| Súkromné projekty | ✗ | ✓ | ✓ | ✓ |
| Custom domény | ✗ | 1 | 10 | neobmedzené |
| Tím | ✗ | 1 používateľ | 3+ seats | RBAC + SLA |

## 🧪 Kvalita — test suite

Vstavaná test suite (~60 testov) pokrýva utility (esc, hl, uid), generátory, detectKind, chat/konzolu/diff render, snapshots, zoom/viewport, publish flow, /editor aj event handlery. Spustí sa **Ctrl+Shift+T** — testy si zálohujú stav aplikácie a po sebe ho obnovia.

## 🏗️ Architektúra prototypu

- **Single-file HTML aplikácia** (žiadne závislosti) — `demo/index.html`
- Design tokens (čierna + modrý akcent), responzívne od iPhone 14
- Stav v jedinom objekte `state` + čisté render funkcie (`renderChat`, `renderPreview`, `renderEditor`…)
- Ladiace logy `dbg()` (console.debug) naprieč celou appkou
- TypeScript port logiky pripravený samostatne (strict mode, `tsc --strict`)

## 📁 Štruktúra repa

```text
LOV-DEVIL-BUILDER-2026/
├── README.md            # táto dokumentácia
├── docs/
│   └── BACKLOG.md       # kompletný backlog (míľniky, epiky, prompty, cenník)
└── demo/
    └── index.html       # funkčný prototyp workspace + /editor
```

## 📄 Licencia & kontakt

Súkromný projekt — všetky práva vyhradené. Prístup na žiadosť.

---

*LOV-DEVIL BUILDER 2026 — postav appku ešte dnes.* 🚀