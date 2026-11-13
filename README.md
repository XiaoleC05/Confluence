# Confluence / 汇流

> **Your sessions remember together.** / **同一工作区的会话，共享同一份记忆。**

**Status: v0.1.0 implemented — Host plugin + read-only Web panel; the offline unit and integration
test suite passes. The bundle has NOT yet been installed into a DSH profile and its panel rendering has
NOT been visually verified.** This README separates what was executed from what is still pending.

Confluence (Chinese name **汇流**, "where streams meet") is a **fully offline** DeepSeek Harness (DSH)
plugin that lets sessions in the same workspace share what they learned: a passive **pulse** in the
prompt, a durable **board** of shared notes, and an explicit, bounded **recall** over earlier sessions.
No server, no network calls, no extra port, no child processes and no model calls at runtime.

- Target host: DSH Desktop **0.2.2-rc.1** (declared minimum `>=0.2.2-rc.1`), profile `desktop`.
- Package: `dsh-confluence` **v0.1.0**, `private: true`, MIT, no runtime dependencies.
- Repository: [https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)

---

## The problem

DSH sessions are isolated language contexts. Two sessions started in the same directory do not know
that they share a workspace, so the same investigation is repeated and decisions are lost between
windows. Today the only workarounds are manual: `@`-mention another session (a user-triggered, bounded
snapshot), enable the experimental session-search tools (off by default and model-triggered), or ask an
agent to write a file the other agent reads.

Confluence makes workspace memory ambient instead: every session in the same project automatically sees
what peers shared, what is open, and what recently happened — locally, offline and bounded.

---

## What v0.1.0 implements

| Pillar | Implemented in v0.1.0 |
|---|---|
| **Pulse** — passive awareness | One global `confluence:pulse` `ctx.systemPrompt.context()` contribution: a byte-stable, bounded digest of unread headlines, open questions/handoffs, live peers and the workspace name. The agent loop commits a new runtime-context snapshot only when the text changes, so an unchanged pulse costs no new tokens. Implemented by `lib/pulse.js` with log-derived watermarks (`lib/watermark.js`). |
| **Board** — shared memory | Append-only, workspace-scoped JSONL journal (one writer shard per process) with typed notes (`finding`, `decision`, `gotcha`, `question`, `handoff`, `warning`), threads, resolution and tombstones. Implemented by `lib/store.js` + `lib/board.js` + `lib/facade.js`. |
| **Ledger + recall** | Metadata-only live session ledger and presence heartbeats (no prompts/tool text), plus explicit literal recall over earlier same-workspace session logs through `ctx.sessionQuery` exact reads. Implemented by `lib/ledger.js`, `lib/presence.js`, `lib/recall.js`. |
| **Six model tools** | `confluence_board`, `confluence_post`, `confluence_read`, `confluence_search`, `confluence_reply`, `confluence_recall` (`lib/tools.js`). |
| **Read-only Web panel** | Left-rail entry + keyed main page (`client.js`) with board timeline, search/filters, entry detail, open items, mark-read and opt-out controls. Data comes from four read-only same-origin routes on the existing DSH web server (`lib/hostui.js`) — the documented route fallback; no `host.call`, no iframe, no push channel. |

The user-visible promise: **"Your sessions remember together."**

---

## How it works (architecture)

```text
┌───────────────────────────── DSH Desktop (one Host per app instance) ─────────────────────────────┐
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
│   ┌──────────────── Confluence Host plugin (plain ESM, Node builtins only) ─────────────────────┐  │
│   │ index.js (facade wiring) → lib/: config · workspace · redact · store · board · ledger      │  │
│   │ presence · watermark · pulse · recall · tools · hostui · facade · util                     │  │
│   └──────────────────────────────────────┬──────────────────────────────────────────────────────┘  │
│                                          │ append-only JSONL shards + presence heartbeats          │
│                 $DSH_HOME/storages/confluence/v1/workspaces/<wsKey>/                              │
│                 ├─ journal.<writerId>.v1.jsonl     ├─ presence/<writerId>.json                     │
│                 └─ MANIFEST.v1.json (M4)           └─ snapshot.<gen>.v1.jsonl (M4)                │
│                                                                                                    │
│   Web panel (client.js): read-only same-origin GET on the existing web server; no new port          │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Key boundaries:

- **Workspace = consent boundary.** Key = canonicalized session `header.cwd` (`fs.realpath`, Windows
  case-folded), frozen per session. Nothing crosses workspaces; recall only reads sessions whose
  canonical `cwd` matches the caller's workspace.
- **The store is profile-local.** Append-only per-writer shards under
  `$DSH_HOME/storages/confluence/v1/`; readers merge shards, tolerate torn trailing lines, and poll as
  the freshness contract (`fs.watch` is only an optimization).
- **The session log stays the source of truth.** Watermarks (`digestSeq`, `boardReadSeq`) are derived
  from committed session events through a `sessionProjections` unit; plugin state is a derived cache.
- **Shared content is untrusted data.** Fixed warning, escaped framing (`<`, `&`, U+2028/2029), no
  instruction-following, bounded sizes, best-effort secret redaction, metadata-only ledger.
- **Offline by construction.** No `fetch` in the Host half, no network modules, no sockets, no child
  processes; the panel's only request is a relative same-origin GET on the host's existing web server.

---

## What v0.1.0 does not do

- no continuous transcript indexing, no LLM extraction, no embeddings/vector search;
- no server, network call, additional listening port, external database, child process or model call;
- no cross-workspace reading or sharing;
- no remote/LAN collaboration, no Liveshare, no git automation;
- no board editing/deletion UI in v0.1.0 (tombstones are M4); no composer, no custom tool cards, no
  per-session unread badge (deferred to v0.1.1);
- not a replacement for `@`-mention snapshots or raw session search — it composes alongside them.

---

## Implementation reality (what is in this repository today)

| Claim | Reality |
|---|---|
| Host plugin (15 `lib/*.js` modules + `index.js` wiring) | **Implemented** |
| Web panel (`client.js`, Dynamic ModuleLoader id `dsh-confluence`) | **Implemented, not visually verified** |
| Six model tools, pulse, board, ledger/presence, recall, store | **Implemented**; unit tests cover each module |
| Offline unit + integration test suite | **Passes offline** — `node --test --test-force-exit "test/*.test.js"` |
| Packaging contract (manifest/patch/locales/icon/entry) | **Passes** — `node scripts/check.mjs` |
| Installed into a scratch profile | **Not executed** (procedure in [docs/install.md](docs/install.md)) |
| Installed into the real desktop profile | **Not executed** (Lead-owned) |
| Panel rendering in a live GUI | **Not executed** (no browser control in this round) |
| M0 spikes / E2E harness run | **Not executed** (specs and scaffolding only) |
| npm pack / publish | **Pack dry-run executed**; no tarball, release or publication |

The repository does **not** claim the plugin is installed, activated or visually verified. Those checks
are listed as pending below and in [docs/install.md](docs/install.md).

---

## Repository layout

```text
D:\05_Code\Confluence\
  index.js                   Host entry: wires the 15 lib modules onto the Cordis context
  client.js                  Web panel: plain Dynamic ModuleLoader module (id 'dsh-confluence')
  lib/                       Host modules (plain ESM, Node builtins only):
    util.js config.js workspace.js redact.js store.js board.js watermark.js pulse.js
    ledger.js presence.js recall.js tools.js hostui.js facade.js
  package.json               bundle manifest: dsh-confluence v0.1.0, private, MIT, no dependencies
  cordis.patch.yml           inserts the single `confluence` row with the full default config
  locale/en.json, zh.json    display metadata + 85 panel strings (en/zh aligned)
  icon.svg                   original icon: three streams merging into one channel
  examples/profile-patch.yml commented user override examples (privacy/low-noise/debug)
  scripts/check.mjs          standalone packaging check (dependency-free)
  test/                      unit tests per module, integration test, e2e scaffolding, fixtures
  docs/                      design, research, decisions, plans, status, install/publishing guides
```

There is no build step: the Host half is plain ESM and the panel is a plain browser module.

---

## Documentation

Start with the [documentation index](docs/README.md) for the full map and reading order.

**Decisions and context**

- [ADR 0001 — Confluence / 汇流 architecture](docs/adr/0001-confluence-architecture.md)
- [ADR 0002 — store format and concurrency](docs/adr/0002-store-format-and-concurrency.md) ·
  [ADR 0003 — pulse and watermarks](docs/adr/0003-pulse-and-watermarks.md) ·
  [ADR 0004 — privacy and consent](docs/adr/0004-privacy-and-consent.md) ·
  [ADR 0005 — UI transport](docs/adr/0005-ui-transport.md) ·
  [ADR 0006 — solo-bench integration](docs/adr/0006-solo-bench-integration.md) (proposed)
- [Round 1](docs/discussion/round-1.md) · [Round 2](docs/discussion/round-2.md) ·
  [Position A](docs/discussion/position-a.md) · [Position B](docs/discussion/position-b.md)

**Research**

- [DSH internals](docs/research/dsh-internals.md) · [Prior art](docs/research/prior-art.md) ·
  [External patterns](docs/research/external-patterns.md)

**Implementation**

- [Implementation interfaces (binding)](docs/plan/implementation-interfaces.md) — module contracts,
  exports, ownership, test conventions.
- [Implementation status (live)](docs/plan/implementation-status.md) — milestone/WP state,
  executed-vs-not-executed verification, blockers.
- [Execution plan](docs/plan/execution-plan.md) · [M0 spikes](docs/plan/m0-spikes.md) (specs; results TBD)
- Design documents: [architecture](docs/design/architecture.md) ·
  [data model](docs/design/data-model.md) · [store format](docs/design/store-format.md) ·
  [tool API](docs/design/tool-api.md) · [pulse](docs/design/pulse.md) ·
  [ledger + recall](docs/design/ledger-recall.md) · [panel](docs/design/ui.md) ·
  [config](docs/design/config.md) · [security & privacy](docs/design/security-privacy.md) ·
  [testing](docs/design/testing.md) · [solo-bench integration](docs/design/solo-bench-integration.md)
- Tests: `test/*.test.js` (module + packaging) and `test/integration.test.js` (host wiring, tools,
  pulse, store, panel routes).

**Packaging and operations**

- [Install and verification guide](docs/install.md)
- [Publishing and release process](docs/publishing.md)

---

## Offline and privacy guarantees

- no `fetch`, outbound socket, network module, child process or model call in the Host half;
- no additional listening port and no server; the panel uses the existing DSH web server via relative
  same-origin GETs only;
- no external database — profile-local files under `$DSH_HOME/storages/confluence/v1/`;
- no telemetry, no crash reporting, no update check.

Privacy model:

- **Workspace is the consent boundary.** Default-on sharing of board notes and metadata *within* one
  workspace; nothing is shared across workspaces.
- **Metadata-first.** The ledger stores titles, session ids, timestamps, turn counts, status and up to
  eight workspace-relative paths; no prompts, assistant text, tool outputs or command lines. Prior
  session logs are read *only* when an agent explicitly calls `confluence_recall`, and only bounded
  excerpts are returned.
- **Best-effort redaction** for API keys, tokens, private keys and password-like values, with
  configurable deny-path and custom patterns plus per-session / per-workspace opt-outs.
- **Shared notes are untrusted data.** The pulse and tool results carry a fixed warning and escaped
  framing; shared content can never trigger a tool call by itself.

These guarantees are enforced by static contract checks and the privacy unit tests (see the
verification table below); they are not a claim that a live host was audited.

---

## Install status

> **Not installed yet.** No DSH profile was modified during this round. v0.1.0 is implemented and its
> offline tests pass, but installation and activation are still pending.

The procedure is documented in [docs/install.md](docs/install.md):

1. **Scratch profile (first):** `dsh plugin --profile <scratch> add <absolute path>`, then
   `--dump-config` to confirm the `confluence` row composes — **not executed**.
2. **Real desktop profile:** Plugin Manager `install_bundle` from the absolute repository path —
   **not executed / Lead-owned**.

What installation verification must still prove: bundle row composes with the full default config, the
six tools appear, the pulse renders bounded and byte-stable, the store files appear under
`$DSH_HOME/storages/confluence/v1/`, the panel opens and is read-only, and no network/port/child
process appears.

Rollback: remove the bundle from the profile (`dsh plugin --profile <name> remove dsh-confluence`) or
delete the scratch `DSH_HOME` directory; plugin data can be removed separately.

---

## Development

Requirements: **Node.js ≥ 22.19.0**; DSH Desktop **0.2.2-rc.1** for real activation later. No
dependencies and no build step.

```powershell
# from the repository root
node --test --test-force-exit "test/*.test.js"   # all offline tests (unit + integration + packaging)
node scripts/check.mjs                            # standalone packaging check (dependency-free)
npm pack --dry-run --json                         # inspect the shipped file list (offline)
```

`npm pack --dry-run` currently reports **24 files**: `package.json`, both READMEs, `LICENSE`, `index.js`,
`client.js`, the 15 `lib/*.js` modules, `cordis.patch.yml`, both locale files and `icon.svg`. No
`test/`, `docs/`, `examples/` or `scripts/` content ships.

### Development, verification and release helpers

| Script | Purpose |
|---|---|
| `node scripts/check.mjs` | Dependency-free packaging/contract checker (12 checks). |
| `node scripts/m0-smoke.mjs` | M0 evidence suite: ULID, redaction corpus, pulse caps, journal append/torn-tail/two-writer, native lease, offline scan. |
| `pwsh -File scripts/e2e-dsh.ps1` | Offline scratch-profile E2E: fresh `DSH_HOME` + headless profile + local Messages-API mock, two real sessions in one workspace, cross-session pulse assertions. |
| `node scripts/export-memories.mjs --dsh-home <dir> --workspace <path>` | Explicit opt-in export producer: writes deterministic `memories.v1.jsonl` + `manifest.json` under `<workspace>/.confluence/export/`. |
| `node --test --test-force-exit "test/*.test.js"` | All offline tests (unit, integration, packaging contract). |

---

## Roadmap

| Milestone | Scope | Status |
|---|---|---|
| **M0 — spikes** | Runtime-context dedupe, projection marker fold, PTC presentation, Windows journal, multi-window topology, host channel, atomic-write import | Specs present; **executed** for S1/S2/S4/S7 (`scripts/m0-smoke.mjs`, 14 pass / 1 blocked) and the route-fallback host channel (S6); PTC dispatch shape (S3) and multi-window topology (S5) remain **open** |
| **M1 — core** | Store, workspace resolver, board, board tools, pulse + welcome digest, projection watermarks | **Implemented and exercised** in v0.1.0 (unit + offline E2E) |
| **M2 — collaboration** | Ledger/presence, reply/search/recall, redaction/caps, private opt-outs, scratch-profile offline E2E | **Implemented**; scratch-profile offline E2E **executed** (8/8 harness checks) |
| **M3 — panel** | Read-only UI, locale, transport, mark-read/opt-out, no-egress test, install verification | **Implemented**; install + activation **executed** on the real desktop profile; panel rendering/visual check **not executed** (needs a page refresh) |
| **M4 — hardening** | Compaction/export + manifest, release verification, soak/concurrency tests, solo-bench integration | Export producer + solo-bench Go consumer **implemented and tested**; compaction/soak and release publishing **not executed** |
| **v0.1.1 (later)** | Header badge, custom tool cards, composer/reply UI | Deferred (signed off) |

---

## Verification status

Executed on this tree (2026-11-13, Windows 11, Node 22.19.0, DSH 0.2.2-rc.1):

| Check | Result |
|---|---|
| Offline test suite (`node --test --test-force-exit "test/*.test.js"`) | **256/256 pass** (unit, integration, packaging contract) |
| Standalone packaging check (`node scripts/check.mjs`) | **12/12 checks pass** |
| `npm pack --dry-run --json` file-list inspection (offline) | **Executed** — 24 files, no dev-tree content; no tarball written |
| M0 smoke (`node scripts/m0-smoke.mjs`) | **14 pass / 0 fail / 1 blocked** — `@deepseek-ai/dsh-atomic-write` is not resolvable from the repository context; the native lease is the shipped path |
| Scratch-profile offline E2E (`pwsh -File scripts/e2e-dsh.ps1`) | **8/8 checks, 7/7 assertions** — scratch `DSH_HOME`, local Messages-API mock, two real headless sessions in one workspace: session 1 publishes with `confluence_post`, session 2 receives it in the passive pulse; durable journal + committed pulse snapshots + no Confluence inbox splice; artifacts under `.tmp/e2e/run-*/` |
| Real desktop-profile install (Plugin Manager `install_bundle`) | **Executed** — `application: applied`; dependency `dsh-confluence: link:D:/05_Code/Confluence` + bundle selected; six tools visible to the live Host; pulse rendered in this session's runtime context; `confluence_board` executed and returned an untrusted-framed board result; store created under the real `~/.dsh/storages/confluence/v1/` |
| Export producer CLI (`node scripts/export-memories.mjs`) | **Executed** against the E2E scratch store — valid `manifest.json` + `memories.v1.jsonl`, deterministic hash, `--dry-run` writes nothing |
| `solo-bench` Go consumer (`internal/confluenceexport`) | **Executed** — `go test ./...`, `go vet ./...`, `gofmt -l .` clean; export-only contract, no live IPC |
| Static offline/no-egress scan, locale parity, icon validation | **Executed by the contract checks** |

Not executed yet:

| Check | Status |
|---|---|
| Panel rendering / visual verification | **Not executed** — the client bundle loads on the next page render; Host routes are registered and auth-guarded (static client contract tests pass) |
| PTC preset (`run_code`) tool reachability | **Not executed** — M0-S3 spike remains open |
| Multi-window live freshness measurement | **Not executed** — polling is the implemented contract; two-process merge is covered by tests |
| Soak/compaction stress, long-run retention | **Not executed** |
| Built tarball + SHA-256, publish/release | **Not executed — nothing was published** |

---

## License

[MIT](LICENSE) © 2026 XiaoleC05 and Confluence / 汇流 contributors.

## Links

- GitHub: [https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)
- Crisp plugin precedent (local checkout): `D:\05_Code\Crisp\integrations\dsh-plugin-crisp`
