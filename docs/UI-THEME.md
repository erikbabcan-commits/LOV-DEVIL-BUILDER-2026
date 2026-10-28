# Forge dark theme

The active React application uses an exact `#171717` base. This change targets
the app shell, navigation, landing page, chat, workspace and editor, not the
contents of generated applications or the separate legacy `demo/index.html`.
There is currently no light/dark toggle in the active React UI.

## Color contract

| Role | Token | Value |
| --- | --- | --- |
| Application background | `--bg-app` | `#171717` |
| Cards and panels | `--bg-panel` | `#202020` |
| Elevated surfaces | `--bg-elevated` | `#292929` |
| Hover surfaces | `--bg-hover` | `#383838` |
| Primary text | `--text-primary` | `#F5F5F5` |
| Secondary text | `--text-secondary` | `#C6C6C6` |
| Muted text / placeholders | `--text-muted` | `#A3A3A3` |
| Button fill / hover / active | `--accent-primary` / `--accent-hover` / `--accent-active` | `#2563EB` / `#1D4ED8` / `#1E40AF` |
| Small accent text | `--accent-text` | `#60A5FA` |
| Button labels | `--text-on-accent` | `#FFFFFF` |
| Keyboard focus | `--focus-ring` | `#BFDBFE` |
| Essential control boundaries | `--border-control` | `#858585` |
| Decorative separators | `--border` | `#404040` |
| Error text | `--danger-text` | `#FDA4AF` |

The legacy tokens (`--bg`, `--panel`, `--text`, etc.) are aliases. Change the
canonical tokens rather than maintaining a second palette. Decorative borders
must not be used as the only way to identify input boundaries or active states.

## Contrast and interaction

The unit suite computes unrounded sRGB contrast for explicit, opaque color pairs.
Normal text targets at least 4.5:1; focus and essential control boundaries target
at least 3:1. Selected measured ratios:

- Muted text on the brightest neutral surface: 4.648:1.
- Accent text on that surface: 4.612:1.
- White labels on primary blue / hover blue: 5.169:1 / 6.702:1.
- Control boundary on the brightest neutral surface: 3.178:1.
- Focus ring against primary blue: 3.637:1.

Do not reduce text opacity on these surfaces. The muted and accent text pairs
have limited headroom on the hover surface. Snapshot version labels use an
opaque dark badge so arbitrary thumbnail gradients cannot reduce their contrast.

The shell includes visible keyboard focus (inset in clipped scroll containers),
disabled/error/active styling and reduced-motion support. The HTML entry point
has the same base background and browser theme color before React loads.

Iframe host surfaces retain their original white fallback and normal color
scheme; generated document styles and templates are unchanged. React already
conditionally mounts the editor frame/empty state, so the old unconditional
`display:none` declarations were removed. The editor body now provides the flex
height boundary required by scrollable code panes.

## Verification and remaining checks

Run locally without a live provider key:

```bash
env MISTRAL_API_KEY= npm run test -- tests/unit
npm run build
npm run lint
```

The theme regression suite lives in `tests/unit/theme.test.ts`. Build includes
TypeScript checking. These source/token tests do not certify rendered WCAG
conformance or replace visual checks.

Verification of the isolated theme + CI-cost-freeze snapshot on 2026-10-28
(not the separate, uncommitted P0 backend worktree):

- Unit tests: **229 passed, 1 skipped** (live provider smoke test disabled).
- Theme regression tests included above: **93 passed**.
- TypeScript and production build: **PASS**.
- ESLint for the modified React components and theme test: **PASS**.
- CSS parsing and `git diff --check`: **PASS**.
- The repository's `npm run lint` (`eslint src tests`): **0 errors, 24 existing warnings**.

As of 2026-10-28, browser checks at widths 390, 768, 1280 and 1440 are **not yet
verified**: no browser binary is installed, and both the Chromium and alternate
Headless Shell downloads returned invalid empty ZIP archives. Existing
Playwright scenarios remain available for a working local browser installation.
Check the landing page, workspace, all editor tabs, dropdowns, approval panel,
keyboard focus, disabled controls, mobile overflow and long code/diff content.

The separate P0 worktree expands lint coverage to the server and has an unrelated
`no-useless-escape` error in `server/agent/autofix.ts`; that work is not part of
this theme commit. No server, store or provider behavior is changed here.

The published feature branch also includes the previously prepared CI cost
freeze: `.github/workflows/ci.yml` accepts only `workflow_dispatch`, not `push`
or `pull_request`. No CI run, live AI request, merge or production deployment is
requested. The default branch's workflow is unchanged until an explicitly
authorized merge.
