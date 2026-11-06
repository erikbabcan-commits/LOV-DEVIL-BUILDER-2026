# P0 release preflight — 2026-10-28

**Release decision: BLOCKED / NO-GO for a public, functional AI backend.**

The user requested production publication. This report records the concrete
checks performed before release; a successful frontend build or GitHub push is
not a production deployment.

## Deployment target

- Repository: `erikbabcan-commits/LOV-DEVIL-BUILDER-2026` (GitHub repo ID `1410148278`).
- Working branch: `hardening/p0-security-review-20261028`.
- Connected Vercel team inspected: `h4ck3d`.
- Vercel project lookup by repository ID returned no project in the default
  context or in `h4ck3d`; the team name search `devil` also returned no project.
- No production URL, project binding, Node backend deployment entry point or
  production `/api` routing configuration was found in the repository.

These checks do not establish that no deployment exists anywhere. A renamed,
unlinked project or a separate VPS may exist. Its exact target must be provided
and verified before any production mutation.

## Hard release gates

| Gate | Evidence / missing implementation |
| --- | --- |
| Production bootstrap | `server/index.ts` throws when `NODE_ENV=production`; this was exercised locally and exited with the intended `Public deployment blocked` error before provider creation/listening. |
| Auth and ownership | AI generation/build/autofix have no application-wide user identity or project ownership checks. GitHub OAuth protects export, not all application mutations. |
| Durable quotas and cost control | `LocalBudgetGuard` is process-local, resets across restarts, is not per-user and does not meter monetary usage. |
| Resource-isolated builds | esbuild compiles untrusted source without executing it, but a dedicated constrained worker/VM with enforced CPU, memory, deadline and egress limits is absent. |
| Durable data and audit | Project persistence is browser IndexedDB; a server database, transactions, user isolation, backup/restore and durable audit trail are not implemented. |
| Manual-edit history semantics | Existing `saveEdFile()` changes HTML under the same snapshot ID. The immutable persistence contract must reject a later conflicting save; manual-edit versioning and full historical source recovery still need a dedicated fix. This release-preparation pass must not be described as verifying all save/restore flows. |
| Cross-tab persistence | File revision checks do not provide a full workspace compare-and-swap or delete tombstones. Concurrent stale deletions across tabs remain unsupported; no multi-tab safety claim is made. |
| Runtime wiring | `npm run build` emits Vite frontend assets. The `/api` proxy is development-only; publishing `dist/` does not deploy the Node API. |
| Browser verification | No local browser executable is available; Chromium and Headless Shell downloads returned invalid empty ZIP archives. Rendered E2E and visual checks remain unverified. |

The production bootstrap and public-mode 503 guards must not be removed, and
`NODE_ENV` must not be falsified to bypass them. Deployment must not be presented
as successful while only the static frontend is online.

## Local P0 remediation in this release-preparation pass

- Fixed the existing autofix regex lint error without changing accepted path
  characters; added focused regressions.
- Replaced permissive CORS prefix matching with exact local origins and rejected
  supplied untrusted Origin values before parsing/admitting AI work.
- Extended secret checks to the full schema-validated model context and plan,
  including history, project metadata and paths.
- Prevented secret-bearing autofix patches from being applied or forwarded to a
  subsequent model call; redacted diagnostics before truncating them.
- Redacted complete and truncated PEM private-key blocks, decoded dependency
  diagnostics and compiler errors before their length limits.
- Bound review to the exact project/snapshot/content at request start. Stale
  results, manual edits and delayed cancelled runs cannot overwrite a newer
  project; approval consumes the review and creates a snapshot atomically.
- Selected only the review base snapshot's source files for AI context, instead
  of flattening/truncating historical versions and dropping current sources.
- Made local full-state persistence atomic and identical snapshot retries
  idempotent. Project/live pointer, snapshots, live files and `lastProject` roll
  back together on conflict or file error. Only live source files are persisted;
  removed paths are reconciled within that transaction. Restore resumes the
  file revision counter beyond persisted values. Tests use fake-indexeddb, not
  a real browser, and do not resolve the manual-edit/cross-tab gates above.
- Preserved local cost admission, AI kill switch, review/approval and fail-closed
  production boundaries.

## Local verification (2026-10-28)

| Check | Result |
| --- | --- |
| `MISTRAL_API_KEY= npm run test -- tests/unit` | 357 passed; 1 live-provider test skipped; 15 test files passed, 1 skipped. |
| `npm run lint` (`src server tests`) | Exit 0; 0 errors, 39 warnings. Warnings are not represented as fixed. |
| `npm run build` | TypeScript (`tsc --noEmit`) and Vite production asset build passed. |
| `git diff --check` | Passed. |
| Lockfile root dependencies | Match `package.json`; resolved package URLs contain no embedded username/password. |
| Production bootstrap rejection | Expected exit 1 with the explicit production guard; no listener or AI request started. |
| React component review | Static review of affected TSX handlers, hooks and escaped content; not a browser-rendered accessibility certification. |
| Browser / Playwright E2E | Not verified: browser executable unavailable; attempted downloads produced empty invalid archives. |
| Clean-room ZIP integration | Not rerun in this pass; the separate integration suite installs dependencies and runs a generated project build. Unit ZIP checks are not equivalent to that proof. |

All provider regressions use test doubles/canaries, not paid AI.
CI remains manual-only on this feature branch. No merge, production deployment,
database migration, domain change or new paid infrastructure is authorized by
this preflight report itself.

## Required next decisions

1. Identify the exact existing production URL/hosting project and backend, or
   explicitly choose a new target.
2. Decide whether the intended release is an access-restricted single-owner pilot
   or a public multi-user service. They have different auth and deployment needs;
   a private pilot must not be relabeled as public production readiness.
3. Confirm the identity/database provider and build isolation environment before
   implementing the remaining gates. Do not reuse another application's database
   or credentials by assumption.
4. Implement and verify those gates in a non-production environment, create a
   tested release artifact and only then promote it to the confirmed target with
   health/API smoke checks and a verified rollback path.
