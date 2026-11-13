// WP3a tests — session ledger capture, coalescing, file hints, caps, read view.
// Contract: implementation-interfaces.md §7; ledger-recall.md §2, §6, §8 L1–L6.
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { SessionLedger, foldSessionRows, workspaceKeyFor } from '../lib/ledger.js'

/** Build a synthetic credential from fragments so the committed source never holds a credential-shaped literal. */
const secret = (...parts) => parts.join('')

const WS_ROOT = path.resolve(os.tmpdir(), 'confluence-ledger-ws')
const ABS_INSIDE = path.join(WS_ROOT, 'src', 'inside.ts')
const ABS_OUTSIDE = path.resolve(os.tmpdir(), 'confluence-ledger-outside', 'x.ts')

const ALLOWED_SESSION_KEYS = new Set([
  'v',
  'type',
  'id',
  'ws',
  'seq',
  'ts',
  'title',
  'status',
  'turns',
  'lastActivityTs',
  'effectiveDir',
  'files',
  'parentSession',
  'origin',
  'redactions',
])

function makeClock(start = 1_700_000_000_000) {
  let value = start
  return {
    now: () => value,
    advance: (ms) => {
      value += ms
      return value
    },
  }
}

function makeJournal(wsKey, clock) {
  const records = []
  const presence = {}
  let seqCounter = 0
  const journal = {
    wsKey,
    dir: path.join(os.tmpdir(), 'confluence-fake-journal', wsKey),
    records: () => records.slice(),
    async append(record) {
      seqCounter += 1
      const stored = {
        v: 1,
        seq: '01J' + String(seqCounter).padStart(23, '0'),
        ts: new Date(clock.now()).toISOString(),
        ...record,
        ws: record.ws ?? wsKey,
      }
      records.push(stored)
      return stored
    },
    async appendAndSync(record) {
      return journal.append(record)
    },
    async refresh() {
      return false
    },
    async writePresence(data) {
      presence[data.writerId] = JSON.parse(JSON.stringify(data))
    },
    async readPresence() {
      return JSON.parse(JSON.stringify(presence))
    },
    async deletePresence() {
      delete presence[journal.writerId ?? '']
    },
  }
  return journal
}

function makeStore(clock) {
  const journals = new Map()
  const opens = []
  return {
    writerId: '4242-abcdef01',
    journals,
    opens,
    async openWorkspace(wsKey, meta) {
      opens.push([wsKey, meta])
      if (!journals.has(wsKey)) journals.set(wsKey, makeJournal(wsKey, clock))
      return journals.get(wsKey)
    },
  }
}

function makeResolver(wsKey = 'ws_1111111111111111', canonicalPath = WS_ROOT) {
  return {
    async resolve() {
      return { key: wsKey, canonicalPath, label: 'ws' }
    },
  }
}

function makeCtx() {
  const handlers = new Map()
  return {
    handlers,
    on(type, handler) {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    },
    emit(type, ...args) {
      const handler = handlers.get(type)
      if (handler) return handler(...args)
      return undefined
    },
  }
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

function createLedger(options = {}) {
  const clock = options.clock ?? makeClock()
  const store = options.store ?? makeStore(clock)
  const ledger = new SessionLedger({
    store,
    config: options.config ?? {},
    logger: options.logger ?? { warn() {}, debug() {} },
    deps: {
      now: clock.now,
      workspaceResolver: options.resolver ?? makeResolver(),
      redactor: options.redactor,
      avoidTimers: true,
    },
  })
  return { ledger, clock, store }
}

function session(id = 'session-a', header = {}) {
  return { id, header: { id, cwd: WS_ROOT, ...header } }
}

async function feed(ledger, targetSession, events) {
  for (const event of events) ledger.onSessionEvent(targetSession, event)
  await settle()
}

const writeCall = (filePath, turn = 1) => ({
  type: 'tool/call',
  time: Date.now(),
  data: { turn, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: filePath }) },
})

// ---------------------------------------------------------------------------
// CON-L1/L2 — field allow-list and no text stored
// ---------------------------------------------------------------------------

test('CON-L1/L2 metadata-only capture: allow-listed keys, no prompt/assistant/tool text', async () => {
  const { ledger, store } = createLedger()
  const target = session('session-a')
  await feed(ledger, target, [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'PROMPT_SECRET_XYZ' }] } },
    { ...writeCall('src/auth/token.ts'), data: { name: 'write', arguments: '{"file_path":"src/auth/token.ts"}', turn: 1 } },
    { type: 'assistant/message', data: { content: [{ type: 'text', text: 'ASSISTANT_SECRET_XYZ' }] } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'TOOL_OUTPUT_SECRET_XYZ' }] } } },
    { type: 'session/title', data: { title: 'Auth  branch\twork' } },
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  ])
  await ledger.flush('ws_1111111111111111')

  const journal = store.journals.get('ws_1111111111111111')
  const records = journal.records().filter((record) => record.type === 'session')
  assert.equal(records.length, 1, 'one coalesced upsert record')
  const record = records[0]
  for (const key of Object.keys(record)) {
    assert.ok(ALLOWED_SESSION_KEYS.has(key), `record field "${key}" is outside the allow-list`)
  }
  assert.equal(record.id, 'session-a')
  assert.equal(record.ws, 'ws_1111111111111111')
  assert.equal(record.status, 'idle')
  assert.equal(record.turns, 3)
  assert.equal(record.title, 'Auth branch work')
  assert.match(record.lastActivityTs, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.deepEqual(record.files, ['src/auth/token.ts'])
  const bytes = JSON.stringify(records)
  for (const secret of ['PROMPT_SECRET_XYZ', 'ASSISTANT_SECRET_XYZ', 'TOOL_OUTPUT_SECRET_XYZ']) {
    assert.equal(bytes.includes(secret), false, `journal must not contain ${secret}`)
  }
})

test('CON-L1 tool-reasoning and command lines are never captured', async () => {
  const { ledger, store } = createLedger()
  await feed(ledger, session(), [
    { type: 'assistant/attempt', data: { reasoning: 'REASONING_SECRET' } },
    { type: 'tool/call', data: { name: 'pwsh', arguments: JSON.stringify({ command: 'echo SECRET_CMD' }) } },
    { type: 'user/message', data: { text: 'USER_TEXT_SECRET' } },
    { type: 'turn/end', data: { turn: 1 } },
  ])
  await ledger.flush('ws_1111111111111111')
  const bytes = JSON.stringify(store.journals.get('ws_1111111111111111').records())
  for (const secret of ['REASONING_SECRET', 'SECRET_CMD', 'USER_TEXT_SECRET']) {
    assert.equal(bytes.includes(secret), false, `journal must not contain ${secret}`)
  }
})

// ---------------------------------------------------------------------------
// coalescing / forced flush
// ---------------------------------------------------------------------------

test('UT-LEDGER-01 coalesces many events into one append; turn/end forces a flush', async () => {
  const { ledger, store } = createLedger()
  const target = session()
  const events = []
  for (let index = 0; index < 20; index += 1) events.push(writeCall(`src/f${index}.ts`, 1))
  events.push({ type: 'turn/end', time: Date.now(), data: { turn: 1 } })
  await feed(ledger, target, events)
  await ledger.flush('ws_1111111111111111')
  const records = store.journals.get('ws_1111111111111111').records()
  assert.equal(records.length, 1, '20 tool calls + turn/end append exactly one coalesced row')

  // A second dirty batch appends exactly one more row (upsert, not one per event).
  await feed(ledger, target, [writeCall('src/late.ts', 2), { type: 'turn/end', data: { turn: 2 } }])
  await ledger.flush('ws_1111111111111111')
  assert.equal(store.journals.get('ws_1111111111111111').records().length, 2)
})

// ---------------------------------------------------------------------------
// CON-L4 file hints
// ---------------------------------------------------------------------------

test('CON-L4 extractFilesFromToolCall: relative/absolute/apply_patch, deny + escape rules', () => {
  const extract = (name, args) => SessionLedger.extractFilesFromToolCall(name, args, WS_ROOT)
  assert.deepEqual(extract('write', JSON.stringify({ file_path: 'src/a.ts' })), ['src/a.ts'])
  assert.deepEqual(extract('edit', '{"path":"src\\\\b.ts"}'), ['src/b.ts'])
  assert.deepEqual(extract('create_file', { file_path: ABS_INSIDE }), ['src/inside.ts'])
  assert.deepEqual(extract('write', { path: ABS_OUTSIDE }), [], 'absolute outside the workspace')
  assert.deepEqual(extract('write', { path: '../escape.ts' }), [], '.. escape')
  assert.deepEqual(extract('write', { path: '.env' }), [], 'deny .env')
  assert.deepEqual(extract('write', { path: 'config/.env.local' }), [], 'deny .env*')
  assert.deepEqual(extract('write', { path: 'keys/server.pem' }), [], 'deny *.pem')
  assert.deepEqual(extract('read', { path: 'src/a.ts' }), [], 'non-hint tool')
  assert.deepEqual(extract('write', 'not json'), [], 'invalid JSON')
  assert.deepEqual(extract('write', { file_path: 'C:\\\\Windows\\\\system.ini' }), [])
  const many = { files: Array.from({ length: 10 }, (_, index) => `src/f${index}.ts`) }
  assert.equal(extract('write', many).length, 8, '≤8 distinct paths')
  const patch = [
    '*** Begin Patch',
    '*** Add File: src/new.ts',
    '+export const x = 1',
    '*** Update File: src/old.ts',
    '@@',
    '*** End Patch',
  ].join('\n')
  assert.deepEqual(extract('apply_patch', { patch }), ['src/new.ts', 'src/old.ts'])
  assert.deepEqual(extract('write', { files: ['src/a.ts', 'src/a.ts'] }), ['src/a.ts'], 'deduped, order kept')
})

test('CON-L5 tool/ptc-dispatch extraction parity; content is never parsed', () => {
  const direct = SessionLedger.extractFilesFromToolCall(
    'edit',
    JSON.stringify({ file_path: 'src/ptc.ts' }),
    WS_ROOT,
  )
  const dispatch = SessionLedger.extractFilesFromPtcDispatch(
    { data: { name: 'edit', arguments: JSON.stringify({ file_path: 'src/ptc.ts' }), content: 'SECRET_CONTENT' } },
    WS_ROOT,
  )
  assert.deepEqual(dispatch, direct)
  assert.deepEqual(SessionLedger.extractFilesFromPtcDispatch({ data: { name: 'unknown' } }, WS_ROOT), [])
})

test('CON-L6 caps: 8 file hints, redacted+160-char title', async () => {
  const { ledger, store } = createLedger({ config: { ledger: { maxFilesPerSession: 20 } } })
  const leakedKey = secret('sk-abcde', 'fghijklmnopqrstuvwx')
  await feed(ledger, session(), [
    { type: 'session/title', data: { title: 'x '.repeat(200) + leakedKey } },
    ...Array.from({ length: 12 }, (_, index) => writeCall(`src/hint-${index}.ts`)),
    { type: 'turn/end', data: { turn: 1 } },
  ])
  await ledger.flush('ws_1111111111111111')
  const record = store.journals.get('ws_1111111111111111').records()[0]
  assert.equal(record.files.length, 8, 'configured cap clamps to the data-model hard cap of 8')
  assert.ok([...record.title].length <= 160)
  assert.equal(record.title.includes(leakedKey), false, 'title redacted')
})

// ---------------------------------------------------------------------------
// suppression
// ---------------------------------------------------------------------------

test('CON-L7 private session and disabled workspace write no ledger rows', async () => {
  const { ledger, store } = createLedger({
    config: { privacy: { privateSessions: ['session-p'], disabledWorkspaces: ['ws_1111111111111111'] } },
  })
  await feed(ledger, session('session-p'), [writeCall('src/a.ts'), { type: 'turn/end', data: { turn: 1 } }])
  await feed(ledger, session('session-q'), [writeCall('src/b.ts'), { type: 'turn/end', data: { turn: 1 } }])
  await ledger.flush()
  const journal = store.journals.get('ws_1111111111111111')
  assert.equal(journal === undefined ? 0 : journal.records().length, 0)
})

// ---------------------------------------------------------------------------
// read view / upsert / effective dir
// ---------------------------------------------------------------------------

test('CON-L3 merged ledger view: last-wins by seq, most recent first, capped', async () => {
  const { ledger, store } = createLedger({ config: { ledger: { maxSessionsPerWorkspace: 20 } } })
  await feed(ledger, session(), [{ type: 'turn/end', data: { turn: 1 } }])
  await ledger.flush('ws_1111111111111111')
  const journal = store.journals.get('ws_1111111111111111')
  const view = ledger.ledger('ws_1111111111111111')
  assert.equal(view.size, 1)

  // Manually append an older and a newer row for another session.
  await journal.append({
    type: 'session',
    id: 'session-old',
    ws: 'ws_1111111111111111',
    seq: '01J000000000000000000000A',
    title: 'old',
    status: 'idle',
    turns: 1,
    lastActivityTs: '2026-11-13T00:00:00.000Z',
  })
  await journal.append({
    type: 'session',
    id: 'session-new',
    ws: 'ws_1111111111111111',
    seq: '01J000000000000000000000B',
    title: 'new',
    status: 'idle',
    turns: 2,
    lastActivityTs: '2026-11-13T01:00:00.000Z',
  })
  await journal.append({
    type: 'session',
    id: 'session-new',
    ws: 'ws_1111111111111111',
    seq: '01J000000000000000000000C',
    title: 'newest',
    status: 'live',
    turns: 3,
    lastActivityTs: '2026-11-13T02:00:00.000Z',
  })
  const merged = ledger.ledger('ws_1111111111111111')
  assert.equal(merged.get('session-new').title, 'newest')
  assert.equal(merged.get('session-new').status, 'live')
  assert.equal([...merged.keys()][0], 'session-new', 'most recently active first')
  // Reader clones: mutating the returned row never mutates the journal record.
  merged.get('session-new').title = 'tampered'
  assert.equal(ledger.ledger('ws_1111111111111111').get('session-new').title, 'newest')
})

test('foldSessionRows is pure and caps at maxSessions', () => {
  const records = Array.from({ length: 30 }, (_, index) => ({
    type: 'session',
    id: `session-${index}`,
    ws: 'ws_1111111111111111',
    seq: `01J${String(index).padStart(23, '0')}`,
    lastActivityTs: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  }))
  const view = foldSessionRows(records, 'ws_1111111111111111', 20)
  assert.equal(view.size, 20)
  assert.ok(view.has('session-29'), 'newest kept')
  assert.equal(view.has('session-0'), false, 'oldest dropped by the cap')
  assert.equal(foldSessionRows(records, 'ws_other', 20).size, 0, 'workspace filter')
})

test('working-directory/change records effectiveDir only when it differs from the workspace', async () => {
  const { ledger, store } = createLedger()
  const moved = path.join(WS_ROOT, 'src', 'auth')
  await feed(ledger, session('session-a'), [
    { type: 'working-directory/change', data: { directory: moved } },
    { type: 'turn/end', data: { turn: 1 } },
  ])
  await ledger.flush('ws_1111111111111111')
  const record = store.journals.get('ws_1111111111111111').records()[0]
  assert.equal(record.effectiveDir, moved)

  const { ledger: ledger2, store: store2 } = createLedger()
  await feed(ledger2, session('session-b'), [
    { type: 'working-directory/change', data: { cwd: WS_ROOT } },
    { type: 'turn/end', data: { turn: 1 } },
  ])
  await ledger2.flush('ws_1111111111111111')
  assert.equal(store2.journals.get('ws_1111111111111111').records()[0].effectiveDir, undefined)
})

test('attach subscribes to session/event and dispose flushes pending rows', async () => {
  const { ledger, clock, store } = createLedger()
  const ctx = makeCtx()
  const disposer = ledger.attach(ctx)
  ctx.emit('session/event', session(), { type: 'session/title', time: clock.now(), data: { title: 'Titled' } })
  await settle()
  await ledger.dispose()
  disposer()
  const records = store.journals.get('ws_1111111111111111').records()
  assert.equal(records.length, 1)
  assert.equal(records[0].title, 'Titled')
})

test('workspace key helper matches the data-model derivation', () => {
  assert.match(workspaceKeyFor('D:\\\\05_Code\\\\solo-bench'), /^ws_[0-9a-f]{16}$/)
  assert.equal(workspaceKeyFor('same'), workspaceKeyFor('same'))
  assert.notEqual(workspaceKeyFor('same'), workspaceKeyFor('other'))
})
