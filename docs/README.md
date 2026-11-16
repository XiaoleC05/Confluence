# Confluence / 高级记忆 — documentation index

This is the reading map for the repository. The project is a **fully-offline DeepSeek Harness
plugin** that gives every session in one DSH profile a single shared memory: a passive pulse, an
explicit board, and on-demand recall. From v0.2.0 the **profile, not the workspace, is the memory
boundary**; the binding decision is [ADR 0007](adr/0007-universal-memory-scope.md), which supersedes
the workspace-scoped parts of [ADR 0001](adr/0001-confluence-architecture.md).

**Status: v0.2.1 (universal memory; Chinese display name 高级记忆).** v0.2.1 is a display-name patch
only (formerly 汇流); the scope, store format, tool API and export contract are unchanged from v0.2.0.
The scope refactor and the independent review's fixes landed
and the offline evidence is green: on the final tree the offline suite is **291/291 pass**, the
standalone check is **17/17 pass**, and the offline scratch-profile cross-directory E2E is
**15/15 PowerShell checks + 12/12 assertions, exit 0** (post-review-fix run
`.tmp/e2e/run-20261116-203730`, 2026-11-16; see
[plan/implementation-status.md](plan/implementation-status.md) and
[discussion/v0.2-e2e-evidence.md](discussion/v0.2-e2e-evidence.md)). Still pending: v0.2.0
reinstall/restart on a real profile and **panel rendering** (never visually verified); nothing has
been published.

Verification honesty: documents state what was **executed** and what was not. The v0.2.0 panel has not
been visually verified in any round. Numbers in the docs are design targets unless stated otherwise.
Unverified claims are marked `HYPOTHESIS:`. Upgrading from v0.1.0? Start with
[upgrade-v0.2.md](upgrade-v0.2.md).

---

## 1. Reading order

1. [Project README](../README.md) — the promise, the pain, the status, the repository layout.
2. [Upgrade to v0.2.0](upgrade-v0.2.md) — what changed, config migration, legacy data, restart,
   rollback (read this first if you ran v0.1.0).
3. [ADR 0007 — universal memory scope](adr/0007-universal-memory-scope.md) — the binding v0.2.0
   decision: one global scope, provenance-only workspaces, export/panel/config consequences.
4. [ADR 0001 — architecture](adr/0001-confluence-architecture.md) — the original three-pillar
   decision (its workspace-scoped parts are superseded by ADR 0007).
5. [Scope refactor delta](plan/scope-refactor-delta.md) — the binding per-module interface delta for
   the v0.2.0 refactor, with acceptance criteria.
6. [Round 2 — cross-critique and decision](discussion/round-2.md) — why this architecture, what was
   rejected, corrections accepted into the design.
7. [Round 1 — research findings and candidate designs](discussion/round-1.md) — the evidence base and
   the two original options.
8. Round-3 design documents below — the implementable detail (components, store format, tools, pulse,
   UI, tests); each carries a **v0.2.0 amendment** note pointing at ADR 0007. Then the implementation
   contract and live status in §6, then packaging/install/publishing.

Read the two [research](research/dsh-internals.md) documents when you need the raw evidence: DSH
internals for exact APIs/behaviour, prior art and external patterns for what to compose with and what
to avoid.

---

## 2. Decision records (ADR)

| ADR | Status | One-line description |
|---|---|---|
| [ADR 0001 — Confluence / 高级记忆 architecture](adr/0001-confluence-architecture.md) | **Accepted** (design phase); workspace-scoped parts **superseded by ADR 0007** | v1 architecture: three-pillar hybrid, workspace identity, append-only sharded journal, six tools, pulse/watermark contract, config, privacy, milestones. |
| [ADR 0002 — store format and concurrency](adr/0002-store-format-and-concurrency.md) | Round 3 — decision record | Storage/journal format, sharding, merge-on-read and the multi-window concurrency model. |
| [ADR 0003 — pulse and watermarks](adr/0003-pulse-and-watermarks.md) | Round 3 — decision record | Passive pulse rendering and log-derived watermark mechanics. |
| [ADR 0004 — privacy and consent](adr/0004-privacy-and-consent.md) | Round 3 — decision record | Privacy, consent boundaries, redaction and opt-out decisions. |
| [ADR 0005 — UI transport](adr/0005-ui-transport.md) | Round 3 — decision record | M3 panel and the host→client data-channel decision. |
| [ADR 0006 — solo-bench integration](adr/0006-solo-bench-integration.md) | **Proposed** (future merge phase; not a decided record) | The `memories.v1.jsonl` export contract and the low-risk merge path into the `solo-bench` workbench. |
| [ADR 0007 — universal memory scope](adr/0007-universal-memory-scope.md) | **Accepted** (v0.2.0; supersedes ADR 0001 §5 and the workspace-scoped parts of §8/§9/§12) | One memory space per profile (`ws_0000000000000000`, "All sessions"); workspaces become provenance; legacy journals merged read-only; breaking config rename. |

## 3. Research (round 1, frozen)

| Document | One-line description |
|---|---|
| [DSH internals (0.2.2-rc.1)](research/dsh-internals.md) | 58-row verified-facts table: APIs, events, projections, storage behavior, multi-process hazards, prompt-assembly facts. |
| [Prior art in the DSH ecosystem](research/prior-art.md) | What already exists (session-reference, session search, dsh-context, better-sidebar, Crisp), what overlaps, and the honest gap analysis. |
| [External patterns](research/external-patterns.md) | Survey of memory/coordination patterns and a decision-oriented applicability matrix for an offline plugin. |

## 4. Discussion records (rounds 1–2 and independent review)

| Document | One-line description |
|---|---|
| [Round 1 — research findings and candidate designs](discussion/round-1.md) | What the research established, Option A and Option B summaries, and the open disagreements carried into round 2. |
| [Round 2 — cross-critique and architecture decision](discussion/round-2.md) | Votes, adopted agreements, Lead rulings (workspace key, six tools, lite-capture deferral, UI scope, storage layout), corrections accepted. |
| [Position A](discussion/position-a.md) | Architect A's written position on the hybrid option and its conditions. |
| [Position B](discussion/position-b.md) | Architect B's written position on the hybrid option and its conditions. |
| [Independent design review](discussion/design-review.md) | Independent verifier verdict (PASS WITH FIXES), executed checks, 8 P1 / 16 P2 findings, requirement matrix and fix dispositions. |
| [v0.2.0 offline E2E evidence](discussion/v0.2-e2e-evidence.md) | Executed evidence record: exact command, run directory, check tables (15/15 + 12/12), observed cross-directory behaviour and the three product bugs found and fixed. |

## 5. Design documents (round 3, with v0.2.0 amendments)

These are the implementable detail behind ADR-0001; [ADR 0007](adr/0007-universal-memory-scope.md)
overrides their workspace-scoped statements (each document says which, in its own "v0.2.0 amendment"
block). All documents listed here are present; the repository contract tests require every link on
this page to resolve.

| Document | One-line description | Status |
|---|---|---|
| [design/architecture.md](design/architecture.md) | Components, boundaries, lifecycle, ownership, and how host/client halves split. | **Available** + v0.2.0 scope amendment |
| [design/data-model.md](design/data-model.md) | Board and ledger record model, invariants, caps, threading and resolution semantics. | **Available** + v0.2.0 amendment (global scope, `origin`, renamed cap) |
| [design/store-format.md](design/store-format.md) | Per-writer JSONL journal format, shards, merge-on-read, torn-line tolerance, compaction, export manifest. | **Available** + v0.2.0 amendment (global dir, legacy merge) |
| [design/tool-api.md](design/tool-api.md) | The six model-facing tools: schemas, descriptions, result rendering, `through=` markers. | **Available** + v0.2.0 amendment (universal wording) |
| [design/pulse.md](design/pulse.md) | Passive digest template, byte-stability rules, budget split, escaping, watermark mechanics, welcome digest. | **Available** + v0.2.0 amendment (`confluence-memory` tag) |
| [design/ledger-recall.md](design/ledger-recall.md) | Metadata-only live ledger, presence heartbeats, on-demand literal recall, provenance refs. | **Available** + v0.2.0 amendment (all-sessions recall) |
| [design/ui.md](design/ui.md) | Read-only M3 panel: `sidebar.panellist` + keyed `main`, locale dictionaries, theme tokens, data channel. | **Available** + v0.2.0 amendment (global panel, no switcher) |
| [design/config.md](design/config.md) | Every configuration field, default, validation/fallback rule and user override semantics. | **Available** + v0.2.0 amendment (removed/renamed keys) |
| [design/security-privacy.md](design/security-privacy.md) | Trust model, untrusted-content framing, redaction, opt-outs, no-egress guarantees, filesystem safety. | **Available** + v0.2.0 amendment (profile boundary) |
| [design/testing.md](design/testing.md) | Acceptance criteria, unit/integration/E2E test plan, no-egress and field-allow-list tests. | **Available** + v0.2.0 amendment (cross-workspace acceptance) + **executed v0.2.0 evidence** (E2E 15/15 + 12/12, 2026-11-16) |
| [design/solo-bench-integration.md](design/solo-bench-integration.md) | `memories.v1.jsonl` export contract and the low-risk merge path into `solo-bench`. | **Available** + v0.2.0 amendment (global export) |

Historical option proposals (superseded by ADR-0001, kept for the decision record):
[Option A](design/options/option-a.md) and [Option B](design/options/option-b.md).

## 6. Implementation plan and status

| Document | One-line description | Status |
|---|---|---|
| [plan/scope-refactor-delta.md](plan/scope-refactor-delta.md) | **Binding** v0.2.0 interface delta: constants, per-module changes, ownership, acceptance criteria. | **Available** |
| [plan/implementation-interfaces.md](plan/implementation-interfaces.md) | **Binding** module contracts, exports, ownership and test conventions for the v0.1.0 build (the delta overrides it for v0.2.0). | **Available** |
| [plan/implementation-status.md](plan/implementation-status.md) | Live coordination record: milestone/WP state, files present, executed-vs-not-executed verification, blockers. | **Available** |
| [plan/execution-plan.md](plan/execution-plan.md) | Milestone plan (M0–M4), owners, dependencies, acceptance gates and risk checkpoints. | **Available** |
| [plan/m0-spikes.md](plan/m0-spikes.md) | M0 spike **specs** (method/protocol for S1–S7, spike→milestone map) and the executed results in §10. | **Available** |

## 7. Packaging and operations

| Document | One-line description |
|---|---|
| [Upgrade to v0.2.0 (universal memory)](upgrade-v0.2.md) | What changed, config migration (`privacy.disabledWorkspaces` removed, `ledger.maxSessions`), legacy read-only merge, restart, rollback. |
| [Install and verification guide](install.md) | How the bundle is installed and verified: Plugin Manager `install_bundle`, scratch-profile CLI path, offline guarantees, checklists, rollback, and the not-executed list. |
| [Publishing and release process](publishing.md) | Versioning, offline pack inspection and checksums, release steps, channel state, and the "nothing was published" honesty note. |

## 8. Planning

| Document | One-line description |
|---|---|
| [Team brief (round 1)](planning/team-brief.md) | Mission, verified environment facts, scope and constraints for the research rounds. |

## 9. Verification status

**v0.1.0 (historical, executed 2026-11-13):**

| Check | Result |
|---|---|
| Round-1 research + round-2 decision + ADRs 0001–0006 | Available (design package; ADR-0006 merge remains proposed) |
| Host plugin (15 `lib/*.js` modules + `index.js`) and Web panel (`client.js`) | **Implemented** |
| Offline test suite (`node --test --test-force-exit "test/*.test.js"`) | **Executed — 256/256 pass** |
| Packaging contract (`node scripts/check.mjs`) | **Executed — 12/12 checks pass** |
| `npm pack --dry-run` file-list inspection | **Executed** — 24 files, no dev-tree content; no tarball written |
| M0 spikes | **Executed** — 14 pass / 0 fail / 1 blocked (`scripts/m0-smoke.mjs`); S1/S2/S4/S7 closed, S3/S5 tracked open; results in `plan/m0-spikes.md` §10 |
| Offline scratch-profile E2E (`scripts/e2e-dsh.ps1`) | v0.1.0: **Executed — 8/8 checks** (two real sessions, cross-session pulse) |
| Bundle installed into a DSH profile; activation observed | **Executed on the real `desktop` profile** via Plugin Manager `install_bundle`; six tools + pulse live; `confluence_board` executed |
| Export producer + `solo-bench` Go consumer | **Implemented and tested** (`scripts/export-memories.mjs`, `solo-bench/internal/confluenceexport`) |
| Panel rendering / live GUI verification | **Not executed** — client bundle loads on the next page refresh; routes are auth-guarded |
| PTC preset tool reachability, multi-window live freshness, soak/compaction | **Not executed** |
| Building/hashing the tarball; publishing/release | **Not executed — nothing was published** |
| Merge into `solo-bench` | **Consumer + vendored copy present**; merge provenance documented in `solo-bench/integrations/dsh-plugin-confluence/INTEGRATION.md` |

**v0.2.0 (universal memory) — this round (2026-11-16):**

| Area | Status |
|---|---|
| Global scope + origin provenance, legacy read-only merge, plain serial merge | **Implemented in this round** (module-level tests per the delta) |
| Offline test suite on the final tree | **Executed — 291/291 pass** |
| Packaging contract (`node scripts/check.mjs`) | **Executed — 17/17 checks pass** (v0.2.0 constants, routes, deprecation warnings, global store layout) |
| M0 smoke (`node scripts/m0-smoke.mjs`) | **Executed — 14 pass / 0 fail / 1 blocked** (optional `@deepseek-ai/dsh-atomic-write` probe) |
| Independent-review fixes (R-01..R-14) | **Landed and covered** — private-session tool gating, single-flight store opens, POSIX/home export scrub, pulse no-churn on ledger heads, heartbeat 0.2.0; suite **291/291** (see [plan/implementation-status.md](plan/implementation-status.md) §4.2) |
| Offline scratch-profile cross-directory E2E (`scripts/e2e-dsh.ps1`) | **Executed — 15/15 PowerShell checks, 0 fail, exit 0; `assert-e2e.mjs` 12/12 checks** — run `.tmp/e2e/run-20261116-203730`; evidence: [discussion/v0.2-e2e-evidence.md](discussion/v0.2-e2e-evidence.md) |
| Cross-workspace memory (session A dir X, session B dir Y, same profile) | **Executed in the offline E2E** — B's committed pulse carried A's note; C board, D full read, E cross-directory recall; no workspace key passed |
| Legacy read-only merge (v0.1.0 journals appear with provenance, files byte-identical) | **Executed in the offline E2E** — seeded `ws_1a2b3c4d5e6f7081` merged; files byte-identical (sha256), nothing migrated |
| Global store + watermarks + cold-start activation | **Executed in the offline E2E** — writes only under `workspaces/ws_0000000000000000/`; `boardReadSeq` advanced; first request headers carried all six tools + pulse; real `~/.dsh` untouched |
| Locale parity (86 keys) and universal copy | **Executed by the contract checks** |
| Panel: global timeline, provenance chips, no workspace switcher, no `/workspaces` route | **Implemented and contract-tested**; rendering **still not visually verified** |
| Export: `scope:"global"`, global `wsKey`, additive `origin`, CLI without `--workspace` | **Implemented in this round**; Go consumer compatibility re-checked |
| Real-profile reinstall + DSH restart for v0.2.0 | **Not executed** (Lead-owned) |

## 10. Documentation conventions

- Every factual claim carries evidence: a `file:line` reference, an API signature from
  `cordis_inspect_query`, or a URL. Unverified claims are prefixed `HYPOTHESIS:`.
- Links are relative and must resolve in the repository; a document is added to this index when it exists.
- Numbers are design targets unless explicitly recorded as measured results.
- The project never claims a capability it has not implemented; v0.2.0 differences from v0.1.0 are
  tracked in [ADR 0007](adr/0007-universal-memory-scope.md) and
  [plan/scope-refactor-delta.md](plan/scope-refactor-delta.md), while the executed-vs-not-executed
  tables stay explicit.
- Historical v0.1.0 text stays where it is marked as history; new scope rules are added as a "v0.2.0
  amendment" note rather than silently rewriting the decision record.
