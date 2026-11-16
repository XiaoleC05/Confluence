// Confluence / 高级记忆 — WP8/M4 universal-memory export tests (`confluence.memories/v1`, v0.2.0).
//
// Contract: docs/adr/0007-universal-memory-scope.md §2 item 7, docs/plan/scope-refactor-delta.md
// §8, docs/design/store-format.md §13.3/§14 (authoritative bytes + integrity rules) and
// docs/design/solo-bench-integration.md §6. Hermetic: an in-memory store double that implements
// the delta §2 surface (`mergedRecords()` / `refreshMerged()` / `legacyWorkspaceMeta()`), a real
// temp directory for the files, no DSH runtime, no network, no child process (the CLI's exported
// run() is called in-process with an injected store factory).
//
// Coverage map:
//   EXP-01  universal manifest (scope/producer/global wsKey) + v1 record mapping
//   EXP-02  legacy journals merged in with provenance origin; no paths, no raw ws field
//   EXP-03  live-only counts, tombstone stubs, retention, skipped replies, deterministic order
//   EXP-04  file hash/bytes cover the whole file; recordCount/firstSeq/lastSeq cover live only
//   EXP-05  redaction re-applied, absolute paths stripped, file hints relative
//   EXP-06  determinism (byte-identical JSONL; manifest differs only in generatedAt)
//   EXP-07  store is only read; dry run writes nothing; no read-back
//   EXP-08  failure modes fail closed (unsupported store, unsafe outDir, throwing redactor)
//   EXP-09  atomic publish order: JSONL first, manifest LAST; a failed manifest leaves no commit
//   EXP-10  caps: 8 MiB deterministic tail truncation with limits.truncated
//   EXP-11  CLI run(): global scope, default <dsh-home>/storages/confluence-exports/<stamp>,
//           --out, --json, --dry-run, no --workspace flag, exit codes 0/1/2
//   EXP-12  pure helpers (labels, path stripping, outDir validation, args, default dir)
//   EXP-13  real JournalStore: the delta surface merges the global journal with a legacy journal,
//           the CLI leaves every store byte untouched, provenance labels are basenames
//   EXP-14  upgrade path: a v0.1 store with only legacy journals exports them and creates no
//           global scope directory (no migration writes)

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { createRedactor } from '../lib/redact.js'
import { resolveConfig } from '../lib/config.js'
import { GLOBAL_SCOPE_KEY as STORE_GLOBAL_SCOPE_KEY, JournalStore } from '../lib/store.js'
import {
  EXPORT_FORMAT_VERSION,
  EXPORT_MANIFEST_FILE,
  EXPORT_MAX_BYTES,
  EXPORT_SCHEMA,
  GLOBAL_SCOPE_KEY,
  GLOBAL_SCOPE_LABEL,
  MEMORIES_FILE,
  exportMemories,
  stripAbsolutePaths,
  validateExportDir,
  workspaceLabelFor,
} from '../lib/export.js'
import { USAGE, defaultExportDir, parseArgs, run, utcStamp, validateOutArg } from '../scripts/export-memories.mjs'

/** Build a synthetic credential from fragments so the committed source never holds a credential-shaped literal. */
const secret = (...parts) => parts.join('')
const leakedKey = secret('sk-fixture', '123456789012345678901234')

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const ISO = (ms) => new Date(ms).toISOString()
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_PREFIX = '01J8Z6Q3M0'

/** Two real workspace keys used only as provenance (never as a partition). */
const ORIGIN_KEY = 'ws_1111111111111111'
const LEGACY_KEY = 'ws_2222222222222222'
const LEGACY_SESSION_ID = 'session-legacy-ledger'

/** Deterministic 26-char Crockford ULID-like value, ordered by n. */
function seqFor(n) {
  let value = Math.max(0, Math.trunc(n))
  let rest = ''
  for (let index = 0; index < 16; index += 1) {
    rest = CROCKFORD[value % 32] + rest
    value = Math.floor(value / 32)
  }
  return ULID_PREFIX + rest
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
/** @type {string[]} */
const tempDirs = []

after(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

async function tempRoot(label = 'confluence-export-') {
  const dir = await fs.mkdtemp(path.join(tmpdir(), label))
  tempDirs.push(dir)
  return dir
}

function makeConfig(storeOverrides = {}) {
  return resolveConfig({ store: { retentionDays: 90, ...storeOverrides } }).config
}

/**
 * Store double implementing the v0.2.0 delta §2 surface the export needs. It exposes no write
 * method at all: the export must only read.
 */
function createFakeStore({ records = [], legacyMeta = [], rootDir = path.join(tmpdir(), 'fake-store-root') } = {}) {
  const calls = { refreshMerged: 0, mergedRecords: 0, legacyWorkspaceMeta: 0, legacyView: 0 }
  return {
    rootDir,
    calls,
    async init() {},
    async refreshMerged() {
      calls.refreshMerged += 1
      return true
    },
    mergedRecords() {
      calls.mergedRecords += 1
      return records
    },
    legacyWorkspaceMeta() {
      calls.legacyWorkspaceMeta += 1
      return legacyMeta
    },
    async close() {},
  }
}

function entryRecord(seq, overrides = {}) {
  return {
    v: 1,
    type: 'entry',
    id: `cnf_${seq}`,
    ws: GLOBAL_SCOPE_KEY,
    seq,
    ts: ISO(NOW - 60 * 60 * 1000),
    kind: 'gotcha',
    title: `note ${seq.slice(-4)}`,
    body: 'body',
    author: { sessionId: 'session-author', title: 'Auth work', origin: 'agent' },
    ...overrides,
  }
}

/** Seed the export fixture: global entries + a pre-0.2.0 legacy journal + tombstones/retention. */
function seed() {
  const seqs = {
    legacy: seqFor(5),
    legacySession: seqFor(6),
    gotcha: seqFor(10),
    question: seqFor(20),
    reply: seqFor(21),
    tombstoned: seqFor(30),
    tombstone1: seqFor(31),
    deletedRoot: seqFor(40),
    deletedReply: seqFor(41),
    tombstone2: seqFor(42),
    old: seqFor(50),
    session: seqFor(60),
    superseding: seqFor(70),
    minimal: seqFor(80),
  }
  const questionId = `cnf_${seqs.question}`
  const deletedRootId = `cnf_${seqs.deletedRoot}`

  const legacyRecord = entryRecord(seqs.legacy, {
    ws: LEGACY_KEY,
    kind: 'decision',
    title: 'Legacy decision from a pre-0.2.0 workspace',
    body: 'Written before the universal scope existed.',
    author: { sessionId: 'session-legacy', origin: 'user' },
  })
  const legacySession = {
    v: 1,
    type: 'session',
    ws: LEGACY_KEY,
    seq: seqs.legacySession,
    ts: ISO(NOW - 30 * 60 * 1000),
    sessionId: LEGACY_SESSION_ID,
    title: 'Legacy ledger only',
    status: 'idle',
  }

  const gotcha = entryRecord(seqs.gotcha, {
    kind: 'gotcha',
    title: 'Windows rename retries wrap in EPERM',
    body:
      'A scanner holds the handle so the API key ' + leakedKey + ' must never ship. ' +
      'Opened C:\\Users\\mockuser\\project\\src\\fs\\rename.ts on the user machine.',
    tags: ['Windows', 'fs', 'not a tag'],
    files: ['src/fs/rename.ts', 'C:\\Users\\mockuser\\project\\.env', '..\\escape\\x.ts'],
    origin: { workspaceKey: ORIGIN_KEY, workspaceLabel: 'repo-a' },
  })
  const question = entryRecord(seqs.question, {
    kind: 'question',
    title: 'Which index rebuild strategy?',
    body: 'Choose one before the migration.',
    tags: ['index'],
    author: { sessionId: 'session-asker', origin: 'agent' },
  })
  const reply = entryRecord(seqs.reply, {
    kind: 'gotcha',
    title: 'Reply: use the native lock',
    body: 'Resolved with the native lease.',
    replyTo: questionId,
    resolves: true,
    author: { sessionId: 'session-answerer', title: 'Data migration', origin: 'agent' },
  })
  const tombstoned = entryRecord(seqs.tombstoned, {
    kind: 'finding',
    title: 'A note that will be forgotten',
    body: 'content that must not be exported',
    tags: ['gone'],
    files: ['src/gone.ts'],
  })
  const tombstone1 = {
    v: 1,
    type: 'tombstone',
    id: `tmb_${seqs.tombstone1}`,
    ws: GLOBAL_SCOPE_KEY,
    seq: seqs.tombstone1,
    ts: ISO(NOW - 2 * 60 * 60 * 1000),
    target: `cnf_${seqs.tombstoned}`,
  }
  const deletedRoot = entryRecord(seqs.deletedRoot, {
    kind: 'question',
    title: 'Deleted root question',
    body: 'root body',
    author: { sessionId: 'session-deleted-root', origin: 'user' },
  })
  const deletedReply = entryRecord(seqs.deletedReply, {
    kind: 'gotcha',
    title: 'Reply under a deleted root',
    body: 'this reply must not be exported',
    replyTo: deletedRootId,
    author: { sessionId: 'session-replier', origin: 'agent' },
  })
  const tombstone2 = {
    v: 1,
    type: 'tombstone',
    id: `tmb_${seqs.tombstone2}`,
    ws: GLOBAL_SCOPE_KEY,
    seq: seqs.tombstone2,
    ts: ISO(NOW - 3 * 60 * 60 * 1000),
    target: deletedRootId,
  }
  const old = entryRecord(seqs.old, {
    kind: 'decision',
    title: 'Old decision hidden by retention',
    ts: ISO(NOW - 200 * 24 * 60 * 60 * 1000),
  })
  const session = {
    v: 1,
    type: 'session',
    ws: GLOBAL_SCOPE_KEY,
    seq: seqs.session,
    ts: ISO(NOW - 5 * 60 * 1000),
    sessionId: 'session-ledger-only',
    title: 'Ledger only',
    status: 'idle',
    turns: 4,
    lastActivityTs: ISO(NOW - 6 * 60 * 1000),
    files: ['src/ledger.ts'],
  }
  const superseding = entryRecord(seqs.superseding, {
    kind: 'decision',
    title: 'Pin dependencies to 0.2.x',
    body: 'Supersedes the open question about strategy.',
    supersedes: questionId,
    author: { sessionId: 'session-decider', title: 'Planner', origin: 'agent' },
  })
  const minimal = entryRecord(seqs.minimal, {
    kind: 'warning',
    title: 'Minimal record without optional fields',
    body: undefined,
    tags: undefined,
    files: undefined,
    author: { sessionId: 'session-minimal', origin: 'agent' },
  })

  // Deliberately unsorted (the store contract sorts; the export must not rely on it).
  const records = [
    legacySession,
    old,
    gotcha,
    minimal,
    tombstone1,
    reply,
    session,
    deletedReply,
    tombstone2,
    question,
    legacyRecord,
    superseding,
    deletedRoot,
    tombstoned,
  ]
  const legacyMeta = [{ wsKey: LEGACY_KEY, canonicalPath: 'D:\\work\\old-repo' }]
  return {
    records,
    legacyMeta,
    ids: {
      legacy: `cnf_${seqs.legacy}`,
      gotcha: `cnf_${seqs.gotcha}`,
      question: questionId,
      reply: `cnf_${seqs.reply}`,
      tombstoned: `cnf_${seqs.tombstoned}`,
      deletedRoot: deletedRootId,
      deletedReply: `cnf_${seqs.deletedReply}`,
      old: `cnf_${seqs.old}`,
      superseding: `cnf_${seqs.superseding}`,
      minimal: `cnf_${seqs.minimal}`,
      session: 'session-ledger-only',
    },
    seqs,
    legacyKey: LEGACY_KEY,
    originKey: ORIGIN_KEY,
  }
}

async function readExport(outDir) {
  const jsonl = await fs.readFile(path.join(outDir, MEMORIES_FILE), 'utf8')
  const manifest = JSON.parse(await fs.readFile(path.join(outDir, EXPORT_MANIFEST_FILE), 'utf8'))
  const lines = jsonl === '' ? [] : jsonl.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { jsonl, manifest, lines, records: lines.map((line) => JSON.parse(line)) }
}

async function exportFixture(options = {}) {
  const store = options.store ?? createFakeStore({
    records: options.records ?? [],
    legacyMeta: options.legacyMeta ?? [],
    rootDir: options.rootDir,
  })
  const config = options.config ?? makeConfig()
  const outDir = options.outDir ?? path.join(await tempRoot(), 'export')
  const result = await exportMemories({
    store,
    board: options.board,
    config,
    redactor: options.redactor ?? createRedactor(config, { logger: silentLogger }),
    outDir,
    fs: options.fs,
    now: options.now ?? (() => NOW),
    dryRun: options.dryRun === true,
  })
  return { result, store, outDir: result.outDir, config }
}

// ---------------------------------------------------------------------------
// EXP-01 — universal manifest + v1 record mapping
// ---------------------------------------------------------------------------

test('EXP-01 export writes a universal manifest and v1 records with the global wsKey', async () => {
  const fixture = seed()
  const { result } = await exportFixture(fixture)
  const { records, manifest } = await readExport(result.outDir)

  assert.equal(result.schema, EXPORT_SCHEMA)
  assert.equal(result.formatVersion, EXPORT_FORMAT_VERSION)
  assert.equal(result.scope, 'global')
  assert.equal(manifest.schema, EXPORT_SCHEMA)
  assert.equal(manifest.formatVersion, EXPORT_FORMAT_VERSION)
  assert.equal(manifest.scope, 'global')
  assert.deepEqual(manifest.producer, { name: 'dsh-confluence', version: '0.2.1', dsh: '0.2.2-rc.1' })
  assert.equal(manifest.generatedAt, ISO(NOW))
  assert.deepEqual(manifest.workspace, { wsKey: GLOBAL_SCOPE_KEY, name: GLOBAL_SCOPE_LABEL })
  assert.equal(manifest.workspace.name, 'All sessions')
  assert.equal(manifest.recordCount, 6)
  assert.equal(manifest.firstSeq, fixture.seqs.legacy)
  assert.equal(manifest.lastSeq, fixture.seqs.minimal)
  assert.equal(manifest.files.length, 1)
  assert.equal(manifest.files[0].name, MEMORIES_FILE)
  assert.ok(manifest.files[0].bytes > 0)
  assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(manifest.redaction, { applied: true, policy: 'confluence.redact/v1' })
  assert.deepEqual(manifest.limits, { truncated: false, maxEntriesPerWorkspace: 2000 })
  assert.deepEqual(result.files, manifest.files)

  assert.equal(records.length, 8, 'six live records plus two tombstone stubs')
  for (const record of records) {
    assert.equal(record.wsKey, GLOBAL_SCOPE_KEY, 'every record carries the reserved global wsKey')
    assert.equal(Object.prototype.hasOwnProperty.call(record, 'ws'), false, 'the raw workspace field never leaks')
    assert.equal(record.v, 1)
    assert.equal(record.schema, EXPORT_SCHEMA)
    assert.equal(record.type, 'entry')
  }

  const byId = new Map(records.map((record) => [record.id, record]))
  const gotcha = byId.get(fixture.ids.gotcha)
  assert.ok(gotcha)
  assert.equal(gotcha.kind, 'gotcha')
  assert.equal(gotcha.deleted, false)
  assert.equal(gotcha.deletedAt, null)
  assert.equal(gotcha.replyTo, null)
  assert.equal(gotcha.resolves, null)
  assert.equal(gotcha.supersedes, null)
  assert.deepEqual(gotcha.author, { sessionId: 'session-author', title: 'Auth work', origin: 'agent' })
  assert.deepEqual(gotcha.origin, { workspaceKey: ORIGIN_KEY, workspaceLabel: 'repo-a' })

  const reply = byId.get(fixture.ids.reply)
  assert.equal(reply.replyTo, fixture.ids.question)
  assert.equal(reply.resolves, fixture.ids.question, 'resolves boolean must map to the replyTo entry id')
  assert.equal(reply.supersedes, null)

  const superseding = byId.get(fixture.ids.superseding)
  assert.equal(superseding.supersedes, fixture.ids.question)

  const minimal = byId.get(fixture.ids.minimal)
  assert.equal(minimal.kind, 'warning')
  assert.equal(Object.prototype.hasOwnProperty.call(minimal, 'body'), false, 'absent body must stay absent')
  assert.equal(Object.prototype.hasOwnProperty.call(minimal, 'tags'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(minimal, 'files'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(minimal, 'origin'), false, 'unknown provenance stays absent')
});

// ---------------------------------------------------------------------------
// EXP-02 — legacy merge + provenance
// ---------------------------------------------------------------------------

test('EXP-02 legacy journals are merged read-only and carried as origin provenance', async () => {
  const fixture = seed()
  const { result } = await exportFixture(fixture)
  const { jsonl, records } = await readExport(result.outDir)
  const byId = new Map(records.map((record) => [record.id, record]))

  const legacy = byId.get(fixture.ids.legacy)
  assert.ok(legacy, 'a pre-0.2.0 legacy record must appear in the universal export')
  assert.equal(legacy.wsKey, GLOBAL_SCOPE_KEY)
  assert.deepEqual(legacy.origin, { workspaceKey: fixture.legacyKey, workspaceLabel: 'old-repo' })
  assert.equal(legacy.title, 'Legacy decision from a pre-0.2.0 workspace')
  assert.equal(legacy.author.origin, 'user')

  assert.equal(records.some((record) => record.id === fixture.ids.session), false, 'global session rows are not exported')
  assert.equal(records.some((record) => record.id === LEGACY_SESSION_ID), false, 'legacy session rows are not exported')
  assert.equal(records.some((record) => record.kind === 'session'), false)
  assert.equal(records.every((record) => record.type === 'entry'), true, 'only entry records may be exported')

  // No absolute paths anywhere: neither the legacy canonical path nor the redacted body survives.
  assert.equal(jsonl.includes('D:\\work\\old-repo'), false, 'the legacy canonical path must not leak')
  assert.equal(jsonl.includes('C:\\Users\\mockuser'), false, 'no absolute home path may survive')
  assert.equal(/[A-Za-z]:\\\\/.test(jsonl), false, 'no Windows drive path may appear in JSON text')
  assert.equal(JSON.stringify(records).includes('mockuser'), false)
});

// ---------------------------------------------------------------------------
// EXP-03 — counts, tombstone stubs, retention, order
// ---------------------------------------------------------------------------

test('EXP-03 live-only counts, tombstone stubs, retention and (seq,id) order', async () => {
  const fixture = seed()
  const { result } = await exportFixture(fixture)
  const { records, manifest, lines } = await readExport(result.outDir)

  const stubs = records.filter((record) => record.deleted === true)
  const live = records.filter((record) => record.deleted !== true)
  assert.equal(stubs.length, 2, 'two directly tombstoned entries become stubs')
  assert.equal(live.length, 6, 'six live records remain (legacy 5, 10, 20, 21, 70, 80)')
  assert.equal(manifest.recordCount, 6)
  assert.equal(result.recordCount, 6)
  assert.equal(result.tombstoneStubs, 2)
  assert.equal(result.skippedReplies, 1, 'a reply under a tombstoned root is not exported')
  assert.equal(result.skippedRetention, 1, 'an entry older than retentionDays is hidden from the export')
  assert.equal(manifest.firstSeq, fixture.seqs.legacy)
  assert.equal(manifest.lastSeq, fixture.seqs.minimal)
  assert.equal(lines.length, records.length)

  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]
    const current = records[index]
    assert.ok(
      previous.seq < current.seq || (previous.seq === current.seq && previous.id <= current.id),
      `records not sorted at line ${index + 1}: ${previous.seq} then ${current.seq}`,
    )
  }

  const tombstoned = stubs.find((record) => record.id === fixture.ids.tombstoned)
  assert.ok(tombstoned)
  assert.equal(tombstoned.wsKey, GLOBAL_SCOPE_KEY)
  assert.equal(tombstoned.title, '')
  assert.equal(tombstoned.body, '')
  assert.equal(Object.prototype.hasOwnProperty.call(tombstoned, 'tags'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(tombstoned, 'files'), false)
  assert.deepEqual(tombstoned.author, { sessionId: 'session-author', origin: 'agent' }, 'stub author is reduced')
  assert.equal(tombstoned.deletedAt, ISO(NOW - 2 * 60 * 60 * 1000))
  assert.equal(tombstoned.replyTo, null)
  assert.equal(tombstoned.resolves, null)
  assert.equal(tombstoned.supersedes, null)

  const deletedRoot = stubs.find((record) => record.id === fixture.ids.deletedRoot)
  assert.ok(deletedRoot)
  assert.equal(deletedRoot.author.origin, 'user')
  assert.equal(records.some((record) => record.id === fixture.ids.deletedReply), false, 'reply under a tombstoned root must be absent')
  assert.equal(records.some((record) => record.id === fixture.ids.old), false, 'retention-hidden entry must be absent')
});

// ---------------------------------------------------------------------------
// EXP-04 — file integrity (V7 single reading)
// ---------------------------------------------------------------------------

test('EXP-04 manifest hashes/bytes cover the whole file while counts cover live records only', async () => {
  const fixture = seed()
  const { result } = await exportFixture(fixture)
  const file = path.join(result.outDir, MEMORIES_FILE)
  const bytes = await fs.readFile(file)
  const manifest = JSON.parse(await fs.readFile(path.join(result.outDir, EXPORT_MANIFEST_FILE), 'utf8'))

  assert.equal(manifest.files.length, 1)
  assert.equal(manifest.files[0].name, MEMORIES_FILE)
  assert.equal(manifest.files[0].bytes, bytes.length)
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(result.files[0].sha256, manifest.files[0].sha256)
  assert.equal(result.files[0].bytes, manifest.files[0].bytes)

  const lines = bytes.toString('utf8').split('\n').filter((line) => line.length > 0)
  assert.equal(manifest.recordCount, lines.filter((line) => JSON.parse(line).deleted !== true).length)
  assert.equal(manifest.recordCount < lines.length, true, 'tombstone stubs are file content but not counted')
  assert.ok(lines.every((line) => Buffer.byteLength(line, 'utf8') <= 64 * 1024), 'per-line 64 KiB cap')
  assert.ok(bytes.length <= EXPORT_MAX_BYTES)
});

// ---------------------------------------------------------------------------
// EXP-05 — redaction + relative file hints
// ---------------------------------------------------------------------------

test('EXP-05 export re-applies redaction, strips absolute paths and keeps file hints relative', async () => {
  const fixture = seed()
  const { result } = await exportFixture(fixture)
  const { jsonl, records } = await readExport(result.outDir)

  assert.equal(jsonl.includes(leakedKey), false, 'API key must be redacted from title/body')
  assert.equal(jsonl.includes('mockuser'), false, 'no absolute home path may survive')
  assert.equal(jsonl.includes('..\\escape'), false, 'no escaping relative path may survive')

  const gotcha = records.find((record) => record.id === fixture.ids.gotcha)
  assert.ok(gotcha)
  assert.deepEqual(gotcha.files, ['src/fs/rename.ts'], 'only the relative, non-denied hint survives')
  assert.deepEqual(gotcha.tags, ['windows', 'fs'], 'tags are normalised to lowercase valid labels')
  assert.equal(gotcha.title.includes(leakedKey), false)
  assert.equal(gotcha.body.includes(leakedKey), false)
  assert.equal(gotcha.body.includes('[redacted]'), true, 'the secret is redacted and reported')
});

// ---------------------------------------------------------------------------
// EXP-06 — determinism
// ---------------------------------------------------------------------------

test('EXP-06 repeated exports are byte-identical; only generatedAt may differ between runs', async () => {
  const fixture = seed()
  const first = await exportFixture(fixture)
  const second = await exportFixture(fixture)
  const later = await exportFixture({ ...fixture, now: () => NOW + 60_000 })

  const a = await readExport(first.result.outDir)
  const b = await readExport(second.result.outDir)
  const c = await readExport(later.result.outDir)
  assert.equal(a.jsonl, b.jsonl, 'same store + same clock must produce identical JSONL bytes')
  assert.equal(a.manifest.files[0].sha256, b.manifest.files[0].sha256)
  assert.deepEqual({ ...a.manifest, generatedAt: null }, { ...b.manifest, generatedAt: null })

  assert.equal(a.jsonl, c.jsonl, 'JSONL stays byte-identical when only the clock advances')
  assert.notEqual(a.manifest.generatedAt, c.manifest.generatedAt)
  assert.deepEqual({ ...a.manifest, generatedAt: null }, { ...c.manifest, generatedAt: null })
});

// ---------------------------------------------------------------------------
// EXP-07 — read-only store + dry run
// ---------------------------------------------------------------------------

test('EXP-07 export only reads mergedRecords(); dry run writes nothing; no read-back', async () => {
  const fixture = seed()
  const store = createFakeStore(fixture)
  const config = makeConfig()
  const dryDir = path.join(await tempRoot(), 'dry')
  const dry = await exportMemories({
    store,
    config,
    redactor: createRedactor(config, { logger: silentLogger }),
    outDir: dryDir,
    now: () => NOW,
    dryRun: true,
  })
  assert.equal(dry.dryRun, true)
  assert.equal(typeof dry.jsonlText, 'string')
  assert.ok(dry.jsonlText.length > 0)
  assert.equal(existsSync(dryDir), false, 'dry run must not create the export directory')
  assert.equal(store.calls.refreshMerged, 1)
  assert.equal(store.calls.mergedRecords, 1)
  assert.equal(typeof store.appendAndSync, 'undefined', 'the export has no store write path')
  assert.equal(typeof store.openWorkspace, 'undefined', 'the export never opens/creates a workspace journal')
  assert.equal(typeof store.writePresence, 'undefined')

  const real = await exportFixture({ ...fixture, store })
  assert.ok(existsSync(path.join(real.outDir, MEMORIES_FILE)))
  assert.ok(existsSync(path.join(real.outDir, EXPORT_MANIFEST_FILE)))
  // No read-back: a second export from an unchanged store yields identical bytes.
  const again = await exportFixture({ ...fixture, store })
  assert.equal((await readExport(real.outDir)).jsonl, (await readExport(again.outDir)).jsonl)
  assert.equal(store.calls.mergedRecords, 3, 'one mergedRecords read per export (plus the dry run)')
});

// ---------------------------------------------------------------------------
// EXP-08 — failure modes (fail closed)
// ---------------------------------------------------------------------------

test('EXP-08 unsupported store, unsafe outDir and a throwing redactor fail closed', async () => {
  const fixture = seed()
  const config = makeConfig()
  const redactor = createRedactor(config, { logger: silentLogger })
  const cleanOut = path.join(await tempRoot(), 'clean')

  await assert.rejects(
    () => exportMemories({ store: { rootDir: path.join(tmpdir(), 'fake-store-root') }, config, redactor, outDir: cleanOut }),
    (error) => error.code === 'STORE_UNAVAILABLE',
    'a store generation without mergedRecords() is refused, not silently exported empty',
  )

  await assert.rejects(
    () => exportMemories({ store: createFakeStore(fixture), config, redactor: {}, outDir: cleanOut }),
    (error) => error.code === 'BAD_ARGUMENT',
  )

  const storeRoot = path.join(tmpdir(), 'fake-store-root')
  const unsafeDirs = [
    path.join(storeRoot, 'workspaces', GLOBAL_SCOPE_KEY),
    `${path.join(tmpdir(), 'escape')}\\..\\still-escape`,
    '.confluence/export',
  ]
  for (const unsafe of unsafeDirs) {
    await assert.rejects(
      () => exportMemories({ store: createFakeStore({ ...fixture, rootDir: storeRoot }), config, redactor, outDir: unsafe }),
      (error) => error.code === 'BAD_ARGUMENT',
      `expected BAD_ARGUMENT for ${unsafe}`,
    )
  }

  const throwingRedactor = {
    title() {
      throw new Error('boom')
    },
    text: redactor.text,
    files: redactor.files,
    tags: redactor.tags,
  }
  const failOut = path.join(await tempRoot(), 'fail')
  await assert.rejects(
    () => exportMemories({ store: createFakeStore(fixture), config, redactor: throwingRedactor, outDir: failOut }),
    (error) => error.code === 'EXPORT_FAILED',
  )
  assert.equal(existsSync(failOut), false, 'a failed export must not publish a partial pair')

  const brokenStore = createFakeStore(fixture)
  brokenStore.refreshMerged = async () => {
    throw new Error('EACCES: permission denied')
  }
  await assert.rejects(
    () => exportMemories({ store: brokenStore, config, redactor, outDir: cleanOut }),
    (error) => error.code === 'STORE_UNAVAILABLE',
  )
  assert.equal(existsSync(cleanOut), false)
});

// ---------------------------------------------------------------------------
// EXP-09 — atomic publish order (manifest LAST)
// ---------------------------------------------------------------------------

function recordingFs(onRename) {
  const renames = []
  return {
    renames,
    fs: {
      open: (...args) => fs.open(...args),
      mkdir: (...args) => fs.mkdir(...args),
      unlink: (...args) => fs.unlink(...args),
      rename: async (from, to) => {
        renames.push(path.basename(to))
        if (typeof onRename === 'function') await onRename(from, to)
        return fs.rename(from, to)
      },
    },
  }
}

async function tempFiles(dir) {
  try {
    return (await fs.readdir(dir)).filter((name) => name.includes('.tmp-'))
  } catch {
    return []
  }
}

test('EXP-09 JSONL is published first and manifest.json LAST; a failed manifest leaves no commit marker', async () => {
  const fixture = seed()
  const config = makeConfig()
  const recorder = recordingFs()
  const outDir = path.join(await tempRoot(), 'atomic')
  await exportMemories({
    store: createFakeStore(fixture),
    config,
    redactor: createRedactor(config, { logger: silentLogger }),
    outDir,
    fs: recorder.fs,
    now: () => NOW,
  })
  assert.deepEqual(recorder.renames, [MEMORIES_FILE, EXPORT_MANIFEST_FILE], 'manifest must be renamed last')
  assert.equal(existsSync(path.join(outDir, MEMORIES_FILE)), true)
  assert.equal(existsSync(path.join(outDir, EXPORT_MANIFEST_FILE)), true)
  assert.deepEqual(await tempFiles(outDir), [], 'no temp files may remain after a successful publish')

  const failing = recordingFs(async (_from, to) => {
    if (path.basename(to) === EXPORT_MANIFEST_FILE) {
      const error = new Error('simulated rename failure')
      error.code = 'EPERM'
      throw error
    }
  })
  const failedOut = path.join(await tempRoot(), 'atomic-failed')
  await assert.rejects(
    () =>
      exportMemories({
        store: createFakeStore(fixture),
        config,
        redactor: createRedactor(config, { logger: silentLogger }),
        outDir: failedOut,
        fs: failing.fs,
        now: () => NOW,
      }),
    (error) => error.code === 'STORE_UNAVAILABLE',
  )
  assert.equal(existsSync(path.join(failedOut, MEMORIES_FILE)), true, 'the JSONL may exist without a commit marker')
  assert.equal(existsSync(path.join(failedOut, EXPORT_MANIFEST_FILE)), false, 'never publish a manifest without its JSONL update')
  assert.deepEqual(await tempFiles(failedOut), [], 'a failed publish removes its temp file')
});

// ---------------------------------------------------------------------------
// EXP-10 — caps (8 MiB deterministic tail truncation)
// ---------------------------------------------------------------------------

function bigRecords(count) {
  const records = []
  for (let index = 0; index < count; index += 1) {
    const seq = seqFor(1000 + index)
    records.push({
      v: 1,
      type: 'entry',
      id: `cnf_${seq}`,
      ws: GLOBAL_SCOPE_KEY,
      seq,
      ts: ISO(NOW - 1000),
      kind: 'finding',
      title: `large record ${index}`,
      body: 'b'.repeat(8192),
      author: { sessionId: 'session-big', origin: 'agent' },
    })
  }
  return records
}

test('EXP-10 the 8 MiB cap truncates deterministically from the tail and is recorded in limits', async () => {
  const records = bigRecords(1100)
  const config = makeConfig({ maxEntriesPerWorkspace: 300 })
  const { result } = await exportFixture({ records, config, dryRun: true })

  assert.equal(result.truncated, true)
  assert.equal(result.manifest.limits.truncated, true)
  assert.equal(result.manifest.limits.maxEntriesPerWorkspace, 300, 'the global entry cap is reported verbatim')
  assert.ok(result.files[0].bytes <= EXPORT_MAX_BYTES)
  assert.equal(Buffer.byteLength(result.jsonlText, 'utf8'), result.files[0].bytes)
  assert.ok(result.recordCount < records.length, 'the tail (highest seq) is dropped')

  const lines = result.jsonlText.trimEnd().split('\n')
  assert.equal(lines.length, result.recordCount)
  const last = JSON.parse(lines[lines.length - 1])
  assert.ok(last.seq < records[records.length - 1].seq, 'the last emitted record is before the dropped tail')
  // Deterministic: the same input reproduces the same truncation point.
  const again = await exportFixture({ records, config, dryRun: true })
  assert.equal(again.result.jsonlText, result.jsonlText)
  assert.deepEqual(again.result.files, result.files)
});

// ---------------------------------------------------------------------------
// EXP-11 — CLI run() (in-process; no child_process)
// ---------------------------------------------------------------------------

function captureIo() {
  const stdout = []
  const stderr = []
  return {
    out: stdout,
    err: stderr,
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
  }
}

async function makeDshHome() {
  const root = await tempRoot('confluence-export-cli-')
  const dshHome = path.join(root, 'dsh-home')
  const storeRoot = path.join(dshHome, 'storages', 'confluence', 'v1')
  await fs.mkdir(storeRoot, { recursive: true })
  return { root, dshHome, storeRoot }
}

function cliStoreFactory({ records, legacyMeta, rootDir }) {
  return () => createFakeStore({ records, legacyMeta, rootDir })
}

test('EXP-11 CLI exports the universal scope to the default dsh-home stamp directory', async () => {
  const fixture = seed()
  const { root, dshHome, storeRoot } = await makeDshHome()

  const json = captureIo()
  const code = await run({
    argv: ['--dsh-home', dshHome, '--json'],
    io: json.io,
    now: () => NOW,
    createStore: cliStoreFactory({ ...fixture, rootDir: storeRoot }),
  })
  assert.equal(code, 0, `CLI failed: ${json.err.join('')}`)
  const summary = JSON.parse(json.out.join(''))
  assert.equal(summary.ok, true)
  assert.equal(summary.schema, EXPORT_SCHEMA)
  assert.equal(summary.formatVersion, EXPORT_FORMAT_VERSION)
  assert.equal(summary.scope, 'global')
  assert.equal(summary.recordCount, 6)
  assert.equal(summary.tombstoneStubs, 2)
  assert.equal(summary.firstSeq, fixture.seqs.legacy)
  assert.equal(summary.lastSeq, fixture.seqs.minimal)
  assert.equal(summary.dryRun, false)
  const expectedOut = path.join(dshHome, 'storages', 'confluence-exports', utcStamp(NOW))
  assert.equal(summary.outDir, expectedOut)
  assert.equal(existsSync(path.join(expectedOut, MEMORIES_FILE)), true)
  assert.equal(existsSync(path.join(expectedOut, EXPORT_MANIFEST_FILE)), true)

  const customOut = path.join(root, 'custom-out')
  const human = captureIo()
  const humanCode = await run({
    argv: ['--dsh-home', dshHome, '--out', customOut],
    io: human.io,
    now: () => NOW,
    createStore: cliStoreFactory({ ...fixture, rootDir: storeRoot }),
  })
  assert.equal(humanCode, 0, human.err.join(''))
  const text = human.out.join('')
  assert.match(text, /Confluence export — confluence\.memories\/v1/)
  assert.match(text, /scope:\s+global\s+\(All sessions\)/)
  assert.match(text, /records:\s+6 live, 2 tombstone stub/)
  assert.equal(existsSync(path.join(customOut, EXPORT_MANIFEST_FILE)), true)

  const dryOut = path.join(root, 'dry-out')
  const dry = captureIo()
  const dryCode = await run({
    argv: ['--dsh-home', dshHome, '--out', dryOut, '--dry-run', '--json'],
    io: dry.io,
    now: () => NOW,
    createStore: cliStoreFactory({ ...fixture, rootDir: storeRoot }),
  })
  assert.equal(dryCode, 0, dry.err.join(''))
  assert.equal(JSON.parse(dry.out.join('')).dryRun, true)
  assert.equal(existsSync(dryOut), false)

  // Exit 1: missing home, missing store, unsupported store generation, unsafe --out.
  for (const argv of [
    ['--dsh-home', path.join(root, 'nope')],
    ['--dsh-home', path.join(root, 'empty-home')],
  ]) {
    await fs.mkdir(path.join(root, 'empty-home'), { recursive: true })
    const capture = captureIo()
    const failure = await run({ argv, io: capture.io, now: () => NOW, createStore: () => createFakeStore(fixture) })
    assert.equal(failure, 1)
    assert.match(capture.err.join(''), /STORE_UNAVAILABLE/)
  }

  const unsupported = captureIo()
  const unsupportedCode = await run({
    argv: ['--dsh-home', dshHome],
    io: unsupported.io,
    now: () => NOW,
    createStore: () => ({ rootDir: storeRoot, async init() {}, async close() {} }),
  })
  assert.equal(unsupportedCode, 1)
  assert.match(unsupported.err.join(''), /STORE_UNAVAILABLE/)

  const insideStore = captureIo()
  const insideCode = await run({
    argv: ['--dsh-home', dshHome, '--out', path.join(storeRoot, 'export')],
    io: insideStore.io,
    now: () => NOW,
    createStore: cliStoreFactory({ ...fixture, rootDir: storeRoot }),
  })
  assert.equal(insideCode, 1)
  assert.match(insideStore.err.join(''), /BAD_ARGUMENT/)

  // Exit 2: usage errors — no --workspace flag exists in v0.2.0.
  const noWorkspace = captureIo()
  const noWorkspaceCode = await run({
    argv: ['--dsh-home', dshHome, '--workspace', root],
    io: noWorkspace.io,
    now: () => NOW,
    createStore: cliStoreFactory({ ...fixture, rootDir: storeRoot }),
  })
  assert.equal(noWorkspaceCode, 2)
  assert.match(noWorkspace.err.join(''), /unknown argument: --workspace/)

  const escapeOut = captureIo()
  const escapeCode = await run({
    argv: ['--dsh-home', dshHome, '--out', '..\\escape'],
    io: escapeOut.io,
    now: () => NOW,
    createStore: cliStoreFactory({ ...fixture, rootDir: storeRoot }),
  })
  assert.equal(escapeCode, 2)
  assert.match(escapeOut.err.join(''), /must not contain/)

  const usage = captureIo()
  assert.equal(await run({ argv: [], io: usage.io }), 2)
});

// ---------------------------------------------------------------------------
// EXP-12 — pure helpers
// ---------------------------------------------------------------------------

test('EXP-12 helper contracts: labels, path stripping, outDir validation, args, default dir', () => {
  assert.equal(workspaceLabelFor('D:\\work\\my-repo'), 'my-repo')
  assert.equal(workspaceLabelFor('/home/u/my-repo'), 'my-repo')
  assert.equal(workspaceLabelFor(''), '')

  assert.equal(stripAbsolutePaths('open C:\\Users\\u\\x.ts now'), 'open <path> now')
  assert.equal(stripAbsolutePaths('see /home/u/project/x.ts'), 'see <path>')
  assert.equal(stripAbsolutePaths('see /opt/secret/config.yml'), 'see <path>')
  assert.equal(stripAbsolutePaths('open /etc/passwd now'), 'open <path> now')
  assert.equal(stripAbsolutePaths('list /srv/data'), 'list <path>')
  assert.equal(stripAbsolutePaths('read ~/notes.txt'), 'read <path>')
  assert.equal(stripAbsolutePaths('https://example.com/a/b'), 'https://example.com/a/b')
  assert.equal(stripAbsolutePaths('https://example.com/a is a URL'), 'https://example.com/a is a URL')
  assert.equal(stripAbsolutePaths('relative/path.ts untouched'), 'relative/path.ts untouched')

  const storeRoot = path.join(tmpdir(), 'fake-store-root')
  const okDir = validateExportDir(path.join(tmpdir(), 'export-out'), storeRoot)
  assert.equal(path.isAbsolute(okDir), true)
  assert.throws(() => validateExportDir('.confluence/export', storeRoot), (error) => error.code === 'BAD_ARGUMENT')
  assert.throws(() => validateExportDir(path.join(storeRoot, 'inside'), storeRoot), (error) => error.code === 'BAD_ARGUMENT')
  assert.throws(() => validateExportDir(`${tmpdir()}\\..\\escape`, storeRoot), (error) => error.code === 'BAD_ARGUMENT')

  assert.equal(validateOutArg('exports/memories'), path.resolve('exports/memories'))
  assert.equal(validateOutArg('C:\\abs\\export'), path.resolve('C:\\abs\\export'))
  assert.throws(() => validateOutArg('../escape'), /must not contain/)
  assert.throws(() => validateOutArg(''), /non-empty/)
  assert.throws(() => validateOutArg('   '), /non-empty/)

  assert.equal(utcStamp(NOW), '20261113T120000Z')
  const dshHome = path.join(tmpdir(), 'dsh-home')
  assert.equal(
    defaultExportDir(dshHome, NOW),
    path.join(dshHome, 'storages', 'confluence-exports', '20261113T120000Z'),
  )

  assert.deepEqual(parseArgs(['--dsh-home', 'h']), { dshHome: 'h', out: '', json: false, dryRun: false, help: false })
  assert.deepEqual(parseArgs(['--dsh-home', 'h', '--out', 'o', '--json', '--dry-run']), {
    dshHome: 'h',
    out: 'o',
    json: true,
    dryRun: true,
    help: false,
  })
  assert.equal(parseArgs(['--help']).help, true)
  assert.throws(() => parseArgs([]), /--dsh-home is required/)
  assert.throws(() => parseArgs(['--dsh-home', 'h', '--workspace', 'w']), /unknown argument: --workspace/)
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/)
  assert.match(USAGE, /--dsh-home/)
  assert.doesNotMatch(USAGE, /--workspace/)
});

// ---------------------------------------------------------------------------
// EXP-13 — real JournalStore integration: delta surface + read-only contract
// ---------------------------------------------------------------------------

/** Files under `dir` as sorted `{rel, bytes, sha256}` records (directories excluded). */
async function snapshotTree(dir) {
  const out = []
  async function walk(current, prefix) {
    const dirents = await fs.readdir(current, { withFileTypes: true })
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const dirent of dirents) {
      const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`
      const full = path.join(current, dirent.name)
      if (dirent.isDirectory()) {
        await walk(full, rel)
      } else if (dirent.isFile()) {
        const bytes = await fs.readFile(full)
        out.push({ rel, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
    }
  }
  await walk(dir, '')
  return out
}

test('EXP-13 real JournalStore: global + legacy journals merge, store files stay byte-identical', async () => {
  assert.equal(STORE_GLOBAL_SCOPE_KEY, GLOBAL_SCOPE_KEY, 'one reserved global scope key across modules')

  const root = await tempRoot('confluence-export-real-')
  const dshHome = path.join(root, 'dsh-home')
  const storeRoot = path.join(dshHome, 'storages', 'confluence', 'v1')
  const legacyDir = path.join(root, 'old-repo')
  await fs.mkdir(legacyDir, { recursive: true })

  const storeConfig = resolveConfig({ store: { dir: storeRoot, pollMs: 50, watch: false } }).config
  const store = new JournalStore({
    config: storeConfig,
    logger: silentLogger,
    deps: { env: { DSH_HOME: dshHome }, pid: 9001, now: () => NOW, random: () => 0.25 },
  })
  await store.init()
  const globalJournal = await store.openGlobal()
  await globalJournal.appendAndSync({
    v: 1,
    type: 'entry',
    id: `cnf_${seqFor(1)}`,
    ws: GLOBAL_SCOPE_KEY,
    seq: seqFor(1),
    ts: ISO(NOW - 60_000),
    kind: 'decision',
    title: 'Universal note from session A',
    body: 'shared memory',
    author: { sessionId: 'session-a', title: 'Session A', origin: 'agent' },
    origin: { workspaceKey: ORIGIN_KEY, workspaceLabel: 'repo-a' },
  })
  const legacyJournal = await store.openWorkspace(LEGACY_KEY, { canonicalPath: legacyDir })
  await legacyJournal.appendAndSync({
    v: 1,
    type: 'entry',
    id: `cnf_${seqFor(2)}`,
    ws: LEGACY_KEY,
    seq: seqFor(2),
    ts: ISO(NOW - 120_000),
    kind: 'gotcha',
    title: 'Legacy note from v0.1',
    body: 'still visible',
    author: { sessionId: 'session-old', origin: 'agent' },
  })
  await store.close()

  const before = await snapshotTree(storeRoot)
  assert.ok(before.length > 0, 'the store must have on-disk files to compare')

  const capture = captureIo()
  const code = await run({
    argv: ['--dsh-home', dshHome, '--json'],
    io: capture.io,
    now: () => NOW,
  })
  assert.equal(code, 0, `CLI failed: ${capture.err.join('')}`)
  const summary = JSON.parse(capture.out.join(''))
  assert.equal(summary.scope, 'global')
  assert.equal(summary.recordCount, 2, 'global and legacy entries both export')
  assert.equal(summary.outDir, path.join(dshHome, 'storages', 'confluence-exports', utcStamp(NOW)))

  const { records, manifest } = await readExport(summary.outDir)
  assert.deepEqual(manifest.workspace, { wsKey: GLOBAL_SCOPE_KEY, name: 'All sessions' })
  const byId = new Map(records.map((record) => [record.id, record]))
  const universal = byId.get(`cnf_${seqFor(1)}`)
  assert.equal(universal.wsKey, GLOBAL_SCOPE_KEY)
  assert.deepEqual(universal.origin, { workspaceKey: ORIGIN_KEY, workspaceLabel: 'repo-a' })
  const legacy = byId.get(`cnf_${seqFor(2)}`)
  assert.equal(legacy.wsKey, GLOBAL_SCOPE_KEY)
  assert.deepEqual(legacy.origin, { workspaceKey: LEGACY_KEY, workspaceLabel: 'old-repo' }, 'legacy label is the manifest basename')

  const after = await snapshotTree(storeRoot)
  assert.deepEqual(after, before, 'the export must not create, append or rewrite any store file')
});

test('EXP-14 a pre-0.2.0 store without a global journal exports legacy memory and creates nothing', async () => {
  const legacyOnlyKey = 'ws_4444444444444444'
  const root = await tempRoot('confluence-export-legacy-only-')
  const dshHome = path.join(root, 'dsh-home')
  const storeRoot = path.join(dshHome, 'storages', 'confluence', 'v1')
  const legacyDir = path.join(root, 'legacy-only-project')
  await fs.mkdir(legacyDir, { recursive: true })

  const storeConfig = resolveConfig({ store: { dir: storeRoot, pollMs: 50, watch: false } }).config
  const store = new JournalStore({
    config: storeConfig,
    logger: silentLogger,
    deps: { env: { DSH_HOME: dshHome }, pid: 9002, now: () => NOW },
  })
  await store.init()
  const legacyJournal = await store.openWorkspace(legacyOnlyKey, { canonicalPath: legacyDir })
  await legacyJournal.appendAndSync({
    v: 1,
    type: 'entry',
    id: `cnf_${seqFor(1)}`,
    ws: legacyOnlyKey,
    seq: seqFor(1),
    ts: ISO(NOW - 1000),
    kind: 'decision',
    title: 'Only legacy memory exists',
    author: { sessionId: 'session-v01', origin: 'agent' },
  })
  await store.close()

  const workspacesDir = path.join(storeRoot, 'workspaces')
  const workspacesBefore = (await fs.readdir(workspacesDir)).sort()
  assert.equal(workspacesBefore.includes(GLOBAL_SCOPE_KEY), false)
  const before = await snapshotTree(storeRoot)

  const capture = captureIo()
  const code = await run({ argv: ['--dsh-home', dshHome, '--json'], io: capture.io, now: () => NOW })
  assert.equal(code, 0, `CLI failed: ${capture.err.join('')}`)
  const summary = JSON.parse(capture.out.join(''))
  assert.equal(summary.scope, 'global')
  assert.equal(summary.recordCount, 1)

  const { records, manifest } = await readExport(summary.outDir)
  assert.deepEqual(manifest.workspace, { wsKey: GLOBAL_SCOPE_KEY, name: 'All sessions' })
  assert.equal(records.length, 1)
  assert.equal(records[0].wsKey, GLOBAL_SCOPE_KEY)
  assert.deepEqual(records[0].origin, { workspaceKey: legacyOnlyKey, workspaceLabel: 'legacy-only-project' })

  assert.deepEqual((await fs.readdir(workspacesDir)).sort(), workspacesBefore, 'no global scope directory may be created by an export')
  assert.deepEqual(await snapshotTree(storeRoot), before, 'legacy journals stay byte-identical')
});
