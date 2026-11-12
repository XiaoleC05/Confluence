# Confluence / 汇流

> **Your sessions remember together.** / **同一工作区的会话，共享同一份记忆。**

**Status: design complete — implementation starts at milestone M1.** This repository currently
contains the complete design, the packaging scaffold for the DSH bundle, and dependency-free contract
tests. The plugin entry point is deliberately empty: **installing this bundle has no user-visible
effect yet.** There is no board, no pulse, no recall, no UI and no data written anywhere.

Confluence (Chinese name **汇流**, "where streams meet") is a fully-offline plugin for
**DeepSeek Harness (DSH)** that makes information sharing between sessions of the same workspace
automatic instead of a manual "please write it to a doc" instruction. It targets DSH Desktop
**0.2.2-rc.1**, profile `desktop`, and later merges into the `solo-bench` offline workbench.

This README is honest about what exists. Nothing here is a benchmark, a screenshot, or a demo; the
project has not been installed into a profile yet.

---

## The problem

DSH sessions are isolated language contexts. Two sessions started in the same directory do not know
that they are working on the same workspace:

- session A root-causes a Windows `EPERM` retry bug; session B re-investigates it from scratch;
- session A decides "pin every dependency to the 0.2.x line"; session B chooses 0.3.x;
- session A is halfway through a schema migration; session B starts another migration over it;
- a user copies a paragraph from one chat window to another all day long.

Today the only workarounds are manual:

| Workaround | Where it falls short |
|---|---|
| Ask the agent to write a file, then ask the other agent to read it | You are the message bus; the file is not durable shared memory |
| `@`-mention another session (`@deepseek-ai/dsh-session-reference`) | User-triggered, per-message, a bounded immutable snapshot; it does not tell the model what is new or open |
| Enable the experimental `session_*` search tools | Shipped **off by default and hidden**; full-text search, model-triggered, no awareness |
| A dashboard/insight plugin (e.g. `dsh-context`) | Read-only insight for a human; it does not share anything between sessions |

The missing layer is **ambient workspace memory**: a session should not have to be told that a peer
learned something. It should just know what the workspace shared, what is open, and what recently
happened — locally, offline and bounded.

---

## What Confluence will do (v1)

The v1 architecture is a three-pillar hybrid, decided in
[ADR 0001](docs/adr/0001-confluence-architecture.md) §2:

### 1. Pulse — passive awareness

One global `ctx.systemPrompt.context()` contribution renders a **byte-stable, bounded digest** on
every agent step: up to three new board headlines, open questions and handoffs, live peer sessions,
and the workspace name. When a new note changes the text, the agent loop commits one new
runtime-context snapshot; when nothing changed, the pulse costs **zero** new tokens and emits no new
message. No wake-ups, no timers, no polling of agents.

### 2. Board — explicit shared memory

A durable, append-only, workspace-scoped board of short typed notes published by agents (or the
user): `finding`, `decision`, `gotcha`, `question`, `handoff`, `warning`. Notes can be threaded with
`reply_to`; questions and handoffs resolve. Nothing is edited in place — corrections are new notes or
resolutions. Six model-facing tools (`confluence_board`, `confluence_post`, `confluence_read`,
`confluence_search`, `confluence_reply`, `confluence_recall`) are the collaboration verbs.

### 3. Ledger + recall — on-demand history

A **metadata-only** session ledger (title, status, turn count, last activity, up to 8
workspace-relative paths observed in tool calls) keeps awareness of live peers. `confluence_recall`
searches prior same-workspace session logs **only when the model calls it**, through
`ctx.sessionQuery` exact reads: literal matches, capped, timed, read-only. Recall never runs inside
the prompt provider and never auto-injects.

The user-visible promise: **"Your sessions remember together."** / **"同一工作区的会话，共享同一份记忆。"**

The docs describe v1 accurately as *awareness plus on-demand literal search* — not as automatic
retroactive transcript indexing (that is a possible v2 step, gated on an evaluation; see ADR §11).

---

## How it works (architecture)

```text
┌───────────────────────────── DSH Desktop (one host per app instance) ─────────────────────────────┐
│                                                                                                    │
│   Session A — workspace W                       Session B — workspace W                            │
│   ┌────────────────────────────┐                ┌────────────────────────────┐                     │
│   │ agent step                 │                │ agent step                 │                     │
│   │ prompt assembly            │                │ prompt assembly            │                     │
│   │  └─ confluence:pulse ──────┼── byte-stable ─┼─► the same rendered text  │                     │
│   │ tools: confluence_*        │   digest       │ tools: confluence_*       │                     │
│   └─────────────┬──────────────┘                └─────────────┬──────────────┘                     │
│                 │                                             │                                   │
│                 ▼                                             ▼                                   │
│   ┌──────────────────────── Confluence host plugin (plain ESM, Node builtins) ──────────────────┐  │
│   │ WorkspaceResolver │ BoardService │ SessionLedger │ PulseProvider │ Watermark │ RecallService│  │
│   └──────────────────────────────────────┬──────────────────────────────────────────────────────┘  │
│                                          │ append-only JSONL shards, presence heartbeats          │
│                 $DSH_HOME/storages/confluence/v1/workspaces/<wsKey>/                              │
│                 ├─ journal.<writerId>.v1.jsonl     ├─ presence/<writerId>.json                     │
│                 └─ MANIFEST.v1.json (M4)           └─ snapshot.<gen>.v1.jsonl (M4)                │
│                                                                                                    │
│   optional M3: read-only panel via sidebar.panellist + keyed main (no port, no network)           │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Key boundaries (full detail in the [design docs](docs/README.md)):

- **Workspace = consent boundary.** Key = canonicalized session `header.cwd` (`fs.realpath`, Windows
  case-folded), frozen per session. Nothing crosses workspaces. A session without a resolvable
  workspace gets no pulse and no Confluence tools.
- **The store is profile-local, not workspace pollution.** Append-only per-writer JSONL shards under
  `$DSH_HOME/storages/confluence/v1/`; readers merge shards, tolerate torn trailing lines, and poll
  every 3–5 s as the freshness contract (`fs.watch` is only an optimization).
- **The session log stays the source of truth.** Watermarks (`digestSeq`, `boardReadSeq`) are derived
  from committed session events through a `sessionProjections` unit, so resume/replay/fork inherit
  them without watermark files; plugin state is a derived cache.
- **Shared content is untrusted data.** Fixed warning, escaped framing (`<`, `&`, U+2028/2029), no
  instruction-following, bounded sizes, best-effort secret redaction, metadata-only ledger.

---

## What v1 will not do

Stated here so nobody is surprised later:

- no continuous transcript indexing, no LLM extraction, no embeddings/vector search;
- no server, network call, additional listening port, external database, child process or model
  invocation;
- no cross-workspace reading or sharing;
- no remote/LAN collaboration, no Liveshare, no git automation;
- no board editing or deletion UI, no accounts or permissions;
- not a replacement for `@`-mention snapshots or raw session search — it composes alongside them.

---

## Design-stage reality (what is in this repository today)

| Claim | Reality today |
|---|---|
| Plugin bundle manifest and patch | **Present** — `package.json`, `cordis.patch.yml` |
| Host entry point | **Present but empty by design** — `index.js` resolves config, logs one warning, registers nothing |
| Locale metadata and icon | **Present** — `locale/en.json`, `locale/zh.json`, `icon.svg` |
| Contract tests | **Present and offline** — `node --test "test/*.test.js"` |
| Design documentation | **Present** — research, rounds 1–2, ADR-0001–0006 and the complete design set |
| Pulse / board / ledger / recall / tools | **Not implemented** — M1–M2 |
| Panel / client half | **Not implemented** — M3 |
| Installed and activated in a DSH profile | **No** — not executed in this phase |

The scaffold logs exactly one activation warning so an installed-but-empty bundle can never be
mistaken for a working one.

---

## Repository layout

```text
D:\05_Code\Confluence\
  README.md                  this file (English)
  README.zh-CN.md            Chinese README
  LICENSE                    MIT
  package.json               bundle manifest, name dsh-confluence, private v0.1.0
  cordis.patch.yml           inserts the single `confluence` row + full default config
  index.js                   host entry (design-stage scaffold only)
  locale/en.json, zh.json    display metadata + future panel strings
  icon.svg                   original icon: three streams merging into one channel
  examples/profile-patch.yml commented user override examples (privacy/low-noise/debug)
  scripts/check.mjs          standalone contract check
  test/contract.test.js      dependency-free node:test contract tests
  docs/                      design, research, decisions, plans, install/publishing guides
```

There is no `lib/`, no `client.js` and no build step yet: the v1 host is planned as plain ESM
JavaScript with Node builtins only, and the client half arrives in M3. The empty `src/` directory is
reserved for future implementation and is not part of the bundle today.

---

## Documentation

Start with the [documentation index](docs/README.md) for the full map and reading order.

**Decisions and context**

- [ADR 0001 — Confluence / 汇流 architecture](docs/adr/0001-confluence-architecture.md) — binding v1
  architecture, configuration, milestones, rejected alternatives.
- [Round 1 — research findings and candidate designs](docs/discussion/round-1.md)
- [Round 2 — cross-critique and architecture decision](docs/discussion/round-2.md)
- [Position A](docs/discussion/position-a.md) · [Position B](docs/discussion/position-b.md)
- [Team brief](docs/planning/team-brief.md)

**Research**

- [DSH internals (0.2.2-rc.1)](docs/research/dsh-internals.md) — verified APIs, events, store
  behaviour, concurrency hazards.
- [Prior art in the DSH ecosystem](docs/research/prior-art.md) — what already exists, what to compose
  with, what not to duplicate.
- [External patterns](docs/research/external-patterns.md) — offline-safe pattern survey and matrix.

**Round-3 design documents**

- [architecture](docs/design/architecture.md) — components, boundaries, lifecycle, ownership.
- [data model](docs/design/data-model.md) — board/ledger record model and invariants.
- [store format](docs/design/store-format.md) — journal format, shards, merge-on-read, compaction, export.
- [tool API](docs/design/tool-api.md) — the six tool schemas and result rendering.
- [pulse](docs/design/pulse.md) — digest template, budget split, escaping, watermark mechanics.
- [ledger + recall](docs/design/ledger-recall.md) — metadata ledger and on-demand recall.
- [panel design](docs/design/ui.md) — read-only panel, slots, locale, data channel.
- [configuration](docs/design/config.md) — every configuration field and default.
- [security & privacy](docs/design/security-privacy.md) — trust model, redaction, opt-outs, no-egress guarantees.
- [test plan](docs/design/testing.md) — acceptance criteria and verification plan.
- [solo-bench integration](docs/design/solo-bench-integration.md) — export contract and merge path.
- [execution plan](docs/plan/execution-plan.md) — milestone plan and ownership.
- [M0 spikes](docs/plan/m0-spikes.md) — M0 spike list and results.
- ADR [0002 — store](docs/adr/0002-store-format-and-concurrency.md),
  [0003 — pulse/watermarks](docs/adr/0003-pulse-and-watermarks.md),
  [0004 — privacy](docs/adr/0004-privacy-and-consent.md),
  [0005 — UI transport](docs/adr/0005-ui-transport.md), [0006 — solo-bench](docs/adr/0006-solo-bench-integration.md).

**Packaging and operations**

- [Install and verification guide (future / M3-verified)](docs/install.md)
- [Publishing and release process](docs/publishing.md)

---

## Offline and privacy guarantees

Confluence is designed to run with **no network at all**:

- no `fetch`, no outbound socket, no child process, no model call in the plugin runtime;
- no additional listening port and no server; installation is a local package operation;
- no external database — only profile-local files under `$DSH_HOME/storages/confluence/v1/`;
- no telemetry, no crash reporting, no update check.

Privacy model (ADR §11):

- **Workspace is the consent boundary.** Default-on sharing of board notes and metadata *within* one
  workspace; nothing is shared across workspaces.
- **Stored vs read on demand is stated plainly.** The store holds board notes, titles, session
  metadata, workspace-relative paths and counts. Prior session logs are read *only* when the model
  explicitly calls `confluence_recall`, and only bounded excerpts are returned.
- **Metadata-first defaults.** No prompts, assistant text, tool outputs or command lines are stored;
  file hints are excluded from the pulse by default (`ledger.fileHintsInPulse: false`).
- **Best-effort redaction** for API keys, tokens, private keys and password-like values, with
  configurable deny-path patterns and per-session / per-workspace opt-outs.
- **Shared notes are untrusted data**, not instructions — the pulse and board results carry a fixed
  warning, escape framing characters, and can never trigger a tool call by themselves.

These are design commitments; the no-egress and field-allow-list tests arrive with the implementation
(M1–M4). The current scaffold itself contains no network or child-process code (checked by
`test/contract.test.js`).

---

## Install (future / M3-verified)

> **Not executed in this phase. Do not expect any behaviour if you install this bundle today.**
> No profile was modified while producing this repository. The documented verification target is
> **M3**, and the full procedure lives in [docs/install.md](docs/install.md).

Two documented paths (shipped DSH guidance, copied from the Crisp integration precedent):

1. **Plugin Manager `install_bundle`** — install the bundle from the absolute repository path; the
   manager performs package installation and bundle selection.
2. **CLI into a scratch profile** — `dsh plugin --profile <scratch-name> add <absolute path>`, then
   `dsh --profile <scratch-name> --dump-config` to confirm the `confluence` row composes, before any
   real-profile install.

Expected design-stage activation behaviour: exactly **one warning** in the host log, stating that the
plugin is a design-stage scaffold with no capabilities. No tools, no prompt text, no UI, no files.

Rollback: remove the bundle from the profile (`dsh plugin --profile <name> remove dsh-confluence`) or
remove the row; a locally linked checkout leaves no state behind.

---

## Development

Requirements: **Node.js ≥ 22.19.0** and, for real activation later, **DSH ≥ 0.2.2-rc.1**. There are
no dependencies to install and no build step.

```powershell
# from the repository root
node --test "test/*.test.js"     # contract tests (offline, no deps)
node scripts/check.mjs          # same checks as a standalone script with a summary
```

What the current tests cover: bundle manifest shape, patch row and default config, locale metadata and
en/zh key alignment, icon validity and self-containment, host-entry import/apply contract (one warning,
no registrations, malformed-config tolerance), no network/child-process/DSH imports in the host entry,
README honesty markers and line budgets, docs-index link resolution, and the install/publishing guide
sections. They intentionally test **packaging**, not unimplemented behaviour.

---

## Roadmap

| Milestone | Scope | Status |
|---|---|---|
| **M0 — spikes** | Verify runtime-context dedupe, projection marker fold, PTC tool presentation, Windows journal append/torn lines, multi-window topology, host data channel, optional atomic-write import. | Planned (1 d) |
| **M1 — core** | Journal store, workspace resolver, board records, `confluence_board`/`post`/`read`, pulse + welcome digest, projection watermarks, unit tests. | Planned (4 d) |
| **M2 — collaboration** | Live ledger + presence, `reply`/`search`/`recall`, redaction/caps, private/opt-out, scratch-profile offline E2E. | Planned (3.5 d) |
| **M3 — panel** | Read-only UI, locale, transport decision, mark-read/opt-out, no-egress test; **install verification**. | Planned (2.5 d) |
| **M4 — hardening** | Compaction/export + manifest, docs/publishing verification, soak/concurrency tests, badge/custom cards, solo-bench integration doc. | Planned (2 d) |

Total v1 scope ≈ **13 engineer-days** (±30 %), per [ADR §14](docs/adr/0001-confluence-architecture.md).
v2 (optional): deterministic lite-capture signals gated on a precision/recall evaluation — not v1.

---

## Verification status

Executed during this design phase:

| Check | Result |
|---|---|
| Design documents written (research, rounds 1–2, ADR-0001) | Executed |
| Packaging scaffold authored (manifest, patch, entry, locales, icon, examples) | Executed |
| Contract tests authored and run offline (`node --test`, Node 22) | Executed — see report below |
| Standalone contract checker authored and run (`node scripts/check.mjs`) | Executed |
| `npm pack --dry-run` file-list inspection (offline; no tarball written) | Executed — 9 files, no unintended content |
| Static offline check of the host entry (no network/child-process/DSH imports) | Executed by contract test |
| Icon structural validation (SVG, no scripts/text/external refs, < 256 KiB) | Executed by contract test |

Not executed during this design phase:

| Check | Status |
|---|---|
| Installing the bundle into any DSH profile | **Not executed** |
| Activation inside a live DSH host; observing the single warning | **Not executed** |
| Pulse injection, board tools, recall, panel rendering | **Not implemented, not executed** |
| Multi-window / multi-process concurrency behaviour | **Not executed** (design + spike plan only) |
| Building/hashing the tarball (`npm pack`), `npm publish --dry-run` | **Not executed** (dry-run listing executed) |
| Publishing to npm or creating a GitHub release | **Not executed — nothing was published** |
| Merge into `solo-bench` | **Not executed** (merge path documented only) |

No benchmarks, screenshots, user counts or performance numbers are claimed anywhere in this
repository; where a number appears (token budget, caps, storage sizes), it is a **design target**.

---

## License

[MIT](LICENSE) © 2026 XiaoleC05 and Confluence / 汇流 contributors.

## Links

- GitHub: [https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)
- Crisp plugin precedent (local checkout): `D:\05_Code\Crisp\integrations\dsh-plugin-crisp`
