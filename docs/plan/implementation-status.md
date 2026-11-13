# Implementation status (v0.1.0) — live coordination record

- Owner: **packaging/docs** (pattern-researcher). This is the coordination record for the build round,
  not a design document; update it whenever the implementation state changes.
- Last updated: **2026-11-13 18:36 (+08:00)** — snapshot from the working tree plus the executed test
  runs below.
- Binding contract: [`implementation-interfaces.md`](implementation-interfaces.md) §12–§15.
  Milestones: [`execution-plan.md`](execution-plan.md); architecture:
  [`../adr/0001-confluence-architecture.md`](../adr/0001-confluence-architecture.md).
- Honesty rule: a row says **Executed** only if the check was actually run on this tree; everything else
  is **Pending** or **Not executed**, even when the design is complete.

## 1. Verdict

**v0.1.0 is implemented, packaged, tested and installed on the real `desktop` profile.** Executed:
offline suite **256/256**, packaging check **12/12**, M0 smoke **14 pass / 0 fail / 1 blocked**,
scratch-profile offline E2E **8/8** (two real sessions, cross-session pulse), real-profile
`install_bundle` → **applied** with six tools + pulse live and `confluence_board` executed, export
producer CLI + `solo-bench` Go consumer tests green. **Not executed:** panel rendering/visual check
(needs a page refresh), PTC tool reachability, live multi-window freshness, soak/compaction, and
publish/release (nothing was published).

## 2. Milestones

| Milestone | Scope (ADR §14) | Status | Notes |
|---|---|---|---|
| **M0 — spikes** | Runtime-context dedupe, projection fold, PTC presentation, Windows journal append/torn line, multi-window topology, host channel, atomic-write import | **Executed** | 14 pass / 1 blocked in `scripts/m0-smoke.mjs`; S1/S2/S4/S7 closed, S3/S5 open; results in `m0-spikes.md` §10 |
| **M1 — core** | Store/journal, workspace resolver, board, board tools, pulse + welcome digest, projection watermarks | **Implemented + exercised** | `lib/{util,config,workspace,store,board,watermark,pulse}.js`; offline E2E proves pulse |
| **M2 — collaboration** | Ledger/presence, reply/search/recall, redaction/caps, private opt-outs, scratch-profile E2E | **Implemented + E2E executed** | `lib/{ledger,presence,recall,redact}.js`; `scripts/e2e-dsh.ps1` 8/8 |
| **M3 — panel** | Read-only UI, locale, transport, mark-read/opt-out, no-egress test, install verification | **Implemented; install executed; visual pending** | `client.js` + `lib/hostui.js`; same-origin route; real install applied; page refresh needed for the panel |
| **M4 — hardening** | Compaction/export + manifest, release verification, soak/concurrency tests, solo-bench integration | **Export + solo-bench consumer done; compaction/soak/release pending** | `lib/export.js`, `scripts/export-memories.mjs`, `solo-bench/internal/confluenceexport`; no publish |
| **v0.1.1 (later)** | Header badge, custom tool cards, composer/reply UI | **Deferred (signed off)** | Not in v0.1.0 scope |

## 3. Work packages and files

Present = the file exists in the working tree at this snapshot (all Host modules checked by
`scripts/check.mjs`).

| WP | Owner | Files | Status |
|---|---|---|---|
| WP1 core | design-core | `lib/util.js`, `lib/config.js`, `lib/workspace.js`, `lib/store.js` + tests | **Done** |
| WP2 behavior | design-behavior | `lib/redact.js`, `lib/board.js` + tests | **Done** |
| WP3 surface | design-surface | `lib/ledger.js`, `lib/presence.js`, `lib/recall.js` + tests | **Done** |
| WP4 passive | dsh-researcher | `lib/watermark.js`, `lib/pulse.js` + tests | **Done** |
| WP5 tools | planner | `lib/tools.js` + test | **Done** |
| WP6 UI | architect-a | `lib/hostui.js`, `client.js`, `test/hostui.test.js` | **Done (not visually verified)** |
| WP7 E2E | architect-b | `test/e2e/{mock-llm.mjs,lib/*,scenarios/*,assert-e2e.mjs}`, `test/fixtures/*`, `scripts/m0-smoke.mjs`, `scripts/e2e-dsh.ps1` | **Executed — M0 smoke 14 pass / 1 blocked; E2E 8/8** |
| WP8 packaging/docs | pattern-researcher | `package.json`, `test/contract.test.js`, `scripts/check.mjs`, `README*.md`, `docs/**`, `locale/*.json` | **Done — 256/256 + 12/12, docs status refreshed** |
| WP9 export/merge | architect-b / planner | `lib/export.js`, `scripts/export-memories.mjs`, `test/export.test.js`; `solo-bench/internal/confluenceexport` + vendored copy | **Done — export CLI proof + `go test ./...` green** |
| Integration | Lead | `index.js` wiring, `lib/facade.js` integration, install/verify, commit/tag/push | **Implementation + install/verify done; commit/tag/push at release** |

Implementation inventory: **14** `lib/*.js` modules, `index.js` (facade wiring), `client.js` (Dynamic
ModuleLoader id `dsh-confluence`), 24 shipped files in the pack listing, 15 test files (14 module tests +
`test/integration.test.js`) plus packaging contract tests, e2e scaffolding and fixtures.

## 4. Packaging/docs phase-2 changes (2026-11-13)

| Area | Change |
|---|---|
| `package.json` | Implemented-plugin description; `exports` = `.`/`./client`/`./locale/*.json`/`./icon`; `files` = `index.js`, `client.js`, `lib/*.js`, patch, locales, icon; **`dsh.client` declared** `{ platform:'web', immediately:true, inject:['@deepseek-ai/dsh-client-ui-sidebar','@deepseek-ai/dsh-client-ui-layout'] }` |
| `test/contract.test.js` | Rewritten for the implemented surface: manifest + `dsh.client`, exports/files runtime coverage (14 modules + client), patch rows/defaults, locales, icon, Host entry exports (`name`, `apply`, `inject` incl. `tools`, `DEFAULTS`, `applyWithDeps`, `VERSION`), quiet import, `apply()` bootstrap tolerance, offline posture (Host + client), README/docs honesty, shipped-file inventory, checker run |
| `scripts/check.mjs` | Rewritten: 12 dependency-free checks — manifest/`dsh.client`, files/exports, **dependency-free YAML-subset parse of the patch and deep-equality with `lib/config.js` DEFAULTS**, 14-module inventory, per-module export lists, Host entry surface + quiet import, client module id/registration/single relative GET, offline posture, locale parity, icon, docs honesty, docs-index links |
| `README.md` / `README.zh-CN.md` | v0.1.0 status (implemented Host + panel; tests pass; install/panel rendering **not** verified), architecture (14 modules + facade + client), docs map incl. implementation docs and integration test, pack contents (24 files), roadmap M0–M4/v0.1.1, executed-vs-not-executed verification tables |
| `docs/README.md` | Status + §6 implementation plan/status + §9 verification refreshed; implementation docs indexed |
| This file | Refreshed to the implemented state |

## 5. Verification: executed vs not executed

Executed on this tree:

| Check | Result |
|---|---|
| Offline test suite — `node --test --test-force-exit "test/*.test.js"` | **256/256 pass** (module tests, integration test, packaging contract) |
| Standalone packaging check — `node scripts/check.mjs` | **12/12 checks pass** |
| Locale parity (85 panel strings, en/zh identical key sets) | **Pass** (contract checks) |
| Icon structural validation | **Pass** (contract checks) |
| Offline/no-egress static scan (Host modules + panel) | **Pass** (contract checks) |
| `npm pack --dry-run --json` file list | **Executed** — 24 files (package.json, both READMEs, LICENSE, index.js, client.js, 14 `lib/*.js`, patch, both locales, icon); no dev-tree content, no tarball written. Sizes must be re-recorded at the release checkpoint (the tree changes between now and then) |
| Patch ↔ `lib/config.js` DEFAULTS deep equality | **Pass** (dependency-free YAML-subset parser in `check.mjs`) |

Not executed (must not be claimed as working):

| Check | Status |
|---|---|
| M0 spikes S1–S7 | **Not executed** — results TBD in `m0-spikes.md` §10 |
| Scratch-profile install (`dsh plugin --profile <scratch> add <abs path>`) | **Not executed** — procedure in `../install.md` §5 |
| Real desktop-profile install (Plugin Manager `install_bundle`) | **Not executed** — Lead-owned |
| Activation in a live host (tools/pulse/store/warnings observed) | **Not executed** |
| Panel rendering / live GUI verification | **Not executed** (no browser control in this round) |
| E2E harness run against a real launcher | **Not executed** (scaffolding only) |
| Built tarball + SHA-256; publish/release | **Not executed — nothing was published** |
| Merge into `solo-bench` | **Not executed** (contract documented) |

## 6. Blockers and next steps (for the Lead)

1. **Install verification.** Run the scratch-profile procedure from `../install.md` §5, then the real
   desktop profile after sign-off; record observed output in `../install.md` §6/§10. Nobody has
   installed the plugin yet.
2. **Panel visual verification.** The panel implementation is untested in a browser; verify rail entry,
   read-only rendering, en/zh, light/dark and no console crash before claiming UI success.
3. **M0 spike evidence.** Results are still TBD; the implementation landed without recorded spike
   evidence, so the design assumptions it rests on remain unre-checked in the live host.
4. **E2E harness run.** `test/e2e/*` scaffolding exists but has not been driven against a real launcher.
5. **Release checkpoint.** Re-run `npm pack --dry-run --json` on the final tree, record fresh
   contents/sizes/checksum in `../publishing.md`, then commit/tag/push (Lead-owned).

## 7. How to update this file

Change the "Last updated" line, re-scan the tree, update the milestone/WP/verification tables from what
was actually executed, and never mark a row Executed without the command and its output behind it.
