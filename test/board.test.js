// Confluence / 高级记忆 — board unit tests (WP2, owner design-behavior).
//
// v0.2.0 universal memory (ADR-0007 / scope-refactor-delta §3): there is ONE global board per DSH
// profile. These tests pin the scope-less API, the global entry record shape (`ws` =
// GLOBAL_SCOPE_KEY), provenance `origin` (legacy labels, basenames only), the read-only legacy
// merge, global caps, threads/statuses, tombstones, search ranking and redaction.
// Hermetic: fake store/journal seams with the delta §2 surface, no DSH runtime, no disk, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BoardService, GLOBAL_SCOPE_KEY, KINDS, foldRecords } from '../lib/board.js'
import { createRedactor } from '../lib/redact.js'

/** Build a synthetic credential from fragments so the committed source never holds a credential-shaped literal. */
const secret = (...parts) => parts.join('')

const ULID_TIME = '01J8Z6Q3M0'
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Deterministic 26-char Crockford ULID-like sequence value. */
function seqFor(n) {
  let value = Math.max(0, Math.trunc(n))
  let random = ''
  for (let index = 0; index < 16; index += 1) {
    random = CROCKFORD[value % 32] + random
    value = Math.floor(value / 32)
  }
  return ULID_TIME + random
}

/** Reserved universal scope key (delta §0) and two pre-existing v0.1.0 workspace journals. */
const GLOBAL_WS = GLOBAL_SCOPE_KEY
const LEGACY_WS_A = 'ws_1111111111111111'
const LEGACY_WS_B = 'ws_2222222222222222'
const LEGACY_LABELS = new Map([
  [LEGACY_WS_A, 'alpha'],
  [LEGACY_WS_B, 'beta'],
])

function baseConfig(overrides = {}) {
  return {
    store: {
      maxEntriesPerWorkspace: 2000,
      maxBodyBytes: 8192,
      ...(overrides.store ?? {}),
    },
    privacy: {
      redact: true,
      redactTitles: true,
      denyPathPatterns: ['**/.env*', '**/*.pem'],
      privateSessions: [],
      redactPatterns: [],
      ...(overrides.privacy ?? {}),
    },
  }
}

/** @param {Record<string, unknown>} a @param {Record<string, unknown>} b */
function compareSeq(a, b) {
  const seqA = String(a.seq ?? '')
  const seqB = String(b.seq ?? '')
  if (seqA !== seqB) return seqA < seqB ? -1 : 1
  const idA = String(a.id ?? a.sessionId ?? '')
  const idB = String(b.id ?? b.sessionId ?? '')
  return idA === idB ? 0 : idA < idB ? -1 : 1
}

/** @param {Record<string, unknown>} record */
function recordKey(record) {
  if (record.type === 'session') return `session:${String(record.sessionId ?? record.id)}`
  return `${String(record.type)}:${String(record.id)}`
}

/**
 * Fake `JournalStore` + global `WorkspaceJournal` with the delta §2 universal surface:
 * `openGlobal`, `mergedRecords`, `legacyView`, `onMergedChange`, `refreshMerged`, `globalJournal`.
 * Legacy per-workspace journals are a static read-only view with provenance labels.
 *
 * `appended` keeps the *raw* records the board handed to `appendAndSync` (before the journal fills
 * `v`/`ws`/`seq`/`ts`), so record-shape assertions cannot be masked by the fake.
 */
function fakeStore({ legacyRecords = [], legacyLabels = new Map() } = {}) {
  let sequence = 500
  let journal = null
  const legacy = legacyRecords.map((record) => ({ ...record }))
  const labels = new Map(legacyLabels)
  const legacyView = Object.freeze({ records: Object.freeze([...legacy]), labels })
  const mergedListeners = new Set()
  const appended = []
  const counters = { openGlobalCalls: 0, refreshMergedCalls: 0, journalChanges: 0 }
  let merged = Object.freeze([])

  function rebuildMerged() {
    const globalRecords = journal === null ? [] : journal.records()
    // Store contract (delta §2): global records first (first-wins on id), sessions last-wins by seq.
    const byKey = new Map()
    for (const record of [...globalRecords, ...legacy]) {
      const key = recordKey(record)
      const existing = byKey.get(key)
      if (existing === undefined) {
        byKey.set(key, record)
      } else if (record.type === 'session' && String(record.seq) > String(existing.seq)) {
        byKey.set(key, record)
      }
    }
    merged = Object.freeze([...byKey.values()].sort(compareSeq))
  }

  function notifyMerged() {
    for (const listener of [...mergedListeners]) {
      try {
        listener(true)
      } catch {
        // a listener must not break the store
      }
    }
  }

  function createJournal() {
    const records = []
    const listeners = new Set()
    return {
      wsKey: GLOBAL_WS,
      records() {
        return [...records].sort(compareSeq)
      },
      async appendAndSync(record) {
        const raw = { ...record }
        appended.push(raw)
        sequence += 1
        const stored = { ...raw }
        if (stored.v === undefined) stored.v = 1
        if (stored.ws === undefined) stored.ws = GLOBAL_WS
        if (stored.seq === undefined) stored.seq = seqFor(sequence)
        if (stored.ts === undefined) stored.ts = '2026-11-16T00:00:00.000Z'
        records.push(stored)
        counters.journalChanges += 1
        rebuildMerged()
        for (const listener of [...listeners]) listener(true)
        notifyMerged()
        return { ...stored }
      },
      async refresh() {
        return false
      },
      onChange(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
  }

  return {
    appended,
    counters,
    async openGlobal() {
      counters.openGlobalCalls += 1
      if (journal === null) {
        journal = createJournal()
        rebuildMerged()
      }
      return journal
    },
    mergedRecords() {
      return merged
    },
    legacyView() {
      return legacyView
    },
    onMergedChange(listener) {
      mergedListeners.add(listener)
      return () => mergedListeners.delete(listener)
    },
    async refreshMerged() {
      counters.refreshMergedCalls += 1
      rebuildMerged()
      notifyMerged()
      return true
    },
    globalJournal() {
      return journal
    },
    mergedListenerCount() {
      return mergedListeners.size
    },
  }
}

const AUTHOR = { sessionId: 'session-author', title: 'Auth work', origin: 'agent' }

/**
 * @param {{store?: object, config?: object}} [options]
 * @returns {Promise<{board: BoardService, store: ReturnType<typeof fakeStore>, cfg: object}>}
 */
async function makeBoard({ store: storeOptions = {}, config: overrides = {} } = {}) {
  const cfg = baseConfig(overrides)
  const store = fakeStore(storeOptions)
  const board = new BoardService({
    store,
    config: cfg,
    redactor: createRedactor(cfg),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    deps: { now: () => 1700000000000, random: () => 0.5 },
  })
  await board.attach()
  return { board, store, cfg }
}

/** Raw global entry record helper for pure fold tests. */
function entryRecord(n, overrides = {}) {
  return {
    v: 1,
    type: 'entry',
    id: `cnf_${seqFor(1000 + n)}`,
    ws: GLOBAL_WS,
    seq: seqFor(n),
    ts: '2026-11-16T00:00:00.000Z',
    kind: 'finding',
    title: `note ${n}`,
    author: { sessionId: 'session-a', title: 'Auth work', origin: 'agent' },
    ...overrides,
  }
}

/** Pre-v0.2.0 record: written by a per-workspace journal, so `ws` is a real workspace key. */
function legacyEntryRecord(n, ws = LEGACY_WS_A, overrides = {}) {
  return entryRecord(n, { ws, seq: seqFor(2000 + n), ...overrides })
}

function tombstoneRecord(n, target, overrides = {}) {
  return {
    v: 1,
    type: 'tombstone',
    id: `tmb_${seqFor(2000 + n)}`,
    ws: GLOBAL_WS,
    seq: seqFor(n),
    ts: '2026-11-16T00:00:00.000Z',
    target,
    ...overrides,
  }
}

function sessionRecord(n, overrides = {}) {
  return {
    v: 1,
    type: 'session',
    id: 'session-ledger',
    ws: GLOBAL_WS,
    seq: seqFor(n),
    ts: '2026-11-16T00:00:00.000Z',
    sessionId: 'session-ledger',
    status: 'idle',
    turns: n,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// foldRecords — merge, order, derived status, threads, tombstones, provenance
// ---------------------------------------------------------------------------

test('UT-BOARD-00 foldRecords(fold) tolerates junk and never filters on a workspace', () => {
  const globalEntry = entryRecord(5)
  const legacyA = legacyEntryRecord(6, LEGACY_WS_A)
  const legacyB = legacyEntryRecord(7, LEGACY_WS_B)
  const view = foldRecords([
    null,
    undefined,
    42,
    'nope',
    {},
    { v: 2, type: 'entry', id: 'x', ws: GLOBAL_WS, seq: seqFor(9) },
    { v: 1, type: 'signal', id: 'sig_1', ws: GLOBAL_WS, seq: seqFor(8) },
    { v: 1, type: 'entry', id: 'bad-seq', ws: GLOBAL_WS, seq: 'not-a-ulid' },
    globalEntry,
    legacyA,
    legacyB,
  ])
  assert.equal(view.entryCount, 3, 'global and legacy journals fold into the one universal board')
  assert.equal(view.entries.get(globalEntry.id).title, globalEntry.title)
  assert.equal(view.entries.get(legacyA.id).title, legacyA.title)
  assert.equal(view.entries.get(legacyB.id).title, legacyB.title)
  assert.equal(view.maxSeq, [globalEntry.seq, legacyA.seq, legacyB.seq].sort().at(-1))
  assert.deepEqual(foldRecords(undefined).stats, {
    entries: 0,
    openQuestions: 0,
    openHandoffs: 0,
    byKind: {},
  })
})

test('UT-BOARD-01 foldRecords orders by seq, entry first-wins, session last-wins across journals', () => {
  const duplicateLow = entryRecord(1, { title: 'first copy' })
  const duplicateHigh = entryRecord(2, { id: duplicateLow.id, ws: LEGACY_WS_A, title: 'second copy' })
  const older = sessionRecord(3, { title: 'older title', turns: 1 })
  const newer = sessionRecord(4, { ws: LEGACY_WS_B, title: 'newer title', turns: 7 })
  for (const records of [
    [duplicateHigh, newer, duplicateLow, older],
    [older, duplicateLow, duplicateHigh, newer],
  ]) {
    const view = foldRecords(records)
    assert.equal(view.entries.size, 1)
    assert.equal(view.entries.get(duplicateLow.id).title, 'first copy', 'first by seq wins, whatever the journal')
    assert.equal(view.sessions.size, 1)
    assert.equal(view.sessions.get('session-ledger').title, 'newer title', 'last by seq wins across journals')
    assert.equal(view.sessions.get('session-ledger').turns, 7)
  }
})

test('UT-BOARD-02 foldRecords derives active/open/resolved/superseded and open lists', () => {
  const question = entryRecord(10, { kind: 'question', title: 'Which index?' })
  const resolution = entryRecord(11, {
    kind: 'finding',
    title: 'Use rebuild-once',
    replyTo: question.id,
    resolves: true,
  })
  const reopened = entryRecord(12, {
    kind: 'finding',
    title: 'Actually not resolved',
    replyTo: question.id,
    resolves: false,
  })
  const decisionOld = entryRecord(13, { kind: 'decision', title: 'Pin 0.2.x' })
  const decisionNew = entryRecord(14, {
    kind: 'decision',
    title: 'Pin 0.2.y',
    supersedes: decisionOld.id,
  })
  const handoff = entryRecord(15, { kind: 'handoff', title: 'Continue panel' })
  const gotcha = entryRecord(16, { kind: 'gotcha', title: 'EPERM retries' })

  const view = foldRecords([question, resolution, reopened, decisionOld, decisionNew, handoff, gotcha])
  assert.equal(view.entries.get(question.id).status, 'open', 'latest resolves:false reopens')
  assert.equal(view.entries.get(resolution.id).status, 'active')
  assert.equal(view.entries.get(decisionOld.id).status, 'superseded')
  assert.equal(view.entries.get(decisionNew.id).status, 'active')
  assert.equal(view.entries.get(gotcha.id).status, 'active')
  assert.deepEqual(
    view.openQuestions.map((entry) => entry.id),
    [question.id],
  )
  assert.deepEqual(
    view.openHandoffs.map((entry) => entry.id),
    [handoff.id],
  )
  assert.deepEqual(view.questions.map((entry) => entry.id), [question.id])
  assert.deepEqual(view.handoffs.map((entry) => entry.id), [handoff.id])
  assert.deepEqual(view.stats, {
    entries: 7,
    openQuestions: 1,
    openHandoffs: 1,
    byKind: { question: 1, finding: 2, decision: 2, handoff: 1, gotcha: 1 },
  })
  assert.equal(view.roots.length, 5, 'two replies are not roots')
})

test('UT-BOARD-03 foldRecords tombstone hides the entry and cascades to its thread', () => {
  const root = entryRecord(20, { kind: 'question', title: 'Deleted question' })
  const reply = entryRecord(21, { kind: 'finding', title: 'Reply', replyTo: root.id })
  const survivor = entryRecord(22, { kind: 'finding', title: 'Visible note' })
  const tomb = tombstoneRecord(23, root.id)

  const view = foldRecords([root, reply, survivor, tomb])
  assert.equal(view.entries.has(root.id), false)
  assert.equal(view.entries.has(reply.id), false, 'thread cascades')
  assert.equal(view.entries.has(survivor.id), true)
  assert.equal(view.entryCount, 1)
  assert.equal(view.tombstones.has(root.id), true)
  assert.deepEqual(
    view.hiddenEntries.get(root.id)?.title,
    'Deleted question',
    'hidden original kept for the deleted stub only',
  )
})

test('UT-BOARD-03b foldRecords attaches legacy provenance labels (basenames only, ws untouched)', () => {
  const labels = new Map([
    [LEGACY_WS_A, 'alpha'],
    [LEGACY_WS_B, 'D:\\work\\beta'],
  ])
  const newEntry = entryRecord(30, {
    origin: { workspaceKey: LEGACY_WS_A, workspaceLabel: 'alpha' },
  })
  const legacyA = legacyEntryRecord(31, LEGACY_WS_A)
  const legacyB = legacyEntryRecord(32, LEGACY_WS_B)
  const unknownLegacy = entryRecord(33, { ws: 'ws_3333333333333333', seq: seqFor(2100) })
  const noOriginGlobal = entryRecord(34)
  const filled = legacyEntryRecord(35, LEGACY_WS_A, { origin: { workspaceKey: LEGACY_WS_A } })
  const hostile = legacyEntryRecord(36, LEGACY_WS_A, {
    origin: { workspaceKey: '../../evil', workspaceLabel: 'C:\\Users\\me\\project' },
  })

  const view = foldRecords(
    [newEntry, legacyA, legacyB, unknownLegacy, noOriginGlobal, filled, hostile],
    labels,
  )
  assert.deepEqual(view.entries.get(newEntry.id).origin, {
    workspaceKey: LEGACY_WS_A,
    workspaceLabel: 'alpha',
  })
  assert.deepEqual(view.entries.get(legacyA.id).origin, {
    workspaceKey: LEGACY_WS_A,
    workspaceLabel: 'alpha',
  })
  assert.equal(view.entries.get(legacyA.id).ws, LEGACY_WS_A, 'legacy records keep their original ws')
  assert.deepEqual(
    view.entries.get(legacyB.id).origin,
    { workspaceKey: LEGACY_WS_B, workspaceLabel: 'beta' },
    'an absolute label is reduced to its basename',
  )
  assert.equal(view.entries.get(unknownLegacy.id).origin, undefined, 'no label -> no origin block')
  assert.equal(view.entries.get(noOriginGlobal.id).origin, undefined, 'global entries derive no provenance')
  assert.equal(view.entries.get(filled.id).origin.workspaceLabel, 'alpha', 'missing legacy label is filled in')
  assert.deepEqual(
    view.entries.get(hostile.id).origin,
    { workspaceLabel: 'project' },
    'invalid workspace key dropped and path reduced to a basename',
  )
  for (const entry of view.entries.values()) {
    if (entry.origin === undefined) continue
    assert.ok(!/[\\/]/.test(String(entry.origin.workspaceLabel ?? '')), 'never a raw path')
  }
  assert.equal(foldRecords([legacyA]).entries.get(legacyA.id).origin, undefined, 'best-effort without labels')
})

// ---------------------------------------------------------------------------
// BoardService — scope-less API, global record shape, caps, threads, search
// ---------------------------------------------------------------------------

test('UT-BOARD-04 every kind posts to the global board with provenance origin and the v1 shape', async () => {
  const { board, store } = await makeBoard()
  const origin = { workspaceKey: LEGACY_WS_A, workspaceLabel: 'alpha' }
  let last
  for (const kind of KINDS) {
    last = await board.post({ kind, title: `note ${kind}`, body: 'body' }, AUTHOR, origin)
    assert.equal(last.kind, kind)
    assert.equal(last.status, kind === 'question' || kind === 'handoff' ? 'open' : 'active')
    assert.equal(typeof last.id, 'string')
    assert.ok(last.id.startsWith('cnf_'))
    assert.equal(last.seq.length, 26)
  }
  const raw = store.appended.at(-1)
  assert.equal(raw.v, 1)
  assert.equal(raw.type, 'entry')
  assert.equal(raw.ws, GLOBAL_SCOPE_KEY, 'entry records use the reserved global scope key')
  assert.equal(raw.ws, 'ws_0000000000000000')
  assert.deepEqual(raw.origin, origin, 'provenance comes from the caller argument')
  assert.equal(raw.author.sessionId, AUTHOR.sessionId)
  assert.equal(raw.author.origin, 'agent')
  assert.equal('replyTo' in raw, false)
  assert.equal('resolves' in raw, false)

  const stored = store.globalJournal().records().find((record) => record.id === raw.id)
  assert.equal(stored.seq, last.seq)
  assert.ok(stored.ts.length > 0)
  assert.equal(board.view().entries.get(raw.id).origin.workspaceLabel, 'alpha')

  const plain = await board.post({ kind: 'finding', title: 'plain' }, AUTHOR)
  assert.equal('origin' in store.appended.at(-1), false, 'provenance is optional')
  assert.equal('origin' in board.view().entries.get(plain.id), false)

  await assert.rejects(
    board.post({ kind: 'note', title: 'x' }, AUTHOR),
    (error) => error.code === 'BAD_ARGUMENT',
  )
})

test('UT-BOARD-05 title/body bounds are enforced (reject or cap, never a silent wrong value)', async () => {
  const { board, store } = await makeBoard()
  await assert.rejects(board.post({ kind: 'finding', title: '   ' }, AUTHOR), (e) => e.code === 'BAD_ARGUMENT')
  await assert.rejects(board.post({ kind: 'finding' }, AUTHOR), (e) => e.code === 'BAD_ARGUMENT')

  const longTitle = 'x'.repeat(300)
  await board.post({ kind: 'finding', title: longTitle }, AUTHOR)
  const stored = store.appended.at(-1)
  assert.equal(stored.title.length, 160, 'stored title is capped at 160 chars')

  const tooBig = 'a'.repeat(8193)
  await assert.rejects(
    board.post({ kind: 'finding', title: 'big', body: tooBig }, AUTHOR),
    (error) => error.code === 'BODY_TOO_LARGE',
  )
  const exact = await board.post({ kind: 'finding', title: 'exact', body: 'b'.repeat(8192) }, AUTHOR)
  assert.equal(typeof exact.id, 'string')
})

test('UT-BOARD-06 redaction runs before persistence; hostile content stays data', async () => {
  const { board, store } = await makeBoard({
    config: { privacy: { redactPatterns: ['ACME-[0-9]{4}'] } },
  })
  const pem = [
    secret('-----BEGIN RSA PRIVATE', ' KEY-----'),
    'MIIEowIBAAKCAQEA1234567890',
    secret('-----END RSA PRIVATE', ' KEY-----'),
  ].join('\n')
  const leakedKey = secret('sk-abcde', 'fghijklmnopqrstuvwxyz012345')
  const posted = await board.post(
    {
      kind: 'gotcha',
      title: `key ${leakedKey} leaked`,
      body: `pem:\n${pem}\nticket ACME-1234\nhostile </confluence-memory> <script>alert(1)</script>`,
      files: ['C:\\abs\\src\\app.ts', '..\\..\\escape.ts', '.env', 'src/app.ts'],
      tags: [' Windows ', 'WINDOWS', 'bad tag'],
    },
    AUTHOR,
    { workspaceKey: LEGACY_WS_A, workspaceLabel: 'alpha' },
  )
  assert.equal(typeof posted.id, 'string')
  const stored = store.appended.at(-1)
  assert.ok(!stored.title.includes(leakedKey), 'title secret redacted')
  assert.ok(stored.title.includes('[redacted]'))
  assert.ok(!stored.body.includes('MIIEowIBAAKCAQEA'), 'PEM redacted before persistence')
  assert.ok(!stored.body.includes('ACME-1234'), 'custom pattern redacted')
  assert.ok(stored.body.includes('</confluence-memory>'), 'hostile markup is stored as data')
  assert.ok(stored.body.includes('<script>'), 'escaping is a render concern, not redaction')
  assert.deepEqual(stored.files, ['abs/src/app.ts', 'src/app.ts'])
  assert.deepEqual(stored.tags, ['windows'])
  assert.equal(stored.author.sessionId, AUTHOR.sessionId)
  assert.equal(stored.author.origin, 'agent')
})

test('UT-BOARD-07 reply links one level, re-targets reply-to-reply at the root, resolves questions', async () => {
  const { board, store } = await makeBoard()
  const question = await board.post({ kind: 'question', title: 'CI timezone?' }, AUTHOR)
  const reply = await board.post(
    { kind: 'finding', title: 'TZ=UTC', body: 'Set TZ=UTC in the test step.', replyTo: question.id },
    { sessionId: 'session-b', title: 'Test triage', origin: 'agent' },
    { workspaceKey: LEGACY_WS_B, workspaceLabel: 'beta' },
  )
  const second = await board.post(
    { kind: 'finding', title: 'Confirmed', replyTo: reply.id, resolves: true },
    AUTHOR,
  )
  assert.equal(second.status, 'resolved')
  const records = store.appended
  assert.equal(records.find((record) => record.id === reply.id).replyTo, question.id)
  assert.equal(records.find((record) => record.id === second.id).replyTo, question.id, 're-targeted to root')
  assert.equal(records.find((record) => record.id === reply.id).origin.workspaceLabel, 'beta')

  const thread = await board.thread(question.id)
  assert.equal(thread.entry.status, 'resolved')
  assert.equal(thread.resolved, true)
  assert.deepEqual(
    thread.replies.map((note) => note.id),
    [reply.id, second.id],
    'replies render in seq order',
  )

  // Re-open is append-only and wins by seq.
  await board.post({ kind: 'finding', title: 'Wrong, reopened', replyTo: question.id, resolves: false }, AUTHOR)
  const reopenedThread = await board.thread(question.id)
  assert.equal(reopenedThread.entry.status, 'open')
  assert.equal(reopenedThread.resolved, false)

  await assert.rejects(
    board.post({ kind: 'finding', title: 'bad', replyTo: 'cnf_nope' }, AUTHOR),
    (error) => error.code === 'UNKNOWN_REF',
  )
  await assert.rejects(
    board.post({ kind: 'finding', title: 'bad', resolves: true }, AUTHOR),
    (error) => error.code === 'BAD_ARGUMENT',
  )
})

test('UT-BOARD-07b resolves is rejected on non-question/handoff roots; supersedes marks the target', async () => {
  const { board } = await makeBoard()
  const finding = await board.post({ kind: 'finding', title: 'A finding' }, AUTHOR)
  await assert.rejects(
    board.post({ kind: 'finding', title: 'reply', replyTo: finding.id, resolves: true }, AUTHOR),
    (error) => error.code === 'BAD_ARGUMENT',
  )
  const replacement = await board.post(
    { kind: 'decision', title: 'Replacement decision', supersedes: finding.id },
    AUTHOR,
  )
  assert.equal(replacement.status, 'active')
  const thread = await board.thread(finding.id)
  assert.equal(thread.superseded, true)
  await assert.rejects(
    board.post({ kind: 'decision', title: 'bad', supersedes: 'cnf_nope' }, AUTHOR),
    (error) => error.code === 'UNKNOWN_REF',
  )
})

test('UT-BOARD-08 thread returns a content-free deleted stub for a tombstoned note', async () => {
  const { board, store } = await makeBoard()
  const posted = await board.post({ kind: 'gotcha', title: 'Will be removed', body: 'secret body' }, AUTHOR)
  // No delete tool exists; append a tombstone through the global journal to exercise the reader.
  await store.globalJournal().appendAndSync({
    v: 1,
    type: 'tombstone',
    id: `tmb_${seqFor(999)}`,
    ws: GLOBAL_SCOPE_KEY,
    ts: '2026-11-16T00:00:00.000Z',
    target: posted.id,
  })
  const thread = await board.thread(posted.id)
  assert.equal(thread.notFound, false)
  assert.equal(thread.entry.deleted, true)
  assert.equal(thread.entry.id, posted.id)
  assert.equal('title' in thread.entry, false, 'deleted stub has no content')
  assert.equal('body' in thread.entry, false)
  assert.deepEqual(thread.replies, [])

  const missing = await board.thread('cnf_missing')
  assert.equal(missing.notFound, true)
  assert.equal(missing.entry, null)
})

test('UT-BOARD-09 search ranks title > tag > body, filters, snippets and truncation', async () => {
  const { board } = await makeBoard()
  const titleMatch = await board.post({ kind: 'decision', title: 'Windows rename retries', body: 'x' }, AUTHOR)
  const tagMatch = await board.post(
    { kind: 'gotcha', title: 'Other trap', body: 'unrelated', tags: ['windows'] },
    AUTHOR,
  )
  const bodyMatch = await board.post(
    { kind: 'finding', title: 'Something else', body: `${'y'.repeat(300)} windows ${'z'.repeat(300)}` },
    AUTHOR,
  )
  const supersededTitle = await board.post({ kind: 'decision', title: 'Windows decision old' }, AUTHOR)
  const newDecision = await board.post(
    { kind: 'decision', title: 'Windows decision new', supersedes: supersededTitle.id },
    AUTHOR,
  )

  const all = await board.search({ query: 'WINDOWS' })
  assert.equal(all.truncated, false)
  assert.equal(all.hits.length, 5)
  const rankedIds = all.hits.map((hit) => hit.entry.id)
  assert.ok(rankedIds.includes(titleMatch.id))
  assert.ok(rankedIds.includes(newDecision.id))
  assert.ok(
    Math.max(rankedIds.indexOf(titleMatch.id), rankedIds.indexOf(newDecision.id)) <
      rankedIds.indexOf(tagMatch.id),
    'title weight 3 beats tag/body',
  )
  assert.ok(
    rankedIds.indexOf(supersededTitle.id) < rankedIds.indexOf(tagMatch.id),
    'superseded title (rank 2.5) still beats a tag-only match',
  )
  assert.ok(rankedIds.indexOf(tagMatch.id) < rankedIds.indexOf(bodyMatch.id), 'tag weight 2 beats body 1')
  for (const hit of all.hits) {
    assert.ok([...hit.snippet].length <= 200, 'snippet ≤ 200 chars')
    assert.ok(hit.score > 0)
  }

  const limited = await board.search({ query: 'windows', limit: 2 })
  assert.equal(limited.hits.length, 2)
  assert.equal(limited.truncated, true)

  const byKind = await board.search({ query: 'windows', kind: 'gotcha' })
  assert.deepEqual(
    byKind.hits.map((hit) => hit.entry.id),
    [tagMatch.id],
  )
  const byTag = await board.search({ query: 'windows', tag: 'WINDOWS' })
  assert.deepEqual(
    byTag.hits.map((hit) => hit.entry.id),
    [tagMatch.id],
  )
  await assert.rejects(board.search({ query: '   ' }), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(board.search({ query: 'x', kind: 'nope' }), (error) => error.code === 'BAD_ARGUMENT')
})

test('UT-BOARD-10 the global cap counts legacy entries and blocks the next global post', async () => {
  const legacyRecords = [
    legacyEntryRecord(40, LEGACY_WS_A, { title: 'old a' }),
    legacyEntryRecord(41, LEGACY_WS_B, { title: 'old b' }),
  ]
  const { board } = await makeBoard({
    store: { legacyRecords, legacyLabels: LEGACY_LABELS },
    config: { store: { maxEntriesPerWorkspace: 3 } },
  })
  assert.equal(board.stats().entries, 2, 'legacy entries are part of the universal board')
  await board.post({ kind: 'finding', title: 'new one' }, AUTHOR)
  await assert.rejects(
    board.post({ kind: 'finding', title: 'overflow' }, AUTHOR),
    (error) => error.code === 'BOARD_FULL' && /shared memory/.test(error.message),
  )
  assert.equal(board.stats().entries, 3)
})

test('UT-BOARD-11 attach() is scope-less and idempotent; post needs attach; refresh rescans', async () => {
  const cfg = baseConfig()
  const store = fakeStore()
  const board = new BoardService({
    store,
    config: cfg,
    redactor: createRedactor(cfg),
    deps: { now: () => 1700000000000, random: () => 0.5 },
  })
  await assert.rejects(
    board.post({ kind: 'finding', title: 'x' }, AUTHOR),
    (error) => error.code === 'STORE_UNAVAILABLE',
  )
  assert.equal(board.view().entryCount, 0, 'an unattached view is safely empty')
  await Promise.all([board.attach(), board.attach()])
  await board.attach()
  assert.equal(store.counters.openGlobalCalls, 1, 'one global journal per mount')
  assert.equal(store.counters.refreshMergedCalls, 1, 'attach performs the first merged scan')
  assert.equal(board.globalJournal(), store.globalJournal())
  assert.equal(typeof board.journalFor, 'undefined', 'no workspace-key accessor survives')

  await board.post({ kind: 'finding', title: 'x' }, AUTHOR)
  assert.equal(board.view().entryCount, 1)
  await board.refresh()
  assert.equal(store.counters.refreshMergedCalls, 2)
  assert.equal(board.view().entryCount, 1, 'refresh keeps the same records')

  const unsupported = new BoardService({ store: {}, config: cfg, redactor: createRedactor(cfg) })
  await assert.rejects(unsupported.attach(), (error) => error.code === 'STORE_UNAVAILABLE')
})

test('UT-BOARD-12 append-only; author is caller-supplied; origin cannot spoof a path or key', async () => {
  const { board, store } = await makeBoard()
  const first = await board.post({ kind: 'finding', title: 'one', body: 'immutable' }, AUTHOR)
  const countBefore = store.appended.length
  await board.post({ kind: 'finding', title: 'two' }, AUTHOR)
  assert.equal(store.appended.length, countBefore + 1, 'one append per post')
  assert.equal(store.globalJournal().records().find((record) => record.id === first.id).body, 'immutable')

  const spoof = await board.post(
    { kind: 'finding', title: 'spoof', files: ['session-victim/author'] },
    { sessionId: 'session-attacker', title: 'Attacker', origin: 'user' },
    { workspaceKey: '../../etc/passwd', workspaceLabel: 'C:\\Users\\me\\secret project' },
  )
  const raw = store.appended.at(-1)
  assert.equal(raw.author.sessionId, 'session-attacker')
  assert.equal(raw.author.origin, 'user')
  assert.deepEqual(raw.files, ['session-victim/author'])
  assert.deepEqual(raw.origin, { workspaceLabel: 'secret project' }, 'invalid key dropped, label basename only')
  assert.equal(raw.origin.workspaceLabel.includes('\\'), false)
  assert.equal(board.view().entries.get(spoof.id).origin.workspaceLabel, 'secret project')

  const keyOnly = await board.post(
    { kind: 'finding', title: 'key only' },
    AUTHOR,
    { workspaceKey: LEGACY_WS_A },
  )
  assert.deepEqual(store.appended.at(-1).origin, { workspaceKey: LEGACY_WS_A })
  assert.equal('workspaceLabel' in board.view().entries.get(keyOnly.id).origin, false)
})

test('UT-BOARD-13 stats/view expose deterministic counts from the universal fold', async () => {
  const { board } = await makeBoard()
  const question = await board.post({ kind: 'question', title: 'q1' }, AUTHOR)
  await board.post({ kind: 'handoff', title: 'h1' }, AUTHOR)
  await board.post({ kind: 'finding', title: 'f1' }, AUTHOR)
  await board.post({ kind: 'finding', title: 'answer', replyTo: question.id, resolves: true }, AUTHOR)
  const stats = board.stats()
  assert.equal(stats.entries, 4)
  assert.equal(stats.openQuestions, 0)
  assert.equal(stats.openHandoffs, 1)
  assert.deepEqual(stats.byKind, { question: 1, handoff: 1, finding: 2 })
  const view = board.view()
  assert.equal(view.entryCount, 4)
  assert.equal(view.roots.length, 3)
  assert.equal(view.maxSeq, view.entries.get([...view.entries.keys()].at(-1)).seq)
  assert.equal(board.view(), view, 'an unchanged store returns the cached fold')
})

test('UT-BOARD-14 two origins fold into one global board; another session posts without a refresh', async () => {
  const legacyRecords = [
    legacyEntryRecord(50, LEGACY_WS_A, { title: 'Windows rename retries', tags: ['windows'] }),
    legacyEntryRecord(51, LEGACY_WS_A, { kind: 'question', title: 'CI timezone?' }),
  ]
  const { board, store } = await makeBoard({
    store: { legacyRecords, legacyLabels: LEGACY_LABELS },
  })
  const posted = await board.post(
    { kind: 'finding', title: 'Windows scanner holds the handle', body: 'retry with backoff' },
    AUTHOR,
    { workspaceKey: LEGACY_WS_B, workspaceLabel: 'beta' },
  )
  const view = board.view()
  assert.equal(view.entryCount, 3, 'legacy journals merge into the single universal board')
  assert.equal(view.entries.get(legacyRecords[0].id).origin.workspaceLabel, 'alpha')
  assert.equal(view.entries.get(posted.id).origin.workspaceLabel, 'beta')
  assert.deepEqual(view.stats.byKind, { finding: 2, question: 1 })
  assert.deepEqual(
    view.openQuestions.map((entry) => entry.id),
    [legacyRecords[1].id],
  )
  assert.ok(store.mergedListenerCount() >= 1, 'the board subscribes to merged changes')

  const hits = await board.search({ query: 'windows' })
  assert.deepEqual(
    new Set(hits.hits.map((hit) => hit.entry.id)),
    new Set([legacyRecords[0].id, posted.id]),
    'search covers every journal, not just this session’s workspace',
  )

  // A note written by another session/writer appears through the change feed, no caller argument.
  const otherId = `cnf_${seqFor(777)}`
  await store.globalJournal().appendAndSync({
    v: 1,
    type: 'entry',
    id: otherId,
    ws: GLOBAL_SCOPE_KEY,
    ts: '2026-11-16T00:00:05.000Z',
    kind: 'decision',
    title: 'Pinned 0.2.0',
    author: { sessionId: 'session-other', title: 'Other work', origin: 'agent' },
    origin: { workspaceKey: LEGACY_WS_B, workspaceLabel: 'beta' },
  })
  const refreshed = board.view()
  assert.equal(refreshed.entries.size, 4, 'a merged change invalidates the derived cache')
  assert.equal(refreshed.entries.get(otherId).title, 'Pinned 0.2.0')
})

test('UT-BOARD-15 a journal-only store surface still folds (transitional fallback)', async () => {
  const records = []
  let sequence = 0
  const journal = {
    records() {
      return records.slice()
    },
    async appendAndSync(record) {
      sequence += 1
      const stored = { v: 1, ws: GLOBAL_SCOPE_KEY, seq: seqFor(sequence), ts: '2026-11-16T00:00:00.000Z', ...record }
      records.push(stored)
      return { ...stored }
    },
  }
  const store = {
    async openGlobal() {
      return journal
    },
  }
  const cfg = baseConfig()
  const board = new BoardService({ store, config: cfg, redactor: createRedactor(cfg) })
  await board.attach()
  assert.equal(board.globalJournal(), journal)
  const posted = await board.post({ kind: 'finding', title: 'fallback works' }, AUTHOR)
  assert.equal(board.stats().entries, 1)
  assert.equal(board.view().entries.get(posted.id).title, 'fallback works')
  await board.refresh()
  assert.equal(board.view().entryCount, 1)
})
