// UT-WM / CON-WM — split watermark fold tests (WP4).
//
// Synthetic committed events only; no DSH runtime, no filesystem, no network.
// Contract: docs/plan/implementation-interfaces.md §8, docs/design/pulse.md §8.
//
// Run: node --test "test/watermark.test.js"

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BOARD_READ_TOOLS,
  PULSE_SECTION_NAME,
  WATERMARK_KEY,
  WATERMARK_STATE_VERSION,
  WatermarkTracker,
  createInitialState,
  createWatermarkProjectionDefinition,
  foldWatermarks,
  parseDigestMarker,
  parseThroughMarker,
} from '../lib/watermark.js'

const SEQ_A = '01J8Z6Q3M5AAAAAAAAAAAAAAAA'
const SEQ_B = '01J8Z6Q3M5BBBBBBBBBBBBBBBB'
const SEQ_C = '01J8Z6Q3M5CCCCCCCCCCCCCCCC'

/** @param {string} type @param {unknown} data @param {number} [seq] */
function ev(type, data, seq = 1) {
  return { type, seq, time: 1_700_000_000_000 + seq, data }
}

/** @param {string} text @param {string} [sectionName] @param {boolean} [sections] */
function userRuntimeContext(text, sectionName = PULSE_SECTION_NAME, sections = true) {
  const data = {
    id: 'msg_1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: sections
      ? { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'working-directory:current', text: 'cwd' }, { name: sectionName, text }] }
      : { kind: 'runtime-context' },
  }
  return ev('user/message', data, 10)
}

/** @param {string} seq */
function pulseBlock(seq, { welcome = false } = {}) {
  return [
    `<confluence-workspace name="w" peers="0" unread="0" seq="${seq}"${welcome ? ' welcome="1"' : ''}>`,
    'Background memory shared by sessions in this workspace.',
    '</confluence-workspace>',
  ].join('\n')
}

/** @param {string} callId @param {string} name @param {number} seq */
function toolCall(callId, name, seq = 20) {
  return ev('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' }, seq)
}

/** @param {string} callId @param {string} text @param {number} seq */
function toolResult(callId, text, seq = 21) {
  return ev(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: {
        id: `m_${seq}`,
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
      },
    },
    seq,
  )
}

/** @param {string} subCallId @param {string} name @param {number} seq */
function ptcStart(subCallId, name, seq = 30) {
  return ev('tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'parent', subCallId, name, arguments: '{}' }, seq)
}

/** @param {string} name @param {string} text @param {number} seq */
function ptcDispatch(name, text, seq = 31, subCallId = 'root:ptc:1') {
  return ev('tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'parent', subCallId, name, arguments: '{}', isError: false, content: [{ type: 'text', text }] }, seq)
}

/** Fold a list of events from the initial state. */
function foldAll(events) {
  let state = createInitialState()
  for (const event of events) state = foldWatermarks(state, event)
  return state
}

/**
 * Minimal Cordis-like context for attach()/fallback tests.
 *
 * @param {object} [services]
 */
function makeCtx(services = {}) {
  const listeners = new Map()
  const ctx = {
    services,
    listeners,
    get(name) {
      return services[name]
    },
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(fn)
        if (index >= 0) current.splice(index, 1)
      }
    },
    emit(name, ...args) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(...args)
    },
  }
  return ctx
}

/**
 * Fake projection service whose register() resolves a handle over mutable state.
 *
 * @param {{ fail?: 'throw' | 'reject' | false, stateRef?: object }} [options]
 */
function makeProjectionService({ fail = false, stateRef = { digestSeq: null, boardReadSeq: null, pending: {} } } = {}) {
  const calls = { register: 0, disposed: 0 }
  let definition = null
  const service = {
    register(candidate) {
      calls.register += 1
      definition = candidate
      if (fail === 'throw') throw new Error('projection registry exploded')
      const handle = {
        stateOf() {
          return stateRef
        },
        async dispose() {
          calls.disposed += 1
        },
      }
      if (fail === 'reject') return Promise.reject(new Error('projection registry rejected'))
      return Object.assign(() => Promise.resolve(), { then: (resolve) => Promise.resolve(handle).then(resolve) })
    },
  }
  return { service, calls, definition: () => definition }
}

// ── definition / state shape ────────────────────────────────────────────────

test('UT-WM-1 definition is one host-only projection unit with a plain parse schema', () => {
  const definition = createWatermarkProjectionDefinition()
  assert.equal(definition.key, WATERMARK_KEY)
  assert.equal(definition.key, 'confluence_watermark')
  assert.equal(definition.stateVersion, WATERMARK_STATE_VERSION)
  assert.equal(definition.stateVersion, 1)
  assert.equal(typeof definition.stateSchema.parse, 'function')
  assert.equal(typeof definition.init, 'function')
  assert.equal(typeof definition.apply, 'function')
  // Host-only: no wire view means the state is checkpointed but never sent to clients.
  assert.ok(!Object.hasOwn(definition, 'wire'))
})

test('UT-WM-2 stateSchema.parse tolerates garbage and normalizes only known fields', () => {
  const { stateSchema } = createWatermarkProjectionDefinition()
  for (const garbage of [undefined, null, 0, 'x', [], {}, { digestSeq: 5 }]) {
    const state = stateSchema.parse(garbage)
    assert.deepEqual(state, { digestSeq: null, boardReadSeq: null, pending: {} })
  }
  const parsed = stateSchema.parse({
    digestSeq: SEQ_A,
    boardReadSeq: SEQ_B,
    pending: { c1: 'confluence_board', c2: 'other_tool', c3: 'confluence_read' },
  })
  assert.deepEqual(parsed, {
    digestSeq: SEQ_A,
    boardReadSeq: SEQ_B,
    pending: { c1: 'confluence_board', c3: 'confluence_read' },
  })
})

test('UT-WM-3 init returns a fresh null-cursor state per call', () => {
  const { init } = createWatermarkProjectionDefinition()
  const first = init({}, 0)
  const second = init({}, 0)
  assert.deepEqual(first, { digestSeq: null, boardReadSeq: null, pending: {} })
  assert.notEqual(first, second)
  assert.notEqual(first.pending, second.pending)
})

// ── digestSeq fold ──────────────────────────────────────────────────────────

test('CON-WM-1 digestSeq folds the pulse section seq attribute (unescaped marker)', () => {
  const state = foldAll([userRuntimeContext(pulseBlock(SEQ_A))])
  assert.equal(state.digestSeq, SEQ_A)
  assert.equal(state.boardReadSeq, null)
})

test('CON-WM-2 digestSeq folds the sentinel seq="0" (empty-board welcome)', () => {
  const state = foldAll([userRuntimeContext(pulseBlock('0', { welcome: true }))])
  assert.equal(state.digestSeq, '0')
})

test('CON-WM-3 digestSeq accepts the escaped tag/quote form defensively', () => {
  const escaped = [
    '\\u003cconfluence-workspace name=\\u0022w\\u0022 peers=\\u00220\\u0022 unread=\\u00220\\u0022 seq=\\u0022' + SEQ_B + '\\u0022\\u003e',
    'body',
  ].join('\n')
  const state = foldAll([userRuntimeContext(escaped)])
  assert.equal(state.digestSeq, SEQ_B)
})

test('CON-WM-4 only the named pulse section is scanned (forge resistance)', () => {
  // A hostile contribution in another named section must not move our cursor.
  const hostile = userRuntimeContext(pulseBlock(SEQ_C), 'some-other-plugin:context')
  const state = foldAll([hostile])
  assert.equal(state.digestSeq, null)

  // A title-like marker inside the pulse section's body must not count either.
  const inBody = [
    `<confluence-workspace name="w" seq="${SEQ_A}">`,
    `hostile body line`,
    `</confluence-workspace>`,
    `<confluence-workspace name="w" seq="${SEQ_B}">`,
  ].join('\n')
  assert.equal(foldAll([userRuntimeContext(inBody)]).digestSeq, SEQ_A)
})

test('CON-WM-5 CLEARED and legacy no-sections snapshots carry no marker and change nothing', () => {
  const cleared = userRuntimeContext('Current runtime context: none. Earlier runtime-context snapshots no longer apply.', PULSE_SECTION_NAME, false)
  const state = foldAll([cleared])
  assert.equal(state.digestSeq, null)
  const previous = { digestSeq: SEQ_A, boardReadSeq: null, pending: {} }
  assert.equal(foldWatermarks(previous, cleared), previous)
})

test('CON-WM-6 digestSeq is max-monotonic and idempotent', () => {
  let state = foldAll([userRuntimeContext(pulseBlock(SEQ_B))])
  const afterFirst = state
  assert.equal(state.digestSeq, SEQ_B)
  // Replaying the same event keeps the reference (pure fold).
  assert.equal(foldWatermarks(state, userRuntimeContext(pulseBlock(SEQ_B))), afterFirst)
  // An older committed snapshot never regresses the cursor.
  state = foldWatermarks(state, userRuntimeContext(pulseBlock(SEQ_A)))
  assert.equal(state.digestSeq, SEQ_B)
  // A newer one advances.
  state = foldWatermarks(state, userRuntimeContext(pulseBlock(SEQ_C)))
  assert.equal(state.digestSeq, SEQ_C)
})

test('CON-WM-7 malformed seq attributes keep the previous value', () => {
  const previous = { digestSeq: SEQ_A, boardReadSeq: null, pending: {} }
  for (const marker of ['', 'lowercase01j8', 'has-a-dash-01J8', 'x'.repeat(40)]) {
    const text = `<confluence-workspace name="w" peers="0" unread="0" seq="${marker}">`
    assert.equal(foldWatermarks(previous, userRuntimeContext(text)), previous)
  }
})

test('CON-WM-8 digest fold never throws on garbage events', () => {
  const previous = { digestSeq: SEQ_A, boardReadSeq: null, pending: {} }
  const garbage = [
    null,
    undefined,
    42,
    {},
    { type: 'user/message' },
    { type: 'user/message', data: null },
    { type: 'user/message', data: { content: null, source: null } },
    { type: 'user/message', data: { content: 'text', source: { kind: 'runtime-context', sections: 'nope' } } },
    { type: 'user/message', data: { content: [null, 1, { type: 'text', text: 7 }], source: { kind: 'runtime-context' } } },
  ]
  for (const event of garbage) {
    assert.equal(foldWatermarks(previous, event), previous)
  }
})

// ── boardReadSeq fold ───────────────────────────────────────────────────────

test('CON-WM-9 boardReadSeq folds a through= marker only for Our tools', () => {
  const call = toolCall('c1', 'confluence_board')
  const result = toolResult('c1', 'Board:\n- note\nthrough=' + SEQ_A)
  const state = foldAll([call, result])
  assert.equal(state.boardReadSeq, SEQ_A)
  assert.deepEqual(state.pending, {})
})

test('CON-WM-10 another tool result carrying through= never advances the cursor', () => {
  const call = toolCall('c2', 'some_other_tool')
  const result = toolResult('c2', 'through=' + SEQ_C)
  const state = foldAll([call, result])
  assert.equal(state.boardReadSeq, null)
  // The pending map only tracks our tools (bounded).
  assert.deepEqual(state.pending, {})
})

test('CON-WM-11 a result without a marker leaves the cursor and clears the pending call', () => {
  const state = foldAll([toolCall('c3', 'confluence_read'), toolResult('c3', 'Error: NO_WORKSPACE')])
  assert.equal(state.boardReadSeq, null)
  assert.deepEqual(state.pending, {})
})

test('CON-WM-12 malformed through values keep the previous cursor', () => {
  const previous = { digestSeq: null, boardReadSeq: SEQ_A, pending: { c4: 'confluence_board' } }
  for (const marker of ['', 'lower01j8', 'x'.repeat(30)]) {
    const state = foldWatermarks(previous, toolResult('c4', 'body\nthrough=' + marker))
    assert.equal(state.boardReadSeq, SEQ_A)
  }
})

test('CON-WM-13 ptc-dispatch result advances the cursor and start events feed the pending map', () => {
  let state = foldAll([ptcStart('root:ptc:1', 'confluence_board')])
  assert.deepEqual(state.pending, { 'root:ptc:1': 'confluence_board' })
  state = foldWatermarks(state, ptcDispatch('confluence_board', 'Board:\nthrough=' + SEQ_B))
  assert.equal(state.boardReadSeq, SEQ_B)
  assert.deepEqual(state.pending, {})
  // A non-Confluence dispatch does nothing.
  const previous = state
  assert.equal(foldWatermarks(previous, ptcDispatch('read', 'through=' + SEQ_C)), previous)
})

test('CON-WM-14 the pending call map is bounded to 16 entries', () => {
  let state = createInitialState()
  for (let index = 0; index < 20; index += 1) state = foldWatermarks(state, toolCall(`call-${index}`, 'confluence_board'))
  assert.equal(Object.keys(state.pending).length, 16)
  assert.equal(state.pending['call-0'], undefined)
  assert.equal(state.pending['call-19'], 'confluence_board')
})

test('CON-WM-15 both cursors are independent and replay is order-insensitive (max)', () => {
  const events = [
    userRuntimeContext(pulseBlock(SEQ_A)),
    toolCall('c1', 'confluence_board'),
    toolResult('c1', 'through=' + SEQ_B),
  ]
  const forward = foldAll(events)
  const replayTwice = foldAll([...events, ...events])
  assert.deepEqual(forward, replayTwice)
  assert.equal(forward.digestSeq, SEQ_A)
  assert.equal(forward.boardReadSeq, SEQ_B)
})

test('CON-WM-16 apply does not mutate the previous state object', () => {
  const previous = createInitialState()
  const snapshot = JSON.parse(JSON.stringify(previous))
  foldWatermarks(previous, toolCall('c1', 'confluence_board'))
  foldWatermarks(previous, userRuntimeContext(pulseBlock(SEQ_A)))
  assert.deepEqual(previous, snapshot)
})

test('CON-WM-17 forked/copied prefix folds deterministically from init', () => {
  const inheritedPrefix = [userRuntimeContext(pulseBlock(SEQ_A)), toolCall('c1', 'confluence_board'), toolResult('c1', 'through=' + SEQ_B)]
  const child = foldAll(inheritedPrefix)
  const rederived = foldAll(inheritedPrefix)
  assert.deepEqual(child, rederived)
  assert.equal(child.digestSeq, SEQ_A)
  assert.equal(child.boardReadSeq, SEQ_B)
})

test('CON-WM-18 BOARD_READ_TOOLS is the closed set confluence_board/confluence_read', () => {
  assert.deepEqual([...BOARD_READ_TOOLS], ['confluence_board', 'confluence_read'])
})

// ── marker parsers ──────────────────────────────────────────────────────────

test('UT-WM-4 parseDigestMarker requires a line-starting tag and a valid seq', () => {
  assert.equal(parseDigestMarker(pulseBlock(SEQ_A)), SEQ_A)
  assert.equal(parseDigestMarker('prefix ' + pulseBlock(SEQ_A)), null)
  assert.equal(parseDigestMarker(`<confluence-workspace seq="notaseq">`), null)
  assert.equal(parseDigestMarker(''), null)
  assert.equal(parseDigestMarker(null), null)
  // Lowercase / non-uppercase alphabets are not our wire alphabet.
  assert.equal(parseDigestMarker('<confluence-workspace seq="01j8z6q3m5">'), null)
})

test('UT-WM-5 parseThroughMarker reads the last marker body line', () => {
  assert.equal(parseThroughMarker('a\nthrough=' + SEQ_A), SEQ_A)
  assert.equal(parseThroughMarker('a\nthrough=' + SEQ_A + '\n\n'), SEQ_A)
  assert.equal(parseThroughMarker('through=' + SEQ_A + '\nmore text'), null)
  assert.equal(parseThroughMarker('through=bad-value!'), null)
  assert.equal(parseThroughMarker(''), null)
})

// ── tracker lifecycle: projection path ──────────────────────────────────────

test('UT-WM-6 attach awaits registration, retains the handle and reads stateOf', async () => {
  const stateRef = { digestSeq: SEQ_A, boardReadSeq: SEQ_B, pending: {} }
  const { service, calls, definition } = makeProjectionService({ stateRef })
  const ctx = makeCtx({ sessionProjections: service })
  const tracker = new WatermarkTracker({ config: {}, logger: null, deps: { now: () => 0 } })
  await tracker.attach(ctx)

  assert.equal(calls.register, 1)
  assert.equal(definition().key, WATERMARK_KEY)
  assert.equal(definition().stateVersion, 1)
  const session = { id: 's1', header: { id: 's1' } }
  assert.deepEqual(tracker.get(session), { digestSeq: SEQ_A, boardReadSeq: SEQ_B })
  // Only the two public cursors are exposed, never the internal pending map.
  assert.deepEqual(Object.keys(tracker.get(session)).sort(), ['boardReadSeq', 'digestSeq'])

  await tracker.dispose()
  assert.equal(calls.disposed, 1)
})

test('UT-WM-7 attach degrades when sessionProjections is absent or broken', async () => {
  for (const options of [{}, { service: { register() { throw new Error('boom') } } }, makeProjectionService({ fail: 'reject' }).service]) {
    const services = options.service ? { sessionProjections: options.service } : {}
    const ctx = makeCtx(services)
    const tracker = new WatermarkTracker({ config: {}, logger: null, deps: {} })
    await assert.doesNotReject(() => tracker.attach(ctx))
    assert.deepEqual(tracker.get({ id: 's1', header: { id: 's1' } }), { digestSeq: null, boardReadSeq: null })
    await tracker.dispose()
  }
})

test('UT-WM-8 a throwing stateOf falls back to the degraded map', async () => {
  const service = {
    register() {
      const handle = { stateOf() { throw new Error('no session') }, async dispose() {} }
      return Object.assign(() => Promise.resolve(), { then: (resolve) => Promise.resolve(handle).then(resolve) })
    },
  }
  const ctx = makeCtx({ sessionProjections: service })
  const tracker = new WatermarkTracker({ config: {}, logger: null, deps: {} })
  await tracker.attach(ctx)
  const session = { id: 's1', header: { id: 's1' } }
  tracker.observeDigestCommit('s1', SEQ_A)
  assert.deepEqual(tracker.get(session), { digestSeq: SEQ_A, boardReadSeq: null })
  await tracker.dispose()
})

// ── tracker lifecycle: degraded fallback ────────────────────────────────────

test('CON-WM-19 without projections a session/event listener keeps in-memory cursors', async () => {
  const ctx = makeCtx({})
  const tracker = new WatermarkTracker({ config: {}, logger: null, deps: {} })
  await tracker.attach(ctx)
  const session = { id: 's1', header: { id: 's1' } }
  ctx.emit('session/event', session, userRuntimeContext(pulseBlock(SEQ_A)))
  ctx.emit('session/event', session, toolCall('c1', 'confluence_board'))
  ctx.emit('session/event', session, toolResult('c1', 'through=' + SEQ_B))
  assert.deepEqual(tracker.get(session), { digestSeq: SEQ_A, boardReadSeq: SEQ_B })
  await tracker.dispose()
})

test('CON-WM-20 the agent/created replay seeds cursors from a bounded reverse scan', async () => {
  const ctx = makeCtx({})
  const tracker = new WatermarkTracker({ config: {}, logger: null, deps: {} })
  await tracker.attach(ctx)
  const events = [userRuntimeContext(pulseBlock(SEQ_A)), toolCall('c1', 'confluence_board'), toolResult('c1', 'through=' + SEQ_B)]
  const session = { id: 's1', header: { id: 's1' }, snapshotEvents: () => events }
  ctx.emit('agent/created', { agent: { session } })
  assert.deepEqual(tracker.get(session), { digestSeq: SEQ_A, boardReadSeq: SEQ_B })
  await tracker.dispose()
})

test('CON-WM-21 session/disposed drops degraded state and observeDigestCommit is monotonic', async () => {
  const ctx = makeCtx({})
  const tracker = new WatermarkTracker({ config: {}, logger: null, deps: {} })
  await tracker.attach(ctx)
  const session = { id: 's1', header: { id: 's1' } }
  tracker.observeDigestCommit('s1', SEQ_B)
  tracker.observeDigestCommit('s1', SEQ_A)
  assert.equal(tracker.get(session).digestSeq, SEQ_B)
  tracker.observeDigestCommit('s1', 'garbage')
  assert.equal(tracker.get(session).digestSeq, SEQ_B)
  ctx.emit('session/disposed', session)
  assert.equal(tracker.get(session).digestSeq, null)
  await tracker.dispose()
})

test('UT-WM-9 dispose is idempotent and removes listeners', async () => {
  const ctx = makeCtx({})
  const tracker = new WatermarkTracker({ config: {}, logger: null, deps: {} })
  await tracker.attach(ctx)
  const session = { id: 's1', header: { id: 's1' } }
  await tracker.dispose()
  await tracker.dispose()
  ctx.emit('session/event', session, userRuntimeContext(pulseBlock(SEQ_A)))
  assert.equal(tracker.get(session).digestSeq, null)
})
