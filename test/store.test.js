// WP1 unit tests — lib/store.js
// Covers implementation-interfaces.md §5 (plus the Lead addendum: listWorkspaces,
// workspaceMeta, viewedRecords, view, isOpen) and store-format.md §17 rows 1–14:
// shard naming, whole-line append, torn tails, merge/dedupe, manifest, presence,
// poll/watch freshness and injectable fs seams.

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import nodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { JournalStore } from '../lib/store.js'
import { createUlidFactory, isUlid } from '../lib/util.js'
import { DEFAULTS } from '../lib/config.js'
import { workspaceKeyFor } from '../lib/workspace.js'

const WS_KEY = 'ws_0123456789abcdef'
const WS_PATH = 'D:\\05_Code\\confluence'
const TS = '2026-11-13T02:41:07.512Z'

/** @type {JournalStore[]} */
const stores = []
/** @type {string[]} */
const tempDirs = []

after(async () => {
  for (const store of stores) {
    try {
      await store.close()
    } catch {
      // ignore cleanup failures
    }
  }
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

async function tempRoot() {
  const dir = await mkdtemp(path.join(tmpdir(), 'confluence-store-'))
  tempDirs.push(dir)
  return dir
}

function seededRandom(seed = 0.42) {
  let state = Math.floor(seed * 1_000_000) + 1
  return () => {
    state = (state * 9301 + 49297) % 233280
    return state / 233280
  }
}

/**
 * @param {{root?: string, pid?: number, seed?: number, pollMs?: number, watch?: boolean, fs?: object, logger?: object, retryDelays?: number[]}} [options]
 */
async function newStore(options = {}) {
  const root = options.root ?? (await tempRoot())
  let tick = 1_700_000_000_000
  const config = {
    store: {
      ...DEFAULTS.store,
      dir: root,
      pollMs: options.pollMs ?? 50,
      watch: options.watch ?? false,
    },
  }
  const store = new JournalStore({
    config,
    logger: options.logger,
    deps: {
      pid: options.pid ?? 4001,
      random: seededRandom(options.seed ?? 0.42),
      now: () => {
        tick += 1000
        return tick
      },
      fs: options.fs,
      retryDelays: options.retryDelays ?? [0, 0, 0],
    },
  })
  stores.push(store)
  await store.init()
  return { store, root }
}

function seqFactory(seed = 0.7, startMs = 1_700_000_000_000) {
  let tick = startMs
  return createUlidFactory(
    () => {
      tick += 1
      return tick
    },
    seededRandom(seed),
  )
}

function entry(seq, overrides = {}) {
  return {
    v: 1,
    type: 'entry',
    id: `cnf_${seq}`,
    ws: WS_KEY,
    seq,
    ts: TS,
    kind: 'finding',
    title: `title-${seq.slice(-4)}`,
    author: { sessionId: 'session-author', origin: 'agent' },
    ...overrides,
  }
}

function sessionRow(seq, overrides = {}) {
  return {
    v: 1,
    type: 'session',
    ws: WS_KEY,
    seq,
    ts: TS,
    sessionId: 'session-1',
    turns: 1,
    lastActivityTs: TS,
    status: 'idle',
    ...overrides,
  }
}

async function writeShard(root, writerId, records, { raw } = {}) {
  const dir = path.join(root, 'workspaces', WS_KEY)
  await mkdir(path.join(dir, 'presence'), { recursive: true })
  const content = raw !== undefined ? raw : records.map((record) => `${JSON.stringify(record)}\n`).join('')
  await writeFile(path.join(dir, `journal.${writerId}.v1.jsonl`), content, 'utf8')
}

async function openJournal(store) {
  return store.openWorkspace(WS_KEY, { canonicalPath: WS_PATH, label: 'confluence' })
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

// ---------------------------------------------------------------------------
// append / encoding (UT-STORE-01, 04, 05)
// ---------------------------------------------------------------------------

test('UT-STORE-01 a record line round-trips: envelope assigned, one LF-terminated JSON object', async () => {
  const { store, root } = await newStore()
  const journal = await openJournal(store)
  const stored = await journal.append({ type: 'entry', id: 'cnf_roundtrip', kind: 'finding', title: 'hello' })

  assert.equal(stored.v, 1)
  assert.equal(stored.ws, WS_KEY)
  assert.ok(isUlid(stored.seq))
  assert.match(stored.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  const shardPath = path.join(root, 'workspaces', WS_KEY, `journal.${store.writerId}.v1.jsonl`)
  const raw = await readFile(shardPath, 'utf8')
  assert.ok(raw.endsWith('\n'))
  assert.equal(raw.split('\n').filter((line) => line !== '').length, 1, 'exactly one record line')
  const parsed = JSON.parse(raw.trim())
  assert.deepEqual(parsed, stored)
  assert.equal(JSON.stringify(parsed), raw.trim(), 'parse -> serialize keeps canonical bytes')

  await journal.refresh({ force: true })
  assert.deepEqual(journal.records(), [stored])
})

test('UT-STORE-04 shard naming: journal.<writerId>.v1.jsonl, writer id stable per mount', async () => {
  const { store, root } = await newStore()
  assert.match(store.writerId, /^\d+-[0-9a-f]{8}$/)
  const journal = await openJournal(store)
  await journal.append(entry(seqFactory()()))
  await journal.append(entry(seqFactory(0.9)()))
  const files = (await readdir(path.join(root, 'workspaces', WS_KEY))).filter((name) => name.endsWith('.jsonl'))
  assert.deepEqual(files, [`journal.${store.writerId}.v1.jsonl`])

  const second = await newStore({ root, pid: 4002, seed: 0.77 })
  const secondJournal = await openJournal(second.store)
  await secondJournal.append(entry(seqFactory(0.5)()))
  const filesAfter = (await readdir(path.join(root, 'workspaces', WS_KEY))).filter((name) =>
    name.endsWith('.jsonl'),
  )
  assert.equal(filesAfter.length, 2, 'each mount (writer id) gets its own shard')
  assert.notEqual(second.store.writerId, store.writerId)
})

test('UT-STORE-05 append writes complete lines only; over-cap serialization is rejected', async () => {
  const { store, root } = await newStore()
  const journal = await openJournal(store)
  const shardPath = path.join(root, 'workspaces', WS_KEY, `journal.${store.writerId}.v1.jsonl`)

  await assert.rejects(
    () => journal.append(entry(seqFactory()(), { body: 'x'.repeat(70000) })),
    (error) => error && error.code === 'BODY_TOO_LARGE',
  )
  const afterReject = await readFile(shardPath, 'utf8').catch(() => '')
  assert.equal(afterReject, '', 'nothing is written for a rejected record')

  const stored = await journal.append(entry(seqFactory(0.8)(), { body: 'ok' }))
  const raw = await readFile(shardPath, 'utf8')
  assert.equal(raw.split('\n').filter((line) => line !== '').length, 1)
  assert.ok(Buffer.byteLength(raw, 'utf8') < 65536)
  assert.equal(JSON.parse(raw.trim()).id, stored.id)
})

test('UT-STORE-05b reader skips oversized/corrupt lines and keeps valid neighbours', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory()
  const before = entry(seqs())
  const after = entry(seqs())
  const raw = [
    JSON.stringify(before),
    'x'.repeat(66000), // over the 64 KiB line cap
    '{not json', // malformed complete line
    JSON.stringify(after),
    '',
  ].join('\n')
  await writeShard(root, '5501-aaaaaaaa', null, { raw })
  const journal = await openJournal(store)
  const records = journal.records()
  assert.equal(records.length, 2, 'only valid lines survive')
  assert.deepEqual(records.map((record) => record.id), [before.id, after.id])
  await assert.doesNotReject(() => journal.refresh({ force: true }))
  assert.equal(journal.records().length, 2)
})

// ---------------------------------------------------------------------------
// merge / dedupe (UT-STORE-02, 03, 06, 07, 08)
// ---------------------------------------------------------------------------

test('UT-STORE-02 unknown record types are ignored; unknown fields are preserved', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory()
  const known = entry(seqs(), { zzz: { custom: true } })
  const unknownType = { v: 1, type: 'signal', ws: WS_KEY, seq: seqs(), ts: TS, text: 'reserved' }
  await writeShard(root, '5001-aaaaaaaa', [known, unknownType])
  const journal = await openJournal(store)
  const records = journal.records()
  assert.equal(records.length, 1, 'reserved/unknown types are ignored by v1 readers')
  assert.deepEqual(records[0].zzz, { custom: true }, 'unknown fields stay in the in-memory record')
  const raw = await readFile(path.join(root, 'workspaces', WS_KEY, 'journal.5001-aaaaaaaa.v1.jsonl'), 'utf8')
  assert.ok(raw.includes('"type":"signal"'), 'readers never rewrite a shard')
})

test('UT-STORE-03 ULID seq order is lexicographic and unique across two writers', async () => {
  const root = await tempRoot()
  const one = await newStore({ root, pid: 5001, seed: 0.11 })
  const two = await newStore({ root, pid: 5002, seed: 0.93 })
  const journalOne = await openJournal(one.store)
  const journalTwo = await openJournal(two.store)
  const seqsOne = seqFactory(0.21)
  const seqsTwo = seqFactory(0.83)
  for (let i = 0; i < 3; i += 1) await journalOne.append(entry(seqsOne(), { title: `a${i}` }))
  for (let i = 0; i < 3; i += 1) await journalTwo.append(entry(seqsTwo(), { title: `b${i}` }))

  await journalOne.refresh({ force: true })
  const records = journalOne.records()
  assert.equal(records.length, 6)
  const seqs = records.map((record) => record.seq)
  assert.equal(new Set(seqs).size, 6, 'seqs are unique across writers')
  assert.deepEqual(seqs, [...seqs].sort(), 'merged view is sorted lexicographically by seq')
  assert.ok(seqs.every(isUlid))
})

test('UT-STORE-06 merge across shards: global seq order, deterministic on repeated reads', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory()
  const s1 = seqs()
  const s2 = seqs()
  const s3 = seqs()
  const s4 = seqs()
  const s5 = seqs()
  const s6 = seqs()
  await writeShard(root, '6001-aaaaaaaa', [entry(s2), entry(s5)])
  await writeShard(root, '6002-bbbbbbbb', [entry(s1), entry(s6)])
  await writeShard(root, '6003-cccccccc', [entry(s3), entry(s4)])
  const journal = await openJournal(store)
  const first = journal.records()
  const second = journal.records()
  assert.equal(first.length, 6)
  assert.deepEqual(first.map((record) => record.seq), [s1, s2, s3, s4, s5, s6])
  assert.deepEqual(first, second, 'repeated reads are deterministic')
  assert.ok(Object.isFrozen(first), 'records() returns a frozen array')
})

test('UT-STORE-07 dedupe: entry first-by-seq wins, session max-seq wins', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory()
  const low = seqs()
  const high = seqs()
  const entryId = `cnf_${low}`
  await writeShard(root, '7001-aaaaaaaa', [
    entry(low, { id: entryId, title: 'first' }),
    sessionRow(low, { turns: 1 }),
  ])
  await writeShard(root, '7002-bbbbbbbb', [
    entry(high, { id: entryId, title: 'second' }),
    sessionRow(high, { turns: 2 }),
  ])
  const journal = await openJournal(store)
  const records = journal.records()
  const mergedEntry = records.find((record) => record.type === 'entry')
  const mergedSession = records.find((record) => record.type === 'session')
  assert.equal(mergedEntry.title, 'first', 'lower seq wins for an immutable entry id')
  assert.equal(mergedSession.turns, 2, 'highest seq wins for a session upsert')
  assert.equal(records.length, 2)
})

test('UT-STORE-08 fixture shards merge to the expected golden snapshot', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory()
  const s1 = seqs()
  const s2 = seqs()
  const s3 = seqs()
  const rows = [entry(s1, { kind: 'decision', title: 'decide' }), entry(s2, { kind: 'gotcha' }), entry(s3, { kind: 'question' })]
  await writeShard(root, '8001-aaaaaaaa', [rows[1]])
  await writeShard(root, '8002-bbbbbbbb', [rows[0], rows[2]])
  const journal = await openJournal(store)
  const golden = rows.map((record) => ({
    id: record.id,
    seq: record.seq,
    kind: record.kind,
    title: record.title,
  }))
  assert.deepEqual(
    journal.records().map((record) => ({ id: record.id, seq: record.seq, kind: record.kind, title: record.title })),
    golden,
  )
})

// ---------------------------------------------------------------------------
// torn tail / crash tolerance (UT-STORE-09, 10, 11)
// ---------------------------------------------------------------------------

test('UT-STORE-09/11 torn trailing line ignored; valid prefix reads cleanly (no throw)', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory()
  const complete = entry(seqs())
  await writeShard(root, '9001-aaaaaaaa', null, {
    raw: `${JSON.stringify(complete)}\n{"v":1,"type":"entry","id":"cnf_trunc`,
  })
  const journal = await openJournal(store)
  assert.equal(journal.records().length, 1)
  assert.equal(journal.records()[0].id, complete.id)
  await assert.doesNotReject(() => journal.refresh({ force: true }))
  assert.equal(journal.records().length, 1, 'the torn tail stays invisible')
})

test('UT-STORE-10 a later complete line after the torn tail is visible; the tail stays ignored', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory()
  const first = entry(seqs())
  const second = entry(seqs())
  const shardName = 'journal.9002-bbbbbbbb.v1.jsonl'
  await writeShard(root, '9002-bbbbbbbb', null, {
    raw: `${JSON.stringify(first)}\n{"v":1,"type":"entry","id":"cnf_torn`,
  })
  const journal = await openJournal(store)
  assert.equal(journal.records().length, 1)
  // A complete record arrives after the unterminated garbage (fixture scenario:
  // a crashed writer's tail followed by another complete line).
  await appendFile(
    path.join(root, 'workspaces', WS_KEY, shardName),
    `\n${JSON.stringify(second)}\n`,
    'utf8',
  )
  const changed = await journal.refresh()
  assert.equal(changed, true)
  const records = journal.records()
  assert.equal(records.length, 2)
  assert.deepEqual(records.map((record) => record.id), [first.id, second.id])
  assert.ok(records.every((record) => record.id !== 'cnf_torn'))
})

// ---------------------------------------------------------------------------
// poll, watch and change feed (UT-STORE-12)
// ---------------------------------------------------------------------------

test('UT-STORE-12 poll refresh sees another writer within a poll interval; onChange fires', async () => {
  const root = await tempRoot()
  const writer = await newStore({ root, pid: 12001, seed: 0.2 })
  const reader = await newStore({ root, pid: 12002, seed: 0.8, pollMs: 25 })
  const writerJournal = await openJournal(writer.store)
  const readerJournal = await openJournal(reader.store)
  const changes = []
  readerJournal.onChange((changed) => changes.push(changed))
  assert.equal(readerJournal.isOpen, true)

  await writerJournal.append(entry(seqFactory(0.4)()))
  const seen = await waitFor(() => readerJournal.records().length === 1)
  assert.equal(seen, true, 'poll freshness contract: another writer becomes visible')
  assert.ok(changes.length >= 1 && changes.every((value) => value === true))
  assert.equal(await readerJournal.refresh(), false, 'no change => refresh returns false')

  await readerJournal.append(entry(seqFactory(0.6)()))
  assert.equal(readerJournal.records().length, 2)
})

test('UT-STORE-12b fs.watch throwing degrades to polling with one warning, never crashes', async () => {
  const logs = []
  const logger = {
    debug: (record) => logs.push(['debug', record]),
    info: (record) => logs.push(['info', record]),
    warn: (record) => logs.push(['warn', record]),
    error: (record) => logs.push(['error', record]),
  }
  let notified = 0
  const deps = {
    watch: () => {
      notified += 1
      throw new Error('fs.watch unsupported')
    },
  }
  const directory = await tempRoot()
  const { store } = await newStore({ root: directory, logger, watch: true })
  // Inject the throwing watcher after construction (public deps seam).
  store._watchImpl = deps.watch
  const journal = await openJournal(store)
  assert.equal(journal.isOpen, true)
  assert.equal(notified, 1, 'watch was attempted')
  assert.ok(
    logs.some(([level, record]) => level === 'warn' && record.event === 'store.watch_unavailable'),
    'one warning is logged and activation continues',
  )
  await assert.doesNotReject(() => journal.append(entry(seqFactory()())))
})

// ---------------------------------------------------------------------------
// manifest, workspace metadata, listing (UT-STORE-13/14)
// ---------------------------------------------------------------------------

test('UT-STORE-13 manifest is created once, cached metadata, tolerant workspace listing', async () => {
  const { store, root } = await newStore()
  const journal = await openJournal(store)
  const manifestPath = path.join(root, 'workspaces', WS_KEY, 'MANIFEST.v1.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.format, 'confluence.store/v1')
  assert.equal(manifest.formatVersion, 1)
  assert.equal(manifest.ws, WS_KEY)
  assert.equal(manifest.workspace.canonicalPath, WS_PATH)
  assert.match(manifest.workspace.createdAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(manifest.generation, 0)

  assert.deepEqual(store.workspaceMeta(WS_KEY), {
    wsKey: WS_KEY,
    canonicalPath: WS_PATH,
    createdAt: manifest.workspace.createdAt,
  })
  assert.equal(store.workspaceMeta('ws_ffffffffffffffff'), null)

  await journal.append(entry(seqFactory()()))
  const listed = await store.listWorkspaces()
  const item = listed.find((workspace) => workspace.wsKey === WS_KEY)
  assert.ok(item)
  assert.equal(item.canonicalPath, WS_PATH)
  assert.equal(item.label, 'confluence')
  assert.equal(item.createdAt, manifest.workspace.createdAt)
  assert.equal(item.entries, 1)

  // Tolerant listing: one bad manifest/directory never fails the listing.
  await mkdir(path.join(root, 'workspaces', 'ws_deadbeefdeadbeef', 'presence'), { recursive: true })
  await writeFile(path.join(root, 'workspaces', 'ws_deadbeefdeadbeef', 'MANIFEST.v1.json'), '{not json', 'utf8')
  await mkdir(path.join(root, 'workspaces', 'not-a-workspace'), { recursive: true })
  const tolerant = await store.listWorkspaces()
  assert.deepEqual(tolerant.map((workspace) => workspace.wsKey), [WS_KEY])
})

test('UT-STORE-14 manifest collision/wrong-ws/invalid cases throw STORE_UNAVAILABLE', async () => {
  const rootA = await tempRoot()
  const { store } = await newStore({ root: rootA })
  await openJournal(store)

  const wrongWsKey = 'ws_aaaaaaaaaaaaaaaa'
  const wrongDir = path.join(rootA, 'workspaces', wrongWsKey)
  await mkdir(path.join(wrongDir, 'presence'), { recursive: true })
  await writeFile(
    path.join(wrongDir, 'MANIFEST.v1.json'),
    JSON.stringify({
      format: 'confluence.store/v1',
      formatVersion: 1,
      ws: WS_KEY,
      workspace: { key: WS_KEY, canonicalPath: WS_PATH, createdAt: TS },
      generation: 0,
    }),
    'utf8',
  )
  await assert.rejects(
    () => store.openWorkspace(wrongWsKey, { canonicalPath: WS_PATH }),
    (error) => error && error.code === 'STORE_UNAVAILABLE',
  )

  const collisionRoot = await tempRoot()
  const collision = await newStore({ root: collisionRoot })
  const collisionJournal = await openJournal(collision.store)
  assert.ok(collisionJournal)
  const otherWsKey = 'ws_bbbbbbbbbbbbbbbb'
  const otherDir = path.join(collisionRoot, 'workspaces', otherWsKey)
  await mkdir(path.join(otherDir, 'presence'), { recursive: true })
  await writeFile(
    path.join(otherDir, 'MANIFEST.v1.json'),
    JSON.stringify({
      format: 'confluence.store/v1',
      formatVersion: 1,
      ws: otherWsKey,
      workspace: { key: otherWsKey, canonicalPath: 'C:\\original\\path', createdAt: TS },
      generation: 0,
    }),
    'utf8',
  )
  await assert.rejects(
    () => collision.store.openWorkspace(otherWsKey, { canonicalPath: 'C:\\other\\path' }),
    (error) => error && error.code === 'STORE_UNAVAILABLE',
  )
})

test('UT-STORE-15 existing manifest unknown fields are preserved (never rewritten)', async () => {
  const root = await tempRoot()
  const wsDir = path.join(root, 'workspaces', WS_KEY)
  await mkdir(path.join(wsDir, 'presence'), { recursive: true })
  const manifest = {
    format: 'confluence.store/v1',
    formatVersion: 1,
    ws: WS_KEY,
    workspace: { key: WS_KEY, canonicalPath: WS_PATH, createdAt: TS, custom: 'keep-me' },
    generation: 0,
    unknownTopLevel: { future: true },
  }
  const text = JSON.stringify(manifest)
  await writeFile(path.join(wsDir, 'MANIFEST.v1.json'), text, 'utf8')
  const { store } = await newStore({ root })
  await openJournal(store)
  assert.equal(await readFile(path.join(wsDir, 'MANIFEST.v1.json'), 'utf8'), text, 'open must not rewrite it')
})

// ---------------------------------------------------------------------------
// presence, durability, size, close (UT-STORE-16..18)
// ---------------------------------------------------------------------------

test('UT-STORE-16 presence heartbeat: atomic file per writer, tolerant read', async () => {
  const { store, root } = await newStore()
  const journal = await openJournal(store)
  await journal.writePresence({ sessions: [{ sessionId: 'session-1', title: 'Auth work', status: 'live' }] })
  const presenceDir = path.join(root, 'workspaces', WS_KEY, 'presence')
  const files = await readdir(presenceDir)
  assert.deepEqual(files, [`${store.writerId}.json`], 'no temp file is left behind')
  const written = JSON.parse(await readFile(path.join(presenceDir, `${store.writerId}.json`), 'utf8'))
  assert.equal(written.writerId, store.writerId)
  assert.match(written.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(written.sessions, [{ sessionId: 'session-1', title: 'Auth work', status: 'live' }])

  await writeFile(path.join(presenceDir, '9999-deadbeef.json'), '{broken', 'utf8')
  const presence = await journal.readPresence()
  assert.ok(presence[store.writerId])
  assert.equal(presence['9999-deadbeef'], undefined, 'invalid heartbeat is ignored')
})

test('UT-STORE-17 appendAndSync/flush/sizeInfo/close contract', async () => {
  const { store } = await newStore()
  const journal = await openJournal(store)
  await assert.doesNotReject(() => journal.flush(), 'flush before any append is a no-op')

  const stored = await journal.appendAndSync(entry(seqFactory()()))
  assert.ok(stored.seq)
  let size = await journal.sizeInfo()
  assert.equal(size.shards, 1)
  assert.ok(size.bytes > 0)
  assert.equal(size.entries, 1)
  assert.equal(journal.view(), journal.records(), 'view() is the synchronous records() alias')
  assert.equal(store.viewedRecords(WS_KEY), journal.records())
  assert.deepEqual(store.viewedRecords('ws_ffffffffffffffff'), [])
  assert.ok(Object.isFrozen(store.viewedRecords('ws_ffffffffffffffff')))

  await store.close()
  assert.equal(journal.isOpen, false)
  await assert.rejects(
    () => journal.append(entry(seqFactory(0.9)())),
    (error) => error && error.code === 'STORE_UNAVAILABLE',
  )
  await assert.doesNotReject(() => store.close(), 'close is idempotent')
  size = await journal.sizeInfo()
  assert.equal(size.entries, 1)
})

// ---------------------------------------------------------------------------
// root resolution + injectable fs seams (UT-STORE-18/19)
// ---------------------------------------------------------------------------

test('UT-STORE-18 DSH_HOME/root resolution order (env, homedir, config.store.dir)', async () => {
  const home = await tempRoot()
  const envHome = path.join(home, 'env-home')
  const fallback = new JournalStore({
    config: { store: { dir: '' } },
    deps: { env: {}, homedir: () => home, random: seededRandom(0.1), pid: 1 },
  })
  assert.equal(fallback.rootDir, path.join(home, '.dsh', 'storages', 'confluence', 'v1'))

  const fromEnv = new JournalStore({
    config: { store: { dir: '' } },
    deps: { env: { DSH_HOME: envHome }, homedir: () => path.join(home, 'ignored'), random: seededRandom(0.1), pid: 1 },
  })
  assert.equal(fromEnv.rootDir, path.join(envHome, 'storages', 'confluence', 'v1'))

  const relative = new JournalStore({
    config: { store: { dir: 'shared' } },
    deps: { env: { DSH_HOME: envHome }, random: seededRandom(0.1), pid: 1 },
  })
  assert.equal(relative.rootDir, path.join(envHome, 'storages', 'confluence', 'shared'))

  const absolute = await tempRoot()
  const absoluteStore = new JournalStore({
    config: { store: { dir: `${absolute}${path.sep}` } },
    deps: { env: { DSH_HOME: envHome }, random: seededRandom(0.1), pid: 1 },
  })
  assert.equal(absoluteStore.rootDir, absolute, 'absolute config dir wins (trailing separator trimmed)')

  const device = new JournalStore({
    config: { store: { dir: '\\\\?\\C:\\device' } },
    deps: { env: { DSH_HOME: envHome }, random: seededRandom(0.1), pid: 1 },
  })
  assert.equal(device.rootDir, path.join(envHome, 'storages', 'confluence', 'v1'))
})

test('UT-STORE-19 all fs access goes through the injectable deps.fs seam', async () => {
  const root = await tempRoot()
  let readFileCalls = 0
  const wrapped = {
    ...nodeFsPromises,
    readFile: async (...args) => {
      readFileCalls += 1
      return nodeFsPromises.readFile(...args)
    },
  }
  const { store } = await newStore({ root, fs: wrapped })
  const journal = await openJournal(store)
  await journal.append(entry(seqFactory()()))
  await journal.refresh({ force: true })
  await store.listWorkspaces()
  assert.ok(readFileCalls >= 2, 'manifest/shard reads use the injected fs implementation')
})
