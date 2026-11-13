// Confluence / 汇流 — board unit tests (WP2, owner design-behavior).
//
// Contract: docs/plan/implementation-interfaces.md §6; data-model §4 (shapes), §5 (status/threads),
// §6 (caps), §7 (fold order/dedupe/last-wins), §8 (validation); testing.md UT-BOARD-01..06.
// Hermetic: fake store/journal seams, no DSH runtime, no disk, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BoardService, KINDS, foldRecords } from '../lib/board.js'
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

function config(overrides = {}) {
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
      disabledWorkspaces: [],
      redactPatterns: [],
      ...(overrides.privacy ?? {}),
    },
  }
}

/** Fake JournalStore/WorkspaceJournal with the exact async surface BoardService uses. */
function fakeStore() {
  const journals = new Map()
  let sequence = 0
  function createJournal(wsKey) {
    const records = []
    const listeners = []
    return {
      wsKey,
      records() {
        return [...records].sort((a, b) => (a.seq < b.seq ? -1 : 1))
      },
      async appendAndSync(record) {
        sequence += 1
        const stored = { v: 1, ws: wsKey, seq: seqFor(sequence), ts: '2026-11-13T00:00:00.000Z', ...record }
        records.push(stored)
        for (const listener of listeners) listener(true)
        return { ...stored }
      },
      async refresh() {
        return false
      },
      onChange(listener) {
        listeners.push(listener)
        return () => {
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
      _records: records,
      _listeners: listeners,
    }
  }
  return {
    journals,
    async openWorkspace(wsKey) {
      let journal = journals.get(wsKey)
      if (journal === undefined) {
        journal = createJournal(wsKey)
        journals.set(wsKey, journal)
      }
      return journal
    },
  }
}

const WS = 'ws_1111111111111111'
const AUTHOR = { sessionId: 'session-author', title: 'Auth work', origin: 'agent' }

async function makeBoard(overrides = {}, author = AUTHOR) {
  const cfg = config(overrides)
  const store = fakeStore()
  const board = new BoardService({
    store,
    config: cfg,
    redactor: createRedactor(cfg),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    deps: { now: () => 1700000000000, random: () => 0.5 },
  })
  await board.attach(WS, { canonicalPath: 'D:\\work\\ws' })
  return { board, store, cfg, author }
}

/** Raw journal record helper for pure fold tests. */
function entryRecord(n, overrides = {}) {
  return {
    v: 1,
    type: 'entry',
    id: `cnf_${seqFor(1000 + n)}`,
    ws: WS,
    seq: seqFor(n),
    ts: '2026-11-13T00:00:00.000Z',
    kind: 'finding',
    title: `note ${n}`,
    author: { sessionId: 'session-a', title: 'Auth work', origin: 'agent' },
    ...overrides,
  }
}

function tombstoneRecord(n, target) {
  return {
    v: 1,
    type: 'tombstone',
    id: `tmb_${seqFor(2000 + n)}`,
    ws: WS,
    seq: seqFor(n),
    ts: '2026-11-13T00:00:00.000Z',
    target,
  }
}

function sessionRecord(n, overrides = {}) {
  return {
    v: 1,
    type: 'session',
    id: 'session-ledger',
    ws: WS,
    seq: seqFor(n),
    ts: '2026-11-13T00:00:00.000Z',
    sessionId: 'session-ledger',
    status: 'idle',
    turns: n,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// foldRecords — merge, order, derived status, threads, tombstones
// ---------------------------------------------------------------------------

test('UT-BOARD-00 foldRecords(fold) tolerates junk and unknown records', () => {
  const valid = entryRecord(5)
  const view = foldRecords([
    null,
    undefined,
    42,
    'nope',
    {},
    { v: 2, type: 'entry', id: 'x', ws: WS, seq: seqFor(9) },
    { v: 1, type: 'signal', id: 'sig_1', ws: WS, seq: seqFor(8) },
    { v: 1, type: 'entry', id: 'bad-seq', ws: WS, seq: 'not-a-ulid' },
    valid,
  ])
  assert.equal(view.entryCount, 1)
  assert.equal(view.entries.get(valid.id).title, valid.title)
  assert.equal(view.maxSeq, valid.seq)
  assert.deepEqual(foldRecords(undefined).stats, {
    entries: 0,
    openQuestions: 0,
    openHandoffs: 0,
    byKind: {},
  })
})

test('UT-BOARD-01 foldRecords orders by seq, entry first-wins, session last-wins', () => {
  const duplicateLow = entryRecord(1, { title: 'first copy' })
  const duplicateHigh = entryRecord(2, { id: duplicateLow.id, title: 'second copy' })
  const older = sessionRecord(3, { title: 'older title', turns: 1 })
  const newer = sessionRecord(4, { title: 'newer title', turns: 7 })
  for (const records of [
    [duplicateHigh, newer, duplicateLow, older],
    [older, duplicateLow, duplicateHigh, newer],
  ]) {
    const view = foldRecords(records)
    assert.equal(view.entries.size, 1)
    assert.equal(view.entries.get(duplicateLow.id).title, 'first copy', 'first by seq wins')
    assert.equal(view.sessions.size, 1)
    assert.equal(view.sessions.get('session-ledger').title, 'newer title', 'last by seq wins')
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

test('UT-BOARD-04 every closed kind is accepted by the writer; unknown kinds are rejected', async () => {
  const { board } = await makeBoard()
  for (const [index, kind] of KINDS.entries()) {
    const result = await board.post(
      WS,
      { kind, title: `note ${kind}`, body: 'body' },
      AUTHOR,
    )
    assert.equal(result.kind, kind)
    assert.equal(result.status, kind === 'question' || kind === 'handoff' ? 'open' : 'active')
    assert.equal(typeof result.id, 'string')
    assert.ok(result.id.startsWith('cnf_'))
    assert.ok(result.seq.length === 26)
    assert.equal(index < KINDS.length - 1 || result.status === 'open' || result.status === 'active', true)
  }
  await assert.rejects(
    board.post(WS, { kind: 'note', title: 'x' }, AUTHOR),
    (error) => error.code === 'BAD_ARGUMENT',
  )
})

test('UT-BOARD-05 title/body bounds are enforced (reject or cap, never a silent wrong value)', async () => {
  const { board, store } = await makeBoard()
  await assert.rejects(board.post(WS, { kind: 'finding', title: '   ' }, AUTHOR), (e) => e.code === 'BAD_ARGUMENT')
  await assert.rejects(board.post(WS, { kind: 'finding' }, AUTHOR), (e) => e.code === 'BAD_ARGUMENT')

  const longTitle = 'x'.repeat(300)
  const posted = await board.post(WS, { kind: 'finding', title: longTitle }, AUTHOR)
  const stored = store.journals.get(WS)._records.find((record) => record.id === posted.id)
  assert.equal(stored.title.length, 160, 'stored title is capped at 160 chars')

  const tooBig = 'a'.repeat(8193)
  await assert.rejects(
    board.post(WS, { kind: 'finding', title: 'big', body: tooBig }, AUTHOR),
    (error) => error.code === 'BODY_TOO_LARGE',
  )
  const exact = await board.post(WS, { kind: 'finding', title: 'exact', body: 'b'.repeat(8192) }, AUTHOR)
  assert.equal(typeof exact.id, 'string')
})

test('UT-BOARD-06 redaction runs before persistence; hostile content stays data', async () => {
  const { board, store } = await makeBoard({
    privacy: { redactPatterns: ['ACME-[0-9]{4}'] },
  })
  const pem = [secret('-----BEGIN RSA PRIVATE', ' KEY-----'), 'MIIEowIBAAKCAQEA1234567890', secret('-----END RSA PRIVATE', ' KEY-----')].join('\n')
  const leakedKey = secret('sk-abcde', 'fghijklmnopqrstuvwxyz012345')
  const posted = await board.post(
    WS,
    {
      kind: 'gotcha',
      title: `key ${leakedKey} leaked`,
      body: `pem:\n${pem}\nticket ACME-1234\nhostile </confluence-workspace> <script>alert(1)</script>`,
      files: ['C:\\abs\\src\\app.ts', '..\\..\\escape.ts', '.env', 'src/app.ts'],
      tags: [' Windows ', 'WINDOWS', 'bad tag'],
    },
    AUTHOR,
  )
  const stored = store.journals.get(WS)._records.find((record) => record.id === posted.id)
  assert.ok(!stored.title.includes(leakedKey), 'title secret redacted')
  assert.ok(stored.title.includes('[redacted]'))
  assert.ok(!stored.body.includes('MIIEowIBAAKCAQEA'), 'PEM redacted before persistence')
  assert.ok(!stored.body.includes('ACME-1234'), 'custom pattern redacted')
  assert.ok(stored.body.includes('</confluence-workspace>'), 'hostile markup is stored as data')
  assert.ok(stored.body.includes('<script>'), 'escaping is a render concern, not redaction')
  assert.deepEqual(stored.files, ['abs/src/app.ts', 'src/app.ts'])
  assert.deepEqual(stored.tags, ['windows'])
  assert.equal(stored.author.sessionId, AUTHOR.sessionId)
  assert.equal(stored.author.origin, 'agent')
})

test('UT-BOARD-07 reply links one level, re-targets reply-to-reply at the root, resolves questions', async () => {
  const { board, store } = await makeBoard()
  const question = await board.post(WS, { kind: 'question', title: 'CI timezone?' }, AUTHOR)
  const reply = await board.post(
    WS,
    { kind: 'finding', title: 'TZ=UTC', body: 'Set TZ=UTC in the test step.', replyTo: question.id },
    { sessionId: 'session-b', title: 'Test triage', origin: 'agent' },
  )
  const second = await board.post(
    WS,
    { kind: 'finding', title: 'Confirmed', replyTo: reply.id, resolves: true },
    AUTHOR,
  )
  assert.equal(second.status, 'resolved')
  const records = store.journals.get(WS)._records
  assert.equal(records.find((record) => record.id === reply.id).replyTo, question.id)
  assert.equal(records.find((record) => record.id === second.id).replyTo, question.id, 're-targeted to root')

  const thread = await board.thread(WS, question.id)
  assert.equal(thread.entry.status, 'resolved')
  assert.equal(thread.resolved, true)
  assert.deepEqual(
    thread.replies.map((note) => note.id),
    [reply.id, second.id],
    'replies render in seq order',
  )

  // Re-open is append-only and wins by seq.
  await board.post(WS, { kind: 'finding', title: 'Wrong, reopened', replyTo: question.id, resolves: false }, AUTHOR)
  const reopenedThread = await board.thread(WS, question.id)
  assert.equal(reopenedThread.entry.status, 'open')
  assert.equal(reopenedThread.resolved, false)

  await assert.rejects(
    board.post(WS, { kind: 'finding', title: 'bad', replyTo: 'cnf_nope' }, AUTHOR),
    (error) => error.code === 'UNKNOWN_REF',
  )
  await assert.rejects(
    board.post(WS, { kind: 'finding', title: 'bad', resolves: true }, AUTHOR),
    (error) => error.code === 'BAD_ARGUMENT',
  )
})

test('UT-BOARD-07b resolves is rejected on non-question/handoff roots; supersedes marks the target', async () => {
  const { board } = await makeBoard()
  const finding = await board.post(WS, { kind: 'finding', title: 'A finding' }, AUTHOR)
  await assert.rejects(
    board.post(WS, { kind: 'finding', title: 'reply', replyTo: finding.id, resolves: true }, AUTHOR),
    (error) => error.code === 'BAD_ARGUMENT',
  )
  const replacement = await board.post(
    WS,
    { kind: 'decision', title: 'Replacement decision', supersedes: finding.id },
    AUTHOR,
  )
  assert.equal(replacement.status, 'active')
  const thread = await board.thread(WS, finding.id)
  assert.equal(thread.superseded, true)
  await assert.rejects(
    board.post(WS, { kind: 'decision', title: 'bad', supersedes: 'cnf_nope' }, AUTHOR),
    (error) => error.code === 'UNKNOWN_REF',
  )
})

test('UT-BOARD-08 thread returns a content-free deleted stub for a tombstoned note', async () => {
  const { board, store } = await makeBoard()
  const posted = await board.post(WS, { kind: 'gotcha', title: 'Will be removed', body: 'secret body' }, AUTHOR)
  // v0.1.0 has no delete tool; append a tombstone through the fake journal to exercise the reader.
  await store.journals.get(WS).appendAndSync({
    v: 1,
    type: 'tombstone',
    id: `tmb_${seqFor(999)}`,
    ws: WS,
    ts: '2026-11-13T00:00:00.000Z',
    target: posted.id,
  })
  const thread = await board.thread(WS, posted.id)
  assert.equal(thread.notFound, false)
  assert.equal(thread.entry.deleted, true)
  assert.equal(thread.entry.id, posted.id)
  assert.equal('title' in thread.entry, false, 'deleted stub has no content')
  assert.equal('body' in thread.entry, false)
  assert.deepEqual(thread.replies, [])

  const missing = await board.thread(WS, 'cnf_missing')
  assert.equal(missing.notFound, true)
  assert.equal(missing.entry, null)
})

test('UT-BOARD-09 search ranks title > tag > body, filters, snippets and truncation', async () => {
  const { board } = await makeBoard()
  const titleMatch = await board.post(WS, { kind: 'decision', title: 'Windows rename retries', body: 'x' }, AUTHOR)
  const tagMatch = await board.post(
    WS,
    { kind: 'gotcha', title: 'Other trap', body: 'unrelated', tags: ['windows'] },
    AUTHOR,
  )
  const bodyMatch = await board.post(
    WS,
    { kind: 'finding', title: 'Something else', body: `${'y'.repeat(300)} windows ${'z'.repeat(300)}` },
    AUTHOR,
  )
  const supersededTitle = await board.post(WS, { kind: 'decision', title: 'Windows decision old' }, AUTHOR)
  const newDecision = await board.post(
    WS,
    { kind: 'decision', title: 'Windows decision new', supersedes: supersededTitle.id },
    AUTHOR,
  )

  const all = await board.search(WS, { query: 'WINDOWS' })
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

  const limited = await board.search(WS, { query: 'windows', limit: 2 })
  assert.equal(limited.hits.length, 2)
  assert.equal(limited.truncated, true)

  const byKind = await board.search(WS, { query: 'windows', kind: 'gotcha' })
  assert.deepEqual(
    byKind.hits.map((hit) => hit.entry.id),
    [tagMatch.id],
  )
  const byTag = await board.search(WS, { query: 'windows', tag: 'WINDOWS' })
  assert.deepEqual(
    byTag.hits.map((hit) => hit.entry.id),
    [tagMatch.id],
  )
  await assert.rejects(board.search(WS, { query: '   ' }), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(board.search(WS, { query: 'x', kind: 'nope' }), (error) => error.code === 'BAD_ARGUMENT')
})

test('UT-BOARD-10 BOARD_FULL is enforced at the visible-entry boundary', async () => {
  const { board } = await makeBoard({ store: { maxEntriesPerWorkspace: 2 } })
  await board.post(WS, { kind: 'finding', title: 'one' }, AUTHOR)
  await board.post(WS, { kind: 'finding', title: 'two' }, AUTHOR)
  await assert.rejects(
    board.post(WS, { kind: 'finding', title: 'three' }, AUTHOR),
    (error) => error.code === 'BOARD_FULL',
  )
  assert.equal(board.stats(WS).entries, 2)
})

test('UT-BOARD-11 post requires attach; attach is idempotent and refreshes the view', async () => {
  const cfg = config()
  const store = fakeStore()
  const board = new BoardService({
    store,
    config: cfg,
    redactor: createRedactor(cfg),
    deps: { now: () => 1700000000000, random: () => 0.5 },
  })
  await assert.rejects(board.post(WS, { kind: 'finding', title: 'x' }, AUTHOR), (e) => e.code === 'STORE_UNAVAILABLE')
  assert.equal(board.view(WS).entryCount, 0, 'unattached view is safely empty')
  await board.attach(WS, {})
  await board.attach(WS, {})
  assert.equal(store.journals.size, 1)
  assert.equal(board.journalFor(WS) !== undefined, true)
  await board.post(WS, { kind: 'finding', title: 'x' }, AUTHOR)
  await board.refresh(WS)
  assert.equal(board.view(WS).entryCount, 1)
})

test('UT-BOARD-12 append-only: entries are immutable records and provenance comes from the caller', async () => {
  const { board, store } = await makeBoard()
  const first = await board.post(WS, { kind: 'finding', title: 'one', body: 'immutable' }, AUTHOR)
  const recordsBefore = store.journals.get(WS)._records.length
  await board.post(WS, { kind: 'finding', title: 'two' }, AUTHOR)
  const records = store.journals.get(WS)._records
  assert.equal(records.length, recordsBefore + 1, 'one append per post')
  const firstRecord = records.find((record) => record.id === first.id)
  assert.equal(firstRecord.body, 'immutable')

  // A hostile `files` value cannot spoof provenance; author fields come only from the caller arg.
  const spoof = await board.post(
    WS,
    { kind: 'finding', title: 'spoof', files: ['session-victim/author'] },
    { sessionId: 'session-attacker', title: 'Attacker', origin: 'user' },
  )
  const spoofRecord = store.journals.get(WS)._records.find((record) => record.id === spoof.id)
  assert.equal(spoofRecord.author.sessionId, 'session-attacker')
  assert.equal(spoofRecord.author.origin, 'user')
  assert.deepEqual(spoofRecord.files, ['session-victim/author'])
})

test('UT-BOARD-13 stats/view expose deterministic counts from the merged view', async () => {
  const { board } = await makeBoard()
  const question = await board.post(WS, { kind: 'question', title: 'q1' }, AUTHOR)
  await board.post(WS, { kind: 'handoff', title: 'h1' }, AUTHOR)
  await board.post(WS, { kind: 'finding', title: 'f1' }, AUTHOR)
  await board.post(WS, { kind: 'finding', title: 'answer', replyTo: question.id, resolves: true }, AUTHOR)
  const stats = board.stats(WS)
  assert.equal(stats.entries, 4)
  assert.equal(stats.openQuestions, 0)
  assert.equal(stats.openHandoffs, 1)
  assert.deepEqual(stats.byKind, { question: 1, handoff: 1, finding: 2 })
  const view = board.view(WS)
  assert.equal(view.entryCount, 4)
  assert.equal(view.roots.length, 3)
  assert.equal(view.maxSeq, view.entries.get([...view.entries.keys()].at(-1)).seq)
})
