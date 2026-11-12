# ADR 0006 — solo-bench integration: vendored subtree + export-only contract

- Status: **Proposed** (binding on the later merge phase; nothing here is executed during the design phase)
- Date: 2026-11-13
- Context: [ADR 0001](0001-confluence-architecture.md) §6/§13/§14;
  [solo-bench integration design](../design/solo-bench-integration.md); [testing strategy](../design/testing.md) §11
- Deciders: Lead + user (merge phase); consulted: planner
- Related: `D:\05_Code\solo-bench\README.md` (2026-11-13); Crisp precedent
  (`D:\05_Code\Crisp\docs\integrations\deepseek-harness.md` §4, `Crisp/integrations/dsh-plugin-crisp/`)

## Context

Confluence / 汇流 will later be merged into the personal offline Go workbench `solo-bench`
(single-user CLI, one SQLite file, no web server/port, no model API, no `os/exec` in phase 0, later
capabilities only as local subprocesses, "不加许可证文件"). It must stay fully offline and must not
depend on DSH internals or on the plugin running. Confluence v1 is likewise fully offline and already
defines an opt-in, deterministic, redacted `memories.v1.jsonl` export as its only external contract
(ADR 0001 §6/§13). How do they meet without coupling — how the plugin enters the workbench repository,
and how the workbench reads Confluence memory without the live plugin or DSH?

## Decision

1. **Vendor the whole Confluence repository into `solo-bench` with `git subtree --squash`** at
   `integrations/dsh-plugin-confluence/`, mirroring Crisp's `integrations/` precedent. The plugin
   package is the repository root, so the vendored directory is self-contained (plugin, tests, E2E
   harness, docs). Updates are manual, reviewed `git subtree pull --squash` from the local clone: no
   submodule, no registry, no network, no CI. The subtree keeps its upstream `LICENSE`; `solo-bench`
   gains **no** repo-root license file.
2. **The only data contract is the opt-in file export** written by the plugin to
   `<workspace>/.confluence/export/`, exactly as specified in
   [`store-format.md`](../design/store-format.md) §14:
   - `manifest.json` (`schema:"confluence.memories/v1"`, `formatVersion:1`): `producer{name,version,dsh}`,
     `workspace{wsKey,name}` (no absolute/home paths), `generatedAt` (only non-deterministic field),
     `recordCount`, `firstSeq`, `lastSeq`, `files[{name,bytes,sha256}]`,
     `redaction{applied,policy:"confluence.redact/v1"}`, `limits{truncated,maxEntriesPerWorkspace}` —
     written **last** and atomically as the commit marker;
   - `memories.v1.jsonl`: one immutable record per line, sorted `(seq,id)` — `v:1`, `schema`,
     `type:"entry"`, `id` (`cnf_`+ULID), `wsKey`, `seq`, `ts`, six-value `kind`, redacted
     `title`/`body`/`tags`, workspace-relative `files`, `author{sessionId,title,origin}`,
     `replyTo`/`resolves`/`supersedes` (id or `null`), `deleted`, `deletedAt`. Tombstoned entries are
     exported as content-free `deleted:true` stubs, excluded from counts; unknown fields are ignored.
     The plugin never reads the export back.
3. **A future, separately approved `solo-bench` phase** may add a read-only Go parser
   (`internal/confluenceexport/` + `solo-bench confluence list|show|status`) consuming that export
   with the `confluence.memories/v1` rules: no server, port, model call, `os/exec`, reverse
   dependency, DB change or service row in phase 0.
4. **`solo-bench` consumes the export, not the live journal or live IPC** (no pipes, sockets, loopback
   HTTP, `$DSH_HOME/storages/confluence`). Rationale below.

## Why the export and not the live journal

- The journal is a plugin-private cache: per-writer shards, merge-on-read, tombstone/compaction
  generations and internal `seq`/lease semantics; a Go reader would reimplement plugin internals.
- The journal tolerates torn lines and partial state by design (poll freshness contract); the
  workbench needs a complete, snapshot-consistent artifact. The manifest-last commit provides exactly
  that and makes interrupted exports detectable.
- The export is redacted, absolute-path-free and opt-in — the privacy surface the workbench may see;
  the journal legitimately holds metadata (writer ids, path hints, session ids) not meant for a third party.
- File-only consumption decouples the projects: no live process, no DSH install, no reverse dependency.
- The named format (`confluence.memories/v1`) gives a versioned contract with explicit
  additive/breaking rules; the journal has no compatibility promise to outsiders.

## Compatibility rules (binding on both sides)

- Within v1: additive optional fields only; unknown fields ignored by readers; unknown record types skipped.
- Breaking changes bump `formatVersion`, add `memories.v2.jsonl` and a `manifest.json` with `formatVersion:2`; the v1 writer is retained ≥1 Confluence minor release.
- Readers validate the manifest first: reject unknown `schema`/`formatVersion`, `files[0]` hash/byte and `recordCount`/`firstSeq`/`lastSeq` mismatches; never partially import.
- Producer version strings are diagnostic only; feature detection uses `schema`/`formatVersion`.
- The Confluence repo ships conformance fixtures; the Go consumer copies them into `testdata/` at merge time rather than reading the vendored subtree at test runtime.

## Consequences

- **Positive:** self-contained offline workbench repository; a small, testable Go consumer; clear
  ownership/privacy boundary; internal store evolution does not break the workbench; Crisp-style
  layout/install/verification discipline reused.
- **Negative:** vendored copy grows size/history; updates are manual and conflict if anyone edits the
  subtree (fixes go upstream); the export is a snapshot, not live sync; a format is tested twice
  (fixtures mitigate).
- **Neutral:** a separate approved phase is needed before the first consumer line; this ADR changes nothing now.

## Non-goals

No live IPC/journal reading; no importing DSH packages or Cordis into Go; no reverse dependency from
the plugin to `solo-bench`; no server/model/network/child process added to `solo-bench`; no DB schema
migration, new table or new service row in phase 0; no automatic workspace discovery/disk scanning;
no writing to the export directory; no root license file; no subtree push/CI automation.

## Alternatives rejected

1. **Submodule** — clean separation but needs a second checkout/network and breaks the self-contained offline workbench; not the Crisp pattern.
2. **npm package/registry install** — violates fully-offline and no-publish constraints; plugin is `private:true`.
3. **Plain copy** — no provenance or update path; silent drift.
4. **Live journal / live IPC (socket, pipe, loopback HTTP)** — couples the workbench to plugin internals and a running DSH process; violates offline/no-server/no-reverse-dependency and the privacy boundary.
5. **A fifth `solo-bench service` row calling Confluence** — the fixed four rows model callable subprocess capabilities; reading an exported file is neither an invocation nor a subprocess.

## References

- Both `D:\05_Code\solo-bench\README.md`/`main.go`/`internal/store/schema.sql` and [store-format.md](../design/store-format.md) §14 + ADR 0002 (authority for the export contract).
- `D:\05_Code\Crisp\docs\integrations\deepseek-harness.md` §§3–6; `Crisp/integrations/dsh-plugin-crisp/`.
- [solo-bench integration design](../design/solo-bench-integration.md) — consumer view, Go parsing rules, command proposal, merge checklist, risks.
