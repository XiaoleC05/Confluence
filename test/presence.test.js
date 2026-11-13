// WP3b tests — presence heartbeat files, synchronous live() cache, stale filtering, privacy.
// Contract: implementation-interfaces.md §7 + Lead WP3 addendum; ledger-recall.md §3;
// data-model.md §4.6; store-format.md §10.
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Presence, presenceConstants } from '../lib/presence.js'

const WS_KEY = 'ws_1111111111111111'
const OTHER_WS_KEY = 'ws_2222222222222222'

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
  const files = {}
  const records = []
  return {
    wsKey,
    dir: path.join(os.tmpdir(), 'confluence-fake-presence', wsKey),
    files,
    records: () => records.slice(),
    async append(record) {
      records.push(record)
      return record
    },
    async refresh() {
      return false
    },
    async writePresence(data) {
      files[data.writerId] = JSON.parse(JSON.stringify(data))
    },
    async readPresence() {
      return JSON.parse(JSON.stringify(files))
    },
    async deletePresence(writerId) {
      delete files[writerId]
    },
  }
}

function makeStore(clock) {
  const journals = new Map()
  return {
    writerId: '4242-abcdef01',
    journals,
    async openWorkspace(wsKey) {
      if (!journals.has(wsKey)) journals.set(wsKey, makeJournal(wsKey, clock))
      return journals.get(wsKey)
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
      return handler ? handler(...args) : undefined
    },
  }
}

function makeTimers() {
  const intervals = []
  let nextId = 1
  const setIntervalFn = (fn, ms) => {
    const entry = { id: nextId, fn, ms, cleared: false, unref() {} }
    nextId += 1
    intervals.push(entry)
    return entry
  }
  const clearIntervalFn = (entry) => {
    if (entry && typeof entry === 'object') entry.cleared = true
  }
  return { intervals, setIntervalFn, clearIntervalFn }
}

function createPresence(options = {}) {
  const clock = options.clock ?? makeClock()
  const store = options.store ?? makeStore(clock)
  const timers = options.timers ?? makeTimers()
  const ctx = options.ctx ?? makeCtx()
  const presence = new Presence({
    store,
    config: options.config ?? {},
    logger: options.logger ?? { warn() {}, debug() {} },
    deps: {
      now: clock.now,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      plugin: { name: 'dsh-confluence', version: '0.1.0' },
      pid: 4242,
    },
  })
  return { presence, clock, store, timers, ctx }
}

function descriptors(...items) {
  return () =>
    items.map((item) => ({
      sessionId: item.sessionId,
      wsKey: item.wsKey ?? WS_KEY,
      title: item.title,
      status: item.status ?? 'live',
    }))
}

const iso = (clock, offsetMs = 0) => new Date(clock.now() - offsetMs).toISOString()

// ---------------------------------------------------------------------------
// heartbeat file
// ---------------------------------------------------------------------------

test('CON-L7 heartbeat file: session ids only, sorted, no titles/status, journal never written', async () => {
  const { presence, store, ctx } = createPresence()
  const disposer = presence.attach(
    ctx,
    descriptors(
      { sessionId: 'session-b', title: 'B title' },
      { sessionId: 'session-a', title: 'A title' },
    ),
  )
  await presence.writeHeartbeat()
  const journal = store.journals.get(WS_KEY)
  const file = journal.files['4242-abcdef01']
  assert.ok(file, 'heartbeat file written for the workspace')
  assert.equal(file.v, 1)
  assert.equal(file.ws, WS_KEY)
  assert.equal(file.writerId, '4242-abcdef01')
  assert.equal(file.pid, 4242)
  assert.deepEqual(file.plugin, { name: 'dsh-confluence', version: '0.1.0' })
  assert.match(file.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.deepEqual(file.sessions, ['session-a', 'session-b'])
  assert.equal('title' in file, false, 'titles never enter the heartbeat file')
  assert.equal(Array.isArray(file.sessions) && typeof file.sessions[0], 'string')
  // Presence never appends journal records.
  assert.equal(journal.records().length, 0)
  await presence.dispose()
  disposer()
})

test('UT-PRESENCE-01 live() is synchronous and returns titles/status joined from descriptors', async () => {
  const { presence, ctx } = createPresence()
  presence.attach(ctx, descriptors({ sessionId: 'session-a', title: 'Auth work', status: 'live' }))
  await presence.writeHeartbeat()
  await presence.refreshPresence(WS_KEY)
  const live = presence.live(WS_KEY)
  assert.equal(Array.isArray(live), true)
  assert.equal(live.length, 1)
  assert.deepEqual(
    { sessionId: live[0].sessionId, title: live[0].title, status: live[0].status },
    { sessionId: 'session-a', title: 'Auth work', status: 'live' },
  )
  assert.equal(typeof live[0].updatedAt, 'string')
  await presence.dispose()
})

test('UT-PRESENCE-02 heartbeats older than 30 s are offline (live filter + refresh filter)', async () => {
  const { presence, clock, stop } = await setupWithRemoteHeartbeat(5000)
  assert.equal(presence.live(WS_KEY).length, 1)
  clock.advance(20_000)
  assert.equal(presence.live(WS_KEY).length, 1, '25 s old is still fresh')
  clock.advance(6000)
  assert.equal(presence.live(WS_KEY).length, 0, 'stale after 30 s, without another refresh')
  await presence.dispose()
  if (stop) stop()
})

test('UT-PRESENCE-03 remote writer titles/status are joined from ledger session rows', async () => {
  const clock = makeClock()
  const store = makeStore(clock)
  const journal = await store.openWorkspace(WS_KEY)
  journal.records = () => [
    {
      v: 1,
      type: 'session',
      id: 'session-remote',
      ws: WS_KEY,
      seq: '01J00000000000000000000A',
      ts: iso(clock, 4000),
      title: 'Remote work',
      status: 'idle',
      turns: 2,
      lastActivityTs: iso(clock, 4000),
    },
  ]
  journal.files['777-aaaaaaaa'] = {
    v: 1,
    ws: WS_KEY,
    writerId: '777-aaaaaaaa',
    pid: 777,
    plugin: { name: 'dsh-confluence', version: '0.1.0' },
    updatedAt: iso(clock, 4000),
    sessions: ['session-remote'],
  }
  const { presence } = createPresence({ store, clock })
  await presence.refreshPresence(WS_KEY)
  const live = presence.live(WS_KEY)
  assert.equal(live.length, 1)
  assert.equal(live[0].sessionId, 'session-remote')
  assert.equal(live[0].title, 'Remote work')
  assert.equal(live[0].status, 'idle')
  assert.equal(live[0].writerId, '777-aaaaaaaa')
  await presence.dispose()
})

test('UT-PRESENCE-04 corrupt/absent presence files are ignored, never throw', async () => {
  const clock = makeClock()
  const store = makeStore(clock)
  const journal = await store.openWorkspace(WS_KEY)
  journal.files['111-aaaaaaaa'] = 'not an object'
  journal.files['222-bbbbbbbb'] = { v: 1, updatedAt: 'not-a-date', sessions: ['session-x'] }
  journal.files['333-cccccccc'] = { v: 1, updatedAt: iso(clock), sessions: 'not-an-array' }
  const { presence } = createPresence({ store, clock })
  await presence.refreshPresence(WS_KEY)
  assert.deepEqual(presence.live(WS_KEY), [])
  // readPresence throwing is tolerated too.
  journal.readPresence = async () => {
    throw new Error('EBUSY')
  }
  await presence.refreshPresence(WS_KEY)
  assert.deepEqual(presence.live(WS_KEY), [])
  await presence.dispose()
})

test('UT-PRESENCE-05 private sessions and disabled workspaces never appear', async () => {
  const { presence, ctx, store, clock } = createPresence({
    config: { privacy: { privateSessions: ['session-private'] } },
  })
  presence.attach(
    ctx,
    descriptors(
      { sessionId: 'session-a' },
      { sessionId: 'session-private' },
      { sessionId: 'session-other', wsKey: OTHER_WS_KEY },
    ),
  )
  await presence.writeHeartbeat()
  const file = store.journals.get(WS_KEY).files['4242-abcdef01']
  assert.deepEqual(file.sessions, ['session-a'])
  // A remote writer advertising the private session is filtered on read too.
  store.journals.get(WS_KEY).files['999-aaaaaaaa'] = {
    v: 1,
    updatedAt: iso(clock),
    sessions: ['session-private'],
  }
  await presence.refreshPresence(WS_KEY)
  assert.deepEqual(
    presence.live(WS_KEY).map((entry) => entry.sessionId),
    ['session-a'],
  )
  await presence.dispose()
})

test('UT-PRESENCE-06 heartbeat is removed when the workspace loses its live sessions', async () => {
  const { presence, ctx, store } = createPresence()
  let current = [{ sessionId: 'session-a', wsKey: WS_KEY, title: 'A', status: 'live' }]
  presence.attach(ctx, () => current)
  await presence.writeHeartbeat()
  assert.ok(store.journals.get(WS_KEY).files['4242-abcdef01'])
  current = []
  await presence.writeHeartbeat()
  assert.equal(store.journals.get(WS_KEY).files['4242-abcdef01'], undefined)
  await presence.dispose()
})

test('UT-PRESENCE-07 attach registers heartbeat 10 s + poll config.store.pollMs timers and turn/end hook', async () => {
  const { presence, ctx, timers, store } = createPresence({ config: { store: { pollMs: 4000 } } })
  presence.attach(ctx, descriptors({ sessionId: 'session-a' }))
  const intervals = timers.intervals.map((entry) => entry.ms).sort((a, b) => a - b)
  assert.deepEqual(intervals, [4000, presenceConstants.HEARTBEAT_INTERVAL_MS])
  assert.ok(ctx.handlers.has('session/event'), 'subscribed to session/event for turn/end')
  const before = store.journals.size
  ctx.emit('session/event', {}, { type: 'turn/end' })
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve))
  const journal = store.journals.get(WS_KEY)
  assert.ok(journal, 'turn/end triggered a heartbeat+refresh cycle')
  assert.ok(journal.files['4242-abcdef01'])
  assert.equal(before <= store.journals.size, true)
  await presence.dispose()
  assert.ok(timers.intervals.every((entry) => entry.cleared), 'dispose clears both timers')
  assert.equal(presence.live(WS_KEY).length, 0, 'dispose clears the cache')
})

test('UT-PRESENCE-08 refreshPresence(wsKey, writerId) filters to one writer', async () => {
  const clock = makeClock()
  const store = makeStore(clock)
  const journal = await store.openWorkspace(WS_KEY)
  journal.files['111-aaaaaaaa'] = { v: 1, updatedAt: iso(clock), sessions: ['session-a'] }
  journal.files['222-bbbbbbbb'] = { v: 1, updatedAt: iso(clock), sessions: ['session-b'] }
  const { presence } = createPresence({ store, clock })
  await presence.refreshPresence(WS_KEY, '222-bbbbbbbb')
  assert.deepEqual(
    presence.live(WS_KEY).map((entry) => entry.writerId),
    ['222-bbbbbbbb'],
  )
  await presence.dispose()
})

/** helper: a remote heartbeat written into the fake journal at `ageMs` before now */
async function setupWithRemoteHeartbeat(ageMs) {
  const clock = makeClock()
  const store = makeStore(clock)
  const journal = await store.openWorkspace(WS_KEY)
  journal.files['777-aaaaaaaa'] = {
    v: 1,
    ws: WS_KEY,
    writerId: '777-aaaaaaaa',
    updatedAt: iso(clock, ageMs),
    sessions: ['session-remote'],
  }
  const { presence } = createPresence({ store, clock })
  await presence.refreshPresence(WS_KEY)
  return { presence, clock }
}
