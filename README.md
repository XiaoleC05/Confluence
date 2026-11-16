# Confluence / 汇流

> **One shared memory for every session on this machine.** / **本机所有会话，共享同一份记忆。**

**Status: v0.2.0 — universal memory.** The scope change is decided in
[ADR 0007](docs/adr/0007-universal-memory-scope.md): the **DSH profile, not the workspace, is the
memory boundary**, so every session — whatever directory it runs in — reads and writes the same shared
memory. On the final v0.2.0 tree — after the independent review's fixes — the offline suite is
**291/291 pass**, the packaging contract is **17/17 pass**, and the offline scratch-profile
**cross-directory E2E is green: 15/15 PowerShell checks + 12/12 assertion checks, exit 0** (post-fix
run `.tmp/e2e/run-20261116-203730`, 2026-11-16; full evidence in
[docs/discussion/v0.2-e2e-evidence.md](docs/discussion/v0.2-e2e-evidence.md) and
[docs/plan/implementation-status.md](docs/plan/implementation-status.md)). The real-profile
reinstall/restart is still not executed, and the panel's visual check is still pending. The v0.1.0
executed evidence below is historical and stays true for that version. The panel's **rendering has
still not been visually verified** for either version, and nothing has been published.

Confluence (Chinese name **汇流**, "where streams meet") is a **fully offline** DeepSeek Harness (DSH)
plugin that gives every session in your profile one long-conversation shared memory: a passive
**pulse** in the prompt, a durable **board** of shared notes, and an explicit, bounded **recall** over
earlier sessions. No server, no network calls, no extra port, no child processes and no model calls at
runtime.

- Target host: DSH Desktop **0.2.2-rc.1** (declared minimum `>=0.2.2-rc.1`), profile `desktop`.
- Package: `dsh-confluence` **v0.2.0**, `private: true`, MIT, no runtime dependencies.
- Repository: [https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)
- Upgrading from v0.1.0? Read [docs/upgrade-v0.2.md](docs/upgrade-v0.2.md) first — two config keys
  changed and the linked bundle needs a DSH restart.

---

## The problem

DSH sessions are isolated language contexts. A new conversation starts with no idea that twenty
minutes ago, in another window or another folder, you and an agent already decided the schema, hit the
Windows rename bug, or agreed on the dependency pin. The same investigation is repeated and the
decisions are lost.

v0.1.0 scoped memory **per workspace** (`header.cwd`). That was the original brief interpreted
literally, and it made the plugin feel like a project tool: memory fragmented across directories, and
a conversation started in another folder could not see the memory created next to it. The user
clarified the product intent — Confluence is a **universal** long-conversation and shared-memory
plugin:

> "这个插件更像是一个长对话和便捷共享记忆插件，这个是通用的，而不是单独给某一个工作区设置的。"

v0.2.0 implements that: **one memory space per profile.** Directory and session are *provenance*
labels on a memory entry, never a partition, filter, or permission boundary.

---

## What v0.2.0 implements

| Pillar | Implemented in v0.2.0 |
|---|---|
| **Pulse** — passive awareness | One global `confluence:pulse` `ctx.systemPrompt.context()` contribution: a byte-stable, bounded `<confluence-memory scope="global" …>` digest of unread notes from **any** session, open questions/handoffs, and all live peers. The agent loop commits a new runtime-context snapshot only when the text changes, so an unchanged pulse costs no new tokens. Implemented by `lib/pulse.js` with log-derived watermarks (`lib/watermark.js`); legacy `<confluence-workspace …>` snapshots are still parsed. |
| **Board** — shared memory | Append-only JSONL journal in **one global scope** (`ws_0000000000000000`, label "All sessions") with typed notes (`finding`, `decision`, `gotcha`, `question`, `handoff`, `warning`), threads, resolution and tombstones. Each entry carries an optional `origin` (the workspace label it was written from) as provenance only. Implemented by `lib/store.js` + `lib/board.js` + `lib/facade.js`. |
| **Ledger + recall** | Metadata-only live session ledger and presence heartbeats for **all** sessions in the profile (no prompts/tool text), plus explicit literal recall over earlier sessions anywhere on this machine through `ctx.sessionQuery` exact reads. `privacy.privateSessions` still removes a session completely. Implemented by `lib/ledger.js`, `lib/presence.js`, `lib/recall.js`. |
| **Six model tools** | `confluence_board`, `confluence_post`, `confluence_read`, `confluence_search`, `confluence_reply`, `confluence_recall` (`lib/tools.js`). Wording is universal: none says "this workspace"; recall says "all earlier sessions on this machine". |
| **Read-only Web panel** | Left-rail entry + keyed main page (`client.js`), title **"汇流记忆 / Confluence memory"**: one global timeline, kind/tag filters, search, entry detail with thread, open items, live peers, and a provenance chip showing the workspace label an entry came from. **No workspace switcher.** Data comes from read-only same-origin routes on the existing DSH web server (`lib/hostui.js`) — `ping`, `overview`, `entry`; no `host.call`, no iframe, no push channel. |
| **Export (opt-in)** | `confluence.memories/v1` unchanged for the consumer: the manifest gains `scope:"global"` and reports the global `wsKey`/name, every record uses the global key, and an additive `origin` carries provenance. CLI drops `--workspace`. |

The user-visible promise: **"Your sessions remember together."**

---

## How it works (architecture)

```text
┌───────────────────────────── DSH Desktop (one Host per app instance) ─────────────────────────────┐
│                                                                                                    │
│   Session A — folder X                          Session B — folder Y                               │
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
│   │ presence · watermark · pulse · recall · tools · hostui · facade · export · util            │  │
│   └──────────────────────────────────────┬──────────────────────────────────────────────────────┘  │
│                    append-only JSONL shards + presence heartbeats (global scope only)              │
│         $DSH_HOME/storages/confluence/v1/workspaces/ws_0000000000000000/                           │
│         ├─ journal.<writerId>.v1.jsonl     ├─ presence/<writerId>.json                             │
│         └─ MANIFEST.v1.json                └─ snapshot.<gen>.v1.jsonl                              │
│         (legacy workspaces/ws_<16hex>/ journals stay on disk, merged READ-ONLY into every view)     │
│                                                                                                    │
│   Web panel (client.js): read-only same-origin GET on the existing web server; no new port          │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Key boundaries:

- **Profile/machine = sharing boundary.** One logical scope `global` (`GLOBAL_SCOPE_KEY =
  ws_0000000000000000`, label "All sessions"). Every session in the profile reads and writes it;
  `lib/workspace.js` is reduced to an **origin resolver** used for provenance (`origin: {
  workspaceKey, workspaceLabel }`) and nothing else. No tool, pulse, recall, panel call or export is
  conditioned on a workspace key.
- **The store is profile-local.** Append-only per-writer shards under
  `$DSH_HOME/storages/confluence/v1/`; new writes only go to the reserved global scope. Legacy
  per-workspace journals are never modified or migrated — they are merged read-only into the board,
  pulse, panel and export, with their manifest label as provenance.
- **The session log stays the source of truth.** Watermarks (`digestSeq`, `boardReadSeq`) are derived
  from committed session events through a `sessionProjections` unit; plugin state is a derived cache.
- **Shared content is untrusted data.** Fixed warning, escaped framing (`<`, `&`, U+2028/2029), no
  instruction-following, bounded sizes, best-effort secret redaction, metadata-only ledger.
- **Offline by construction.** No `fetch` in the Host half, no network modules, no sockets, no child
  processes; the panel's only request is a relative same-origin GET on the host's existing web server.

---

## What v0.2.0 does not do

- no continuous transcript indexing, no LLM extraction, no embeddings/vector search;
- no server, network call, additional listening port, external database, child process or model call;
- no per-workspace isolation mode and no scope switch — universal is the product (ADR 0007 §5);
- no sharing across profiles, OS users or machines; the boundary is this DSH profile;
- no remote/LAN collaboration, no Liveshare, no git automation;
- no board editing/deletion UI yet (tombstones are M4); no composer, no custom tool cards, no
  per-session unread badge (deferred);
- not a replacement for `@`-mention snapshots or raw session search — it composes alongside them.

---

## Implementation reality (what is in this repository today)

| Claim | Reality |
|---|---|
| Host plugin (15 `lib/*.js` modules + `index.js` wiring) | **Implemented**; the v0.2.0 universal-memory refactor is on this tree (suite 291/291) |
| Web panel (`client.js`, Dynamic ModuleLoader id `dsh-confluence`) | **Implemented, not visually verified** |
| Six model tools, pulse, board, ledger/presence, recall, store, export | **Implemented**; unit tests cover each module |
| Offline unit + integration test suite | v0.1.0: **passes offline** (`node --test --test-force-exit "test/*.test.js"`), 256/256. v0.2.0 final tree: **291/291 pass** (2026-11-16) |
| Packaging contract (manifest/patch/locales/icon/entry) | v0.1.0: **passes** (`node scripts/check.mjs`), 12/12. v0.2.0 final tree: **17/17 checks pass** |
| Cross-workspace acceptance (session A folder X, session B folder Y, same profile) | v0.2.0 **executed** — offline scratch-profile E2E run `20261116-203730`: **15/15 harness checks, 12/12 assertions**; see [design/testing.md](docs/design/testing.md) and the [evidence record](docs/discussion/v0.2-e2e-evidence.md) |
| Installed into a scratch profile | **Executed in the offline E2E** (throwaway `DSH_HOME`, `dsh plugin add` + `--dump-config`, 2026-11-16); a long-lived manual scratch profile is not required for that evidence |
| Installed into the real desktop profile | v0.1.0 **executed** (Plugin Manager `install_bundle` → applied); v0.2.0 reinstall/restart **not executed** |
| Legacy read-only merge observed in a live scratch profile | **Executed in the E2E** — seeded v0.1.0 journal merged with provenance, files byte-identical (sha256), nothing migrated |
| Panel rendering in a live GUI | **Not executed** (no browser control) |
| npm pack / publish | **Pack dry-run executed**; no tarball, release or publication |

The repository does **not** claim the plugin is installed into the user's desktop profile, or that the
panel was visually verified for v0.2.0. Activation, the six tools, the pulse, the global store and the
legacy merge were observed only inside the throwaway E2E scratch profile.

---

## Repository layout

```text
D:\05_Code\Confluence\
  index.js                   Host entry: wires the 15 lib modules onto the Cordis context
  client.js                  Web panel: plain Dynamic ModuleLoader module (id 'dsh-confluence')
  lib/                       Host modules (plain ESM, Node builtins only):
    util.js config.js workspace.js redact.js store.js board.js watermark.js pulse.js
    ledger.js presence.js recall.js tools.js hostui.js facade.js export.js
  package.json               bundle manifest: dsh-confluence v0.2.0, private, MIT, no dependencies
  cordis.patch.yml           inserts the single `confluence` row with the full default config
  locale/en.json, zh.json    display metadata + panel strings (en/zh aligned)
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
- [ADR 0007 — Universal memory scope](docs/adr/0007-universal-memory-scope.md) — **binding for
  v0.2.0**: the profile is the memory boundary; supersedes the workspace-scoped parts of ADR 0001
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

- [Scope refactor delta (binding)](docs/plan/scope-refactor-delta.md) — the v0.2.0 interface
  contract: names/constants, git interface changes, acceptance criteria.
- [Implementation interfaces (binding)](docs/plan/implementation-interfaces.md) — module contracts,
  exports, ownership, test conventions (v0.1.0 baseline; the delta overrides it).
- [Implementation status (live)](docs/plan/implementation-status.md) — milestone/WP state,
  executed-vs-not-executed verification, blockers.
- [Execution plan](docs/plan/execution-plan.md) · [M0 spikes](docs/plan/m0-spikes.md) (specs; results
  in §10)
- Design documents: [architecture](docs/design/architecture.md) ·
  [data model](docs/design/data-model.md) · [store format](docs/design/store-format.md) ·
  [tool API](docs/design/tool-api.md) · [pulse](docs/design/pulse.md) ·
  [ledger + recall](docs/design/ledger-recall.md) · [panel](docs/design/ui.md) ·
  [config](docs/design/config.md) · [security & privacy](docs/design/security-privacy.md) ·
  [testing](docs/design/testing.md) · [solo-bench integration](docs/design/solo-bench-integration.md)
  — each carries a "v0.2.0 amendment" note pointing at ADR 0007.
- Tests: `test/*.test.js` (module + packaging) and `test/integration.test.js` (host wiring, tools,
  pulse, store, panel routes).

**Packaging and operations**

- [Install and verification guide](docs/install.md)
- [Publishing and release process](docs/publishing.md)
- [Upgrade to v0.2.0 (universal memory)](docs/upgrade-v0.2.md) — config migration, legacy data,
  restart, rollback.

---

## Offline and privacy guarantees

- no `fetch`, outbound socket, network module, child process or model call in the Host half;
- no additional listening port and no server; the panel uses the existing DSH web server via relative
  same-origin GETs only;
- no external database — profile-local files under `$DSH_HOME/storages/confluence/v1/`;
- no telemetry, no crash reporting, no update check.

Privacy model — stated plainly, because the boundary moved:

- **The profile on this machine is the sharing boundary.** Confluence is a single-user local
  workbench: shared memory written by any session in the profile is readable by every other session in
  the same profile, by design. That is the product, not a bug. Nothing crosses profiles, OS users, or
  machines.
- **The workspace is no longer a boundary.** v0.1.0 offered per-workspace opt-out
  (`privacy.disabledWorkspaces`); v0.2.0 removes it, because there is no workspace boundary left to
  disable. Its replacement for the narrow "keep this conversation out of shared memory" case is
  **`privacy.privateSessions`**: a private session gets no pulse, no ledger row, no presence, and no
  Confluence tools — it is invisible to shared memory while it remains private.
- **Metadata-first.** The ledger stores titles, session ids, timestamps, turn counts, status and up to
  eight workspace-relative paths; no prompts, assistant text, tool outputs or command lines. Prior
  session logs are read *only* when an agent explicitly calls `confluence_recall`, and only bounded
  excerpts are returned.
- **Best-effort redaction** for API keys, tokens, private keys and password-like values, with
  configurable deny-path and custom patterns plus the per-session opt-out.
- **Shared notes are untrusted data.** The pulse and tool results carry a fixed warning and escaped
  framing; shared content can never trigger a tool call by itself.
- **Export stays opt-in and redacted**, and never contains absolute paths.

These guarantees are enforced by static contract checks and the privacy unit tests; they are not a
claim that a live host was audited, and they never protect against other tools in the same profile.

---

## Upgrading from v0.1.0

Two config keys changed; the rest still works, and legacy memory is not lost. Full guide:
**[docs/upgrade-v0.2.md](docs/upgrade-v0.2.md)**.

- **Removed:** `privacy.disabledWorkspaces` — v0.1.0 profiles that set it get an activation warning
  (`CONFIG_DEPRECATED privacy.disabledWorkspaces`) and the value is ignored. Use `privacy.privateSessions`
  instead.
- **Renamed:** `ledger.maxSessionsPerWorkspace` → `ledger.maxSessions` (default 200, range 20–1000).
  The old key is no longer read; set the new one if you customized it.
- **Unchanged:** `store.maxEntriesPerWorkspace` keeps its name and now caps the single global board.
  There is no scope switch — `memory.scope` does not exist.
- **Restart required:** the installed bundle is a local link, so DSH must be restarted (or the bundle
  row toggled) to load the new Host module generation. A config edit alone reloads the plugin row, not
  the module code.
- **Legacy data:** v0.1.0 per-workspace journals are merged read-only into the global view. They are
  not rewritten, moved, or deleted; new notes are written only to the global scope.

---

## Install status

> **Not reinstalled into the real desktop profile for v0.2.0.** v0.1.0 was installed there; the v0.2.0
> upgrade (reinstall + DSH restart + live re-verification) has not been executed. The **offline
> scratch-profile E2E** *has* been executed (2026-11-16): a throwaway `DSH_HOME`, `dsh plugin add`,
> `--dump-config`, five headless sessions and the assertions (15/15 + 12/12, run `20261116-203730`).

The procedure is documented in [docs/install.md](docs/install.md):

1. **Scratch profile:** executed by the offline E2E — `dsh plugin --profile <scratch> add <absolute path>`
   plus `--dump-config` in `.tmp/e2e/run-20261116-203730/dsh-home`; the `confluence` row composed with
   the full default config (E2E-00a/b/c).
2. **Real desktop profile:** Plugin Manager `install_bundle` from the absolute repository path, then
   restart DSH — **not executed / Lead-owned**. A config edit alone does not load the new Host modules;
   the linked bundle needs the restart.

What installation verification must prove: the bundle row composes with the full default config (no
`disabledWorkspaces`, `ledger.maxSessions` present), the six tools appear, the pulse renders bounded
and byte-stable with the `<confluence-memory>` tag, the store files appear under the **global** scope
directory, the panel opens with a global timeline and no workspace switcher, and no
network/port/child process appears.

Rollback: remove the bundle from the profile (`dsh plugin --profile <name> remove dsh-confluence`) and
restart DSH; plugin data can be removed separately.

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

`npm pack --dry-run` for the v0.1.0 tree reported **24 files**: `package.json`, both READMEs,
`LICENSE`, `index.js`, `client.js`, the 15 `lib/*.js` modules (including `export.js`), `cordis.patch.yml`,
both locale files and `icon.svg`. No `test/`, `docs/`, `examples/` or `scripts/` content ships. Re-run
and re-record this listing at the next release checkpoint.

### Development, verification and release helpers

| Script | Purpose |
|---|---|
| `node scripts/check.mjs` | Dependency-free packaging/contract checker. |
| `node scripts/m0-smoke.mjs` | M0 evidence suite: ULID, redaction corpus, pulse caps, journal append/torn-tail/two-writer, native lease, offline scan. |
| `pwsh -File scripts/e2e-dsh.ps1` | Offline scratch-profile E2E: fresh `DSH_HOME` + headless profile + local Messages-API mock. Executed for v0.2.0 (`20261116-203730`): session A in `workspace-a`, sessions B–E in `workspace-b`, one profile → **15/15 checks + 12/12 assertions**. |
| `node scripts/export-memories.mjs --dsh-home <dir> [--out <dir>] [--json] [--dry-run]` | Explicit opt-in export producer. Default output: `<dsh-home>/storages/confluence-exports/<UTC-stamp>/`. There is no `--workspace` flag any more. |
| `node --test --test-force-exit "test/*.test.js"` | All offline tests (unit, integration, packaging contract). |

---

## Roadmap

| Milestone | Scope | Status |
|---|---|---|
| **M0 — spikes** | Runtime-context dedupe, projection marker fold, PTC presentation, Windows journal, multi-window topology, host channel, atomic-write import | Specs present; **executed** for S1/S2/S4/S7 (`scripts/m0-smoke.mjs`, 14 pass / 1 blocked) and the route-fallback host channel (S6); PTC dispatch shape (S3) and multi-window topology (S5) remain **open** |
| **M1 — core** | Store, **origin resolver** (v0.2.0), board, board tools, pulse + welcome digest, projection watermarks | **Implemented and exercised**; v0.2.0 global-scope rewrite landed, offline suite 291/291 |
| **M2 — collaboration** | Ledger/presence, reply/search/recall, redaction/caps, private opt-outs, scratch-profile offline E2E | **Implemented and exercised end-to-end** — scratch-profile cross-directory E2E **15/15 + 12/12** (2026-11-16) |
| **M3 — panel** | Read-only UI, locale, transport, mark-read/opt-out, no-egress test, install verification | **Implemented**; global panel (no workspace switcher, provenance chips) contract-tested; visual check **not executed** |
| **M4 — hardening** | Compaction/export + manifest, release verification, soak/concurrency tests, solo-bench integration | Export producer + solo-bench Go consumer **implemented and tested**; global export format update in this round; compaction/soak and release **not executed** |
| **v0.2.x (later)** | Header badge, custom tool cards, composer/reply UI | Deferred (signed off) |

---

## Verification status

**v0.1.0 (historical, executed 2026-11-13, Windows 11, Node 22.19.0, DSH 0.2.2-rc.1):**

| Check | Result |
|---|---|
| Offline test suite (`node --test --test-force-exit "test/*.test.js"`) | **256/256 pass** (unit, integration, packaging contract) |
| Standalone packaging check (`node scripts/check.mjs`) | **12/12 checks pass** |
| `npm pack --dry-run --json` file-list inspection (offline) | **Executed** — 24 files, no dev-tree content; no tarball written |
| M0 smoke (`node scripts/m0-smoke.mjs`) | **14 pass / 0 fail / 1 blocked** — `@deepseek-ai/dsh-atomic-write` is not resolvable from the repository context; the native lease is the shipped path |
| Scratch-profile offline E2E (`pwsh -File scripts/e2e-dsh.ps1`) | v0.1.0: **8/8 checks, 7/7 assertions** — two real headless sessions in one workspace, cross-session pulse |
| Real desktop-profile install (Plugin Manager `install_bundle`) | **Executed** — `application: applied`; six tools visible; pulse rendered; `confluence_board` executed; store created under `~/.dsh/storages/confluence/v1/` |
| Export producer CLI + `solo-bench` Go consumer | **Executed** — deterministic manifest/hash, `go test ./...` green |
| Static offline/no-egress scan, locale parity, icon validation | **Executed by the contract checks** |

**v0.2.0 (universal memory) — this round, executed 2026-11-16:**

| Check | Status |
|---|---|
| Offline suite on the final tree (`node --test --test-force-exit "test/*.test.js"`) | **Executed — 291/291 pass** (module, integration and packaging contract tests) |
| Packaging contract (`node scripts/check.mjs`) | **Executed — 17/17 checks pass**, including v0.2.0 constants, routes, deprecation warnings and the global store layout |
| M0 smoke (`node scripts/m0-smoke.mjs`) | **Executed — 14 pass / 0 fail / 1 blocked** — the blocked item is the optional `@deepseek-ai/dsh-atomic-write` probe; the native lease is the shipped path |
| Offline scratch-profile cross-directory E2E (`pwsh -NoProfile -File scripts/e2e-dsh.ps1`) | **Executed — 15/15 PowerShell checks, 0 fail, exit 0; `assert-e2e.mjs` 12/12 checks** — run `.tmp/e2e/run-20261116-203730` (`summary.json`, `mock-*.jsonl`, session logs kept as artifacts) |
| Cross-directory memory (A in `workspace-a`; B/C/D/E in `workspace-b`, same profile) | **Executed in the E2E** — B's committed pulse carried A's note; C listed A's note + the legacy note; D returned A's note body; E's `confluence_recall` found A's session text from the other directory |
| Global store + legacy read-only merge | **Executed in the E2E** — new writes only under `storages/confluence/v1/workspaces/ws_0000000000000000/`; seeded `ws_1a2b3c4d5e6f7081` files byte-identical (sha256), nothing migrated |
| Watermarks + cold-start activation | **Executed in the E2E** — `boardReadSeq` advanced after board/read and stayed `null` for post-only/pulse-only sessions; the cold-start first request headers already carried all six tools + the pulse |
| Locale parity (86 keys, en/zh identical) + universal copy | **Executed by the contract checks** |
| Tool descriptions / panel route list / patch keys | **Executed by the contract checks** (no "this workspace"; ping/overview/entry only; `ledger.maxSessions`, no `disabledWorkspaces`) |
| Global panel (`overview`/`entry`, no `/workspaces` route, provenance chips) | Implemented and contract-tested; **rendering still not visually verified** |
| Real-profile reinstall + restart for v0.2.0 | **Not executed** (Lead-owned; the linked bundle needs a DSH restart) |

Full v0.2.0 E2E evidence: [docs/discussion/v0.2-e2e-evidence.md](docs/discussion/v0.2-e2e-evidence.md).

Not executed for either version:

| Check | Status |
|---|---|
| Panel rendering / visual verification | **Not executed** — the client bundle loads on the next page render; Host routes are registered and auth-guarded |
| PTC preset (`run_code`) tool reachability | **Not executed** — M0-S3 spike remains open |
| Multi-window live freshness measurement | **Not executed** — polling is the implemented contract |
| Soak/compaction stress, long-run retention | **Not executed** |
| Built tarball + SHA-256, publish/release | **Not executed — nothing was published** |

Also not executed for v0.2.0: the real desktop-profile reinstall/restart and any real-profile live
smoke. The E2E deliberately ran only against a throwaway `DSH_HOME`, so the user's live profile was
never written.

---

## License

[MIT](LICENSE) © 2026 XiaoleC05 and Confluence / 汇流 contributors.

## Links

- GitHub: [https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)
- Crisp plugin precedent (local checkout): `D:\05_Code\Crisp\integrations\dsh-plugin-crisp`
