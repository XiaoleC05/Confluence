# Install and verification guide (future / M3-verified)

- Status: **procedure for milestone M3. Not executed in this design phase.**
- Bundle: `dsh-confluence` v0.1.0, row id `confluence`, bundle patch `./cordis.patch.yml`.
- Target: DSH Desktop **0.2.2-rc.1** (Documented minimum `>=0.2.2-rc.1` via `engines.dsh`), profile
  `desktop`, Windows 11. A scratch profile is used first; the real profile is never modified during
  design-stage verification.
- Design context: [ADR 0001 §13](adr/0001-confluence-architecture.md) (packaging),
  [README](../README.md) (design-stage status).

> **Design-stage caveat.** This repository currently installs an *empty scaffold*. The bundle row
> mounts, `index.js` resolves configuration and logs exactly one warning, and **nothing else
> happens**: no tools, no pulse, no store, no UI. Do not install it expecting the product described
> in the README. The steps below exist so the M3 implementer verifies installation the same way the
> Crisp integration did, not so users adopt the plugin today.

---

## 1. What installation does

Installing a bundle performs three things:

1. adds the package as a profile dependency (a local link when installing from this checkout);
2. appends the bundle to `dsh.profile.bundles` in the profile manifest;
3. applies `cordis.patch.yml`, which inserts the single `confluence` Loader row with the complete v1
   default configuration.

It does **not** write to the real profile when the procedure below is followed, does not start a
server, does not open a network port, and does not call any model.

## 2. Prerequisites

- DSH Desktop 0.2.2-rc.1 installed (or a `dsh` CLI of the same version on `PATH`).
- Node.js ≥ 22.19.0 (see `engines` in `package.json`).
- The repository checked out locally, e.g. `D:\05_Code\Confluence`.
- **Not executed in this phase:** no profile has been modified while producing this repository.

## 3. Recommended path — Plugin Manager `install_bundle`

This is the shipped DSH plugin-management path: the manager performs package installation and bundle
selection; it should not be reproduced by hand-editing `package.json` or `cordis.patch.yml`.

Steps for the M3 verifier:

1. Open **Plugins → Add plugin** in DSH Desktop (or use the `plugin_manager` tool with
   `action: "install_bundle"` and the **absolute repository path** as `target`).
2. Target directory: `D:\05_Code\Confluence`.
3. Confirm the bundle `dsh-confluence` appears in the installed list and the `confluence` row is
   enabled.
4. Confirm the design-stage activation warning appears **once** in the host log (see §6).
5. Confirm no tools, prompt text, UI entries, ports or files were added (see §7).

> **Not executed.** This path was not run in the design phase: the repository is a design artifact
> and the user's profile must not be changed. Treat the steps above as the documented procedure to
> verify at M3, exactly as the Crisp integration documented its own unexecuted `install_bundle` path.

## 4. Alternative path — CLI into a scratch profile

Used for reproducible verification without touching the user's desktop profile. Based on the Crisp
integration's executed scratch-profile procedure.

```powershell
# A throwaway DSH_HOME: no real profile is opened.
$env:DSH_HOME = 'D:\05_Code\Confluence\.tmp\dsh-home'

# 1. Create a scratch profile from a shipped template and print the composed config.
dsh --profile confluence-scratch --from-default-profile headless --dump-config

# 2. Install this checkout as a linked local package (offline: no registry needed for a link
#    with no dependencies; verify this claim again at M3 before documenting it as executed).
dsh plugin --profile confluence-scratch add 'D:\05_Code\Confluence'

# 3. Inspect the composed layer; the row below must be present.
dsh --profile confluence-scratch --dump-config | Select-String 'confluence' -Context 0,12

# 4. Boot the scratch profile and observe exactly one activation warning.
dsh --profile confluence-scratch
```

Expected composed layer shape at design stage (**expected, not observed**):

```yaml
# == dsh-confluence
- id: confluence
  name: dsh-confluence
  config:
    enabled: true
    store: { dir: '', retentionDays: 90, maxEntriesPerWorkspace: 2000, ... }
    ...
```

If `dsh` is not on `PATH`, the Desktop installation ships one under
`<DeepSeek Harness install>\resources\runtime\cli\bin\dsh.cmd`; use that path in the commands above.

## 5. Offline guarantees for the install path

- The bundle has **no dependencies** (`package.json` declares none), so a local link install should
  not need package-registry access.
- The plugin performs **no network calls at runtime**: no `fetch`, no sockets, no update check.
- No additional listening port is opened; there is no server process.
- `HYPOTHESIS:` pnpm may still contact its configured registry for unrelated profile bookkeeping even
  on a link install; verify offline behaviour explicitly at M3 and record the result here. Do not
  claim "verified offline install" before that run.

## 6. Expected design-stage activation behaviour

The host log should contain **exactly one** Confluence warning per activation, in this shape:

```text
[confluence] design-stage scaffold, no capabilities implemented: Confluence / 汇流 stores nothing,
injects no pulse, and registers no tools or UI. Installation has no user-visible effect.
Implementation starts at milestone M1 (docs/plan/execution-plan.md). Resolved: store: ...
```

Acceptance for the design stage:

- the row activates (no `failed`, no `restart-required` beyond a first install);
- the warning appears once, not per session and not per request;
- no other log line or output is produced by the plugin;
- uninstalling/removing the row removes the warning.

## 7. Confirm "nothing happened" (negative checks)

After installation, all of the following must hold at **design stage**:

| Negative check | How to confirm |
|---|---|
| No model-facing tools | The tool list has no `confluence_*` entries |
| No prompt text | System prompt assembly contains no `<confluence-workspace>` block |
| No UI entry | The left sidebar lists no Confluence panel |
| No storage | `$DSH_HOME/storages/confluence/` does not exist |
| No port | `src/index.js` and `index.js` contain no server/listen call; no new listening socket |
| No network | Host entry contains no network imports (checked by contract tests) |
| No files in the workspace | The workspace directory is untouched |

## 8. Rollback

```powershell
# Remove the bundle and its profile dependency.
dsh plugin --profile <profile-name> remove dsh-confluence

# If a row was added manually to the profile patch, remove the `- id: confluence` block instead.
# A linked checkout leaves no generated state; delete .tmp/dsh-home for a scratch-profile run.
```

Rollback expectations: the warning stops appearing; nothing else changes, because the design-stage
plugin never wrote state.

## 9. What M3 must add to this document

When the implementation lands, this guide must be updated with **executed** evidence:

- [ ] Plugin Manager `install_bundle` run and result (or the reason it remains unexecuted).
- [ ] Scratch-profile CLI run with real captured `--dump-config` output.
- [ ] Activation warning captured from a real host log.
- [ ] Confirmation of the expected file layout under `$DSH_HOME/storages/confluence/v1/`.
- [ ] Offline verification (network disabled during install and first run).
- [ ] Uninstall/rollback executed and confirmed.
- [ ] Display metadata (title, description, icon) checked in the Plugin Manager in both locales.
- [ ] Panel smoke test (M3 UI milestone).

## 10. Verification status

| Check | Status |
|---|---|
| `package.json`/patch/locale/icon contract | Executed by `node --test "test/*.test.js"` |
| `install_bundle` into a real profile | **Not executed** |
| CLI local install into a scratch profile | **Not executed** |
| Activation in a live host; single warning observed | **Not executed** |
| Offline install (network disabled) | **Not executed** (hypothesis noted in §5) |
| Uninstall / rollback | **Not executed** |
