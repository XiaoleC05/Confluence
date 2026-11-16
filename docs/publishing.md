# Publishing and release process (v0.2.0 — universal memory)

- Status: **v0.1.0 is implemented, committed, tagged and pushed to GitHub; no npm package and no
  GitHub release exist.** The v0.1.0 release commit is `6755bd7` on `main` with annotated tag `v0.1.0`
  (tag object `792b686`, verified via `git ls-remote`). **v0.2.0 has not been committed, tagged, pushed
  or published**; its refactor is a working-tree change at the time of writing. The v0.2.0 tree is a
  **release candidate with executed offline evidence** — suite 291/291 after the independent review's
  fixes, packaging 17/17, M0 smoke
  14/1 blocked, scratch-profile cross-directory E2E 15/15 + 12/12 (2026-11-16) — but installing it on
  the real profile, the tarball/SHA-256 step and the release itself are still pending. Nothing in
  this document is a claim that an npm/public package release happened.
- Current artifact in the tree: `dsh-confluence` **v0.2.0**, `"private": true`, MIT — 15 host modules
  under `lib/`, the host entry `index.js`, the read-only panel (`client.js`), export producer
  (`lib/export.js` + `scripts/export-memories.mjs`), locale resources, icon, bundle patch and design
  documentation.
- Breaking changes in v0.2.0: memory scope is now universal (ADR 0007), `privacy.disabledWorkspaces`
  was removed and `ledger.maxSessionsPerWorkspace` was renamed to `ledger.maxSessions`. Upgrade notes:
  [upgrade-v0.2.md](upgrade-v0.2.md).
- Related: [install guide](install.md), [implementation status](plan/implementation-status.md),
  [scope refactor delta](plan/scope-refactor-delta.md),
  [implementation interfaces](plan/implementation-interfaces.md) §12–§13,
  [ADR 0007](adr/0007-universal-memory-scope.md), [README](../README.md).

---

## 1. Repository and channel state

| Item | State |
|---|---|
| GitHub repository | `https://github.com/XiaoleC05/Confluence.git` — public; **design phase (`design-v1`) and v0.1.0 (`main` @ `6755bd7`, tag `v0.1.0`) are pushed** |
| Local repository | `D:\05_Code\Confluence`, branch `main`, remote `origin` set; **v0.1.0 tag present; v0.2.0 changes are uncommitted** |
| v0.1.0 release | **Committed + tagged + pushed** (`git ls-remote` confirms `main` = `6755bd7` and tag object `792b686`) — historical |
| v0.2.0 release | **Not attempted** — no commit, tag, push, tarball or npm package |
| Push from this machine | **Executed over SSH** for v0.1.0 (`origin` push URL `git@github.com:XiaoleC05/Confluence.git`; local SSH config routes `github.com` through `ssh.github.com:443`). Use SSH (`git push origin main --tags`) from this machine. |
| npm package | **Does not exist**; `"private": true` prevents accidental publication |
| GitHub release / tag | tag `v0.1.0` pushed; **no release page exists for either version** |
| Verification state | v0.1.0: offline suite 256/256, packaging 12/12, M0 smoke 14 pass/1 blocked, scratch-profile E2E 8/8, real-profile install + activation + pulse + board tool call, export CLI + solo-bench Go consumer. **v0.2.0 (2026-11-16): offline suite 291/291, packaging check 17/17, M0 smoke 14 pass/1 blocked, scratch-profile cross-directory E2E 15/15 + 12/12 (run `.tmp/e2e/run-20261116-203730`, exit 0).** Still not executed for either version: real-profile v0.2.0 install + restart/live smoke, panel visual rendering, PTC tool reachability, multi-window freshness, soak/compaction, tarball/SHA-256, publish (see `install.md`). |

## 2. Versioning policy

- SemVer; current version **0.2.0** (private, unreleased).
- While the major version is `0`, a **minor** bump may carry breaking changes — v0.2.0 does exactly
  that (universal memory scope, removed/renamed config keys); patch bumps are fixes.
- The version is declared in **one place**: `package.json`. `index.js`/`lib/` must not repeat it in a
  second source; the export producer reads it from the package (`producer.version`).
- Tag format: `v<version>` (e.g. `v0.2.0`), created only on a release commit.
- Do **not** remove `"private": true` until install/activation verification has passed and an explicit
  publish decision is recorded (ADR addendum or Lead sign-off).

## 3. Pre-release checklist (run from the repository root)

1. **All tests pass offline** (module tests + packaging contract):

   ```powershell
   node --test --test-force-exit "test/*.test.js"
   node scripts/check.mjs
   ```

2. **Version and metadata are consistent** — `package.json` version `0.2.0`, patch/export producer
   agree, `meta.description` matches `design/config.md` §7, README/status docs no longer describe the
   v0.1.0 workspace scope as current.
3. **Config surface matches the delta** — `cordis.patch.yml` contains `ledger.maxSessions`, contains no
   `privacy.disabledWorkspaces`, and deep-equals `lib/config.js` DEFAULTS (the packaging check asserts
   this).
4. **Bundle surface is complete** — `index.js`, every required `lib/*.js` (15 modules), `client.js`,
   `cordis.patch.yml`, `locale/en.json`, `locale/zh.json`, `icon.svg` exist and are covered by
   `exports`/`files`.
5. **No-egress / privacy check** — static scan finds no `http(s)` imports, `fetch` outside the single
   panel route adapter, sockets, child processes or model calls; the store holds no prompt, assistant,
   tool-output or command text; redaction tests pass.
6. **Install verification** — `install.md` §6 checks executed and recorded (or explicitly deferred with
   a reason; then do not call the build "verified"). The **offline scratch-profile** part is executed
   for v0.2.0 (E2E 15/15 + 12/12, run `20261116-203730`); the **real desktop profile** install and the
   DSH restart after installing the linked bundle are still outstanding.
7. **Docs honesty pass** — README "Status", `plan/implementation-status.md`, `upgrade-v0.2.md` and this
   document match the executed evidence. Do not describe unimplemented or unverified features in the
   present tense.
8. **Secrets and local paths** — scan for API keys, tokens, absolute home paths, captured session
   content and `.tmp` scratch state. `.gitignore` excludes local exports and test scratch dirs.
9. **Pack contents inspected before any release** (see §4).

## 4. Pack and inspect (no registry access required)

`npm pack` builds the tarball locally; `--dry-run` lists the file set without writing it. Both work
offline for a dependency-free package.

```powershell
# List what would be packed (no network).
npm pack --dry-run --json

# At the release checkpoint: build the tarball and record its checksum.
npm pack
Get-FileHash .\dsh-confluence-0.2.0.tgz -Algorithm SHA256
```

Record the tarball **checksum (SHA-256)**, byte sizes and file count with the release notes. Because
the tree changes during the implementation round, the pack listing must be re-recorded at the release
checkpoint; a previous listing is not evidence for a later tree.

Expected tarball contents for the complete v0.2.0 tree (npm always includes `package.json`, `README*`,
`LICENSE` and the `files` allow-list):

```text
package/package.json
package/README.md
package/README.zh-CN.md
package/LICENSE
package/index.js
package/client.js
package/lib/board.js
package/lib/config.js
package/lib/export.js
package/lib/facade.js
package/lib/hostui.js
package/lib/ledger.js
package/lib/presence.js
package/lib/pulse.js
package/lib/recall.js
package/lib/redact.js
package/lib/store.js
package/lib/tools.js
package/lib/util.js
package/lib/watermark.js
package/lib/workspace.js
package/cordis.patch.yml
package/locale/en.json
package/locale/zh.json
package/icon.svg
```

The exact file list is owned by `package.json` `files` and the module inventory in
`plan/implementation-interfaces.md` §0 / the delta §1–§8; if a module is split/renamed, update both and
re-inspect. Re-run the pack command **after the modules land** and re-record sizes.

Checks to perform on the listing:

- exactly one copy of each runtime/display file; no `test/`, `docs/`, `examples/`, `scripts/`, `.tmp/`
  or export-directory content leaks in (documentation ships via GitHub, not npm);
- `cordis.patch.yml`, `client.js`, every `lib/*.js`, both locales and `icon.svg` are present — without
  them the bundle is not installable/visible/functional;
- no `.jsonl`, `.log`, `.tgz` or snapshot artifacts from local verification runs;
- record a fresh listing + SHA-256 at the release checkpoint (a later tree invalidates earlier sizes).

### Historical reference — v0.1.0 pack listing

> The v0.1.0 tree packed **24 files** (`package.json`, both READMEs, `LICENSE`, `index.js`,
> `client.js`, the 15 `lib/*.js` modules, `cordis.patch.yml`, both locale files, `icon.svg`) in an
> executed `npm pack --dry-run`. The v0.2.0 tree keeps the same file inventory (scope refactor edits
> existing modules; no module was added or removed), but sizes and hashes must be re-recorded at the
> v0.2.0 release checkpoint.

### Historical reference — design-stage dry-run (superseded)

> **Stale/superseded.** The 9-file listing below was recorded on 2026-11-13 for the design-stage
> scaffold (before `lib/` and `client.js` existed). It is **not** a release measurement and must not
> be quoted as release evidence.

| Field | Design-stage value (superseded) |
|---|---|
| package | `dsh-confluence@0.1.0` |
| packed / unpacked size | 22,677 B / 59,830 B (stale) |
| entries | 9: `LICENSE`, `README.md`, `README.zh-CN.md`, `cordis.patch.yml`, `icon.svg`, `index.js`, `locale/en.json`, `locale/zh.json`, `package.json` |
| unintended files | none at that time |

## 5. Bundle registration for release notes

A published package is only installable if it declares the bundle correctly (all present):

- `dsh.bundle.patch` → `./cordis.patch.yml`, inserting one row, id `confluence`, name `dsh-confluence`;
- `engines.dsh` → `>=0.2.2-rc.1` so incompatible hosts refuse the install;
- locale `meta.title` / `meta.description` and the icon exported so Plugin Manager can display the
  bundle without activating it;
- `./client` export + `files` entries and the `dsh.client` manifest block for the panel half
  (`platform: 'web'`, `immediately: true`, inject sidebar + layout).

Do not hand-edit a user's profile `package.json` or `cordis.patch.yml` in release notes; document the
Plugin Manager / `dsh plugin add` paths instead.

## 6. Release steps (at the v0.2.0 release checkpoint, in order)

1. Run the §3 checklist on a clean checkout, after the refactor is merged and green.
2. The cross-workspace acceptance test has already been executed offline (E2E 15/15 + 12/12, run
   `.tmp/e2e/run-20261116-203730`, recorded in `install.md` §10 and
   `plan/implementation-status.md`). Re-run it only if the tree changes; do not re-record an old run
   as new evidence.
3. Re-run §4 pack inspection on the **final** tree; archive the listing and SHA-256 with the notes.
4. Commit: `chore(release): v0.2.0` (Lead owns commit/push).
5. Tag locally: `git tag -a v0.2.0 -m "Confluence v0.2.0 — universal memory"`.
6. Push `main` and the tag when credentials/network allow; create a GitHub release whose notes state
   exactly what was verified, and link the upgrade note for v0.1.0 users.
7. Publish to npm only after the private flag is deliberately removed and an npm account/token is
   available. `npm publish --dry-run` first; verify the file list matches §4; then publish.
8. Record the publication result (package URL, tarball SHA-256, date) in this document.

## 7. What must not be claimed

Until each item is actually executed and recorded, release notes and READMEs must not claim:

- that v0.2.0 was installed into the **real desktop profile**, that DSH was restarted onto it, or that
  activation was observed there;
- that the v0.2.0 panel renders, or which transport shipped, without a recorded UI verification;
- that offline installation with the network disabled was verified;
- that any v0.2.0 tarball was produced, hashed or published;
- that GitHub contains the v0.2.0 implementation before the push is confirmed.

Claims that **are** supported for v0.2.0: the offline suite (291/291), the packaging check (17/17), the
M0 smoke run (14 pass / 1 blocked), and the offline scratch-profile cross-directory E2E (15/15 + 12/12,
run `.tmp/e2e/run-20261116-203730`) — all executed 2026-11-16.

## 8. Publication status

**Nothing was published.** No npm package and no GitHub release exist for either version. The design
phase and v0.1.0 are pushed to GitHub; the v0.2.0 refactor is a local working-tree change until the
release commit. The design-stage `npm pack --dry-run` (9 files) and the v0.1.0 dry-run (24 files) were
executed locally only; the v0.2.0 tree has not been packed yet.

The v0.2.0 tree is a **release candidate**: its offline evidence is executed and green (291/291,
17/17, M0 14/1 blocked, E2E 15/15 + 12/12 on 2026-11-16), but it is **not** installed on the real
profile, its tarball and SHA-256 do not exist, and no release/tag/push has happened. The next
checkpoint is the release commit plus the §4 pack inspection on the final tree.
