# Confluence / 汇流 — documentation index

This is the reading map for the repository. The project is a **fully-offline DeepSeek Harness
plugin** that gives sessions in the same workspace a shared memory: a passive pulse, an explicit
board, and on-demand recall. The binding architecture is
[ADR 0001](adr/0001-confluence-architecture.md).

**Status: v0.1.0 implemented (Host plugin + read-only panel).** The offline unit and integration test
suite passes and the packaging contract passes. Installation, live activation and panel rendering are
**not executed**; the M0 spike specs are present but **not executed** (results TBD in
`plan/m0-spikes.md` §10). Packaging, install and publishing guides are present.

Verification honesty: documents state what was **executed** and what was not. The project has not been
installed into a DSH profile, has not run in a live host, and has published nothing. Numbers in the
docs are design targets unless stated otherwise. Unverified claims are marked `HYPOTHESIS:`.

---

## 1. Reading order

1. [Project README](../README.md) — the promise, the pain, the status, the repository layout.
2. [ADR 0001 — architecture](adr/0001-confluence-architecture.md) — the binding decision: three
   pillars, storage/concurrency model, tools, pulse/watermarks, config, privacy, milestones.
3. [Round 2 — cross-critique and decision](discussion/round-2.md) — why this architecture, what was
   rejected, corrections accepted into the design.
4. [Round 1 — research findings and candidate designs](discussion/round-1.md) — the evidence base and
   the two original options.
5. Round-3 design documents below — the implementable detail (components, store format, tools, pulse,
   UI, tests), then the implementation contract and live status in §6, then packaging/install/publishing.

Read the two [research](research/dsh-internals.md) documents when you need the raw evidence: DSH
internals for exact APIs/behaviour, prior art and external patterns for what to compose with and what
to avoid.

---

## 2. Decision records (ADR)

| ADR | Status | One-line description |
|---|---|---|
| [ADR 0001 — Confluence / 汇流 architecture](adr/0001-confluence-architecture.md) | **Accepted** (design phase) | Binding v1 architecture: three-pillar hybrid, workspace identity, append-only sharded journal, six tools, pulse/watermark contract, config, privacy, milestones, rejected alternatives. |
| [ADR 0002 — store format and concurrency](adr/0002-store-format-and-concurrency.md) | Round 3 — decision record | Storage/journal format, sharding, merge-on-read and the multi-window concurrency model. |
| [ADR 0003 — pulse and watermarks](adr/0003-pulse-and-watermarks.md) | Round 3 — decision record | Passive pulse rendering and log-derived watermark mechanics. |
| [ADR 0004 — privacy and consent](adr/0004-privacy-and-consent.md) | Round 3 — decision record | Privacy, consent boundaries, redaction and opt-out decisions. |
| [ADR 0005 — UI transport](adr/0005-ui-transport.md) | Round 3 — decision record | M3 panel and the host→client data-channel decision. |
| [ADR 0006 — solo-bench integration](adr/0006-solo-bench-integration.md) | **Proposed** (future merge phase; not a decided record) | The `memories.v1.jsonl` export contract and the low-risk merge path into the `solo-bench` workbench. |

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

## 5. Design documents (round 3)

These are the implementable detail behind ADR-0001. All documents listed here are present; the
repository contract tests require every link on this page to resolve.

| Document | One-line description | Status |
|---|---|---|
| [design/architecture.md](design/architecture.md) | Components, boundaries, lifecycle, ownership, and how host/client halves split. | **Available** |
| [design/data-model.md](design/data-model.md) | Board and ledger record model, invariants, caps, threading and resolution semantics. | **Available** |
| [design/store-format.md](design/store-format.md) | Per-writer JSONL journal format, shards, merge-on-read, torn-line tolerance, compaction, export manifest. | **Available** |
| [design/tool-api.md](design/tool-api.md) | The six model-facing tools: schemas, descriptions, result rendering, `through=` markers. | **Available** |
| [design/pulse.md](design/pulse.md) | Passive digest template, byte-stability rules, budget split, escaping, watermark mechanics, welcome digest. | **Available** |
| [design/ledger-recall.md](design/ledger-recall.md) | Metadata-only live ledger, presence heartbeats, on-demand literal recall, provenance refs. | **Available** |
| [design/ui.md](design/ui.md) | Read-only M3 panel: `sidebar.panellist` + keyed `main`, locale dictionaries, theme tokens, data channel. | **Available** |
| [design/config.md](design/config.md) | Every configuration field, default, validation/fallback rule and user override semantics. | **Available** |
| [design/security-privacy.md](design/security-privacy.md) | Trust model, untrusted-content framing, redaction, opt-outs, no-egress guarantees, filesystem safety. | **Available** |
| [design/testing.md](design/testing.md) | Acceptance criteria, unit/integration/E2E test plan, no-egress and field-allow-list tests. | **Available** |
| [design/solo-bench-integration.md](design/solo-bench-integration.md) | `memories.v1.jsonl` export contract and the low-risk merge path into `solo-bench`. | **Available** |

Historical option proposals (superseded by ADR-0001, kept for the decision record):
[Option A](design/options/option-a.md) and [Option B](design/options/option-b.md).

## 6. Implementation plan and status

| Document | One-line description | Status |
|---|---|---|
| [plan/implementation-interfaces.md](plan/implementation-interfaces.md) | **Binding** module contracts, exports, ownership and test conventions for the v0.1.0 build. | **Available** |
| [plan/implementation-status.md](plan/implementation-status.md) | Live coordination record: milestone/WP state, files present, executed-vs-not-executed verification, blockers. | **Available** |
| [plan/execution-plan.md](plan/execution-plan.md) | Milestone plan (M0–M4), owners, dependencies, acceptance gates and risk checkpoints. | **Available** |
| [plan/m0-spikes.md](plan/m0-spikes.md) | M0 spike **specs** (method/protocol for S1–S7, spike→milestone map); **not executed** — results TBD in §10. | **Available** |

## 7. Packaging and operations

| Document | One-line description |
|---|---|
| [Install and verification guide (v0.1.0)](install.md) | How the bundle is installed and verified: Plugin Manager `install_bundle`, scratch-profile CLI path, offline guarantees, checklists, rollback, and the not-executed list. |
| [Publishing and release process](publishing.md) | Versioning, offline pack inspection and checksums, release steps, channel state, and the "nothing was published" honesty note. |

## 8. Planning

| Document | One-line description |
|---|---|
| [Team brief (round 1)](planning/team-brief.md) | Mission, verified environment facts, scope and constraints for the research rounds. |

## 9. Verification status

| Area | Status |
|---|---|
| Round-1 research + round-2 decision + ADRs 0001–0006 | Available (design package; ADR-0006 merge remains proposed) |
| Host plugin (15 `lib/*.js` modules + `index.js`) and Web panel (`client.js`) | **Implemented** |
| Offline test suite (`node --test --test-force-exit "test/*.test.js"`) | **Executed — 256/256 pass** |
| Packaging contract (`node scripts/check.mjs`) | **Executed — 12/12 checks pass** |
| `npm pack --dry-run` file-list inspection | **Executed** — 24 files, no dev-tree content; no tarball written |
| M0 spikes | **Executed** — 14 pass / 0 fail / 1 blocked (`scripts/m0-smoke.mjs`); S1/S2/S4/S7 closed, S3/S5 tracked open; results in `plan/m0-spikes.md` §10 |
| Offline scratch-profile E2E (`scripts/e2e-dsh.ps1`) | **Executed — 8/8 checks** (two real sessions, cross-session pulse) |
| Bundle installed into a DSH profile; activation observed | **Executed on the real `desktop` profile** via Plugin Manager `install_bundle`; six tools + pulse live; `confluence_board` executed |
| Panel rendering / live GUI verification | **Not executed** — client bundle loads on the next page refresh; routes are auth-guarded |
| PTC preset tool reachability, multi-window live freshness, soak/compaction | **Not executed** |
| Export producer + `solo-bench` Go consumer | **Implemented and tested** (`scripts/export-memories.mjs`, `solo-bench/internal/confluenceexport`) |
| Building/hashing the tarball; publishing/release | **Not executed — nothing was published** |
| Merge into `solo-bench` | **Consumer + vendored copy present**; merge provenance documented in `solo-bench/integrations/dsh-plugin-confluence/INTEGRATION.md` |

## 10. Documentation conventions

- Every factual claim carries evidence: a `file:line` reference, an API signature from
  `cordis_inspect_query`, or a URL. Unverified claims are prefixed `HYPOTHESIS:`.
- Links are relative and must resolve in the repository; a document is added to this index when it exists.
- Numbers are design targets unless explicitly recorded as measured results.
- The project never claims a capability it has not implemented; the v0.1.0 implementation is covered by
  the offline test suite, while install/activation/panel checks remain explicitly pending.

