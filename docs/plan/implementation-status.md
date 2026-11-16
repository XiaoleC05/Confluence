# Implementation status (v0.2.0, universal memory) — live coordination record

- Owner: **packaging/docs** (`docs-refactor`). This is the coordination record for the build round,
  not a design document; update it whenever the implementation state changes.
- Last updated: **2026-11-17 (v0.2.1 display-name patch: Chinese name 汇流 → 高级记忆; no memory,
  storage, tool or export behaviour changed)**. Prior snapshot: 2026-11-16 (phase 4: independent-review
  fixes landed, suite re-run 291/291, E2E re-run post-fix, evidence sections updated).
- Binding contract: [`scope-refactor-delta.md`](scope-refactor-delta.md) (v0.2.0) on top of
  [`implementation-interfaces.md`](implementation-interfaces.md) (v0.1.0 baseline).
  Decision: [`../adr/0007-universal-memory-scope.md`](../adr/0007-universal-memory-scope.md).
  Milestones: [`execution-plan.md`](execution-plan.md). Upgrade notes: [`../upgrade-v0.2.md`](../upgrade-v0.2.md).
- Honesty rule: a row says **Executed** only if the check was actually run on this tree; everything else
  is **Pending** or **Not executed**, even when the design is complete.

## 1. Verdict

**v0.2.1 (universal memory; Chinese display name 高级记忆) is implemented and its offline evidence is
green.** v0.2.1 changes only the Chinese display name (formerly 汇流); the v0.2.0 scope decision
(ADR 0007), the binding interface delta, the module changes (global scope, origin provenance, legacy
read-only merge, global panel, global export), the docs/product reframing, the locale strings and the
upgrade note are in place. On the final tree (2026-11-16, unchanged by the display-name patch) the
offline suite is **291/291 pass**, the
standalone packaging check is **17/17 pass**, the M0 smoke suite is **14 pass / 0 fail / 1 blocked**,
and the offline scratch-profile cross-directory E2E is **15/15 PowerShell checks + 12/12 assertion
checks, exit 0** (run `.tmp/e2e/run-20261116-203730`); all of it is recorded in §5.

The independent review's findings **R-01..R-14** have been dispositioned and the fixed tree is the one
measured here: R-01 (private sessions now gated on every tool), R-03/R-04/R-05/R-06/R-07/R-09/R-10/
R-11/R-13 are fixed, R-12 is resolved by wording, R-08's `solo-bench` fixture is regenerated (Go
consumer re-run green) and R-14 stays an accepted wire-compatibility residual. Details: §4.2.

**Not executed for v0.2.0:** install + DSH restart on the **real desktop profile** (and therefore any
real-profile live smoke), and any panel rendering check. **Not executed for either version:** panel
visual verification, PTC tool reachability, live multi-window freshness, soak/compaction, publish.

v0.1.0 remains the last version installed on the real desktop profile: offline suite 256/256,
packaging check 12/12, M0 smoke 14 pass / 1 blocked, scratch-profile E2E 8/8, real-profile
`install_bundle` applied, export CLI + `solo-bench` Go consumer green (all 2026-11-13).

## 2. Milestones

| Milestone | Scope (ADR §14) | Status | Notes |
|---|---|---|---|
| **M0 — spikes** | Runtime-context dedupe, projection fold, PTC presentation, Windows journal append/torn line, multi-window topology, host channel, atomic-write import | **Executed (v0.1.0)** | 14 pass / 1 blocked in `scripts/m0-smoke.mjs`; S1/S2/S4/S7 closed, S3/S5 open; results in `m0-spikes.md` §10 |
| **M1 — core** | Store/journal, **origin resolver** (v0.2.0), board, board tools, pulse + welcome digest, projection watermarks | **v0.2.0 implemented — tests green** | `lib/{util,config,workspace,store,board,watermark,pulse}.js`; global scope `ws_0000000000000000` + legacy read-only merge; single-flight opens |
| **M2 — collaboration** | Ledger/presence, reply/search/recall, redaction/caps, private opt-outs, scratch-profile E2E | **v0.2.0 implemented; offline E2E green** | `lib/{ledger,presence,recall,redact}.js`; recall is profile-wide; private sessions now gated on all tools; the cross-directory scratch-profile E2E passed 15/15 + 12/12 on 2026-11-16 |
| **M3 — panel** | Read-only UI, locale, transport, mark-read/opt-out, no-egress test, install verification | **v0.2.0 implemented + contract-tested; visual check pending** | `client.js` + `lib/hostui.js`; global timeline, provenance chips, no workspace switcher, routes ping/overview/entry |
| **M4 — hardening** | Compaction/export + manifest, release verification, soak/concurrency tests, solo-bench integration | **Global export implemented; compaction/soak/release pending** | `lib/export.js`, `scripts/export-memories.mjs`; v0.2.0 solo-bench fixture regenerated (Go consumer green), merge pending; no publish |
| **v0.2.x (later)** | Header badge, custom tool cards, composer/reply UI | **Deferred (signed off)** | Not in v0.2.0 scope |

## 3. Work packages and files (v0.2.0)

Present = the file exists in the working tree at this snapshot. Ownership follows the delta.

| WP | Owner | Files | Status |
|---|---|---|---|
| WP1 core | design-core | `lib/util.js`, `lib/config.js`, `lib/workspace.js`, `lib/store.js` + tests | **v0.2.0 landed — tests green** (origin resolver, global journal, legacy merge) |
| WP2 behavior | design-behavior | `lib/redact.js`, `lib/board.js` + tests | **v0.2.0 landed — tests green** (global fold, `origin` provenance) |
| WP3 surface | design-surface | `lib/ledger.js`, `lib/presence.js`, `lib/recall.js` + tests | **v0.2.0 landed — tests green** (global ledger/presence, lazy `sessionQuery`, unfiltered recall) |
| WP4 passive | dsh-researcher | `lib/watermark.js`, `lib/pulse.js` + tests | **v0.2.0 landed — tests green** (`confluence-memory` tag, global text, line-scan `through=` marker) |
| WP5 tools | planner | `lib/tools.js`, `lib/export.js`, `scripts/export-memories.mjs` + tests | **v0.2.0 landed — tests green** (universal wording; global export manifest) |
| WP6 UI | architect-a | `lib/hostui.js`, `client.js`, `test/hostui.test.js` | **Done — global panel (not visually verified)** |
| WP7 E2E | e2e-crossworkspace | `test/e2e/*`, `test/fixtures/*`, `scripts/m0-smoke.mjs`, `scripts/e2e-dsh.ps1` | **Done — offline E2E green 15/15 + 12/12** (run `20261116-203730`) |
| WP8 packaging/docs | docs-refactor | `README*.md`, `docs/**` (except Lead-owned ADR 0007 + delta), `locale/*.json`, `examples/profile-patch.yml`, `test/contract.test.js`, `scripts/check.mjs` | **Phase 1+2 done; phase 3 evidence sections updated** — suite 291/291, checker 17/17 |
| WP9 integration | Lead | `index.js`, `lib/facade.js`, `lib/config.js`, `cordis.patch.yml`, `package.json`, `lib/pulse.js` wiring | **v0.2.0 wiring verified offline** (cold-start E2E); real-profile install/restart Lead-owned |
| E2E/Panel | architect-a / e2e-crossworkspace | install + restart + panel render verification | E2E executed offline (scratch profile); **real-profile install + panel render still Not executed** |

Implementation inventory: **15** `lib/*.js` modules (no module added or removed in v0.2.0), `index.js`
(facade wiring), `client.js` (Dynamic ModuleLoader id `dsh-confluence`), 24 shipped files in the pack
listing, 15 test files (14 module tests + `test/integration.test.js`) plus packaging contract tests, e2e
scaffolding and fixtures.

## 4. Phase 1 changes (docs/packaging/locale, 2026-11-16)

| Area | Change |
|---|---|
| `README.md` / `README.zh-CN.md` | Re-framed as universal memory: title/tagline, "why" (workspace scoping fragmented memory), three pillars, profile-level privacy model, architecture (global scope `ws_0000000000000000`/"All sessions", legacy read-only merge), universal tool wording, global panel, global export, roadmap, executed-vs-not-executed tables, docs map incl. ADR 0007 / delta / upgrade note, upgrade section, restart requirement |
| `docs/upgrade-v0.2.md` | **New** — what changed, breaking config migration (`privacy.disabledWorkspaces` removed with CONFIG_DEPRECATED warning, `ledger.maxSessionsPerWorkspace` → `ledger.maxSessions`), legacy read-only merge, restart, verification, rollback |
| `docs/README.md` | Index updated: ADR 0007 row, scope-refactor delta + upgrade note in the map, design docs marked with v0.2.0 amendments, verification split into v0.1.0 historical vs v0.2.0 in this round |
| `docs/install.md` | v0.2.0 registrations (global store/pulse tag/panel routes), restart requirement, rewritten v0.2.0 checklist incl. cross-workspace + legacy-merge rows (phase 1 left every row "Not executed"; **phase 3 replaced them with the executed E2E evidence and kept the real-profile/panel rows open**) |
| `docs/publishing.md` | v0.2.0 versioning (breaking minor bump), pack inventory + re-record note, updated "what must not be claimed"; v0.1.0 facts kept as history |
| `docs/design/*.md`, `docs/plan/m0-spikes.md` | "v0.2.0 amendment" blocks pointing at ADR 0007 + targeted statement fixes (global scope/provenance, store dir/merge, pulse tag, tool wording, panel, config keys, profile privacy boundary, cross-workspace testing, global export) |
| `locale/en.json`, `locale/zh.json` | Universal panel copy: ui-refactor's six strings applied verbatim, `scope.global` added; 86 keys each (was 85), key sets identical; `meta.description` re-framed; no workspace wording left in values |
| `examples/profile-patch.yml` | Removing `disabledWorkspaces`, `ledger.maxSessions`, `privateSessions` guidance, universal-scope note |
| `test/contract.test.js`, `scripts/check.mjs` | **Updated in phase 2 (2026-11-16)** to the v0.2.0 surface: version 0.2.0, 86 locale keys with `scope.global`, universal palette/deprecation/route/store checks, README/docs markers incl. ADR 0007 / delta / upgrade note. Contract tests now 23 (was 18); checker now 17 checks (was 12). |

### 4.1 Phase 3 changes (verification evidence, 2026-11-16)

| Area | Change |
|---|---|
| `scripts/e2e-dsh.ps1` + `test/e2e/assert-e2e.mjs` | The offline cross-directory E2E was executed to green: **15/15 PowerShell checks, 0 fail, exit 0; 12/12 assertion checks** (run `.tmp/e2e/run-20261116-203730`). See §5 and `../design/testing.md` §9a. |
| Product fixes found by that run | (1) `parseThroughMarker` only accepted the marker as the last line, so `boardReadSeq` never advanced — it now scans every rendered line (`lib/watermark.js:182`); (2) cold-start activation registered tools/pulse/routes after the first `await`, so the first request missed them — registration is now synchronous before the async store/board/watermark attach (`index.js:328-366`); (3) `sessionQuery` was captured eagerly ~150 ms before the service registered, so `confluence_recall` stayed unavailable on a cold headless boot — it is now resolved lazily through `deps.getSessionQuery` (`lib/recall.js:283`, `index.js:161`). |
| `README*.md`, `docs/README.md`, `../install.md`, `../publishing.md`, this file, `../design/testing.md` | Verification/evidence sections now record the executed E2E and keep the split between "v0.2.0 executed" and "still not executed". |
| `../discussion/v0.2-e2e-evidence.md` | **New** evidence record: exact command, run directory, check tables, observed behaviour, three bugs found/fixed, post-review fix dispositions, remaining gaps. `../discussion/v0.2-review.md` is left to its owner. |

### 4.2 Post-review fixes (2026-11-16, after the independent review)

The review ([`../discussion/v0.2-review.md`](../discussion/v0.2-review.md), reviewer-owned) found
R-01..R-14. The fixed tree carries:

| ID | Severity | Disposition |
|---|---|---|
| R-01 | P1 | **Fixed** — `privacy.privateSessions` gates all six tools (`lib/facade.js:244-257`); `INT-07` covers every tool. |
| R-02 | P1 (snapshot) | **Resolved** — the E2E evidence record exists and its assertions are persisted. |
| R-03 | P2 | **Fixed** — single-flight `openWorkspace`/`openGlobal` (`lib/store.js:378-506`); `UT-STORE-19`. |
| R-04 | P2 | **Fixed** — export scrubs any POSIX absolute path and `~/` (`lib/export.js:117-126`); `EXP-12` cases. |
| R-05 | P2 | **Fixed** — pulse digest cursor ignores the session-ledger head (`lib/pulse.js:810`); `CON-PL-18b` proves no churn. |
| R-06 | P2 | **Fixed** — presence heartbeat version `0.2.0` (`lib/presence.js:36`). |
| R-07 | P2 | **Fixed** — `cordis.patch.yml` comments modernized for v0.2.0. |
| R-08 | P2 | **Addressed** — `solo-bench` real fixture regenerated from the v0.2.0 global export; `go test -count=1 ./internal/confluenceexport` → ok (0.601 s). |
| R-09 | P3 | **Fixed** — upgrade note: old ledger key is accepted with `CONFIG_DEPRECATED` and mapped; rename to silence. |
| R-10 | P3 | **Fixed** — dead `isValidDisabledWorkspace` helper/comment removed. |
| R-11 | P3 | **Fixed** — export temp file unlinked on every failure path (`lib/export.js:528,556`). |
| R-12 | P3 | **Resolved by wording** — ADR-0007 §2.5 / delta §7: kind filter + free-text search (tag facet out of scope); reviewer nit: `docs/design/ui.md:13` still says "kind/tag filters". |
| R-13 | P3 | **Fixed except one nit** — stale workspace-scoped design sentences corrected; `docs/design/store-format.md:142` still says "for this workspace". |
| R-14 | P3 | **Accepted residual** — tool output field `workspace` kept for wire compatibility. |

The suite on the fixed tree is **291/291** (288 + `UT-STORE-19`, `CON-PL-18b`, `INT-07`; the export path
cases extend the existing `EXP-12`), packaging **17/17**, M0 **14 pass / 1 blocked**, and the E2E was
re-run post-fix as `20261116-203730` (15/15 + 12/12, exit 0).

## 5. Verification: executed vs not executed

**v0.1.0 — executed on this tree (historical, 2026-11-13):**

| Check | Result |
|---|---|
| Offline test suite — `node --test --test-force-exit "test/*.test.js"` | **256/256 pass** (module tests, integration test, packaging contract) |
| Standalone packaging check — `node scripts/check.mjs` | **12/12 checks pass** |
| Locale parity (85 panel strings, en/zh identical key sets) | **Pass** (contract checks) |
| Icon structural validation | **Pass** (contract checks) |
| Offline/no-egress static scan (Host modules + panel) | **Pass** (contract checks) |
| `npm pack --dry-run --json` file list | **Executed** — 24 files; no dev-tree content, no tarball written |
| Patch ↔ `lib/config.js` DEFAULTS deep equality | **Pass** (dependency-free YAML-subset parser in `check.mjs`) |
| Real desktop-profile install + activation + pulse + board tool call | **Executed** (Plugin Manager `install_bundle` → applied) |
| Cross-session pulse in a scratch profile (`scripts/e2e-dsh.ps1`) | **Executed — 8/8 checks** (v0.1.0: same-workspace sessions) |
| Export producer CLI + solo-bench Go consumer | **Executed** (v0.1.0 workspace export) |

**v0.2.0 — executed on this tree (2026-11-16):**

| Check | Result |
|---|---|
| Offline test suite — `node --test --test-force-exit "test/*.test.js"` | **291/291 pass** (module tests, integration test, revised packaging contract) |
| Standalone packaging check — `node scripts/check.mjs` | **17/17 checks pass** (12 v0.1.0 checks + v0.2.0 constants/tools/routes/config-deprecation/store checks) |
| M0 smoke — `node scripts/m0-smoke.mjs` | **14 pass / 0 fail / 1 blocked** — the blocked item is the optional `@deepseek-ai/dsh-atomic-write` probe; the native lease is the shipped path |
| Offline scratch-profile cross-directory E2E — `pwsh -NoProfile -File scripts/e2e-dsh.ps1` | **15/15 PowerShell checks, 0 fail, exit 0; `test/e2e/assert-e2e.mjs` 12/12 checks** — run `.tmp/e2e/run-20261116-203730` (`summary.json`, `mock-*.jsonl`, per-session logs kept) |
| Cross-directory memory (A in `workspace-a`; B/C/D/E in `workspace-b`, same profile) | **Executed in the E2E** — B's committed pulse carried A's note; C's board listed A's + the legacy note; D read A's note body; E recalled A's session text from the other directory; no tool call passed a workspace key |
| Global store written only under the scratch `DSH_HOME` | **Executed in the E2E** — `storages/confluence/v1/workspaces/ws_0000000000000000/`; real `~/.dsh` files unchanged and its pre-existing store (15 files) contained no run artifact |
| Legacy read-only merge | **Executed in the E2E** — seeded `ws_1a2b3c4d5e6f7081` appeared with its `legacy-alpha` provenance; files byte-identical (sha256), nothing migrated |
| Pulse tag + watermarks | **Executed in the E2E** — committed `<confluence-memory scope="global" …>` snapshots; `boardReadSeq` advanced after board/read and stayed `null` for post-only/pulse-only sessions; `digestSeq` committed for readers |
| Cold-start activation | **Executed in the E2E** — the writer's first request headers already carried all six tools + the pulse; `summary.json.writerAttempts` = 1 |
| Product bugs found and fixed by the E2E | **Fixed and re-verified** — `parseThroughMarker` line scan (`lib/watermark.js:182`), synchronous tool/pulse/route registration before the first `await` (`index.js:328-366`), lazy `sessionQuery` via `deps.getSessionQuery` (`lib/recall.js:283`) |
| Independent-review fixes (R-01..R-14) | **Fixed / re-verified** — R-01 private gating (`INT-07`), R-03 single-flight (`UT-STORE-19`), R-04 POSIX/home scrub (`EXP-12`), R-05 pulse no-churn (`CON-PL-18b`), R-06 heartbeat 0.2.0, R-07 patch comments, R-09/R-10/R-11 fixes, R-13 docs fixes (one residual nit); R-12 resolved by wording; R-14 accepted residual (§4.2) |
| `solo-bench` Go consumer on the regenerated v0.2.0 fixture | **Executed** — `go test -count=1 ./internal/confluenceexport` → ok (0.601 s); fixture `scope:"global"`, producer `0.2.0`; merge still out of scope |
| Locale parity (86 panel strings, en/zh identical key sets, `scope.global`) | **Pass** (contract checks) |
| Universal-memory constants agree (store/board/export/facade/hostui/watermark) | **Pass** (`GLOBAL_SCOPE_KEY`, `MEMORY_SCOPE`, `PANEL_SCOPE`, `confluence-memory`, legacy tag parsed) |
| Tool descriptions universal (no "this workspace", no `NO_WORKSPACE`) | **Pass** (contract check + `tools.test.js`) |
| Panel routes exactly ping/overview/entry, no `/workspaces`, no `workspaceKey` | **Pass** (contract + `hostui.test.js`) |
| Config: removed workspace opt-out + renamed ledger cap warn/map | **Pass** (`CONFIG_DEPRECATED privacy.disabledWorkspaces`, `CONFIG_DEPRECATED ledger.maxSessionsPerWorkspace`) |
| Global store directory reserved (`workspaces/ws_0000000000000000`), legacy scan read-only | **Pass** (contract check) |
| Per-module behaviour suites (store/workspace/board/pulse/watermark/ledger/presence/recall/tools/export/hostui/integration) | **Pass** (part of the 291) |

**v0.2.0 — not executed yet (must not be claimed as working):**

| Check | Status |
|---|---|
| Real desktop-profile install + DSH restart for v0.2.0, and any real-profile live smoke | **Not executed** (Lead-owned; deliberately avoided writing the user's live profile) |
| Panel rendering / visual verification in a live GUI | **Implemented + contract-tested; rendering not verified** |
| Offline install with the network disabled | **Not executed** (hypothesis in `../install.md` §7) |
| Export `--dry-run` on a live scratch store; uninstall/rollback end-to-end | **Not executed** |
| PTC preset (`run_code`) tool reachability; multi-window live freshness; soak/compaction | **Not executed** |
| Publish/release | **Not executed — nothing was published** |

## 6. Blockers and next steps

1. **Install + restart** of the linked bundle into the real desktop profile, then the `install.md` §6
   checklist on that host. A config edit alone does not load the new Host modules.
2. **Panel visual verification.** Global timeline, provenance chips, no workspace switcher, en/zh,
   light/dark, no console crash.
3. **Release checkpoint.** Re-run `npm pack --dry-run --json` on the final tree, record fresh
   contents/sizes/checksum in `../publishing.md`, then commit/tag/push (Lead-owned).
4. **solo-bench fixtures.** The v0.2.0 real fixture is regenerated and the Go consumer test is green;
   the vendored-copy sync/merge remains a separate approved phase (nothing merged).

## 7. How to update this file

Change the "Last updated" line, re-scan the tree, update the milestone/WP/verification tables from what
was actually executed, and never mark a row Executed without the command and its output behind it. The
cross-directory E2E row now cites run `20261116-203730`; a re-run must replace that path and counts in
the evidence record too.
