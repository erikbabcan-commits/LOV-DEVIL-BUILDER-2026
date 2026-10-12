# React + Vite + TypeScript migračný kontrakt (M0 príprava, M1 plán)

**Zásada: existujúca appka je vizuálna a behaviorálna pravda. Žiadny redesign,
žiadne shadcn/Tailwind prepisy existujúcich obrazoviek.** `demo/index.html`
ostáva v repu ako referenčná implementácia a rollback, kým migráted verzia
neprejde akceptačnými kritériami.

## Stack (rozhodnuté)

React 18 + Vite + TypeScript (strict) + Zustand. Žiadne Tailwind ani shadcn
pre existujúce screny — pôvodné CSS sa prenesie ako globálny stylesheet.

## Zachovávané nevyhnutne (UI Preservation Contract)

- Pôvodné CSS a design tokeny (`:root` blok, demo/index.html:5–15) — kopírované 1:1
- Layout: topbar / home / workspace (chat+canvas split s resizerom) / editor dashboard
- Farby, gradienty (`#2563eb→#38bdf8`), radii, tiene, fonty, custom scrollbar
- Animácie: `fadeUp`, `pulse` save-dot, plan-step progresia, publish choreografia, toasty
- Mobile: `.mtabs` tab rail, `.mvp` viewport prepínač, breakpointy 1023/420/360
- Klávesové skratky: Ctrl+Enter, Ctrl+K, Ctrl+S, Ctrl+Shift+T, Esc
- Správanie navigácie: `data-mode` home/work, `data-view` chat/canvas

## Mapa extrakcie komponentov

| Existujúce (demo/index.html) | → React | Poznámky |
|---|---|---|
| CSS `:root` + všetky pravidlá | `src/styles/forge.css` (globálny import v main.tsx) | 1:1 kópia |
| `state` (~:1086) | `stores/useAppStore.ts` (Zustand) | rovnaké názvy polí; `saveState/restoreState` → store snapshot util |
| `esc/hl/uid/now/dbg/copy/log/toast` | `src/lib/utils.ts` | pure port + Vitest |
| `vfsSplitBlocks/vfsJoinBlocks/filesFor/filesToHtml` | `src/lib/vfs.ts` | po M0-D3 oprave; Vitest roundtrip testy |
| Topbar + `startEditTitle`, model menu, settings | `<TopBar/>`, `<ModelMenu/>`, `<SettingsPop/>` | zachovať id/class pre CSS |
| Home sekcia + `homeChips` | `<LandingPage/>`, `<PromptComposer/>` | |
| `renderChat/msgSig/chatMsgHtml/addMsg` | `<ChatPanel/>`, `<MessageBubble/>`, `<PlanBlock/>`, `<CodeBlock/>` | `msgSig` → `React.memo` comparator |
| `generate()` + `advance()` choreografia | `hooks/useAgentRun.ts` + `services/ai/` (provider interface) | mock provider zostáva ako offline fallback |
| `buildSaas/Kanban/Settings/Dashboard`, `KINDS/detectKind`, `SNIPPETS` | `src/services/templates/` | 1:1 port |
| Canvas + `renderPreview/currentHtml/withEditMode/setZoom/setViewport` | `<PreviewCanvas/>`, `<DeviceFrame/>` | iframe sandbox zachovať |
| `renderRaw/hl` Code tab | `<CodePanel/>` | |
| `log/renderConsole` | `<ConsolePanel/>` | |
| `renderDiff` + diff štatistika | `<DiffViewer/>` + `src/lib/diff.ts` | |
| History bar + `createSnapshot/viewSnapshot/backToLive` | `<VersionHistory/>` | D2 guard portuje so sebou |
| `/editor` sekcia (~:1896+) | `<ProjectDashboard/>`, `<ProjectSidebar/>`, `<FileExplorer/>`, `<EditorPanel/>` | D1 fallback portuje so sebou |
| Modaly (publish, bpWizard, domModal, gCheckout) | `<PublishModal/>` atď. | rovnaký DOM |
| Vnútorná test suite (`runTests`, ~:3353) | Playwright spec `tests/e2e/runtime-suite.spec.ts` + Vitest unit testy pre `lib/*` | CI nástroj |

## Stratégia migrácie stavu

- Zustand store so slovkami podľa domén: `workspace` (mode, viewport, zoom, tab),
  `project` (snapshots, liveHtml, viewing, liveId), `editor` (edFile, edEditing, vfs),
  `ui` (toasty, modaly).
- Priamy prenos: `state.viewing` guard (D2) a `edFile` fallback (D1) žijú v store
  akciách — rovnaké invarianty, rovnaké správanie.
- `subscribeWithSelector` pre selektívne re-rendery (nahrádza manuálne podpisy `msgSig`).

## Stratégia CSS

- Globálny `forge.css` importovaný v `main.tsx`; žiadne CSS moduly pre existujúce
  komponenty (rovnaké triedy, rovnaký vizuál).
- Nové komponenty (budúce M4+) môžu použiť Tailwind — ale nikdy nemenia existujúce screeny.

## Test migračný plán

- Vitest: utils, vfs (roundtrip D3), diff, detectKind — port 1: z existujúcich t() tvrdení.
- Playwright: E2E nad React verziou — port existujúcich DOM testov + D1/D2/D3 regresie.
- Vizuálna regresia: screenshoty home/workspace/editor pri 1280px a 390px oproti
  baseline z `demo/index.html` (baseline treba nafotografovať v browseri lokálne —
  sandbox bez browsera, pozri M0 report).

## Poradie implementácie (file-by-file, M1)

1. `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/styles/forge.css`
2. `src/lib/utils.ts` (+ unit testy)
3. `src/lib/vfs.ts` (+ roundtrip testy — port z /tmp overenia)
4. `src/stores/useAppStore.ts`
5. `<TopBar/>` → `<LandingPage/>` (prvý vizuálny milestone — porovnať s referenciou)
6. `<ChatPanel/>` + `<PreviewCanvas/>` + tabs
7. `<VersionHistory/>`, `<ProjectDashboard/>`, `<EditorPanel/>`
8. Modaly + klávesové skratky
9. Playwright E2E port

## Rollback

- `demo/index.html` zostáva funkcčná počas celej migrácie; pri akomkoľvek regresnom
  zlyhaní je možné sa k nej vrátiť (kanonická verzia).
- React app žije v `src/`, pôvodný súbor sa nemaže ani neprepisuje.

## Akceptačné kritériá M1

- Vizuálne totožné s referenciou pri 1280px aj 390px (screenshot diff).
- Všetky portované Vitest/Playwright testy zelené.
- Žiadna zmena vizuálnej identity (farby, fonty, animácie, layout).
