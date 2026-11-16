# Install and verification guide (v0.2.0, universal memory)

- Status: **v0.1.0 was installed and activated on the real `desktop` profile on 2026-11-13** (Plugin
  Manager `install_bundle` → `application: applied`; six tools visible; pulse rendered;
  `confluence_board` executed). **v0.2.0 has not been installed into the real `desktop` profile or
  restarted there yet** — the scope refactor changes the Host modules and the linked bundle needs a
  DSH restart. The **offline scratch-profile E2E is executed and green** (2026-11-16, run
  `.tmp/e2e/run-20261116-203730`): it installs the bundle into a throwaway `DSH_HOME`, verifies the
  composed row, runs five headless sessions and passes 15/15 + 12/12 assertions. Treat every
  real-profile row below as pending until it is executed and recorded here.
- Bundle: `dsh-confluence` v0.2.0 (`private: true`), row id `confluence`, bundle patch
  `./cordis.patch.yml` (complete v1 default config: `ledger.maxSessions`, no
  `privacy.disabledWorkspaces`).
- Target: DSH Desktop **0.2.2-rc.1** (minimum declared through `engines.dsh` `>=0.2.2-rc.1`), profile
  `desktop`, Windows 11. A scratch profile is used first.
- Upgrading from v0.1.0? The config migration, legacy-data behaviour and restart requirement are in
  [upgrade-v0.2.md](upgrade-v0.2.md); this guide covers install and verification.
- Context: [scope refactor delta](plan/scope-refactor-delta.md),
  [ADR 0007](adr/0007-universal-memory-scope.md), [UI design](design/ui.md),
  [config contract](design/config.md).

> **Verification record.** v0.1.0 executed: (a) offline suite `node --test --test-force-exit
> "test/*.test.js"` → 256/256 pass; (b) packaging check `node scripts/check.mjs` → 12/12; (c)
> `scripts/e2e-dsh.ps1` → 8/8 checks; (d) real-profile `install_bundle` → applied, tools registered,
> pulse visible, board tool called; (e) panel **rendering/visual** check NOT executed.
> **v0.2.0 executed (2026-11-16):** (a) offline suite → **291/291 pass**; (b) packaging check →
> **17/17**; (c) M0 smoke `node scripts/m0-smoke.mjs` → **14 pass / 0 fail / 1 blocked** (optional
> `@deepseek-ai/dsh-atomic-write` probe); (d) offline scratch-profile cross-directory E2E
> `pwsh -NoProfile -File scripts/e2e-dsh.ps1` → **15/15 PowerShell checks, 0 fail, exit 0;
> `assert-e2e.mjs` 12/12 checks**, run `.tmp/e2e/run-20261116-203730` — session A in `workspace-a`,
> sessions B–E in `workspace-b`, one scratch profile. **Not yet executed for v0.2.0:** install +
> **restart** on the real desktop profile (and any real-profile live smoke), panel rendering, PTC
> reachability, multi-window freshness, soak/compaction, tarball/publish. Do not claim v0.2.0
> real-profile install or visual success before that is recorded here.

---

## 1. What installation does

Installing a bundle performs three things:

1. adds the package as a profile dependency (a local link when installing from this checkout);
2. appends the bundle to `dsh.profile.bundles` in the profile manifest;
3. applies `cordis.patch.yml`, which inserts the single `confluence` Loader row with the complete
   default configuration.

Installing does **not** start a server, open a listening port, call a model, or write outside
`$DSH_HOME/storages/confluence/v1/` (plus an opt-in export directory under
`$DSH_HOME/storages/confluence-exports/`). It needs no network access; the package has no dependencies.

Because this checkout is linked into the profile, **installing or upgrading requires a DSH restart** to
load a new Host module generation. A config edit only reloads the plugin row.

## 2. What the v0.2.0 host registers when it activates

Documented from the binding delta (§1–§8); observed in the **offline scratch-profile E2E** (run
`20261116-203730`) but not yet in the real desktop host:

| Registration | Behaviour | Verification step |
|---|---|---|
| Six model tools | `confluence_board`, `confluence_post`, `confluence_read`, `confluence_search`, `confluence_reply`, `confluence_recall`; universal wording, no `NO_WORKSPACE` error and no workspace parameter | tool list contains the six names; `confluence_board` in any session returns the global board |
| One prompt context | `confluence:pulse` — a byte-stable bounded digest with a `<confluence-memory scope="global" …>` tag; empty when nothing is new; legacy `<confluence-workspace …>` snapshots still parsed | first step in a session shows a pulse block bounded to ≤1400 chars / 320 estimated tokens |
| Store | append-only JSONL journals under `$DSH_HOME/storages/confluence/v1/workspaces/ws_0000000000000000/`; legacy per-workspace journals merged read-only | the global directory and `journal.<writerId>.v1.jsonl` appear after the first post; legacy dirs unchanged (mtime/hash) |
| Ledger + presence | metadata-only session rows and `presence/<writerId>.json` heartbeats in the global journal, covering all live sessions in the profile | `session` records and presence files appear; no prompt/tool text inside them |
| Panel (M3) | read-only left-rail page + keyed main page, `ping`/`overview`/`entry` routes on the existing same-origin web server; global timeline, provenance chips, no workspace switcher, no `/workspaces` route | rail entry opens the page; `GET /confluence/panel/ping` returns `{ok:true,…}` |
| Activation warnings | deterministic `CODE field` lines for invalid config (never user content) | host log warning lines match the codes in `design/config.md` §3; a leftover `privacy.disabledWorkspaces` produces `CONFIG_DEPRECATED privacy.disabledWorkspaces` |

Expected negative results (the plugin must remain offline and quiet):

- no network egress, no additional listening port, no child process, no model call;
- no writes inside any workspace (export is opt-in and defaults to `$DSH_HOME/storages/confluence-exports/`);
- no `.jsonl.zstd` parsing: recall goes through `ctx.sessionQuery` only.

## 3. Prerequisites

- DSH Desktop 0.2.2-rc.1 (or a matching `dsh` CLI) with the `desktop` profile available.
- Node.js ≥ 22.19.0 (see `engines` in `package.json`).
- The repository checked out locally, e.g. `D:\05_Code\Confluence`.
- A disposable scratch profile (`$DSH_HOME` pointed at a temp directory) for the CLI path.

## 4. Path A — Plugin Manager `install_bundle`

This is the shipped DSH plugin-management path. The manager performs package installation and bundle
selection; do not reproduce it by hand-editing the profile.

1. Open **Plugins → Add plugin** in DSH Desktop, or call the `plugin_manager` tool with
   `action: "install_bundle"` and the absolute repository path as `target`.
2. Target: `D:\05_Code\Confluence`.
3. Confirm the bundle `dsh-confluence` appears and the `confluence` row is enabled.
4. **Restart DSH Desktop** so the linked checkout's new Host modules load.
5. Read the host log: activation warnings must be `CODE field` lines only — with a default config there
   are none; a stale v0.1.0 override may log `CONFIG_DEPRECATED privacy.disabledWorkspaces`.
6. Run the verification checklist in §6.
7. When finished, remove the bundle (`remove_bundle` / Plugins UI), restart, and confirm the row
   disappears.

Status: **not executed on the real desktop profile for v0.2.0** (v0.1.0 install executed 2026-11-13).
The same bundle path was installed and activated in the offline E2E scratch profile on 2026-11-16
(15/15 + 12/12 checks), but that does not re-verify the real profile. Do not write "installed and
verified" in release notes until this path is executed and recorded here.

## 5. Path B — CLI into a scratch profile

Reproducible verification without touching the user's desktop profile; shaped after the Crisp
integration's executed scratch-profile procedure.

```powershell
# A throwaway DSH_HOME: no real profile is opened.
$env:DSH_HOME = 'D:\05_Code\Confluence\.tmp\dsh-home'

# 1. Create a scratch profile from a shipped template and print the composed config.
dsh --profile confluence-scratch --from-default-profile headless --dump-config

# 2. Install this checkout as a linked local package
dsh plugin --profile confluence-scratch add 'D:\05_Code\Confluence'

# 3. Inspect the composed layer; the confluence row must be present with the full default config
#    (ledger.maxSessions present, no privacy.disabledWorkspaces).
dsh --profile confluence-scratch --dump-config | Select-String 'confluence' -Context 0,20

# 4. Boot the scratch profile and check the activation warnings.
dsh --profile confluence-scratch
```

Expected composed layer (shape observed in the offline E2E `--dump-config` check E2E-00c, run
`20261116-203730`; not yet observed on the real desktop profile):

```yaml
# == dsh-confluence
- id: confluence
  name: dsh-confluence
  config:
    enabled: true
    store: { dir: '', retentionDays: 90, maxEntriesPerWorkspace: 2000, ... }
    ledger: { enabled: true, maxFilesPerSession: 8, maxSessions: 200, fileHintsInPulse: false }
    privacy: { redact: true, redactTitles: true, redactPatterns: [], ... }
    ...
```

If `dsh` is not on `PATH`, the Desktop installation ships one under
`<DeepSeek Harness install>\resources\runtime\cli\bin\dsh.cmd`.

## 6. Verification checklist (v0.2.0 round)

Run in the scratch profile first, then (only after sign-off) in the real desktop profile, and restart
DSH after installing.

**Evidence already executed offline (2026-11-16, real profile never touched):**

| Check | Result |
|---|---|
| Offline suite `node --test --test-force-exit "test/*.test.js"` | ✅ **291/291 pass** |
| Packaging contract `node scripts/check.mjs` | ✅ **17/17 checks pass** |
| M0 smoke `node scripts/m0-smoke.mjs` | ✅ **14 pass / 0 fail / 1 blocked** — optional `@deepseek-ai/dsh-atomic-write` probe |
| Independent-review fixes (R-01..R-14) | ✅ **Landed and covered** — private sessions gated on all six tools (`INT-07`), single-flight store opens (`UT-STORE-19`), POSIX/home export scrub (`EXP-12`), pulse ledger-head no-churn (`CON-PL-18b`), heartbeat version 0.2.0; suite **291/291** (details in [`plan/implementation-status.md`](plan/implementation-status.md) §4.2) |
| Scratch-profile cross-directory E2E `pwsh -NoProfile -File scripts/e2e-dsh.ps1` | ✅ **15/15 PowerShell checks + 12/12 assertions, exit 0** — run `.tmp/e2e/run-20261116-203730` |
| Real desktop-profile reinstall + DSH restart | ⬜ **Not executed** — install via Plugin Manager `install_bundle`, then **restart DSH** (a config edit alone does not load the linked Host modules), then run this checklist on the real host |

| # | Check | Expected | Status |
|---|---|---|---|
| 1 | `--dump-config` contains `# == dsh-confluence` with the full default config | row composes; `ledger.maxSessions`, no `disabledWorkspaces` | **✅ Executed in the E2E** (E2E-00c) |
| 2 | Bundle is listed and can be toggled | enabled, no `failed`/`overridden` | **Not executed** (installed with `dsh plugin add`; not toggled in a UI) |
| 3 | Host log shows only `CODE field` activation warnings (none with defaults) | zero warnings with defaults; `CONFIG_DEPRECATED privacy.disabledWorkspaces` only for a stale override | **Not executed** (the E2E did not assert the whole warning set) |
| 4 | Tool list contains the six `confluence_*` tools in a session | present, universal descriptions | **✅ Executed in the E2E** — the cold-start first request headers already carried all six tools |
| 5 | Pulse appears on the first step, bounded, tagged `<confluence-memory scope="global" …>`; unchanged text adds no new message | present, bounded, byte-stable | **✅ Pulse presence/tag executed in the E2E**; unchanged-text dedupe is covered by the offline suite (part of the 291), not re-observed in this E2E |
| 6 | Global store created under `storages/confluence/v1/workspaces/ws_0000000000000000/`; journal shard + presence file after posting/activity | files exist, no content leakage; legacy dirs untouched | **✅ Executed in the E2E** (E2E-01b/E2E-07) |
| 7 | **Cross-workspace memory:** session A in directory X posts; session B in directory Y (same profile) sees it in the pulse and `confluence_board`; `confluence_recall` from B finds text spoken in A | shared by default, no workspace key passed anywhere | **✅ Executed in the E2E** — headline gate passed (E2E-04/E2E-08/E2E-12) |
| 8 | Legacy merge: a pre-existing v0.1.0 journal appears with a provenance label; its files are byte-identical after the run | merged read-only | **✅ Executed in the E2E** (E2E-09) |
| 9 | Panel: rail entry, global timeline, provenance chips, kind/tag filter, no workspace switcher, no `/workspaces` route | opens, read-only, rendering verified | **Not executed** (no browser control) |
| 10 | Recall reads all earlier sessions in the profile, bounded/redacted, excluding the caller and `privacy.privateSessions` | universal, capped | **✅ Cross-directory recall executed in the E2E** (E2E-12); private-target exclusion is unit/ISO-covered (part of the 291) |
| 11 | `--dry-run` export reports `scope:"global"`, global `wsKey`, no `--workspace` flag | additive-compatible manifest | **Not executed** on the E2E store |
| 12 | No network egress, no new listening port, no child process, no model call | none | **Partially** — static contract scan passes and the E2E used only a loopback mock; no network-disabled install run |
| 13 | Uninstall removes the row and leaves no plugin state | clean removal after restart | **Not executed** |
| 14 | Display metadata in Plugin Manager (title/description/icon, en + zh) | correct in both locales | **Contract-checked** (locale parity + icon); not visually verified in Plugin Manager |

## 7. Offline guarantees for the install path

- The bundle declares **no dependencies**, so a local link install should not need registry access.
- `HYPOTHESIS:` pnpm may still contact its configured registry for unrelated profile bookkeeping even
  on a link install; verify with the network disabled and record the result. Do not claim
  "verified offline install" before that run.
- The plugin performs no network calls at runtime (contract-tested static scan).
- No additional listening port: the panel data channel is a route on the existing web server; it opens
  no port.

## 8. Rollback

```powershell
# Remove the bundle and its profile dependency, then restart DSH.
dsh plugin --profile <profile-name> remove dsh-confluence

# Scratch profile: delete the throwaway tree instead of touching any real profile.
Remove-Item -Recurse -Force 'D:\05_Code\Confluence\.tmp\dsh-home'

# Plugin data is separate from install state; delete only if you intend to lose the board:
#   Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\storages\confluence"
```

Rollback never touches v0.1.0 legacy journals (the upgrade never wrote to them). The v0.2.0 global
directory can stay on disk; a v0.1.0 install ignores it. Do not claim rollback verified until it is
executed.

## 9. What remains unexecuted

Everything below is still open; the offline scratch-profile evidence in §6 does **not** close it.

- `plugin_manager install_bundle` of v0.2.0 into the **real desktop profile**, and the DSH restart
  that loads it (the linked bundle needs the restart; a config edit is not enough).
- Any real-profile live smoke (the E2E deliberately ran only against a throwaway `DSH_HOME` so the
  user's live profile was never written).
- Panel rendering / visual verification in a live GUI (no browser control in this round).
- PTC preset (`run_code`) tool reachability; multi-window live freshness measurement.
- Soak/compaction stress and long-run retention.
- `--dry-run` export against the E2E scratch store; uninstall/rollback executed end-to-end.
- Offline install with the network disabled.

These must be executed and recorded here (with dates and captured output) before the first release
checkpoint can cite installation as verified.

## 10. Verification status (authoritative)

| Check | Status |
|---|---|
| Packaging/contract checks | **Executed for v0.2.0** — `node scripts/check.mjs` → 17/17 checks pass on the final tree (2026-11-16) |
| Module + integration tests (`node --test --test-force-exit "test/*.test.js"`) | **Executed for v0.2.0** — 291/291 pass; see [`plan/implementation-status.md`](plan/implementation-status.md) |
| M0 smoke (`node scripts/m0-smoke.mjs`) | **Executed for v0.2.0** — 14 pass / 0 fail / 1 blocked (optional `@deepseek-ai/dsh-atomic-write` probe) |
| Scratch-profile offline E2E (`scripts/e2e-dsh.ps1`) | **Executed for v0.2.0** — 15/15 PowerShell checks + 12/12 assertions, exit 0, run `.tmp/e2e/run-20261116-203730` |
| Cross-workspace acceptance test (session A dir X, session B dir Y, same scratch profile) | **Executed in the offline E2E** (E2E-04/E2E-08/E2E-12) |
| Legacy read-only merge | **Executed in the offline E2E** — seeded journal preserved byte-identical, nothing migrated |
| `install_bundle` into the real desktop profile (v0.2.0) + DSH restart | **Not executed** (Lead-owned) |
| CLI install into a scratch profile (v0.2.0) | **Executed by the offline E2E** (`dsh plugin add` into the throwaway profile) |
| Activation in a live desktop host (warnings, tools, pulse, store) | **Not executed on the real profile**; observed in the scratch headless E2E |
| Panel rendering / transport behaviour | **Not executed** |
| Offline install (network disabled) | **Not executed** (hypothesis in §7) |
| Uninstall / rollback | **Not executed** |
