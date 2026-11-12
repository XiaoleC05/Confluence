# Publishing and release process

- Status: **design phase — nothing has been published.** No npm package, no GitHub release, no tag,
  no remote commit exists as a result of this work. This document defines the process the project
  will follow at M4, after the implementation and install verification exist.
- Current artifact: `dsh-confluence` v0.1.0, `"private": true`, MIT, an empty host scaffold plus
  design documentation.
- Related: [install guide](install.md), [ADR 0001 §13](adr/0001-confluence-architecture.md),
  [README](../README.md).

---

## 1. Repository and channel state (as observed)

| Item | State |
|---|---|
| GitHub repository | `https://github.com/XiaoleC05/Confluence.git` — **exists and is public**, created 2026-11-12, empty (no branches, commits, releases or contents) |
| Local repository | `D:\05_Code\Confluence`, branch `main`, remote `origin` set |
| Push from this machine | **Blocked** — connection reset / no credentials; this phase produces **local commits only** |
| npm package | **Does not exist**; `"private": true` prevents accidental publication |
| GitHub release / tag | **None** |
| Local commits | Design and packaging commits exist locally; they are not on GitHub |

`HYPOTHESIS:` the push failure is network/credential-related and not a repository permission problem
(the remote was created by the same account earlier). Verify at M4 on a machine with credentials.

## 2. Versioning policy

- SemVer, starting at **0.1.0** for the design-stage scaffold.
- While the major version is `0`, a **minor** bump may carry breaking changes; patch bumps are fixes.
- The version is declared in **one place**: `package.json`. `index.js` intentionally does not repeat
  it, so there is no second source to drift.
- Tag format: `v<version>` (e.g. `v0.1.0`), created only on a release commit.
- Do **not** remove `"private": true` until the M3 install/activation verification has passed and an
  explicit decision to publish is recorded in an ADR addendum.

## 3. Pre-release checklist (run from the repository root)

1. **Contract checks pass offline**

   ```powershell
   node --test "test/*.test.js"
   node scripts/check.mjs
   ```

2. **Version is consistent** — `package.json` version changed, README/roadmap claims still true,
   `docs/README.md` status updated for anything newly finished.

3. **Threat/privacy review** — confirm the change adds no network, child process, listening port,
   model call or new stored field outside the documented data model; update
   `docs/design/security-privacy.md` if the data surface changed.

4. **Docs status honesty** — the README "Status", "Design-stage reality" and "Verification status"
   tables must match reality. Do not describe unimplemented features in the present tense.

5. **No secrets or local paths** — scan the tree for API keys, tokens, absolute home paths and
   captured session content. The `.gitignore` already excludes local exports and scratch state.

6. **Pack contents inspected before publishing** (see §4).

## 4. Pack and inspect (no registry access required)

`npm pack` builds the tarball locally; `--dry-run` lists the file set without writing it. Both work
offline for a dependency-free package.

```powershell
# List what would be packed (no network).
npm pack --dry-run

# Build the tarball, compute its checksum and record it with the release notes.
npm pack
Get-FileHash .\dsh-confluence-0.1.0.tgz -Algorithm SHA256
```

Record the tarball checksum (SHA-256) next to the pack listing in the release notes.

Expected tarball contents for v0.1.0 (npm always includes `package.json`, `README*` and `LICENSE`
in addition to the `files` allow-list):

```text
package/package.json
package/README.md
package/README.zh-CN.md
package/LICENSE
package/index.js
package/cordis.patch.yml
package/locale/en.json
package/locale/zh.json
package/icon.svg
```

Checks to perform on the listing:

- every runtime/display file appears exactly once; no `test/`, `docs/`, `examples/`, `scripts/` or
  `.tmp/` content leaks in (documentation is shipped via GitHub, not the npm tarball);
- `cordis.patch.yml` and `icon.svg` are present (without them the bundle is not installable/visible);
- the tarball size is small (single-digit KiB at design stage); a sudden jump signals accidental
  inclusion of logs or state;
- re-running `npm pack` produces an **identical file list** (hashes may differ if npm metadata
  timestamps are embedded — record what you observe rather than assuming determinism).

### Observed design-stage dry-run (executed 2026-11-13)

`npm pack --dry-run --json` was executed offline on the design-stage repository. It wrote no
tarball and reported:

| Field | Observed value |
|---|---|
| package | `dsh-confluence@0.1.0` |
| packed / unpacked size | 22,677 B / 59,830 B |
| entries | **9**: `LICENSE`, `README.md`, `README.zh-CN.md`, `cordis.patch.yml`, `icon.svg`, `index.js`, `locale/en.json`, `locale/zh.json`, `package.json` |
| dry-run shasum / integrity | `a291f81ed9ae3bf3f6497382810b7c88fd357920` / `sha512-wxgm7x3o…` (over the virtual tarball; not a published artifact) |
| unintended files | none — no `test/`, `docs/`, `examples/`, `scripts/` or scratch state |

This confirms the `files` allow-list behaves as intended. It does **not** replace a real
`npm pack` + SHA-256 checksum + `npm publish --dry-run` run, which remain unexecuted.

**Not executed in this phase:** no `.tgz` tarball has been built, hashed with SHA-256, or published.
The dry-run listing above was executed and its observed contents are recorded; publication itself was
not.

## 5. Bundle registration for release notes

A published package is only installable if it declares the bundle correctly:

- `dsh.bundle.patch` → `./cordis.patch.yml` (present);
- the patch inserts one row, id `confluence`, name `dsh-confluence` (present);
- `engines.dsh` → `>=0.2.2-rc.1` (present) so incompatible hosts refuse the install;
- locale `meta.title` / `meta.description` and the icon are exported so Plugin Manager can display
  the bundle without activating it (present).

Do not hand-edit a user's profile `package.json` or `cordis.patch.yml` in release notes; document the
Plugin Manager / `dsh plugin add` paths instead.

## 6. Release steps (M4 and later, in order)

1. Run the §3 checklist on a clean checkout.
2. Run §4 pack inspection; archive the listing and SHA-256 alongside the release notes.
3. Commit the version bump: `chore(release): vX.Y.Z` (local commit only while push is blocked).
4. Tag locally: `git tag -a vX.Y.Z -m "Confluence vX.Y.Z"`.
5. When credentials and network allow: push `main` and the tag; create a GitHub release whose notes
   state exactly what was verified (link `docs/install.md` verification results).
6. Publish to npm only after the private flag is deliberately removed and an npm account/token is
   available. `npm publish --dry-run` first; verify the file list matches §4; then publish.
7. Record the publication result (package URL, tarball SHA-256, date) in this document.

## 7. What must not be claimed

Until each item is actually executed and recorded, release notes and READMEs must not claim:

- that the bundle was installed into a profile;
- that activation was observed in a real host;
- that offline installation was verified;
- that any npm tarball was produced, hashed or published;
- that the GitHub repository contains the project (it is empty until push succeeds).

## 8. Publication status

**Nothing was published.** This design phase produced local files and local commits only. The
GitHub repository remains empty, no npm package exists, and no release or tag was created.
`npm pack --dry-run` was executed to inspect the file list (recorded in §4); it wrote no artifact.
