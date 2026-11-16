# Offline cross-directory E2E harness (Confluence / 高级记忆 v0.2.0)

This directory holds the **release-path end-to-end harness** for the Confluence DSH plugin.
v0.2.0 (ADR-0007: *universal memory scope*) changes the product claim from "sessions share
memory inside one workspace" to **"every session in a DSH profile shares one memory"**, so the
headline acceptance test is now cross-directory:

> a session in directory **A** publishes shared memory; a session in a **different** directory
> **B**, same profile, receives it in its passive pulse and can read it.

Everything here is **offline**: the only "server" is the local Messages-API stub
(`test/e2e/mock-llm.mjs`, `127.0.0.1` ephemeral port), every DSH path is a throwaway
`.tmp/e2e/run-<stamp>/dsh-home`, and the real `~/.dsh` profile is only hashed, never opened.

## Files

| Path | Role |
|---|---|
| `scripts/e2e-dsh.ps1` | Orchestrator (PowerShell 7): scratch profile + bundle install + warm-up + acceptance sessions + assertions + guards + `summary.json`. |
| `test/e2e/assert-e2e.mjs` | All offline assertions over the run directory, scratch store, mock request logs, committed session logs (zstd) and pulse watermarks. Exit 0 = green. |
| `test/e2e/lib/session-log.mjs` | Dependency-free reader for DSH v4 session logs (concatenated zstd frames) plus pulse/tool-call/tool-result helpers. Accepts **both** pulse tags. |
| `test/e2e/mock-llm.mjs` | Deterministic Messages-API stub (SSE + non-stream) with a request recorder. No network egress. |
| `test/e2e/scenarios/warmup.json` | One throwaway session right after install; absorbs the first-mount activation race (DSH activation is async). |
| `test/e2e/scenarios/tool-post.json` | Writer session A: one `confluence_post` call, then text. |
| `test/e2e/scenarios/text-answer.json` | Passive pulse session B: text only — no tool call, so only the pulse can deliver A's note. |
| `test/e2e/scenarios/board-read.json` | Board reader session C: one `confluence_board` call, then text. |
| `test/e2e/scenarios/note-read.template.json` | Note reader session D template. `e2e-dsh.ps1` substitutes `{{NOTE_ID}}` with the real note id read back from the global journal and writes `<run>/scenario-note-reader.json`. One `confluence_read` call, then text. |
| `test/fixtures/pulse/cap-cases.json` | Global pulse template cases shared with `scripts/m0-smoke.mjs` (and `test/pulse.test.js`): header `<confluence-memory scope="global" …>`, **no workspace label**. |

Each acceptance session makes at most one tool call. That keeps the mock scenarios
independent of DSH's runtime-context message count (which changed in v0.2.0) and makes every
failure fall through to a final answer instead of looping.

## Run layout (evidence is kept)

```text
.tmp/e2e/run-<stamp>/
  dsh-home/                                  # scratch DSH_HOME (never the real one)
    profiles/confluence-e2e/                 # scratch headless profile + linked dsh-confluence
    storages/confluence/v1/workspaces/
      ws_0000000000000000/                    # universal global scope (written by the plugin)
        MANIFEST.v1.json                     # workspace: { canonicalPath: "", label: "All sessions" }
        journal.<pid>-<writer>.v1.jsonl
      ws_<16hex>/                            # seeded legacy v0.1.0 journal (read-only fixture)
    storages/session_projcache/sessions/     # DSH projection state incl. confluence_watermark
  workspace-a/                               # session A (and the warm-up) cwd
  workspace-b/                               # sessions B, C, D, E cwd (different directory)
  mock-a|b|c|d|e.jsonl                       # every model request body (what the model saw)
  session-a|b|c|d|e.out.txt / .err.txt
  session-warmup.out.txt
  scenario-note-reader.json                  # generated note-read scenario for D
  legacy-seed.json                           # seeded legacy files + sha256 (byte-identity check)
  summary.json                               # PASS/FAIL table + run metadata
```

## Sessions

| Session | cwd | Scenario | What it proves |
|---|---|---|---|
| warm-up | `workspace-a` | `warmup.json` | one throwaway session so the first acceptance session does not race plugin activation |
| A | `workspace-a` | `tool-post.json` → `confluence_post` | a real model tool call writes one durable entry to the global journal |
| B | `workspace-b` | `text-answer.json` (no tools) | **passive pulse delivery across directories**: A's note title appears in B's `<confluence-memory scope="global" …>` block |
| C | `workspace-b` | `board-read.json` → `confluence_board` | active board read from another directory: A's note **and** the legacy note are listed, `through=` advances |
| D | `workspace-b` | generated `note-read.template.json` → `confluence_read` | full note read from another directory: the `Body:` of A's note is returned for the real `cnf_…` id |
| E | `workspace-b` | `recall.json` → `confluence_recall` | cross-directory recall: a literal phrase spoken in A's session returns a `session:<id>:<seq>` hit from `workspace-a` |

Sessions run sequentially against separate mock instances, all under one scratch `DSH_HOME`,
so they share the plugin's universal store exactly like two real DSH windows.

The legacy fixture is seeded **after** session A and **before** B/C/D: A's welcome pulse must
show the empty-board copy, while B and C must see the legacy entry through the read-only merge
(the entry timestamp is generated one day before the run — the pulse drops records older than
7 days, so a hard-coded date would silently fall out of the digest). The seed's files are hashed
into `legacy-seed.json` and re-hashed after the run.

DSH activation: v0.2.0 registers tools/pulse/panel routes synchronously inside `apply()` before the
first `await` (store/board/projection attach), which fixes the cold-start race where the very first
headless request could be built with 0 Confluence tools and no pulse. The warm-up session and the
bounded writer retry remain as diagnostics (`summary.json.writerAttempts`); a green v0.2.0 run shows
all 6 tools + pulse in request/header #1 and `writerAttempts: 1`.

## Checks

`scripts/e2e-dsh.ps1` (PowerShell table in `summary.json`):

| Id | Check |
|---|---|
| E2E-00a/b/c | scratch headless profile composes; local bundle installs; `--dump-config` contains the `confluence` row |
| E2E-00d | warm-up session exits 0 (absorbs the first-mount activation race) |
| E2E-01a | session A (workspace-a) publishes one note; `summary.json.writerAttempts` records whether the bounded retry was needed |
| E2E-01b | the note is in `workspaces/ws_0000000000000000/journal.*.v1.jsonl` under the scratch home |
| E2E-01c | session E recalls an excerpt from a workspace-A session (runs right after A: recall searches at most 3 recent sessions) |
| E2E-01d | legacy v1 per-workspace journal + MANIFEST seeded read-only |
| E2E-01e | session B (different directory, no tools) exits 0 |
| E2E-01f | session C reads the shared board from another directory |
| E2E-01g | session D reads the full note body from another directory |
| E2E-02 | `assert-e2e.mjs` exit 0 (all checks below) |
| GUARD-01 | real desktop profile files unchanged |
| GUARD-02 | the real `DSH_HOME` Confluence store (which may pre-exist and be live) contains no trace of this run's note title / run stamp |
| GUARD-03 | no scratch profile leaked into the real `DSH_HOME` |

`test/e2e/assert-e2e.mjs`:

| Id | Check |
|---|---|
| E2E-01 | acceptance sessions exit 0; bundle composes in the scratch profile |
| E2E-02 | A's welcome pulse is `<confluence-memory scope="global" … welcome="1" unread="0">`; no legacy tag |
| E2E-03 | exactly one entry in the global journal: `cnf_…` id, ULID seq, title/kind/tags/body, `ws = ws_0000000000000000`; provenance `origin` has no path; every ledger session row is global |
| E2E-04 | **cross-directory**: session A cwd ≠ session B cwd (different persisted buckets), B's passive pulse carries A's title **and** the merged legacy title, `unread >= 2`, global tag/scope |
| E2E-05 | committed session logs: A called `confluence_post` once (successful); B's pulse snapshots use the new tag and contain both notes; C = `confluence_board` only, D = `confluence_read` only, E = `confluence_recall` only; no snapshot uses `<confluence-workspace>` |
| E2E-06 | no Confluence `agent/inbox/spliced` push (pulse is the only passive channel) |
| E2E-07 | store only under the scratch `DSH_HOME`; workspace dirs are exactly `{ws_0000000000000000, seeded legacy}`; global manifest `ws`/`canonicalPath:""`/`label:"All sessions"`; no empty files |
| E2E-08 | from `workspace-b`: `confluence_board` lists A's note + legacy note + `through=`; `confluence_read` returns the note `Body:` (wire-level and committed-log checked); no absolute scratch path in model-visible board/read text |
| E2E-09 | legacy files byte-identical (sha256), no extra files, no record migrated into the global journal |
| E2E-10 | no Confluence tool call passes a `workspace`/`ws`/`scope` argument, and no `ws_<16hex>` literal appears in arguments (universal memory has no scope arg) |
| E2E-11 | `confluence_watermark` projection: `digestSeq` commits for readers; `boardReadSeq` stays `null` for post-only/pulse-only/recall sessions and equals the newest `through=` marker after C's board read and D's note read |
| E2E-12 | **cross-directory recall**: `confluence_recall` from `workspace-b` returns a `session:<id>:<seq>` hit from a `workspace-a` session (not the caller), and the excerpt contains the queried phrase |

## Running

```powershell
# from the repository root (PowerShell 7, Node 22.19+)
pwsh -NoProfile -File scripts/e2e-dsh.ps1

# inspect the newest run
$run = Get-ChildItem .tmp\e2e -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content (Join-Path $run.FullName 'summary.json')
```

Exit codes: `0` = all checks passed; `1` = at least one FAIL; the harness prints `SKIPPED` and
exits `0` only when the `dsh` launcher or `node` is missing. Assertion failures print the
offending artifact/value on the following line; stderr tails are printed for a failed session.

## Rules and gotchas

- **Never** point `DSH_HOME` at the real profile or install packages from the network. The
  script overrides `DSH_HOME`, `DEEPSEEK_BASE_URL` and `DEEPSEEK_API_KEY` for every child
  process and restores them in `finally`.
- The real `DSH_HOME` may already contain a Confluence store (the user's own profile, or a
  live DSH session). GUARD-02 therefore checks the real claim — *this run wrote nothing
  there* — by scanning that store for this run's unique note title and run stamp; it does not
  require the store to be absent.
- Pulse checks accept **both** `<confluence-memory …>` (v0.2.0) and the legacy
  `<confluence-workspace …>` via `pulseTag`/`pulseHeader`/`pulseSnapshots` in
  `lib/session-log.mjs`. New runs must only commit the new tag; legacy acceptance exists for
  inherited snapshots.
- The note-reader scenario is generated because `confluence_read` needs the real `cnf_…` id,
  which is only minted at runtime. The harness reads it from the global journal between
  sessions — no session log is edited or faked.
- The seeded legacy note is timestamped one day before the run: the pulse drops records older
  than `PULSE_STALE_AFTER_MS` (7 days), so a hard-coded date would silently leave the digest
  while still showing in the board fold.
- `workspace-a`/`workspace-b` are deliberately **not** real project names: their only role is
  provenance (`origin.workspaceLabel`) in the universal timeline.
- `scripts/m0-smoke.mjs` covers the same pulse-template contract without booting DSH
  (`SMOKE-PULSE-FIXTURES`, `SMOKE-PULSE`, `SMOKE-SESSION-DECODE`).
