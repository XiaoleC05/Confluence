// Confluence / 汇流 — WP8/M4 export tests (`confluence.memories/v1`).
//
// Contract: docs/design/store-format.md §13.3/§14 (authoritative bytes + integrity rules),
// docs/design/solo-bench-integration.md §6, docs/adr/0006. Hermetic: real temp-dir JournalStore,
// no DSH runtime, no network, no child process (the CLI's exported run() is called in-process).
//
// Coverage map:
//   EXP-01..03  record mapping, ordering, live-only counts, tombstone stub rule
//   EXP-04      manifest exact shape + file hash/bytes + integrity rules (V7)
//   EXP-05      redaction + absolute/home path stripping + workspace-relative file hints
//   EXP-06      determinism (byte-identical JSONL; manifest differs only in generatedAt)
//   EXP-07      no store mutation / no read-back; dry run
//   EXP-08      failure modes: unknown workspace, unsafe outDir, redactor failure (fail closed)
//   EXP-09      CLI run(): json summary, human summary, dry-run, error exits, usage
//   EXP-10      pure helpers (workspace label, path stripping, outDir validation, arg parsing)

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { JournalStore } from '../lib/store.js'
import { createRedactor } from '../lib/redact.js'
import { resolveConfig } from '../lib/config.js'
import { canonicalizeDir, workspaceKeyFor } from '../lib/workspace.js'
import { createUlidFactory } from '../lib/util.js'

/** Build a synthetic credential from fragments so the committed source never holds a credential-shaped literal. */
const secret = (...parts) => parts.join('')
const leakedKey = secret('sk-fixture', '123456789012345678901234')
import {
  EXPORT_FORMAT_VERSION,
  EXPORT_MANIFEST_FILE,
  EXPORT_SCHEMA,
  MEMORIES_FILE,
  exportWorkspace,
  stripAbsolutePaths,
  validateExportDir,
  workspaceLabelFor,
} from '../lib/export.js'
import { USAGE, parseArgs, run, validateWorkspaceRelativeDir } from '../scripts/export-memories.mjs'

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const ISO = (ms) => new Date(ms).toISOString()
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_PREFIX = '01J8Z6Q3M0'

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

function seededRandom(seed = 0.42) {
  let state = Math.floor(seed * 1_000_000) + 1
  return () => {
    state = (state * 9301 + 49297) % 233280
    return state / 233280
  }
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
/** @type {JournalStore[]} */
const stores = []
/** @type {string[]} */
const tempDirs = []

after(async () => {
  for (const store of stores) await store.close().catch(() => {})
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

async function tempRoot(label = 'confluence-export-') {
  const dir = await fs.mkdtemp(path.join(tmpdir(), label))
  tempDirs.push(dir)
  return dir
}

/**
 * Create a real store with one workspace and a real workspace directory (canonicalized exactly
 * like the plugin does), returning the handles the export needs.
 */
async function makeWorkspace({ storageName = 'store' } = {}) {
  const root = await tempRoot()
  const workspaceDir = path.join(root, storageName)
  await fs.mkdir(workspaceDir, { recursive: true })
  const dshHome = path.join(root, 'dsh-home')
  const storeRoot = path.join(dshHome, 'storages', 'confluence', 'v1')
  const config = resolveConfig({ store: { dir: storeRoot, pollMs: 50, watch: false } }).config
  const store = new JournalStore({
    config,
    logger: silentLogger,
    deps: { env: { DSH_HOME: dshHome }, pid: 7801, random: seededRandom(0.3), now: () => NOW },
  })
  stores.push(store)
  await store.init()
  const canonicalPath = await canonicalizeDir(workspaceDir)
  assert.notEqual(canonicalPath, null, 'test workspace must canonicalize')
  const wsKey = workspaceKeyFor(canonicalPath)
  const journal = await store.openWorkspace(wsKey, { canonicalPath })
  return { root, workspaceDir, canonicalPath, dshHome, storeRoot, config, store, journal, wsKey }
}

/** Append one journal record the way the board writer does (durable append). */
async function append(journal, record) {
  return journal.appendAndSync(record)
}

function entryRecord(wsKey, seq, overrides = {}) {
  return {
    v: 1,
    type: 'entry',
    id: `cnf_${seq}`,
    ws: wsKey,
    seq,
    ts: ISO(NOW - 60 * 60 * 1000),
    kind: 'gotcha',
    title: `note ${seq.slice(-4)}`,
    body: 'body',
    author: { sessionId: 'session-author', title: 'Auth work', origin: 'agent' },
    ...overrides,
  }
}

/** Seed the full export fixture set and return the ids for assertions. */
async function seed(ws, options = {}) {
  const { journal, wsKey } = ws
  const seq10 = seqFor(10)
  const seq20 = seqFor(20)
  const seq21 = seqFor(21)
  const seq30 = seqFor(30)
  const seq31 = seqFor(31)
  const seq40 = seqFor(40)
  const seq41 = seqFor(41)
  const seq42 = seqFor(42)
  const seq50 = seqFor(50)
  const seq60 = seqFor(60)
  const seq70 = seqFor(70)
  const seq80 = seqFor(80)

  const gotchaId = `cnf_${seq10}`
  await append(journal, entryRecord(wsKey, seq10, {
    kind: 'gotcha',
    title: 'Windows rename retries wrap in EPERM',
    body:
      'A scanner holds the handle so the API key ' + leakedKey + ' must never ship. ' +
      'Opened C:\\Users\\mockuser\\project\\src\\fs\\rename.ts on the user machine.',
    tags: ['Windows', 'fs', 'not a tag'],
    files: ['src/fs/rename.ts', 'C:\\Users\\mockuser\\project\\.env', '..\\escape\\x.ts'],
  }))

  const questionId = `cnf_${seq20}`
  await append(journal, entryRecord(wsKey, seq20, {
    kind: 'question',
    title: 'Which index rebuild strategy?',
    body: 'Choose one before the migration.',
    tags: ['index'],
    author: { sessionId: 'session-asker', origin: 'agent' },
  }))
  await append(journal, entryRecord(wsKey, seq21, {
    kind: 'gotcha',
    title: 'Reply: use the native lock',
    body: 'Resolved with the native lease.',
    replyTo: questionId,
    resolves: true,
    author: { sessionId: 'session-answerer', title: 'Data migration', origin: 'agent' },
  }))

  const tombstonedId = `cnf_${seq30}`
  await append(journal, entryRecord(wsKey, seq30, {
    kind: 'finding',
    title: 'A note that will be forgotten',
    body: 'content that must not be exported',
    tags: ['gone'],
    files: ['src/gone.ts'],
  }))
  await append(journal, {
    v: 1,
    type: 'tombstone',
    id: `tmb_${seq31}`,
    ws: wsKey,
    seq: seq31,
    ts: ISO(NOW - 2 * 60 * 60 * 1000),
    target: tombstonedId,
  })

  const deletedRootId = `cnf_${seq40}`
  await append(journal, entryRecord(wsKey, seq40, {
    kind: 'question',
    title: 'Deleted root question',
    body: 'root body',
    author: { sessionId: 'session-deleted-root', origin: 'user' },
  }))
  await append(journal, entryRecord(wsKey, seq41, {
    kind: 'gotcha',
    title: 'Reply under a deleted root',
    body: 'this reply must not be exported',
    replyTo: deletedRootId,
    author: { sessionId: 'session-replier', origin: 'agent' },
  }))
  await append(journal, {
    v: 1,
    type: 'tombstone',
    id: `tmb_${seq42}`,
    ws: wsKey,
    seq: seq42,
    ts: ISO(NOW - 3 * 60 * 60 * 1000),
    target: deletedRootId,
  })

  const oldId = `cnf_${seq50}`
  await append(journal, entryRecord(wsKey, seq50, {
    kind: 'decision',
    title: 'Old decision hidden by retention',
    ts: ISO(NOW - 200 * 24 * 60 * 60 * 1000),
  }))

  // Ledger row: metadata only, never exported.
  await append(journal, {
    v: 1,
    type: 'session',
    ws: wsKey,
    seq: seq60,
    ts: ISO(NOW - 5 * 60 * 1000),
    sessionId: 'session-ledger-only',
    title: 'Ledger only',
    status: 'idle',
    turns: 4,
    lastActivityTs: ISO(NOW - 6 * 60 * 1000),
    files: ['src/ledger.ts'],
  })

  const supersedingId = `cnf_${seq70}`
  await append(journal, entryRecord(wsKey, seq70, {
    kind: 'decision',
    title: 'Pin dependencies to 0.2.x',
    body: 'Supersedes the open question about strategy.',
    supersedes: questionId,
    author: { sessionId: 'session-decider', title: 'Planner', origin: 'agent' },
  }))

  const minimalId = `cnf_${seq80}`
  await append(journal, entryRecord(wsKey, seq80, {
    kind: 'warning',
    title: 'Minimal record without optional fields',
    body: undefined,
    tags: undefined,
    files: undefined,
    author: { sessionId: 'session-minimal', origin: 'agent' },
  }))

  if (options.extraRecords) {
    for (const record of options.extraRecords) await append(journal, record)
  }

  return {
    ids: {
      gotcha: gotchaId,
      question: questionId,
      reply: `cnf_${seq21}`,
      tombstoned: tombstonedId,
      deletedRoot: deletedRootId,
      deletedReply: `cnf_${seq41}`,
      old: oldId,
      superseding: supersedingId,
      minimal: minimalId,
    },
    seqs: { seq10, seq20, seq21, seq30, seq40, seq70, seq80 },
  }
}

function outDirFor(ws, name = 'export') {
  return path.join(ws.workspaceDir, '.confluence', name)
}

async function readExport(outDir) {
  const jsonl = await fs.readFile(path.join(outDir, MEMORIES_FILE), 'utf8')
  const manifest = JSON.parse(await fs.readFile(path.join(outDir, EXPORT_MANIFEST_FILE), 'utf8'))
  const lines = jsonl === '' ? [] : jsonl.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { jsonl, manifest, lines, records: lines.map((line) => JSON.parse(line)) }
}

async function exportFixture(ws, options = {}) {
  const outDir = options.outDir ?? outDirFor(ws)
  const result = await exportWorkspace({
    store: ws.store,
    config: ws.config,
    redactor: createRedactor(ws.config, { logger: silentLogger }),
    workspaceKey: ws.wsKey,
    outDir,
    logger: silentLogger,
    now: options.now ?? (() => NOW),
    dryRun: options.dryRun === true,
  })
  return { result, outDir }
}

// ---------------------------------------------------------------------------
// EXP-01/02/03 — record mapping, ordering, counts, tombstone rule
// ---------------------------------------------------------------------------

test('EXP-01 export maps live entries, threads and supersedes links into confluence.memories/v1 records', async () => {
  const ws = await makeWorkspace()
  const { ids } = await seed(ws)
  const { result } = await exportFixture(ws)
  const { records, manifest } = await readExport(result.outDir)

  assert.equal(result.schema, EXPORT_SCHEMA)
  assert.equal(manifest.formatVersion, EXPORT_FORMAT_VERSION)
  assert.equal(manifest.schema, EXPORT_SCHEMA)
  assert.equal(manifest.producer.name, 'dsh-confluence')
  assert.equal(manifest.producer.version, '0.1.0')
  assert.equal(manifest.producer.dsh, '0.2.2-rc.1')
  assert.equal(manifest.workspace.wsKey, ws.wsKey)
  assert.equal(manifest.workspace.name, 'store')
  assert.equal(manifest.redaction.applied, true)
  assert.equal(manifest.redaction.policy, 'confluence.redact/v1')
  assert.deepEqual(manifest.limits, { truncated: false, maxEntriesPerWorkspace: 2000 })

  const byId = new Map(records.map((record) => [record.id, record]))
  const gotcha = byId.get(ids.gotcha)
  assert.ok(gotcha, 'live gotcha missing from export')
  assert.equal(gotcha.v, 1)
  assert.equal(gotcha.schema, EXPORT_SCHEMA)
  assert.equal(gotcha.type, 'entry')
  assert.equal(gotcha.wsKey, ws.wsKey)
  assert.equal(gotcha.kind, 'gotcha')
  assert.equal(gotcha.deleted, false)
  assert.equal(gotcha.deletedAt, null)
  assert.equal(gotcha.replyTo, null)
  assert.equal(gotcha.resolves, null)
  assert.equal(gotcha.supersedes, null)
  assert.deepEqual(gotcha.author, { sessionId: 'session-author', title: 'Auth work', origin: 'agent' })

  const reply = byId.get(ids.reply)
  assert.equal(reply.replyTo, ids.question)
  assert.equal(reply.resolves, ids.question, 'resolves boolean must map to the replyTo entry id')
  assert.equal(reply.supersedes, null)

  const superseding = byId.get(ids.superseding)
  assert.equal(superseding.supersedes, ids.question)

  const minimal = byId.get(ids.minimal)
  assert.equal(minimal.kind, 'warning')
  assert.equal(Object.prototype.hasOwnProperty.call(minimal, 'body'), false, 'absent body must stay absent')
  assert.equal(Object.prototype.hasOwnProperty.call(minimal, 'tags'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(minimal, 'files'), false)
})

test('EXP-02 export is sorted by (seq,id) and carries no ledger/session rows', async () => {
  const ws = await makeWorkspace()
  await seed(ws)
  const { result } = await exportFixture(ws)
  const { records, lines } = await readExport(result.outDir)

  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]
    const current = records[index]
    assert.ok(
      previous.seq < current.seq || (previous.seq === current.seq && previous.id <= current.id),
      `records not sorted at line ${index + 1}: ${previous.seq} then ${current.seq}`,
    )
  }
  assert.equal(records.every((record) => record.type === 'entry'), true, 'only entry records may be exported')
  assert.equal(records.some((record) => record.id === 'session-ledger-only'), false, 'session ledger rows must not be exported')
  assert.equal(records.some((record) => record.kind === 'session'), false)
  assert.equal(lines.length, records.length)
  assert.ok(lines.every((line) => line.length > 0), 'no blank line is allowed inside the JSONL')
})

test('EXP-03 live-only counts and the tombstone stub rule (incl. cascaded replies and retention)', async () => {
  const ws = await makeWorkspace()
  const { ids } = await seed(ws)
  const { result } = await exportFixture(ws)
  const { records, manifest } = await readExport(result.outDir)

  const stubs = records.filter((record) => record.deleted === true)
  const live = records.filter((record) => record.deleted !== true)
  assert.equal(stubs.length, 2, 'two directly tombstoned entries become stubs')
  assert.equal(live.length, 5, 'five live records remain (seq 10,20,21,70,80)')
  assert.equal(manifest.recordCount, 5)
  assert.equal(result.recordCount, 5)
  assert.equal(result.tombstoneStubs, 2)
  assert.equal(result.skippedReplies, 1, 'a reply under a tombstoned root is not exported')
  assert.equal(result.skippedRetention, 1, 'an entry older than retentionDays is hidden from the export')
  assert.equal(manifest.firstSeq, seqFor(10))
  assert.equal(manifest.lastSeq, seqFor(80))

  const tombstoned = stubs.find((record) => record.id === ids.tombstoned)
  assert.ok(tombstoned)
  assert.equal(tombstoned.title, '')
  assert.equal(tombstoned.body, '')
  assert.equal(Object.prototype.hasOwnProperty.call(tombstoned, 'tags'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(tombstoned, 'files'), false)
  assert.deepEqual(tombstoned.author, { sessionId: 'session-author', origin: 'agent' }, 'stub author is reduced')
  assert.equal(tombstoned.deletedAt, ISO(NOW - 2 * 60 * 60 * 1000))
  assert.equal(tombstoned.replyTo, null)
  assert.equal(tombstoned.resolves, null)
  assert.equal(tombstoned.supersedes, null)

  const deletedRoot = stubs.find((record) => record.id === ids.deletedRoot)
  assert.ok(deletedRoot)
  assert.equal(deletedRoot.author.origin, 'user')
  assert.equal(records.some((record) => record.id === ids.deletedReply), false, 'reply under a tombstoned root must be absent')
  assert.equal(records.some((record) => record.id === ids.old), false, 'retention-hidden entry must be absent')
})

// ---------------------------------------------------------------------------
// EXP-04 — manifest/file integrity (V7 single reading) + per-line cap
// ---------------------------------------------------------------------------

test('EXP-04 manifest hashes and bytes cover the complete file while counts cover live records only', async () => {
  const ws = await makeWorkspace()
  await seed(ws)
  const { result } = await exportFixture(ws)
  const outDir = result.outDir
  const file = path.join(outDir, MEMORIES_FILE)
  const bytes = await fs.readFile(file)
  const manifest = JSON.parse(await fs.readFile(path.join(outDir, EXPORT_MANIFEST_FILE), 'utf8'))

  assert.equal(manifest.files.length, 1)
  assert.deepEqual(manifest.files[0].name, MEMORIES_FILE)
  assert.equal(manifest.files[0].bytes, bytes.length)
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(bytes).digest('hex'))
  const lines = bytes.toString('utf8').split('\n').filter((line) => line.length > 0)
  assert.equal(manifest.recordCount, lines.filter((line) => JSON.parse(line).deleted !== true).length)
  assert.equal(manifest.recordCount < lines.length, true, 'tombstone stubs are file content but not counted')
  assert.ok(lines.every((line) => Buffer.byteLength(line, 'utf8') <= 64 * 1024), 'per-line 64 KiB cap')
  assert.equal(result.files[0].sha256, manifest.files[0].sha256)
})

// ---------------------------------------------------------------------------
// EXP-05 — redaction, absolute paths, workspace-relative file hints
// ---------------------------------------------------------------------------

test('EXP-05 export re-applies redaction, strips absolute paths, and keeps file hints workspace-relative', async () => {
  const ws = await makeWorkspace()
  const { ids } = await seed(ws)
  const { result } = await exportFixture(ws)
  const { jsonl } = await readExport(result.outDir)

  assert.equal(jsonl.includes(leakedKey), false, 'API key must be redacted from title/body')
  assert.equal(/[A-Za-z]:\\/.test(jsonl), false, 'no Windows drive path may survive in the export')
  assert.equal(jsonl.includes('C:\\Users\\mockuser'), false, 'no absolute home path may survive')
  assert.equal(jsonl.includes('..\\escape'), false, 'no escaping relative path may survive')

  const { records } = await readExport(result.outDir)
  const gotcha = records.find((record) => record.id === ids.gotcha)
  assert.ok(gotcha)
  assert.deepEqual(gotcha.files, ['src/fs/rename.ts'], 'only the workspace-relative, non-denied hint survives')
  assert.deepEqual(gotcha.tags, ['windows', 'fs'], 'tags are normalised to lowercase valid labels')
  assert.equal(gotcha.body.includes('[redacted]'), true, 'the secret and the absolute path mention are redacted')
})

// ---------------------------------------------------------------------------
// EXP-06 — determinism
// ---------------------------------------------------------------------------

test('EXP-06 repeated exports are byte-identical; only generatedAt may differ between runs', async () => {
  const ws = await makeWorkspace()
  await seed(ws)
  const first = await exportFixture(ws, { outDir: outDirFor(ws, 'export-a') })
  const second = await exportFixture(ws, { outDir: outDirFor(ws, 'export-b') })
  const later = await exportFixture(ws, { outDir: outDirFor(ws, 'export-c'), now: () => NOW + 60_000 })

  const a = await readExport(first.outDir)
  const b = await readExport(second.outDir)
  const c = await readExport(later.outDir)
  assert.equal(a.jsonl, b.jsonl, 'same store + same clock must produce identical JSONL bytes')
  assert.equal(a.manifest.files[0].sha256, b.manifest.files[0].sha256)
  assert.deepEqual({ ...a.manifest, generatedAt: null }, { ...b.manifest, generatedAt: null })

  assert.equal(a.jsonl, c.jsonl, 'JSONL stays byte-identical when only the clock advances')
  assert.notEqual(a.manifest.generatedAt, c.manifest.generatedAt)
  assert.deepEqual({ ...a.manifest, generatedAt: null }, { ...c.manifest, generatedAt: null })
})

// ---------------------------------------------------------------------------
// EXP-07 — read-only store, no read-back, dry run
// ---------------------------------------------------------------------------

test('EXP-07 export never writes the store, never reads the export back, and supports dry-run', async () => {
  const ws = await makeWorkspace()
  await seed(ws)
  const workspaceStoreDir = path.join(ws.storeRoot, 'workspaces', ws.wsKey)
  const before = (await fs.readdir(workspaceStoreDir)).sort()
  const sizesBefore = await Promise.all(
    before.filter((name) => name.endsWith('.jsonl')).map(async (name) => (await fs.stat(path.join(workspaceStoreDir, name))).size),
  )
  const recordCountBefore = ws.journal.records().length

  const dry = await exportFixture(ws, { outDir: outDirFor(ws, 'dry'), dryRun: true })
  assert.equal(dry.result.dryRun, true)
  assert.equal(typeof dry.result.jsonlText, 'string')
  assert.equal(existsSync(dry.outDir), false, 'dry run must not create the export directory')

  const real = await exportFixture(ws, { outDir: outDirFor(ws, 'real') })
  const after = (await fs.readdir(workspaceStoreDir)).sort()
  const sizesAfter = await Promise.all(
    after.filter((name) => name.endsWith('.jsonl')).map(async (name) => (await fs.stat(path.join(workspaceStoreDir, name))).size),
  )
  assert.deepEqual(after, before, 'export must not add or remove store files')
  assert.deepEqual(sizesAfter, sizesBefore, 'export must not append to store shards')
  assert.equal(ws.journal.records().length, recordCountBefore, 'export must not mutate the merged read cache')
  assert.ok(existsSync(path.join(real.outDir, MEMORIES_FILE)))
  assert.ok(existsSync(path.join(real.outDir, EXPORT_MANIFEST_FILE)))
  // No read-back: a second export from an unchanged store still works and yields identical bytes.
  const again = await exportFixture(ws, { outDir: outDirFor(ws, 'real2') })
  assert.equal((await readExport(real.outDir)).jsonl, (await readExport(again.outDir)).jsonl)
})

// ---------------------------------------------------------------------------
// EXP-08 — failure modes (fail closed)
// ---------------------------------------------------------------------------

test('EXP-08 unknown workspace, unsafe outDir and a throwing redactor fail closed', async () => {
  const ws = await makeWorkspace()
  await seed(ws)
  const redactor = createRedactor(ws.config, { logger: silentLogger })

  await assert.rejects(
    () =>
      exportWorkspace({
        store: ws.store,
        config: ws.config,
        redactor,
        workspaceKey: 'ws_0000000000000000',
        outDir: outDirFor(ws),
        logger: silentLogger,
        now: () => NOW,
      }),
    (error) => error.code === 'NOT_FOUND',
  )

  const unsafeDirs = [
    path.join(ws.storeRoot, 'workspaces', ws.wsKey), // inside the store
    `${ws.workspaceDir}\\..\\escape`, // literal ".." segment (path.join would normalize it away)
    '.confluence/export', // relative
  ]
  for (const unsafe of unsafeDirs) {
    await assert.rejects(
      () =>
        exportWorkspace({
          store: ws.store,
          config: ws.config,
          redactor,
          workspaceKey: ws.wsKey,
          outDir: unsafe,
          logger: silentLogger,
          now: () => NOW,
        }),
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
  const failOut = outDirFor(ws, 'fail')
  await assert.rejects(
    () =>
      exportWorkspace({
        store: ws.store,
        config: ws.config,
        redactor: throwingRedactor,
        workspaceKey: ws.wsKey,
        outDir: failOut,
        logger: silentLogger,
        now: () => NOW,
      }),
    (error) => error.code === 'EXPORT_FAILED',
  )
  assert.equal(existsSync(failOut), false, 'a failed export must not publish a partial pair')
})

// ---------------------------------------------------------------------------
// EXP-09 — CLI run() (in-process; no child_process)
// ---------------------------------------------------------------------------

function captureIo() {
  const stdout = []
  const stderr = []
  return {
    stdout: stdout.join.bind(stdout),
    stderr: stderr.join.bind(stderr),
    out: stdout,
    err: stderr,
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
  }
}

test('EXP-09 CLI run(): json summary, human summary, dry-run and error exits', async () => {
  const ws = await makeWorkspace()
  await seed(ws)
  await ws.store.close()

  const jsonCapture = captureIo()
  const jsonCode = await run({
    argv: ['--dsh-home', ws.dshHome, '--workspace', ws.workspaceDir, '--json'],
    io: jsonCapture.io,
    now: () => NOW,
  })
  assert.equal(jsonCode, 0, `CLI failed: ${jsonCapture.err.join('')}`)
  const summary = JSON.parse(jsonCapture.out.join(''))
  assert.equal(summary.ok, true)
  assert.equal(summary.schema, EXPORT_SCHEMA)
  assert.equal(summary.workspaceKey, ws.wsKey)
  assert.equal(summary.recordCount, 5)
  assert.equal(summary.tombstoneStubs, 2)
  assert.equal(summary.firstSeq, seqFor(10))
  assert.equal(summary.lastSeq, seqFor(80))
  assert.equal(summary.dryRun, false)
  assert.equal(existsSync(path.join(ws.workspaceDir, '.confluence', 'export', MEMORIES_FILE)), true)

  const humanCapture = captureIo()
  const humanCode = await run({
    argv: ['--dsh-home', ws.dshHome, '--workspace', ws.workspaceDir, '--out', 'exports/memories'],
    io: humanCapture.io,
    now: () => NOW,
  })
  assert.equal(humanCode, 0, humanCapture.err.join(''))
  const human = humanCapture.out.join('')
  assert.match(human, /Confluence export — confluence\.memories\/v1/)
  assert.match(human, /records:\s+5 live, 2 tombstone stub/)
  assert.equal(existsSync(path.join(ws.workspaceDir, 'exports', 'memories', EXPORT_MANIFEST_FILE)), true)

  const dryCapture = captureIo()
  const dryCode = await run({
    argv: ['--dsh-home', ws.dshHome, '--workspace', ws.workspaceDir, '--out', 'dry-run-out', '--dry-run', '--json'],
    io: dryCapture.io,
    now: () => NOW,
  })
  assert.equal(dryCode, 0, dryCapture.err.join(''))
  const drySummary = JSON.parse(dryCapture.out.join(''))
  assert.equal(drySummary.dryRun, true)
  assert.equal(existsSync(path.join(ws.workspaceDir, 'dry-run-out')), false)

  const missingStore = captureIo()
  const missingCode = await run({ argv: ['--dsh-home', path.join(ws.root, 'nope'), '--workspace', ws.workspaceDir], io: missingStore.io })
  assert.equal(missingCode, 1)
  assert.match(missingStore.err.join(''), /STORE_UNAVAILABLE/)

  const unknownWorkspace = captureIo()
  const otherDir = path.join(ws.root, 'other-workspace')
  await fs.mkdir(otherDir, { recursive: true })
  const unknownCode = await run({ argv: ['--dsh-home', ws.dshHome, '--workspace', otherDir], io: unknownWorkspace.io })
  assert.equal(unknownCode, 1)
  assert.match(unknownWorkspace.err.join(''), /NOT_FOUND/)

  const rootedOut = captureIo()
  const rootedCode = await run({
    argv: ['--dsh-home', ws.dshHome, '--workspace', ws.workspaceDir, '--out', 'C:\\abs\\export'],
    io: rootedOut.io,
  })
  assert.equal(rootedCode, 2, 'an unsafe --out is a usage error')
  assert.match(rootedOut.err.join(''), /workspace-relative/)

  const usageCode = await run({ argv: [], io: captureIo().io })
  assert.equal(usageCode, 2)
})

// ---------------------------------------------------------------------------
// EXP-10 — pure helpers
// ---------------------------------------------------------------------------

test('EXP-10 helper contracts: labels, path stripping, outDir validation, arg parsing', () => {
  assert.equal(workspaceLabelFor('D:\\work\\my-repo'), 'my-repo')
  assert.equal(workspaceLabelFor('/home/u/my-repo'), 'my-repo')
  assert.equal(workspaceLabelFor(''), '')

  assert.equal(stripAbsolutePaths('open C:\\Users\\u\\x.ts now'), 'open <path> now')
  assert.equal(stripAbsolutePaths('see /home/u/project/x.ts'), 'see <path>')
  assert.equal(stripAbsolutePaths('https://example.com/a is a URL'), 'https://example.com/a is a URL')
  assert.equal(stripAbsolutePaths('relative/path.ts untouched'), 'relative/path.ts untouched')

  const storeRoot = path.join(tmpdir(), 'fake-store-root')
  const okDir = validateExportDir(path.join(tmpdir(), 'export-out'), storeRoot)
  assert.equal(path.isAbsolute(okDir), true)
  assert.throws(() => validateExportDir('.confluence/export', storeRoot), (error) => error.code === 'BAD_ARGUMENT')
  assert.throws(() => validateExportDir(path.join(storeRoot, 'inside'), storeRoot), (error) => error.code === 'BAD_ARGUMENT')
  assert.throws(() => validateExportDir(`${tmpdir()}\\..\\escape`, storeRoot), (error) => error.code === 'BAD_ARGUMENT')

  assert.equal(validateWorkspaceRelativeDir('.confluence/export'), '.confluence/export')
  assert.throws(() => validateWorkspaceRelativeDir('../escape'), /must not contain/)
  assert.throws(() => validateWorkspaceRelativeDir('C:\\abs'), /workspace-relative/)

  assert.deepEqual(parseArgs(['--dsh-home', 'h', '--workspace', 'w']), {
    dshHome: 'h',
    workspace: 'w',
    out: '',
    json: false,
    dryRun: false,
    help: false,
  })
  assert.equal(parseArgs(['--help']).help, true)
  assert.throws(() => parseArgs(['--workspace', 'w']), /--dsh-home is required/)
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/)
  assert.match(USAGE, /--dsh-home/)
})
