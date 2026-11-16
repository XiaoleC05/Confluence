// WP1 unit tests — lib/store.js (v0.2.0 universal scope)
//
// Covers the retained v1 journal contract (append/merge/dedupe/torn tail,
// manifest validation, presence) plus the v0.2.0 delta from
// docs/plan/scope-refactor-delta.md §2:
//   - the reserved global scope (empty canonicalPath allowed only there),
//   - `openGlobal()` idempotence and the global manifest,
//   - the read-only legacy merge (order/dedupe/labels, no legacy writes),
//   - corrupt-legacy tolerance,
//   - `mergedRecords`/`onMergedChange`/`refreshMerged`,
//   - presence through the global journal.
//
// All store instances use deterministic deps (fixed pid/clock/random) and
// per-test temp roots, exactly like the v0.1.0 suite.

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GLOBAL_SCOPE_KEY, GLOBAL_SCOPE_LABEL, JournalStore } from '../lib/store.js'
import { createUlidFactory, isUlid } from '../lib/util.js'
import { DEFAULTS } from '../lib/config.js'

// Reserved determinism: fixed keys/paths/clock, no ambient process state.
const WS_A = 'ws_aaaaaaaaaaaaaaaa'
const WS_B = 'ws_bbbbbbbbbbbbbbbb'
const WS_C = 'ws_cccccccccccccccc'
const WS_D = 'ws_dddddddddddddddd'
const WS_E = 'ws_eeeeeeeeeeeeeeee'
const WS_F = 'ws_ffffffffffffffff'
const PATH_A = 'D:\\05_Code\\alpha'
const PATH_B = 'D:\\05_Code\\beta'
const PATH_C = 'D:\\05_Code\\gamma'
const TS = '2026-11-16T12:00:00.000Z'

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
 * @param {{root?: string, pid?: number, seed?: number, pollMs?: number, watch?: boolean, logger?: object, retryDelays?: number[]}} [options]
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
      platform: 'win32', // deterministic basename semantics for Windows-style manifests
      random: seededRandom(options.seed ?? 0.42),
      now: () => {
        tick += 1000
        return tick
      },
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

/**
 * @param {string} wsKey
 * @param {string} seq
 * @param {string} id
 * @param {Record<string, unknown>} [overrides]
 */
function entry(wsKey, seq, id, overrides = {}) {
  return {
    v: 1,
    type: 'entry',
    id,
    ws: wsKey,
    seq,
    ts: TS,
    kind: 'finding',
    title: `title-${id}`,
    author: { sessionId: 'session-author', origin: 'agent' },
    ...overrides,
  }
}

/**
 * @param {string} wsKey
 * @param {string} seq
 * @param {string} sessionId
 * @param {Record<string, unknown>} [overrides]
 */
function sessionRow(wsKey, seq, sessionId, overrides = {}) {
  return {
    v: 1,
    type: 'session',
    ws: wsKey,
    seq,
    ts: TS,
    sessionId,
    turns: 1,
    lastActivityTs: TS,
    status: 'idle',
    ...overrides,
  }
}

/**
 * Seed a legacy v0.1 per-workspace directory by hand. Never uses the store, so
 * the fixtures stay byte-identical unless something writes to them.
 *
 * @param {string} root
 * @param {string} wsKey
 * @param {{canonicalPath?: string, label?: string, shards?: Record<string, object[] | string>, rawManifest?: string}} spec
 */
async function seedLegacyWorkspace(root, wsKey, spec = {}) {
  const dir = path.join(root, 'workspaces', wsKey)
  await mkdir(dir, { recursive: true })
  const manifest =
    spec.rawManifest ??
    JSON.stringify({
      format: 'confluence.store/v1',
      formatVersion: 1,
      ws: wsKey,
      workspace: {
        key: wsKey,
        canonicalPath: spec.canonicalPath ?? PATH_A,
        ...(spec.label === undefined ? {} : { label: spec.label }),
        createdAt: TS,
      },
      generation: 0,
    })
  await writeFile(path.join(dir, 'MANIFEST.v1.json'), manifest, 'utf8')
  for (const [writerId, records] of Object.entries(spec.shards ?? {})) {
    const content =
      typeof records === 'string' ? records : records.map((record) => `${JSON.stringify(record)}\n`).join('')
    await writeFile(path.join(dir, `journal.${writerId}.v1.jsonl`), content, 'utf8')
  }
  return dir
}

/** Recursive directory snapshot (files -> exact bytes, dirs -> nested snapshot). */
async function snapshotFiles(dir) {
  const out = {}
  let dirents = []
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name)
    if (dirent.isDirectory()) out[`${dirent.name}/`] = await snapshotFiles(full)
    else if (dirent.isFile()) out[dirent.name] = await readFile(full, 'utf8')
  }
  return out
}

// ---------------------------------------------------------------------------
// retained v1 journal contract
// ---------------------------------------------------------------------------

test('UT-STORE-01 a record line round-trips: envelope assigned, one LF-terminated JSON object', async () => {
  const { store, root } = await newStore()
  const journal = await store.openWorkspace(WS_A, { canonicalPath: PATH_A, label: 'alpha' })
  const stored = await journal.append({ type: 'entry', id: 'cnf_roundtrip', kind: 'finding', title: 'hello' })

  assert.equal(stored.v, 1)
  assert.equal(stored.ws, WS_A)
  assert.ok(isUlid(stored.seq))
  assert.match(stored.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  const shardPath = path.join(root, 'workspaces', WS_A, `journal.${store.writerId}.v1.jsonl`)
  const raw = await readFile(shardPath, 'utf8')
  assert.ok(raw.endsWith('\n'))
  assert.equal(raw.split('\n').filter((line) => line !== '').length, 1, 'exactly one record line')
  assert.deepEqual(JSON.parse(raw.trim()), stored)

  await journal.refresh({ force: true })
  assert.deepEqual(journal.records(), [stored])
})

test('UT-STORE-02 journal dedupe: entry first-by-seq wins, session rows max-seq win', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory()
  const low = seqs()
  const high = seqs()
  const entryId = `cnf_${low}`
  await seedLegacyWorkspace(root, WS_A, {
    canonicalPath: PATH_A,
    shards: {
      '7001-aaaaaaaa': [entry(WS_A, low, entryId, { title: 'first' }), sessionRow(WS_A, low, 'session-1', { turns: 1 })],
      '7002-bbbbbbbb': [entry(WS_A, high, entryId, { title: 'second' }), sessionRow(WS_A, high, 'session-1', { turns: 2 })],
    },
  })
  const journal = await store.openWorkspace(WS_A) // existing manifest, no meta required
  const records = journal.records()
  assert.equal(records.find((record) => record.type === 'entry').title, 'first')
  assert.equal(records.find((record) => record.type === 'session').turns, 2)
  assert.equal(records.length, 2)
})

test('UT-STORE-03 torn trailing line is ignored; complete prefix reads cleanly', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory()
  const complete = entry(WS_A, seqs(), 'cnf_torn_ok')
  await seedLegacyWorkspace(root, WS_A, {
    canonicalPath: PATH_A,
    shards: { '9001-aaaaaaaa': `${JSON.stringify(complete)}\n{"v":1,"type":"entry","id":"cnf_trunc` },
  })
  const journal = await store.openWorkspace(WS_A)
  assert.equal(journal.records().length, 1)
  assert.equal(journal.records()[0].id, complete.id)
  await assert.doesNotReject(() => journal.refresh({ force: true }))
})

// ---------------------------------------------------------------------------
// manifest validation + global manifest
// ---------------------------------------------------------------------------

test('UT-STORE-10 empty canonicalPath is valid only for the global scope key', async () => {
  const { store, root } = await newStore()

  // A non-global manifest with an empty canonical path is invalid...
  await mkdir(path.join(root, 'workspaces', WS_E), { recursive: true })
  await writeFile(
    path.join(root, 'workspaces', WS_E, 'MANIFEST.v1.json'),
    JSON.stringify({
      format: 'confluence.store/v1',
      formatVersion: 1,
      ws: WS_E,
      workspace: { key: WS_E, canonicalPath: '', createdAt: TS },
      generation: 0,
    }),
    'utf8',
  )
  await assert.rejects(
    () => store.openWorkspace(WS_E),
    (error) => error && error.code === 'STORE_UNAVAILABLE',
  )

  // ...and creating a brand-new non-global journal without a path is refused.
  await assert.rejects(
    () => store.openWorkspace(WS_F),
    (error) => error && error.code === 'BAD_ARGUMENT',
  )

  // An existing legacy manifest with a path still opens by key without meta and
  // is never rewritten (read-only compatibility).
  const dirA = await seedLegacyWorkspace(root, WS_A, { canonicalPath: PATH_A })
  const manifestText = await readFile(path.join(dirA, 'MANIFEST.v1.json'), 'utf8')
  const journal = await store.openWorkspace(WS_A)
  assert.equal(journal.wsKey, WS_A)
  assert.equal(await readFile(path.join(dirA, 'MANIFEST.v1.json'), 'utf8'), manifestText)

  // A normal new workspace is created with its canonical path.
  const created = await store.openWorkspace(WS_B, { canonicalPath: PATH_B, label: 'beta' })
  const createdManifest = JSON.parse(
    await readFile(path.join(root, 'workspaces', WS_B, 'MANIFEST.v1.json'), 'utf8'),
  )
  assert.equal(createdManifest.workspace.canonicalPath, PATH_B)
  assert.equal(createdManifest.workspace.label, 'beta')
  assert.equal(created.wsKey, WS_B)
})

test('UT-STORE-11 global scope: manifest shape, empty canonicalPath, idempotent open, presence', async () => {
  const { store, root } = await newStore()
  assert.equal(store.globalJournal(), null, 'no global journal before openGlobal()')

  const journal = await store.openGlobal()
  const globalDir = path.join(root, 'workspaces', GLOBAL_SCOPE_KEY)
  assert.equal(journal.wsKey, GLOBAL_SCOPE_KEY)
  assert.equal(journal.dir, globalDir)
  assert.equal(store.globalJournal(), journal)

  const manifestPath = path.join(globalDir, 'MANIFEST.v1.json')
  const manifestText = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(manifestText)
  assert.equal(manifest.format, 'confluence.store/v1')
  assert.equal(manifest.formatVersion, 1)
  assert.equal(manifest.ws, GLOBAL_SCOPE_KEY)
  assert.equal(manifest.workspace.key, GLOBAL_SCOPE_KEY)
  assert.equal(manifest.workspace.canonicalPath, '')
  assert.equal(manifest.workspace.label, GLOBAL_SCOPE_LABEL)
  assert.match(manifest.workspace.createdAt, /^\d{4}-\d{2}-\d{2}T/)

  // Idempotent: same journal instance, manifest bytes untouched.
  const second = await store.openGlobal()
  assert.equal(second, journal)
  assert.equal(await readFile(manifestPath, 'utf8'), manifestText)

  const stored = await journal.append({ type: 'entry', id: 'cnf_global_1', kind: 'finding', title: 'shared' })
  assert.equal(stored.ws, GLOBAL_SCOPE_KEY, 'records default to the global scope key')
  assert.deepEqual(store.mergedRecords().map((record) => record.id), ['cnf_global_1'])

  // Presence lives in the global journal and uses the existing atomic writer.
  await journal.writePresence({ sessions: [{ sessionId: 'session-1', title: 'Auth work', status: 'live' }] })
  const presenceFiles = await readdir(path.join(globalDir, 'presence'))
  assert.deepEqual(presenceFiles, [`${store.writerId}.json`])
  const presence = await journal.readPresence()
  assert.deepEqual(presence[store.writerId].sessions, [
    { sessionId: 'session-1', title: 'Auth work', status: 'live' },
  ])
})

// ---------------------------------------------------------------------------
// legacy read-only merge
// ---------------------------------------------------------------------------

test('UT-STORE-12 legacy merge: labels, order, dedupe (global first-wins, sessions last-wins)', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory(0.37)
  const q = Array.from({ length: 12 }, () => seqs())

  await seedLegacyWorkspace(root, WS_A, {
    canonicalPath: PATH_A,
    shards: {
      '1201-aaaaaaaa': [
        sessionRow(WS_A, q[0], 'sess-legacy'),
        entry(WS_A, q[1], 'cnf_legacy_a'),
        sessionRow(WS_A, q[4], 'sess-shared', { turns: 1 }),
        entry(WS_A, q[6], 'cnf_cross', { title: 'cross A' }),
        entry(WS_A, q[7], 'cnf_dup', { title: 'legacy duplicate' }),
      ],
    },
  })
  await seedLegacyWorkspace(root, WS_B, {
    canonicalPath: PATH_B,
    shards: {
      '1202-bbbbbbbb': [
        entry(WS_B, q[2], 'cnf_legacy_b'),
        entry(WS_B, q[3], 'cnf_cross', { title: 'cross B (earlier)' }),
        entry(WS_B, q[5], 'cnf_legacy_b2'),
      ],
    },
  })

  const journal = await store.openGlobal()
  await journal.append(entry(GLOBAL_SCOPE_KEY, q[8], 'cnf_global'))
  await journal.append(entry(GLOBAL_SCOPE_KEY, q[9], 'cnf_dup', { title: 'global wins' }))
  await journal.append(sessionRow(GLOBAL_SCOPE_KEY, q[10], 'sess-shared', { turns: 3 }))

  // Manifest labels supply provenance; the global scope is never "legacy".
  assert.deepEqual(store.legacyWorkspaceMeta(), [
    { wsKey: WS_A, canonicalPath: PATH_A, label: 'alpha' },
    { wsKey: WS_B, canonicalPath: PATH_B, label: 'beta' },
  ])

  const legacy = store.legacyView()
  assert.equal(store.legacyView(), legacy, 'the legacy view is cached')
  assert.deepEqual([...legacy.labels.keys()], [WS_A, WS_B])
  assert.equal(legacy.labels.get(WS_A), 'alpha')
  assert.equal(legacy.labels.get(WS_B), 'beta')
  assert.ok(Object.isFrozen(legacy.records))
  assert.ok(
    legacy.records.every((record) => record.ws === WS_A || record.ws === WS_B),
    'legacy records keep their original ws field and are never rewritten',
  )
  assert.equal(legacy.records.find((record) => record.id === 'cnf_dup').title, 'legacy duplicate')
  assert.equal(
    legacy.records.find((record) => record.id === 'cnf_cross').ws,
    WS_B,
    'within legacy data the earliest seq wins for one entry id',
  )

  const merged = store.mergedRecords()
  assert.ok(Object.isFrozen(merged))
  assert.equal(store.mergedRecords(), merged, 'the merged view is cached until a change')
  assert.deepEqual(
    merged.map((record) => record.seq),
    [q[0], q[1], q[2], q[3], q[5], q[8], q[9], q[10]],
    'sorted by seq with entry/id duplicates and stale session rows removed',
  )

  const duplicate = merged.find((record) => record.id === 'cnf_dup')
  assert.equal(duplicate.ws, GLOBAL_SCOPE_KEY, 'the global record wins the id even with a higher seq')
  assert.equal(duplicate.title, 'global wins')
  const shared = merged.find((record) => record.sessionId === 'sess-shared')
  assert.equal(shared.turns, 3, 'session rows are upserts: the highest seq wins')
  assert.equal(shared.seq, q[10])
  assert.ok(merged.some((record) => record.sessionId === 'sess-legacy'))

  // A global append invalidates the merged cache and the new record appears.
  await journal.append(entry(GLOBAL_SCOPE_KEY, q[11], 'cnf_after'))
  const after = store.mergedRecords()
  assert.notEqual(after, merged)
  assert.deepEqual(
    after.map((record) => record.seq),
    [q[0], q[1], q[2], q[3], q[5], q[8], q[9], q[10], q[11]],
  )
})

test('UT-STORE-13 legacy journals are read-only: no legacy file is modified, created or deleted', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory(0.61)
  const dirA = await seedLegacyWorkspace(root, WS_A, {
    canonicalPath: PATH_A,
    shards: { '1111-aaaaaaaa': [entry(WS_A, seqs(), 'cnf_legacy_ro_a')] },
  })
  const dirB = await seedLegacyWorkspace(root, WS_B, {
    canonicalPath: PATH_B,
    shards: { '2222-bbbbbbbb': [entry(WS_B, seqs(), 'cnf_legacy_ro_b')] },
  })
  const beforeA = await snapshotFiles(dirA)
  const beforeB = await snapshotFiles(dirB)

  const journal = await store.openGlobal()
  await journal.append(entry(GLOBAL_SCOPE_KEY, seqs(), 'cnf_global_ro'))
  await store.refreshMerged()
  assert.equal(store.legacyWorkspaceMeta().length, 2)
  assert.equal(store.legacyView().records.length, 2)
  assert.equal(store.mergedRecords().length, 3)
  await store.listWorkspaces()

  assert.deepEqual(await snapshotFiles(dirA), beforeA, 'legacy workspace A is byte-identical')
  assert.deepEqual(await snapshotFiles(dirB), beforeB, 'legacy workspace B is byte-identical')
  assert.deepEqual(
    (await readdir(dirA)).sort(),
    ['MANIFEST.v1.json', 'journal.1111-aaaaaaaa.v1.jsonl'],
    'no writer shard/presence directory is added to a legacy workspace',
  )
  assert.ok(!(await readdir(path.join(root, 'workspaces'))).includes('presence'))
})

test('UT-STORE-14 corrupt legacy manifests and journal lines are tolerated, never thrown', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory(0.83)
  const q = Array.from({ length: 8 }, () => seqs())

  const validOne = entry(WS_D, q[1], 'cnf_valid_1')
  const validTwo = entry(WS_D, q[3], 'cnf_valid_2')
  const rawShard = [
    JSON.stringify(validOne),
    'x'.repeat(66000), // over the 64 KiB per-line cap
    '{not json',
    JSON.stringify({ v: 1, type: 'signal', ws: WS_D, seq: q[4], ts: TS }),
    JSON.stringify(entry(WS_A, q[5], 'cnf_wrong_ws')),
    JSON.stringify(validTwo),
    '{"v":1,"type":"entry","id":"cnf_torn', // torn tail, no LF
  ].join('\n')
  await seedLegacyWorkspace(root, WS_D, {
    canonicalPath: PATH_C,
    shards: { '1401-dddddddd': rawShard },
  })
  // Corrupt manifest: the workspace cannot be labelled, so it is skipped.
  await seedLegacyWorkspace(root, WS_C, {
    rawManifest: '{not json',
    shards: { '1402-cccccccc': [entry(WS_C, q[2], 'cnf_corrupt_manifest')] },
  })
  // Shard with no manifest at all.
  await mkdir(path.join(root, 'workspaces', WS_E), { recursive: true })
  await writeFile(
    path.join(root, 'workspaces', WS_E, 'journal.1403-eeeeeeee.v1.jsonl'),
    `${JSON.stringify(entry(WS_E, q[6], 'cnf_no_manifest'))}\n`,
    'utf8',
  )

  assert.doesNotThrow(() => store.legacyWorkspaceMeta())
  const meta = store.legacyWorkspaceMeta()
  assert.deepEqual(meta.map((item) => item.wsKey), [WS_D])
  assert.equal(meta[0].label, 'gamma')

  const legacy = store.legacyView()
  assert.deepEqual(legacy.records.map((record) => record.id), ['cnf_valid_1', 'cnf_valid_2'])
  assert.deepEqual([...legacy.labels.keys()], [WS_D])
  assert.ok(!legacy.records.some((record) => record.id === 'cnf_corrupt_manifest'))
  assert.ok(!legacy.records.some((record) => record.id === 'cnf_no_manifest'))
  assert.ok(!legacy.records.some((record) => record.id === 'cnf_torn'))

  assert.doesNotThrow(() => store.mergedRecords())
  assert.deepEqual(store.mergedRecords().map((record) => record.id), ['cnf_valid_1', 'cnf_valid_2'])
  assert.equal(await store.refreshMerged(), false, 'a corrupt legacy corpus never fails a refresh')
})

// ---------------------------------------------------------------------------
// universal change feed
// ---------------------------------------------------------------------------

test('UT-STORE-15 onMergedChange/refreshMerged follow the global journal across mounts', async () => {
  const root = await tempRoot()
  const one = await newStore({ root, pid: 7001, seed: 0.11, pollMs: 60_000 })
  const two = await newStore({ root, pid: 7002, seed: 0.93, pollMs: 60_000 })
  const seqsOne = seqFactory(0.21)
  const seqsTwo = seqFactory(0.71)

  const changes = []
  const unsubscribe = one.store.onMergedChange((changed) => changes.push(changed))
  assert.equal(typeof unsubscribe, 'function')
  assert.equal(one.store.onMergedChange('not a function')(), undefined, 'a bad listener is a no-op')

  const journalOne = await one.store.openGlobal()
  await journalOne.append(entry(GLOBAL_SCOPE_KEY, seqsOne(), 'cnf_one'))
  assert.deepEqual(changes, [true], 'the subscriber fires on a global append')
  assert.equal(one.store.mergedRecords().filter((record) => record.id === 'cnf_one').length, 1)
  assert.equal(await one.store.refreshMerged(), false, 'nothing changed => false')

  // Another mount (different writer id) appends to the same universal journal.
  const journalTwo = await two.store.openGlobal()
  await journalTwo.append(entry(GLOBAL_SCOPE_KEY, seqsTwo(), 'cnf_two'))
  assert.equal(await one.store.refreshMerged(), true)
  assert.equal(one.store.mergedRecords().filter((record) => record.id === 'cnf_two').length, 1)
  assert.deepEqual(changes, [true, true])

  // Unsubscribed listeners stop receiving the feed.
  unsubscribe()
  await journalTwo.append(entry(GLOBAL_SCOPE_KEY, seqsTwo(), 'cnf_three'))
  assert.equal(await one.store.refreshMerged(), true)
  assert.equal(one.store.mergedRecords().filter((record) => record.id === 'cnf_three').length, 1)
  assert.deepEqual(changes, [true, true], 'the unsubscribed callback is no longer called')
})

// ---------------------------------------------------------------------------
// read-only universal view for export/CLI (no plugin mount)
// ---------------------------------------------------------------------------

test('UT-STORE-17 refreshMerged opens an existing global scope read-only and never creates one', async () => {
  const root = await tempRoot()
  const seeded = await newStore({ root, pid: 6001, seed: 0.31 })
  const seededJournal = await seeded.store.openGlobal()
  await seededJournal.append(entry(GLOBAL_SCOPE_KEY, seqFactory(0.44)(), 'cnf_seeded_global'))
  await seeded.store.close()
  await seedLegacyWorkspace(root, WS_A, {
    canonicalPath: PATH_A,
    shards: { '1701-aaaaaaaa': [entry(WS_A, seqFactory(0.55)(), 'cnf_seeded_legacy')] },
  })
  const before = await snapshotFiles(path.join(root, 'workspaces'))

  const { store } = await newStore({ root, pid: 6002, seed: 0.77, pollMs: 60_000 })
  assert.equal(store.globalJournal(), null, 'not opened by init()')
  assert.equal(await store.refreshMerged(), true, 'the on-disk global journal is opened and merged')
  assert.ok(store.globalJournal() !== null)
  assert.deepEqual(
    store.mergedRecords().map((record) => record.id).sort(),
    ['cnf_seeded_global', 'cnf_seeded_legacy'],
  )
  assert.deepEqual(await snapshotFiles(path.join(root, 'workspaces')), before, 'read-only refresh writes nothing')

  // A profile with legacy journals but no v0.2 global scope is exported without
  // creating the universal scope directory.
  const fresh = await newStore()
  assert.equal(await fresh.store.refreshMerged(), false)
  await assert.rejects(
    () => readdir(path.join(fresh.root, 'workspaces', GLOBAL_SCOPE_KEY)),
    (error) => error && error.code === 'ENOENT',
  )
})

test('UT-STORE-18 a pre-init legacy scan is not cached: init() rebinds the real corpus', async () => {
  const base = await tempRoot()
  const root = path.join(base, 'not-yet-created') // init() owns creating the root
  const config = { store: { ...DEFAULTS.store, dir: root, pollMs: 60_000, watch: false } }
  const store = new JournalStore({
    config,
    deps: { pid: 8001, platform: 'win32', random: seededRandom(0.5), now: () => 1_700_000_000_000, retryDelays: [0, 0, 0] },
  })
  stores.push(store)
  assert.deepEqual(store.mergedRecords(), [], 'no root yet => no legacy records (and no throw)')
  await store.init()
  await seedLegacyWorkspace(root, WS_A, {
    canonicalPath: PATH_A,
    shards: { '1801-aaaaaaaa': [entry(WS_A, seqFactory(0.27)(), 'cnf_late_root')] },
  })
  assert.deepEqual(store.mergedRecords().map((record) => record.id), ['cnf_late_root'])
})

// ---------------------------------------------------------------------------
// root resolution (retained)
// ---------------------------------------------------------------------------

test('UT-STORE-16 root resolution order: config.store.dir, DSH_HOME env, homedir fallback', async () => {
  const home = await tempRoot()
  const envHome = path.join(home, 'env-home')

  const fallback = new JournalStore({
    config: { store: { dir: '' } },
    deps: { env: {}, homedir: () => home, random: seededRandom(0.1), pid: 1 },
  })
  assert.equal(fallback.rootDir, path.join(home, '.dsh', 'storages', 'confluence', 'v1'))

  const fromEnv = new JournalStore({
    config: { store: { dir: '' } },
    deps: {
      env: { DSH_HOME: envHome },
      homedir: () => path.join(home, 'ignored'),
      random: seededRandom(0.1),
      pid: 1,
    },
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
})

test('UT-STORE-19 concurrent openGlobal()/openWorkspace() share one live journal', async () => {
  const { store } = await newStore()
  const [first, second] = await Promise.all([store.openGlobal(), store.openGlobal()])
  assert.equal(first, second, 'concurrent opens must return the same journal instance')
  assert.equal(store.globalJournal(), first)
  assert.deepEqual(store.legacyWorkspaceMeta(), [])
  await store.close()
  assert.equal(first.isOpen, false, 'close() must close the canonical journal')
})