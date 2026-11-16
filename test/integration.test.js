// Confluence / 汇流 — end-to-end wiring test (Lead-owned, v0.2.0 universal scope).
//
// Drives the real plugin modules through a fake Cordis context + fake host
// services (tools, systemPrompt, webServer, agents, sessionQuery) with the real
// filesystem under a temp directory. The v0.2.0 acceptance is cross-workspace:
// two sessions with DIFFERENT working directories share one profile-wide memory.
//
//   applyWithDeps -> six tools + one pulse context + three panel routes
//   session A (cwd A) posts; session B (cwd B) sees it in board/pulse
//   legacy v1 per-workspace journals are merged read-only with provenance labels
//   the global journal lives at workspaces/ws_0000000000000000/
//
// Offline: no network, no DSH packages, Node builtins only.

import assert from 'node:assert/strict'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { applyWithDeps } from '../index.js'
import { GLOBAL_SCOPE_KEY, JournalStore } from '../lib/store.js'
import { resolveConfig } from '../lib/config.js'
import { createOriginResolver } from '../lib/workspace.js'

const LEGACY_WS_KEY = `ws_${'1'.repeat(16)}`

/** @type {{dir: string, projectA: string, projectB: string, legacyDir: string, store: string}} */
const paths = { dir: '', projectA: '', projectB: '', legacyDir: '', store: '' }

/** @type {object | null} */
let services = null
/** @type {object} */
const captured = {
  tools: new Map(),
  routes: new Map(),
  prompts: [],
  listeners: new Map(),
  disposers: [],
}

/** Fake Cordis context: captures registrations and provides fake host services. */
function createFakeCtx() {
  const host = {
    tools: {
      register(definition) {
        captured.tools.set(definition.name, definition)
        return () => captured.tools.delete(definition.name)
      },
    },
    systemPrompt: {
      context(definition) {
        captured.prompts.push(definition)
        return () => {
          const index = captured.prompts.indexOf(definition)
          if (index >= 0) captured.prompts.splice(index, 1)
        }
      },
      section() {
        return () => {}
      },
    },
    webServer: {
      getOrigin() {
        return 'http://127.0.0.1:0'
      },
      register(route) {
        captured.routes.set(route.path, route)
        return () => captured.routes.delete(route.path)
      },
    },
    agents: { list: () => [] },
    workingDirectory: { get: () => undefined },
    sessionQuery: {
      async listSessions() {
        return []
      },
      async readTitle(sessionId) {
        return { title: `title:${sessionId}` }
      },
      async filterEvents() {
        return []
      },
      async readEvent() {
        return { events: [] }
      },
    },
    sessionTitle: { get: () => undefined },
  }

  const ctx = {
    get(name) {
      return host[name]
    },
    tools: host.tools,
    systemPrompt: host.systemPrompt,
    webServer: host.webServer,
    agents: host.agents,
    workingDirectory: host.workingDirectory,
    sessionQuery: host.sessionQuery,
    sessionTitle: host.sessionTitle,
    on(type, listener) {
      const list = captured.listeners.get(type) ?? []
      list.push(listener)
      captured.listeners.set(type, list)
      return () => {
        const current = captured.listeners.get(type) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(callback) {
      const disposer = callback()
      captured.disposers.push(() => {
        try {
          if (typeof disposer === 'function') disposer()
        } catch {
          // ignore
        }
      })
      return () => {}
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  return { ctx, host }
}

/** @param {string} id @param {string} cwd @returns {object} */
function fakeSession(id, cwd) {
  return {
    id,
    header: { id, cwd, isSeeded: false },
    snapshotEvents() {
      return []
    },
    seq: 0,
  }
}

/** @param {object} session @param {string} [id] @returns {object} */
function fakeAgent(session, id = session.id) {
  return { id, session, status: 'idle' }
}

/** @param {string} type @param {...any} args */
function emit(type, ...args) {
  for (const listener of captured.listeners.get(type) ?? []) {
    try {
      listener(...args)
    } catch {
      // Event listeners must not break the test flow.
    }
  }
}

/** @param {string} name @returns {object} */
function tool(name) {
  const definition = captured.tools.get(name)
  assert.ok(definition, `tool ${name} was registered`)
  return definition
}

/** @param {object} agent @param {object} args */
async function exec(name, agent, args) {
  return await tool(name).execute(args, {
    agent,
    callId: `call-${Math.random()}`,
    signal: AbortSignal.timeout(5000),
    deferContext() {},
    concludeTurn() {},
  })
}

/**
 * Seed one legacy v0.1.0 workspace journal into the same store root, with one
 * entry inside. Returns the entry id.
 * @returns {Promise<string>}
 */
async function seedLegacyWorkspace() {
  const config = resolveConfig({ store: { dir: paths.store } }).config
  const deps = {
    fs,
    fsSync,
    now: () => Date.now(),
    random: Math.random,
    pid: 12345,
  }
  const store = new JournalStore({ config, logger: null, deps })
  await store.init()
  const journal = await store.openWorkspace(LEGACY_WS_KEY, {
    canonicalPath: paths.legacyDir,
    label: path.basename(paths.legacyDir),
  })
  const stored = await journal.append({
    v: 1,
    type: 'entry',
    id: 'cnf_01JBQ8Z4K7F1G2H3J4K5M6N7P8',
    ws: LEGACY_WS_KEY,
    seq: '01JBQ8Z4K7F1G2H3J4K5M6N7P8',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'decision',
    title: 'Legacy workspace decision',
    body: 'Written before v0.2.0 in a per-workspace journal.',
    author: { sessionId: 'session-legacy', title: 'Legacy session', origin: 'agent' },
  })
  await store.close()
  return stored.id
}

before(async () => {
  paths.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'confluence-universal-'))
  paths.projectA = path.join(paths.dir, 'project-a')
  paths.projectB = path.join(paths.dir, 'project-b')
  paths.legacyDir = path.join(paths.dir, 'legacy-project')
  paths.store = path.join(paths.dir, 'store')
  await fs.mkdir(paths.projectA, { recursive: true })
  await fs.mkdir(paths.projectB, { recursive: true })
  await fs.mkdir(paths.legacyDir, { recursive: true })

  paths.legacyEntryId = await seedLegacyWorkspace()

  const { ctx } = createFakeCtx()
  const originResolver = createOriginResolver({ workingDirectory: { get: () => undefined }, fs })
  services = await applyWithDeps(
    ctx,
    { store: { dir: paths.store, pollMs: 4000 }, privacy: { privateSessions: ['session-private'] } },
    { originResolver },
  )
})

after(async () => {
  try {
    if (services && typeof services.disposeAsync === 'function') {
      await Promise.race([services.disposeAsync(), new Promise((resolve) => setTimeout(resolve, 3000))])
    }
  } catch {
    // Teardown is best-effort.
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  try {
    if (paths.dir !== '') await fs.rm(paths.dir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup.
  }
})

test('INT-01 activation registers six tools, one global pulse and three panel routes', () => {
  assert.deepEqual(
    [...captured.tools.keys()].sort(),
    [
      'confluence_board',
      'confluence_post',
      'confluence_read',
      'confluence_recall',
      'confluence_reply',
      'confluence_search',
    ],
  )
  assert.equal(captured.prompts.length, 1)
  assert.equal(captured.prompts[0].name, 'confluence:pulse')
  assert.equal(captured.prompts[0].interpolate, false)
  assert.equal(captured.prompts[0].required, false)
  assert.deepEqual([...captured.routes.keys()].sort(), [
    '/confluence/panel/entry',
    '/confluence/panel/overview',
    '/confluence/panel/ping',
  ])
  assert.equal(services.scope.key, 'global')
  assert.equal(services.globalScopeKey, GLOBAL_SCOPE_KEY)
})

test('INT-02 a post from workspace A is visible to a session in workspace B (universal memory)', async () => {
  const agentA = fakeAgent(fakeSession('session-a', paths.projectA))
  const agentB = fakeAgent(fakeSession('session-b', paths.projectB))
  emit('agent/created', { agent: agentA })
  emit('agent/created', { agent: agentB })
  await services.services.facade.ensureReady(agentA)
  await services.services.facade.ensureReady(agentB)
  services.services.pulse.refresh()

  const posted = await exec('confluence_post', agentA, {
    kind: 'gotcha',
    title: 'Universal memory gotcha',
    body: 'Published from project-a and visible from project-b.',
    tags: ['universal', 'e2e'],
    files: ['src/universal.ts'],
  })
  assert.match(posted.id, /^cnf_[0-9A-HJKMNP-TV-Z]{26}$/)

  const view = services.services.facade.boardView(agentB)
  const titles = view.entries.map((entry) => entry.title)
  assert.ok(titles.includes('Universal memory gotcha'), 'session B board misses session A note')
  const entry = view.entries.find((row) => row.title === 'Universal memory gotcha')
  assert.equal(entry.workspaceLabel, 'project-a', 'provenance label is the source workspace basename')
  assert.equal(entry.authorTitle, 'title:session-a')

  // The one global journal holds the record (universal scope directory).
  const globalDir = path.join(paths.store, 'workspaces', GLOBAL_SCOPE_KEY)
  const files = await fs.readdir(globalDir)
  assert.ok(files.some((name) => /^journal\.[0-9]+-[0-9a-f]{8}\.v1\.jsonl$/.test(name)))

  // A tool call from B renders the same note.
  const board = await exec('confluence_board', agentB, { limit: 5 })
  const rendered = JSON.stringify(tool('confluence_board').output.render({ limit: 5 }, board))
  assert.match(rendered, /Universal memory gotcha/)
  assert.match(rendered, /through=[0-9A-HJKMNP-TV-Z]{26}/)
})

test('INT-03 legacy per-workspace v1 data is merged read-only with provenance', async () => {
  const agentB = fakeAgent(fakeSession('session-b2', paths.projectB))
  emit('agent/created', { agent: agentB })
  await services.services.facade.ensureReady(agentB)
  const view = services.services.facade.boardView(agentB)
  const legacy = view.entries.find((row) => row.title === 'Legacy workspace decision')
  assert.ok(legacy, 'legacy v1 entry is missing from the universal board')
  assert.equal(legacy.workspaceLabel, 'legacy-project')
  const thread = await exec('confluence_read', agentB, { ref: paths.legacyEntryId })
  assert.match(JSON.stringify(thread), /Legacy workspace decision/)
})

test('INT-04 the passive pulse is global and names the source session/entry', async () => {
  const agentB = fakeAgent(fakeSession('session-b3', paths.projectB))
  emit('agent/created', { agent: agentB })
  await services.services.facade.ensureReady(agentB)
  services.services.pulse.refresh()
  const pulseText = captured.prompts[0].text({ agent: agentB })
  assert.match(pulseText, /<confluence-memory[^>]*scope="global"/)
  assert.match(pulseText, /Universal memory gotcha/)
  assert.doesNotMatch(pulseText, /<confluence-workspace/)
})

test('INT-05 reply/resolve works on the universal board', async () => {
  const agentA = fakeAgent(fakeSession('session-a2', paths.projectA))
  const agentB = fakeAgent(fakeSession('session-b4', paths.projectB))
  emit('agent/created', { agent: agentA })
  emit('agent/created', { agent: agentB })
  await services.services.facade.ensureReady(agentA)
  const question = await exec('confluence_post', agentA, {
    kind: 'question',
    title: 'Universal question?',
    body: 'Does this cross workspaces?',
  })
  const reply = await exec('confluence_reply', agentB, {
    id: question.id,
    body: 'Yes, it does.',
    resolves: true,
  })
  assert.equal(reply.resolved, true)
  assert.equal(reply.thread_id, question.id)
  const read = await exec('confluence_read', agentA, { ref: question.id })
  assert.match(JSON.stringify(read), /Yes, it does\./)
})

test('INT-06 panel overview/entry serve one global scope with provenance labels', async () => {
  const overviewRoute = captured.routes.get('/confluence/panel/overview')
  assert.ok(overviewRoute)
  const payload = await callRoute(overviewRoute, '/confluence/panel/overview?limit=50')
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.scope, { key: 'global', label: 'All sessions' })
  assert.ok(Array.isArray(payload.entries))
  const entry = payload.entries.find((row) => row.title === 'Universal memory gotcha')
  assert.ok(entry, 'global note missing from panel overview')
  assert.equal(entry.workspaceLabel, 'project-a')
  assert.equal(entry.body, undefined, 'list view never carries bodies')

  const entryRoute = captured.routes.get('/confluence/panel/entry')
  const detail = await callRoute(entryRoute, `/confluence/panel/entry?id=${encodeURIComponent(paths.legacyEntryId)}`)
  assert.equal(detail.ok, true)
  assert.match(detail.entry.title, /Legacy workspace decision/)
  assert.equal(detail.entry.workspaceLabel, 'legacy-project')
})

test('INT-07 privacy.privateSessions opts a session out of every tool (review R-01)', async () => {
  const privateAgent = fakeAgent(fakeSession('session-private', paths.projectA))
  emit('agent/created', { agent: privateAgent })
  await services.services.facade.ensureReady(privateAgent).catch(() => {})
  const calls = [
    ['confluence_board', { limit: 5 }],
    ['confluence_search', { query: 'legacy' }],
    ['confluence_read', { ref: paths.legacyEntryId }],
    ['confluence_recall', { query: 'legacy' }],
    ['confluence_post', { kind: 'finding', title: 'private write' }],
    ['confluence_reply', { id: paths.legacyEntryId, body: 'private reply' }],
  ]
  for (const [name, args] of calls) {
    await assert.rejects(() => exec(name, privateAgent, args), /private|UNAVAILABLE/i, `${name} must be disabled`)
  }
  assert.throws(() => services.services.facade.boardView(privateAgent), /private/i)
  // Non-private sessions keep working.
  const normal = fakeAgent(fakeSession('session-normal', paths.projectB))
  const board = await exec('confluence_board', normal, { limit: 5 })
  assert.equal(board.workspace, 'All sessions')
})

// ── fake HTTP route invocation ───────────────────────────────────────────

/**
 * @param {{handler: Function}} route
 * @param {string} url
 * @returns {Promise<any>}
 */
async function callRoute(route, url) {
  const parsed = new URL(url, 'http://127.0.0.1')
  const req = {
    method: 'GET',
    url: `${parsed.pathname}${parsed.search}`,
    headers: { host: '127.0.0.1', origin: 'http://127.0.0.1', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const chunks = []
  let statusCode = 200
  const res = {
    get statusCode() {
      return statusCode
    },
    set statusCode(value) {
      statusCode = value
    },
    setHeader() {},
    end(body) {
      if (body !== undefined) chunks.push(Buffer.from(body))
    },
    write(body) {
      chunks.push(Buffer.from(body))
    },
  }
  await route.handler(req, res)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
