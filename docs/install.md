# Install and verification guide (v0.1.0)

- Status: **v0.1.0 installed and activated on the real `desktop` profile on 2026-11-13** (Plugin
  Manager `install_bundle` → `application: applied`; six tools visible to the live Host; pulse
  rendered in the live session runtime context; `confluence_board` executed successfully). The
  offline scratch-profile path is exercised by [`../scripts/e2e-dsh.ps1`](../scripts/e2e-dsh.ps1)
  (8/8 checks). Panel **rendering** is still unverified (needs a page refresh); release/publish
  steps remain unexecuted.
- Bundle: `dsh-confluence` v0.1.0 (`private: true`), row id `confluence`, bundle patch
  `./cordis.patch.yml` (complete v1 default config).
- Target: DSH Desktop **0.2.2-rc.1** (minimum declared through `engines.dsh` `>=0.2.2-rc.1`), profile
  `desktop`, Windows 11. A scratch profile is used first; the real profile was backed up before the
  one executed install (backup path recorded in the build report).
- Context: [implementation interfaces](plan/implementation-interfaces.md) §12–§13,
  [ADR 0001 §13](adr/0001-confluence-architecture.md), [UI design §3.3](design/ui.md),
  [config contract](design/config.md).

> **Verification record:** the executed evidence is:
> (a) offline suite `node --test --test-force-exit "test/*.test.js"` → 256/256 pass;
> (b) packaging check `node scripts/check.mjs` → 12/12;
> (c) `scripts/e2e-dsh.ps1` → 8/8 checks (scratch profile, mock model, two real sessions, cross-session
> pulse); (d) real-profile `install_bundle` → applied, tools registered, pulse visible, board tool
> called; (e) panel **rendering/visual** check NOT executed — the client bundle is part of the page
> module graph and loads on the next page refresh. Do not claim visual success until that is observed.

---

## 1. What installation does

Installing a bundle performs three things:

1. adds the package as a profile dependency (a local link when installing from this checkout);
2. appends the bundle to `dsh.profile.bundles` in the profile manifest;
3. applies `cordis.patch.yml`, which inserts the single `confluence` Loader row with the complete v1
   default configuration.

Installing does **not** start a server, does not open a listening port, does not call a model, and
does not write outside `$DSH_HOME/storages/confluence/v1/` (or an opt-in export directory inside the
workspace at M4). It does not need network access; the package has no dependencies.

## 2. What the v0.1.0 host registers when it activates

Documented from the binding implementation interfaces (§13) — **not yet observed in a live host**:

| Registration | Behaviour | Verification step |
|---|---|---|
| Six model tools | `confluence_board`, `confluence_post`, `confluence_read`, `confluence_search`, `confluence_reply`, `confluence_recall`; they throw `NO_WORKSPACE` for sessions without a resolvable workspace | tool list contains the six names; a tool call in a workspace session returns board data |
| One prompt context | `confluence:pulse` — a byte-stable bounded workspace digest; empty when nothing is new; no wake/poll | first step in a session shows a pulse block bounded to ≤1400 chars / 320 estimated tokens |
| Store | append-only JSONL journals under `$DSH_HOME/storages/confluence/v1/workspaces/<wsKey>/` | directory and `journal.<writerId>.v1.jsonl` appear after the first board post |
| Ledger + presence | metadata-only session rows and `presence/<writerId>.json` heartbeats | `session` records and presence files appear; no prompt/tool text inside them |
| Panel (M3) | read-only left-rail page + keyed main page, data via the transport chosen by spike S6 (`ui.md` §3.3); v0.1.0 target is the proven same-origin route path | rail entry "Confluence / 汇流" opens the page; `GET /confluence/panel/ping` returns `{ok:true,…}` if the route transport shipped |
| Activation warnings | deterministic `CODE field` lines for invalid config (never user content) | host log warning lines match the codes in `design/config.md` §3 |

Expected negative results (the plugin must remain offline and quiet):

- no network egress, no additional listening port, no child process, no model call;
- no writes inside the workspace by default (export is opt-in and M4);
- no `.jsonl.zstd` parsing: recall goes through `ctx.sessionQuery` only.

## 3. Prerequisites

- DSH Desktop 0.2.2-rc.1 (or a matching `dsh` CLI) with the `desktop` profile available.
- Node.js ≥ 22.19.0 (see `engines` in `package.json`).
- The repository checked out locally, e.g. `D:\05_Code\Confluence`.
- A disposable scratch profile (`$DSH_HOME` pointed at a temp directory) for the CLI path.

## 4. Path A — Plugin Manager `install_bundle` (documented; **not executed**)

This is the shipped DSH plugin-management path. The manager performs package installation and bundle
selection; do not reproduce it by hand-editing the profile.

1. Open **Plugins → Add plugin** in DSH Desktop, or call the `plugin_manager` tool with
   `action: "install_bundle"` and the absolute repository path as `target`.
2. Target: `D:\05_Code\Confluence`.
3. Confirm the bundle `dsh-confluence` appears and the `confluence` row is enabled.
4. Read the host log: activation warnings must be `CODE field` lines only (see `design/config.md` §3).
5. Run the verification checklist in §6.
6. When finished, remove the bundle (`remove_bundle` / Plugins UI) and confirm the row disappears.

Status: **documented only.** The repository is an implementation artifact in this round; no profile
was modified. Do not write "installed and verified" in release notes until this path is executed and
recorded here.

## 5. Path B — CLI into a scratch profile (documented; **not executed**)

Reproducible verification without touching the user's desktop profile; shaped after the Crisp
integration's executed scratch-profile procedure.

```powershell
# A throwaway DSH_HOME: no real profile is opened.
$env:DSH_HOME = 'D:\05_Code\Confluence\.tmp\dsh-home'

# 1. Create a scratch profile from a shipped template and print the composed config.
dsh --profile confluence-scratch --from-default-profile headless --dump-config

# 2. Install this checkout as a linked local package
#    (no dependencies; registry access should not be required — verify this claim at M3).
dsh plugin --profile confluence-scratch add 'D:\05_Code\Confluence'

# 3. Inspect the composed layer; the confluence row must be present with the full default config.
dsh --profile confluence-scratch --dump-config | Select-String 'confluence' -Context 0,14

# 4. Boot the scratch profile and check the activation warnings.
dsh --profile confluence-scratch
```

Expected composed layer (documented shape; not observed output):

```yaml
# == dsh-confluence
- id: confluence
  name: dsh-confluence
  config:
    enabled: true
    store: { dir: '', retentionDays: 90, maxEntriesPerWorkspace: 2000, ... }
    privacy: { redact: true, redactTitles: true, redactPatterns: [], ... }
    ...
```

If `dsh` is not on `PATH`, the Desktop installation ships one under
`<DeepSeek Harness install>\resources\runtime\cli\bin\dsh.cmd`.

## 6. Verification checklist (for the M3/install round)

Run in the scratch profile first, then (only after sign-off) in the real desktop profile.

| # | Check | Expected | Status |
|---|---|---|---|
| 1 | `--dump-config` contains `# == dsh-confluence` with the full default config | row composes | **Not executed** |
| 2 | Bundle is listed and can be toggled | enabled, no `failed`/`overridden` | **Not executed** |
| 3 | Host log shows only `CODE field` activation warnings (none with defaults) | zero warnings with defaults | **Not executed** |
| 4 | Tool list in a workspace session contains the six `confluence_*` tools | present | **Not executed** |
| 5 | Pulse appears on the first step, bounded; unchanged text adds no new message | present, bounded, byte-stable | **Not executed** |
| 6 | Store root created; journal shard + presence file after posting/activity | files exist, no content leakage | **Not executed** |
| 7 | Recall returns only same-workspace, bounded, redacted excerpts via `ctx.sessionQuery` | workspace-scoped | **Not executed** |
| 8 | Panel entry + page (if the panel shipped): rail entry, ping route/transport, reload-safe | opens, read-only | **Not executed** |
| 9 | No network egress, no new listening port, no child process, no model call | none | **Not executed** |
| 10 | Uninstall removes the row and leaves no plugin state | clean removal | **Not executed** |
| 11 | Display metadata in Plugin Manager (title/description/icon, en + zh) | correct in both locales | **Not executed** |

## 7. Offline guarantees for the install path

- The bundle declares **no dependencies**, so a local link install should not need registry access.
- `HYPOTHESIS:` pnpm may still contact its configured registry for unrelated profile bookkeeping even
  on a link install; verify with the network disabled at M3 and record the result. Do not claim
  "verified offline install" before that run.
- The plugin performs no network calls at runtime (contract-tested static scan; E2E no-egress test
  planned for M2/M3).
- No additional listening port: the M3 panel data channel is the existing web server route (if
  transport B ships) or an in-process call (if A ships); neither opens a port.

## 8. Rollback

```powershell
# Remove the bundle and its profile dependency.
dsh plugin --profile <profile-name> remove dsh-confluence

# Scratch profile: delete the throwaway tree instead of touching any real profile.
Remove-Item -Recurse -Force 'D:\05_Code\Confluence\.tmp\dsh-home'

# Plugin data is separate from install state; delete only if you intend to lose the board:
#   Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\storages\confluence"
```

Rollback leaves the workspace untouched (default config writes nothing into it).

## 9. What remains unexecuted

- `plugin_manager install_bundle` into any profile.
- CLI install into a scratch profile.
- Activation in a live host; warning/pulse/tool/panel behaviour observed.
- Offline install with the network disabled.
- Any UI rendering/visual verification (no browser control in this round).
- Uninstall/rollback executed end-to-end.

These must be executed and recorded here (with dates and captured output) before the first release
checkpoint can cite installation as verified.

## 10. Verification status (authoritative)

| Check | Status |
|---|---|
| Packaging/contract checks | Executed in the design phase; **v0.1.0 packaging assertions are being updated in phase 2** (the contract test still expects the host-only design-stage surface) |
| Module unit tests (`node --test "test/*.test.js"`) | In progress in this round; see [`plan/implementation-status.md`](plan/implementation-status.md) |
| `install_bundle` into a real profile | **Not executed** |
| CLI install into a scratch profile | **Not executed** |
| Activation in a live host (warnings, tools, pulse, store) | **Not executed** |
| Panel rendering / transport behaviour | **Not executed** |
| Offline install (network disabled) | **Not executed** (hypothesis in §7) |
| Uninstall / rollback | **Not executed** |
