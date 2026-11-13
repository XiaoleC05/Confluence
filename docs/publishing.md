# Publishing and release process (v0.1.0)

- Status: **v0.1.0 implemented, committed and tagged locally; no npm package and no GitHub release
  exist.** The repository working tree is clean at tag `v0.1.0`; the GitHub remote still carries the
  design-phase commit because this machine currently cannot reach `github.com:443` (and the credential
  helper cannot be prompted in the automated session). Nothing in this document is a claim that a
  public release happened.
- Current artifact: `dsh-confluence` **v0.1.0**, `"private": true`, MIT — 15 host modules under `lib/`,
  the host entry `index.js`, the read-only panel (`client.js`), export producer (`lib/export.js` +
  `scripts/export-memories.mjs`), locale resources, icon, bundle patch and design documentation.
- Related: [install guide](install.md), [implementation status](plan/implementation-status.md),
  [implementation interfaces](plan/implementation-interfaces.md) §12–§13,
  [ADR 0001 §13](adr/0001-confluence-architecture.md), [README](../README.md).

---

## 1. Repository and channel state

| Item | State |
|---|---|
| GitHub repository | `https://github.com/XiaoleC05/Confluence.git` — public; **design phase pushed** (`design-v1`); v0.1.0 push pending connectivity |
| Local repository | `D:\05_Code\Confluence`, branch `main`, remote `origin` set; **clean tree at commit `5dccc12`, tags `design-v1` + `v0.1.0`** |
| v0.1.0 implementation | **Committed + tagged locally** (`git log --oneline --decorate`); `v0.1.0` is a local annotated tag |
| Push from this machine | **Blocked at release time:** `github.com:443` unreachable / connection reset and interactive credential prompts disabled. Retry: `git push origin main --tags` from an interactive shell when the network/credentials work. Local commits and tags are the authoritative release artifacts in the meantime. |
| npm package | **Does not exist**; `"private": true` prevents accidental publication |
| GitHub release / tag | **Local tag `v0.1.0` exists; remote tag/release pending the push** |
| Verification state | Executed: offline suite 256/256, packaging 12/12, M0 smoke 14 pass/1 blocked, scratch-profile E2E 8/8, real-profile install + activation + pulse + board tool call, export CLI + solo-bench Go consumer. Not executed: panel visual rendering, PTC tool reachability, multi-window freshness, soak/compaction, publish (see `install.md`). |

## 2. Versioning policy

- SemVer; this round is **v0.1.0** (first implementation version, still unreleased/private).
- While the major version is `0`, a **minor** bump may carry breaking changes; patch bumps are fixes.
- The version is declared in **one place**: `package.json`. `index.js`/`lib/` must not repeat it in a
  second source.
- Tag format: `v<version>` (e.g. `v0.1.0`), created only on a release commit.
- Do **not** remove `"private": true` until install/activation verification has passed and an explicit
  publish decision is recorded (ADR addendum or Lead sign-off).

## 3. Pre-release checklist (run from the repository root)

1. **All tests pass offline** (module tests + packaging contract once phase 2 updates it):

   ```powershell
   node --test "test/*.test.js"
   node scripts/check.mjs
   ```

2. **Version and metadata are consistent** — `package.json` version `0.1.0`, `meta.description` matches
   `design/config.md` §7, README/status docs no longer describe the plugin as an empty scaffold.
3. **Bundle surface is complete** — `index.js`, every required `lib/*.js`, `client.js` (if the panel
   ships), `cordis.patch.yml`, `locale/en.json`, `locale/zh.json`, `icon.svg` exist and are covered by
   `exports`/`files`.
4. **No-egress / privacy check** — static scan finds no `http(s)` imports, `fetch` outside the single
   panel route adapter, sockets, child processes or model calls; the store holds no prompt, assistant,
   tool-output or command text; redaction tests pass.
5. **Install verification** — `install.md` §6 checks executed and recorded (or explicitly deferred with
   a reason; then do not call the build "verified").
6. **Docs honesty pass** — README "Status", `plan/implementation-status.md` and this document match the
   executed evidence. Do not describe unimplemented or unverified features in the present tense.
7. **Secrets and local paths** — scan for API keys, tokens, absolute home paths, captured session
   content and `.tmp` scratch state. `.gitignore` excludes local exports and test scratch dirs.
8. **Pack contents inspected before any release** (see §4).

## 4. Pack and inspect (no registry access required)

`npm pack` builds the tarball locally; `--dry-run` lists the file set without writing it. Both work
offline for a dependency-free package.

```powershell
# List what would be packed (no network).
npm pack --dry-run --json

# At the release checkpoint: build the tarball and record its checksum.
npm pack
Get-FileHash .\dsh-confluence-0.1.0.tgz -Algorithm SHA256
```

Record the tarball **checksum (SHA-256)**, byte sizes and file count with the release notes. Because
the tree changes during the implementation round, the pack listing must be re-recorded at the release
checkpoint; a previous listing is not evidence for a later tree.

Expected tarball contents for the complete v0.1.0 tree (npm always includes `package.json`, `README*`,
`LICENSE` and, once present, `client.js`/`lib/` via the `files` allow-list):

```text
package/package.json
package/README.md
package/README.zh-CN.md
package/LICENSE
package/index.js
package/client.js
package/lib/util.js
package/lib/config.js
package/lib/workspace.js
package/lib/redact.js
package/lib/store.js
package/lib/board.js
package/lib/watermark.js
package/lib/pulse.js
package/lib/ledger.js
package/lib/presence.js
package/lib/recall.js
package/lib/tools.js
package/lib/hostui.js
package/cordis.patch.yml
package/locale/en.json
package/locale/zh.json
package/icon.svg
```

The exact file list is owned by `package.json` `files` and the module inventory in
`plan/implementation-interfaces.md` §0; if a module is split/renamed, update both and re-inspect.
Re-run the pack command **after the modules land** and re-record sizes — do not copy the design-stage
numbers below.

Checks to perform on the listing:

- exactly one copy of each runtime/display file; no `test/`, `docs/`, `examples/`, `scripts/`, `.tmp/`
  or `confluence-export/` content leaks in (documentation ships via GitHub, not npm);
- `cordis.patch.yml`, `client.js`, every `lib/*.js`, both locales and `icon.svg` are present — without
  them the bundle is not installable/visible/functional;
- no `.jsonl`, `.log`, `.tgz` or snapshot artifacts from local verification runs;
- record a fresh listing + SHA-256 at the release checkpoint (a later tree invalidates earlier sizes).

### Historical reference — design-stage dry-run (superseded)

> **Stale/superseded.** The 9-file listing below was recorded on 2026-11-13 for the design-stage
> scaffold (before `lib/` and `client.js` existed). It is **not** the v0.1.0 pack listing and must not
> be quoted as release evidence. Re-record at the next release checkpoint.

| Field | Design-stage value (superseded) |
|---|---|
| package | `dsh-confluence@0.1.0` |
| packed / unpacked size | 22,677 B / 59,830 B (stale) |
| entries | 9: `LICENSE`, `README.md`, `README.zh-CN.md`, `cordis.patch.yml`, `icon.svg`, `index.js`, `locale/en.json`, `locale/zh.json`, `package.json` |
| unintended files | none at that time |

**Not executed for v0.1.0:** the complete v0.1.0 tree has not been packed, hashed or published. The
numbers above are historical design-stage output only.

**Partial-tree observation (not release evidence).** During the concurrent implementation round a
`npm pack --dry-run --json` was executed on an incomplete tree: **10 entries**, 29,785 B packed /
81,393 B unpacked, including `lib/redact.js`. This shows the updated `files` patterns do pick up
`lib/*.js` (and will pick up `client.js` when it exists); it is **not** a v0.1.0 release measurement.
Re-run and re-record when `lib/` and `client.js` are complete.

## 5. Bundle registration for release notes

A published package is only installable if it declares the bundle correctly (all present):

- `dsh.bundle.patch` → `./cordis.patch.yml`, inserting one row, id `confluence`, name `dsh-confluence`;
- `engines.dsh` → `>=0.2.2-rc.1` so incompatible hosts refuse the install;
- locale `meta.title` / `meta.description` and the icon exported so Plugin Manager can display the
  bundle without activating it;
- `./client` export + `files` entries for the panel half **only once `client.js` exists**; the
  `dsh.client` manifest block is added after the panel format is confirmed (see
  `plan/implementation-status.md` blockers).

Do not hand-edit a user's profile `package.json` or `cordis.patch.yml` in release notes; document the
Plugin Manager / `dsh plugin add` paths instead.

## 6. Release steps (at the v0.1.0 release checkpoint, in order)

1. Run the §3 checklist on a clean checkout.
2. Re-run §4 pack inspection on the **final** tree; archive the listing and SHA-256 with the notes.
3. Commit: `chore(release): v0.1.0` (local commit while push is blocked; Lead owns push).
4. Tag locally: `git tag -a v0.1.0 -m "Confluence v0.1.0"`.
5. Push `main` and the tag when credentials/network allow; create a GitHub release whose notes state
   exactly what was verified (link `install.md` verification results and the implementation status).
6. Publish to npm only after the private flag is deliberately removed and an npm account/token is
   available. `npm publish --dry-run` first; verify the file list matches §4; then publish.
7. Record the publication result (package URL, tarball SHA-256, date) in this document.

## 7. What must not be claimed

Until each item is actually executed and recorded, release notes and READMEs must not claim:

- that the bundle was installed into a profile, or that activation was observed in a live host;
- that offline installation was verified;
- that the panel renders (or which transport shipped) without a recorded UI verification;
- that any v0.1.0 tarball was produced, hashed or published;
- that GitHub contains the v0.1.0 implementation before the push is confirmed.

## 8. Publication status

**Nothing was published.** No npm package, GitHub release or release tag exists for the plugin. The
design phase is pushed to GitHub; the v0.1.0 implementation round is local until the release commit.
The design-stage `npm pack --dry-run` (9 files) was executed during the design phase only; the v0.1.0
tree has not been packed yet.
