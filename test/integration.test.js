// Confluence / 汇流 — end-to-end wiring test (Lead-owned).
//
// Drives the real plugin modules through a fake Cordis context + fake host
// services (tools, systemPrompt, webServer, agents, sessionQuery) with the real
// filesystem under a temp directory. This proves the wiring contract that unit
// tests cover only piecewise:
//
//   applyWithDeps -> tools.register (six definitions)
//                 -> systemPrompt.context (one pulse registration)
//                 -> webServer.register (four read-only routes)
//   confluence_post (session A) writes a journal entry;
//   confluence_board (session B) sees it and returns a through= cursor;
//   the pulse text for session B lists A's note;
//   a second post is visible through the panel overview payload.
//
// Offline: no network, no DSH packages, Node builtins only.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { applyWithDeps } from '../index.js'

const WORKSPACE_KEY = `ws_${'a'.repeat(16)}`

/** @type {{dir: string, project: string, store: string}} */
const paths = { dir: '', project: '', store: '' }

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
    workingDirectory: { get: () => paths.project },
    sessionQuery: {
      async listSessions() {
        return []
      },
      async readTitle() {
        return { title: 'fixture session' }
      },
      async filterEvents() {
        return []
      },
      async readEvent() {
        return { events: [] }
      },
    },
    sessionTitle: { get: () => 'fixture session' },
  }

  const ctx = {
    get(name) {
      return host[name]
    },
    // A real Cordis context exposes injected services as properties as well as
    // through get(); modules use both forms.
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
    effect(callback, label) {
      const disposer = callback()
      const wrapped = () => {
        try {
          if (typeof disposer === 'function') disposer()
        } catch {
          // ignore
        }
      }
      captured.disposers.push(wrapped)
      return wrapped
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  return { ctx, host }
}

/** @param {string} id @returns {object} */
function fakeSession(id) {
  return {
    id,
    header: { id, cwd: paths.project, isSeeded: false },
    snapshotEvents() {
      return []
    },
    seq: 0,
  }
}

/** @param {string} id @returns {object} */
function fakeAgent(id) {
  return { id, session: fakeSession(id), status: 'idle' }
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

before(async () => {
  paths.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'confluence-integration-'))
  paths.project = path.join(paths.dir, 'project')
  paths.store = path.join(paths.dir, 'store')
  await fs.mkdir(paths.project, { recursive: true })

  const { ctx } = createFakeCtx()
  const workspaceResolver = {
    async resolve() {
      return { key: WORKSPACE_KEY, canonicalPath: paths.project, label: 'project' }
    },
  }
  const { resolveConfig } = await import('../lib/config.js')
  const { config } = resolveConfig({ store: { dir: paths.store, pollMs: 4000 } })
  services = await applyWithDeps(ctx, config, { workspaceResolver })
})

after(async () => {
  try {
    if (services && typeof services.disposeAsync === 'function') {
      // Bound teardown so a stuck watcher can never hang the test process forever.
      await Promise.race([services.disposeAsync(), new Promise((resolve) => setTimeout(resolve, 3000))])
    } else if (services && typeof services.dispose === 'function') {
      services.dispose()
    }
  } catch {
    // Teardown is best-effort.
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  try {
    if (paths.dir !== '') await fs.rm(paths.dir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup of the temp tree.
  }
})

test('INT-01 activation registers six tools, one pulse context and four panel routes', () => {
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
  assert.deepEqual(
    [...captured.routes.keys()].sort(),
    ['/confluence/panel/entry', '/confluence/panel/overview', '/confluence/panel/ping', '/confluence/panel/workspaces'],
  )
})

test('INT-02 a post from session A is visible to session B and returns a through cursor', async () => {
  const agentA = fakeAgent('session-a')
  const agentB = fakeAgent('session-b')
  emit('agent/created', { agent: agentA })
  emit('agent/created', { agent: agentB })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const posted = await exec('confluence_post', agentA, {
    kind: 'gotcha',
    title: 'Windows rename retries wrap in EPERM',
    body: 'Wrap rename in a retry loop because scanners hold handles.',
    tags: ['windows', 'fs'],
    files: ['src/fs/rename.ts'],
  })
  assert.equal(typeof posted.id, 'string')
  assert.match(posted.id, /^cnf_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.equal(posted.kind, 'gotcha')

  const board = await exec('confluence_board', agentB, { limit: 5 })
  const raw = typeof board === 'string' ? board : JSON.stringify(board)
  assert.match(raw, /Windows rename retries wrap in EPERM/)
  const through = board && (board.through ?? board.through_seq)
  assert.match(String(through), /^[0-9A-HJKMNP-TV-Z]{26}$/)
  const rendered = tool('confluence_board').output.render({ limit: 5 }, board)
  assert.match(JSON.stringify(rendered), /Windows rename retries wrap in EPERM/)

  // The journal is on disk under the configured store root.
  const dirs = await fs.readdir(path.join(paths.store, 'workspaces', WORKSPACE_KEY))
  assert.ok(dirs.some((name) => name.startsWith('journal.') && name.endsWith('.v1.jsonl')))

  // Pulse for session B lists A's note (same workspace, different session).
  await new Promise((resolve) => setTimeout(resolve, 50))
  const pulseText = captured.prompts[0].text({ agent: agentB })
  assert.match(pulseText, /Windows rename retries wrap in EPERM/)
  assert.match(pulseText, /<confluence-workspace/)
})

test('INT-03 panel overview exposes the post read-only, with no body in the list view', async () => {
  const route = captured.routes.get('/confluence/panel/overview')
  assert.ok(route)
  const payload = await callRoute(route, `/confluence/panel/overview?ws=${WORKSPACE_KEY}`)
  assert.equal(payload.ok, true)
  assert.equal(payload.workspace.key, WORKSPACE_KEY)
  assert.ok(Array.isArray(payload.entries) && payload.entries.length >= 1)
  const titles = payload.entries.map((entry) => entry.title).join('\n')
  assert.match(titles, /Windows rename retries wrap in EPERM/)
  assert.equal(payload.entries[0].body, undefined)
})

test('INT-04 reply resolves a question and both tools share the thread', async () => {
  const agentA = fakeAgent('session-a')
  const agentB = fakeAgent('session-b')
  const question = await exec('confluence_post', agentA, {
    kind: 'question',
    title: 'Does the v2 API still need the legacy flag?',
    body: 'Please confirm before I delete it.',
  })
  const reply = await exec('confluence_reply', agentB, {
    id: question.id,
    body: 'Yes, keep it until 2.1.',
    resolves: true,
  })
  assert.equal(reply.resolved, true)
  assert.equal(reply.thread_id, question.id)

  const read = await exec('confluence_read', agentA, { ref: question.id })
  const raw = typeof read === 'string' ? read : JSON.stringify(read)
  assert.match(raw, /Yes, keep it until 2\.1/)
})

// ── fake HTTP route invocation ───────────────────────────────────────────

/**
 * Invoke a captured `webServer.register({kind,path,handler})` handler with a
 * minimal IncomingMessage/ServerResponse pair and return the parsed JSON body.
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
  const headers = {}
  const res = {
    get statusCode() {
      return statusCode
    },
    set statusCode(value) {
      statusCode = value
    },
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.from(body))
    },
    write(body) {
      chunks.push(Buffer.from(body))
    },
  }
  await route.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text)
}



