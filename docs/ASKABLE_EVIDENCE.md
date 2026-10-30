# LOV-DEVIL-BUILDER-2026 — candidate change evidence

**Status:** public loopback pilot; NOT a production multi-user app, and NOT
cleared for external AI-training tasks. No standalone LICENSE is present.

**Baseline checked:** `main` at `1861add8c59040c7f056907cdcc3aabfd174df5e`
(2026-10-29). Recheck branch/HEAD before any external presentation.

| Git reference | Observable change | Checks and boundaries |
| --- | --- | --- |
| [PR #19](https://github.com/erikbabcan-commits/LOV-DEVIL-BUILDER-2026/pull/19), merge `1861add` | GitHub OAuth/session route hardening, export, test and CI integration | `tests/unit/server/github-production.test.ts`, `tests/e2e/github-oauth.spec.ts`; review deployment configuration separately |
| [PR #18](https://github.com/erikbabcan-commits/LOV-DEVIL-BUILDER-2026/pull/18), merge `4c44d69` | ZIP/export integration and lockfile changes | `tests/unit/export.test.ts`, `tests/integration/zipCleanBuild.test.ts` |
| [PR #1](https://github.com/erikbabcan-commits/LOV-DEVIL-BUILDER-2026/pull/1), merge `a55a25d` | M0 stabilization | Compare to `demo/index.html` historical reference and tests |

These merges are visible in Git. Merge authorship alone does not prove
copyright ownership of the entire imported or AI-assisted codebase. The owner
must confirm origin and the right to license a specific change to a third party.

## Commit-level attribution (Git signals only)

| Source commit | Recorded Git author | Observed contribution |
| --- | --- | --- |
| `b9fbf4b` (PR #19) | `youh4ck3dme <H4CK3D@H4CK3D.ME>` | OAuth server routes, secure export/tests, lockfile and configuration changes |
| `e03e582`, `11a4fec` (PR #19) | `youh4ck3dme <H4CK3D@H4CK3D.ME>` | Same-origin proxy routing and E2E regression tests |
| `180c98f` (PR #19) | `erikbabcan-commits <erikbabcan@gmail.com>` | Correction of broken editor export button labels |
| `90a2c14`, `ee35532`, `2446120` (PR #18) | `erikbabcan-commits <erikbabcan@gmail.com>` | Conflict-resolution changes preserving export and ZIP test boundaries |

The two Git identities are **not automatically treated as the same legal
author**, even when the claimant controls both accounts. AI tooling, imported
templates, other PR contributors and upstream files need explicit attribution.
For any proposed Askable task, review the exact source diff, author/reviewer
contributions and contractual permissions before submitting any code.

## Reproduction without a deployment

```sh
npm ci
npm run typecheck
npm run test
npm run build
```

The backend is a loopback pilot. `esbuild` compiles untrusted source inside
the server process; it is not a separate worker/container with CPU/memory
limits. UI publish flows and previews are not proof of real hosting or billing.

## Before external reuse

- [ ] Confirm ownership/attribution of the exact files in a proposed change.
- [ ] Choose licensing terms explicitly, if external reuse is intended.
- [ ] Separate historical demo behavior from the current React/server runtime.
- [ ] Add real runtime isolation and verify it before untrusted multi-user hosting.
- [ ] Reproduce tests on the proposed SHA, report failures and limitations.
- [ ] Never publish a proprietary Askable task, solution or public fork.
