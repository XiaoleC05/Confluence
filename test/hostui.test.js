// Confluence / 高级记忆 — v0.2.0 tests: Host UI routes (lib/hostui.js) and the Web panel
// client half (client.js), both universal-memory (ADR-0007) read-only surfaces.
// Dependency-free: node:test + node:assert/strict + node:vm.
//
// Coverage:
//   WO-01..WO-18  hostui registration, three routes, guards, global payload shapes
//                 (no workspace parameter), provenance labels, caps, error mapping
//   UI-01..UI-05  client ModuleLoader contract, three-route/global timeline rendering,
//                 static read-only/offline scan, shipped-locale key coverage
//
// Run from the repository root: node --test --test-force-exit "test/hostui.test.js"

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

import {
  HOSTUI_PREFIX,
  MAX_RESPONSE_BYTES,
  PANEL_SCOPE,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  hostuiInternals,
  registerHostUi,
} from '../lib/hostui.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_PATH = path.join(ROOT, 'client.js')
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8')
const ROUTE_PATHS = {
  ping: `${HOSTUI_PREFIX}/ping`,
  overview: `${HOSTUI_PREFIX}/overview`,
  entry: `${HOSTUI_PREFIX}/entry`,
}
const REMOVED_WORKSPACES_ROUTE = `${HOSTUI_PREFIX}/workspaces`
const WS_KEY = 'ws_0123456789abcdef'
const ENTRY_ID = 'cnf_01JBQ8Z4K1H9T2R6N4X7C0W8FD'

// ---------------------------------------------------------------------------
// fake Host environment
// ---------------------------------------------------------------------------

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    ended: false,
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = String(value)
    },
    end(chunk) {
      this.ended = true
      if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    },
  }
}

function createReq({ method = 'GET', url = '/', headers = {} } = {}) {
  return { method, url, headers }
}

function createWebServer() {
  const routes = new Map()
  return {
    routes,
    register({ kind, path: routePath, handler }) {
      assert.equal(kind, 'exact')
      assert.equal(typeof handler, 'function')
      assert.equal(routes.has(routePath), false, `duplicate route ${routePath}`)
      routes.set(routePath, handler)
      return () => routes.delete(routePath)
    },
    getOrigin() {
      return 'http://127.0.0.1:53074'
    },
  }
}

function createLogger() {
  const lines = []
  const record = (level) => (...args) => lines.push({ level, args })
  return { lines, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') }
}

function createCtx({ webServer, connection, logger } = {}) {
  const effects = []
  const ctx = {
    webServer,
    effects,
    logger: logger ?? createLogger(),
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'connection') return connection
      return undefined
    },
    effect(fn, label) {
      effects.push(label)
      const cleanup = fn()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
  return ctx
}

/** Global overview shape the updated facade returns (no workspace header). */
function emptyOverview() {
  return { scope: { key: 'global', label: 'All sessions' }, entries: [], stats: {}, peers: [], truncated: false }
}

function createFacade(data = {}) {
  const calls = []
  const has = (key) => Object.prototype.hasOwnProperty.call(data, key)
  const facade = {
    calls,
    async overview(requested) {
      calls.push(['overview', requested])
      return has('overview') ? data.overview : emptyOverview()
    },
    async entry(id) {
      calls.push(['entry', id])
      return has('entry') ? data.entry : null
    },
    // v0.1.0 surface that must no longer be used by the panel.
    async listWorkspaces() {
      calls.push(['listWorkspaces'])
      throw new Error('workspace listing must not be used by the global panel')
    },
  }
  return facade
}

function routeHandler(webServer, routePath) {
  const handler = webServer.routes.get(routePath)
  assert.equal(typeof handler, 'function', `route not registered: ${routePath}`)
  return handler
}

async function invoke(webServer, routePath, { method = 'GET', headers = {}, query } = {}) {
  const handler = routeHandler(webServer, routePath)
  const search = query === undefined ? '' : new URLSearchParams(query).toString()
  const req = createReq({ method, url: routePath + (search === '' ? '' : '?' + search), headers })
  const res = createRes()
  await handler(req, res)
  const json = res.body === '' ? null : JSON.parse(res.body)
  return { res, json }
}

function mount(data, { connection, logger, config, facade } = {}) {
  const webServer = createWebServer()
  const ctx = createCtx({ webServer, connection, logger })
  const usedFacade = facade ?? createFacade(data)
  const dispose = registerHostUi(ctx, {
    facade: usedFacade,
    config: config ?? { ui: { enabled: true } },
    logger: logger ?? ctx.logger,
  })
  return { webServer, ctx, facade: usedFacade, dispose }
}

function summaryKeys(entry) {
  return Object.keys(entry).sort()
}

function makeEntryId(index) {
  return `cnf_${String(index).padStart(26, '0')}`
}

// ---------------------------------------------------------------------------
// WO: Host UI route registration and guards
// ---------------------------------------------------------------------------

test('WO-01 registerHostUi returns a no-op disposer when webServer is absent', () => {
  const ctx = createCtx({ webServer: undefined })
  const facade = createFacade()
  const dispose = registerHostUi(ctx, { facade, config: { ui: { enabled: true } }, logger: ctx.logger })
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
  assert.doesNotThrow(() => dispose())
  assert.deepEqual(ctx.effects, [])
  assert.equal(ctx.logger.lines.some((line) => line.level === 'debug'), true)
})

test('WO-02 registerHostUi returns a no-op without a facade', () => {
  const webServer = createWebServer()
  const ctx = createCtx({ webServer })
  const dispose = registerHostUi(ctx, { config: { ui: { enabled: true } }, logger: ctx.logger })
  assert.equal(typeof dispose, 'function')
  assert.equal(webServer.routes.size, 0)
  dispose()
})

test('WO-03 registerHostUi mounts nothing when ui.enabled is false', () => {
  const mounted = mount({}, { config: { ui: { enabled: false } } })
  assert.equal(mounted.webServer.routes.size, 0)
  assert.doesNotThrow(() => mounted.dispose())
})

test('WO-04 registers exactly the three global routes and disposes them idempotently', () => {
  const mounted = mount({})
  assert.deepEqual([...mounted.webServer.routes.keys()].sort(), Object.values(ROUTE_PATHS).sort())
  assert.equal(mounted.webServer.routes.has(REMOVED_WORKSPACES_ROUTE), false, 'the /workspaces route must be gone')
  assert.equal(mounted.ctx.effects.length, 3)
  mounted.dispose()
  assert.equal(mounted.webServer.routes.size, 0)
  assert.doesNotThrow(() => mounted.dispose())
})

test('WO-05 ping is unchanged: fixed shape, no-store JSON, HEAD support', async () => {
  const mounted = mount({})
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.ping)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.deepEqual(json, { ok: true, name: PLUGIN_NAME, version: PLUGIN_VERSION })

  const head = await invoke(mounted.webServer, ROUTE_PATHS.ping, { method: 'HEAD' })
  assert.equal(head.res.statusCode, 200)
  assert.equal(head.res.body, '')
  assert.equal(head.res.headers['cache-control'], 'no-store')
  assert.equal(Number(head.res.headers['content-length']) > 0, true)
  mounted.dispose()
})

test('WO-06 rejects non-GET methods with 405 and an Allow header', async () => {
  const mounted = mount({})
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const routePath of [ROUTE_PATHS.overview, ROUTE_PATHS.entry]) {
      const { res } = await invoke(mounted.webServer, routePath, { method })
      assert.equal(res.statusCode, 405, `${method} must be rejected on ${routePath}`)
      assert.equal(res.headers.allow, 'GET, HEAD')
      assert.equal(res.ended, true)
    }
  }
  assert.equal(mounted.facade.calls.length, 0, 'guarded requests must not touch the facade')
  mounted.dispose()
})

test('WO-07 the optional connection fence answers before routing', async () => {
  const connection = { requestRejection: (req) => (req.headers['x-fence'] === '1' ? 403 : undefined) }
  const mounted = mount({}, { connection })
  const fenced = await invoke(mounted.webServer, ROUTE_PATHS.overview, { headers: { 'x-fence': '1' } })
  assert.equal(fenced.res.statusCode, 403)
  assert.equal(mounted.facade.calls.length, 0)
  const allowed = await invoke(mounted.webServer, ROUTE_PATHS.ping)
  assert.equal(allowed.res.statusCode, 200)
  mounted.dispose()
})

test('WO-08 rejects foreign Origin and cross-site Sec-Fetch-Site', async () => {
  const mounted = mount({})
  const foreign = await invoke(mounted.webServer, ROUTE_PATHS.ping, {
    headers: { origin: 'https://evil.example', host: '127.0.0.1:53074' },
  })
  assert.equal(foreign.res.statusCode, 403)
  assert.equal(foreign.json.error.code, 'CONFLUENCE_FOREIGN_ORIGIN')

  const crossSite = await invoke(mounted.webServer, ROUTE_PATHS.ping, {
    headers: { 'sec-fetch-site': 'cross-site', host: '127.0.0.1:53074' },
  })
  assert.equal(crossSite.res.statusCode, 403)

  const sameOrigin = await invoke(mounted.webServer, ROUTE_PATHS.ping, {
    headers: { origin: 'http://127.0.0.1:53074', host: '127.0.0.1:53074', 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(sameOrigin.res.statusCode, 200)
  mounted.dispose()
})

// ---------------------------------------------------------------------------
// WO: global payload contract (no workspace parameter anywhere)
// ---------------------------------------------------------------------------

test('WO-09 overview serves one global timeline with provenance labels only', async () => {
  const overview = {
    // A stale/facade-supplied workspace header must never reach the panel.
    scope: { key: 'ws_0123456789abcdef', label: 'leaky workspace' },
    entries: [
      {
        id: ENTRY_ID,
        seq: '01JBQ8Z4K1',
        kind: 'gotcha',
        title: 'Windows rename retries',
        authorTitle: 'Auth work',
        workspaceLabel: 'D:\\05_Code\\solo-bench',
        ts: '2026-11-13T03:55:00.000Z',
        status: 'open',
        replyCount: 2,
        body: 'SECRET BODY',
        preview: 'SECRET PREVIEW',
        author: { sessionId: 'session-x' },
        ws: WS_KEY,
      },
      {
        id: makeEntryId(2),
        seq: '01JBQ8Z4K2',
        kind: 'finding',
        title: 'No direct label',
        authorTitle: 'Data migration',
        origin: { workspaceKey: WS_KEY, workspaceLabel: 'C:\\work\\auth-service' },
        ts: '2026-11-13T03:56:00.000Z',
        status: 'active',
        replyCount: 0,
      },
      {
        id: ENTRY_ID,
        seq: '01JBQ8Z4K3',
        kind: 'warning',
        title: 'duplicate id must be dropped',
        authorTitle: 'x',
        ts: '2026-11-13T03:57:00.000Z',
      },
      {
        id: 'tmb_01JBQ8Z4K1H9T2R6N4X7C0W8FD',
        seq: '01JBQ8Z4K4',
        kind: 'warning',
        title: 'invalid id must be dropped',
      },
    ],
    stats: { total: 12, openQuestions: 2, openHandoffs: 1, unread: 7 },
    peers: [
      { title: 'Auth work', status: 'running', sessionId: 'session-x', workspaceLabel: 'C:\\work\\auth-service' },
      { title: 'Docs', status: 'idle', origin: { workspaceLabel: 'docs-site' } },
      { title: '', status: 'running' },
      { title: 'Odd status', status: 'weird' },
    ],
    truncated: true,
  }
  const mounted = mount({ overview })
  // `ws` is a stale v0.1.0 query parameter: ignored, never forwarded.
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.overview, {
    query: { ws: WS_KEY, q: 'rename', kind: 'gotcha', limit: '10' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(json.scope, { key: 'global', label: 'All sessions' })
  assert.deepEqual(json.scope, PANEL_SCOPE)
  assert.equal(json.entries.length, 2)
  assert.deepEqual(json.entries[0], {
    id: ENTRY_ID,
    seq: '01JBQ8Z4K1',
    kind: 'gotcha',
    title: 'Windows rename retries',
    authorTitle: 'Auth work',
    workspaceLabel: 'solo-bench',
    ts: '2026-11-13T03:55:00.000Z',
    status: 'open',
    replyCount: 2,
  })
  assert.deepEqual(summaryKeys(json.entries[0]), [
    'authorTitle', 'id', 'kind', 'replyCount', 'seq', 'status', 'title', 'ts', 'workspaceLabel',
  ])
  assert.deepEqual(summaryKeys(json.entries[1]), [
    'authorTitle', 'id', 'kind', 'replyCount', 'seq', 'status', 'title', 'ts', 'workspaceLabel',
  ])
  assert.equal(json.entries[1].workspaceLabel, 'auth-service')
  assert.deepEqual(json.stats, { total: 12, openQuestions: 2, openHandoffs: 1, unread: 0 })
  assert.deepEqual(json.peers, [
    { title: 'Auth work', status: 'running', workspaceLabel: 'auth-service' },
    { title: 'Docs', status: 'idle', workspaceLabel: 'docs-site' },
    { title: 'Odd status', status: 'unknown' },
  ])
  assert.equal(json.truncated, true)
  const serialized = JSON.stringify(json)
  assert.equal(serialized.includes('SECRET'), false)
  assert.equal(serialized.includes(WS_KEY), false, 'no workspace key may leak into the global payload')
  assert.equal(serialized.includes('solo-bench\\'), false, 'labels are basenames only')
  assert.equal(serialized.includes('C:\\\\work'), false, 'no absolute path may leak into the global payload')
  assert.deepEqual(mounted.facade.calls[0], ['overview', { q: 'rename', kind: 'gotcha', limit: 10 }])
  mounted.dispose()
})

test('WO-10 overview forwards filters without a workspace and caps entries', async () => {
  const entries = []
  for (let index = 0; index < 60; index += 1) {
    entries.push({
      id: makeEntryId(index),
      seq: '01JBQ8Z4K1',
      kind: 'finding',
      title: 't' + String(index),
      authorTitle: 'Session',
      ts: '2026-11-13T03:55:00.000Z',
      status: 'active',
      replyCount: 0,
    })
  }
  const mounted = mount({ overview: { entries, stats: {}, peers: [], truncated: false } })

  const defaults = await invoke(mounted.webServer, ROUTE_PATHS.overview)
  assert.equal(defaults.res.statusCode, 200)
  assert.equal(defaults.json.entries.length, 20, 'the default page size is 20')
  assert.deepEqual(defaults.json.scope, { key: 'global', label: 'All sessions' })
  assert.deepEqual(defaults.json.stats, { total: 0, openQuestions: 0, openHandoffs: 0, unread: 0 })
  assert.deepEqual(defaults.json.peers, [])
  assert.equal(defaults.json.truncated, true, 'dropping entries must be explicit')
  assert.deepEqual(mounted.facade.calls[0], ['overview', { q: '', kind: undefined, limit: 20 }])
  assert.equal(Object.prototype.hasOwnProperty.call(mounted.facade.calls[0][1], 'ws'), false)

  const unknownKind = await invoke(mounted.webServer, ROUTE_PATHS.overview, { query: { kind: 'not-a-kind' } })
  assert.equal(unknownKind.res.statusCode, 200)
  assert.deepEqual(mounted.facade.calls[1], ['overview', { q: '', kind: undefined, limit: 20 }])

  const capped = await invoke(mounted.webServer, ROUTE_PATHS.overview, { query: { limit: '9999' } })
  assert.equal(capped.json.entries.length, 50)
  assert.equal(capped.json.truncated, true)
  assert.deepEqual(mounted.facade.calls[2], ['overview', { q: '', kind: undefined, limit: 50 }])

  const floor = await invoke(mounted.webServer, ROUTE_PATHS.overview, { query: { limit: '0', q: 'x' } })
  assert.deepEqual(mounted.facade.calls[3], ['overview', { q: 'x', kind: undefined, limit: 1 }])
  assert.equal(floor.json.entries.length, 1)
  mounted.dispose()
})

test('WO-11 overview maps facade rejections to stable panel errors', async () => {
  const mounted = mount({})
  const unavailableFacade = createFacade()
  unavailableFacade.overview = async () => {
    const error = new Error('store is unavailable')
    error.code = 'STORE_UNAVAILABLE'
    throw error
  }
  const unavailable = mount({}, { facade: unavailableFacade })
  const unavailableResult = await invoke(unavailable.webServer, ROUTE_PATHS.overview)
  assert.equal(unavailableResult.res.statusCode, 503)
  assert.equal(unavailableResult.json.error.code, 'CONFLUENCE_STORE_UNAVAILABLE')

  const invalidFacade = createFacade()
  invalidFacade.overview = async () => {
    const error = new Error('bad filter')
    error.code = 'BAD_ARGUMENT'
    throw error
  }
  const invalid = mount({}, { facade: invalidFacade })
  const invalidResult = await invoke(invalid.webServer, ROUTE_PATHS.overview)
  assert.equal(invalidResult.res.statusCode, 400)
  assert.equal(invalidResult.json.error.code, 'CONFLUENCE_INVALID_ARGUMENT')

  const genericFacade = createFacade()
  genericFacade.overview = async () => {
    throw new Error('unexpected\nfailure at C:\\secret\\path')
  }
  const generic = mount({}, { facade: genericFacade })
  const failed = await invoke(generic.webServer, ROUTE_PATHS.overview)
  assert.equal(failed.res.statusCode, 500)
  assert.equal(failed.json.error.code, 'CONFLUENCE_INTERNAL')
  assert.equal(failed.json.error.message.includes('\n'), false)

  const nullFacade = createFacade()
  nullFacade.overview = async () => null
  const nullMounted = mount({}, { facade: nullFacade })
  const nullResult = await invoke(nullMounted.webServer, ROUTE_PATHS.overview)
  assert.equal(nullResult.res.statusCode, 503)
  assert.equal(nullResult.json.error.code, 'CONFLUENCE_STORE_UNAVAILABLE')

  const missingFacade = createFacade()
  delete missingFacade.overview
  const missing = mount({}, { facade: missingFacade })
  const missingResult = await invoke(missing.webServer, ROUTE_PATHS.overview)
  assert.equal(missingResult.res.statusCode, 503)

  mounted.dispose()
  unavailable.dispose()
  invalid.dispose()
  generic.dispose()
  nullMounted.dispose()
  missing.dispose()
})

test('WO-12 entry is a global id lookup with body, relative files, provenance and bounded replies', async () => {
  const replies = []
  for (let index = 0; index < 60; index += 1) {
    const reply = {
      id: makeEntryId(index),
      seq: '01JBQ8Z4K2',
      body: 'reply ' + String(index),
      authorTitle: 'Data migration',
      ts: '2026-11-13T03:56:00.000Z',
    }
    if (index === 0) reply.workspaceLabel = 'C:\\work\\auth-service'
    if (index === 1) reply.origin = { workspaceLabel: 'docs-site' }
    replies.push(reply)
  }
  const mounted = mount({
    entry: {
      entry: {
        id: ENTRY_ID,
        seq: '01JBQ8Z4K1',
        kind: 'finding',
        title: 'Index retries',
        body: 'Body\u0000text\nsecond line',
        tags: ['windows', 'WINDOWS', 'io'],
        files: ['D:\\work\\src\\win\\rename.ts', '\\\\server\\share\\x.ts', '../escape.ts', 'src/auth/index.ts'],
        authorTitle: 'Auth work',
        workspaceLabel: 'C:\\work\\auth-service',
        ts: '2026-11-13T03:55:00.000Z',
        status: 'active',
        origin: { workspaceKey: WS_KEY, workspaceLabel: 'must-not-win' },
      },
      replies,
    },
  })
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.entry, {
    query: { ws: WS_KEY, id: ENTRY_ID },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(mounted.facade.calls[0], ['entry', ENTRY_ID])
  assert.deepEqual(summaryKeys(json.entry), [
    'authorTitle', 'body', 'files', 'id', 'kind', 'seq', 'status', 'tags', 'title', 'ts', 'workspaceLabel',
  ])
  assert.equal(json.entry.workspaceLabel, 'auth-service')
  assert.equal(json.entry.body.includes('\u0000'), false)
  assert.equal(json.entry.body.includes('\n'), true)
  assert.deepEqual(json.entry.tags, ['windows', 'io'])
  assert.deepEqual(json.entry.files, ['work/src/win/rename.ts', 'src/auth/index.ts'])
  assert.equal(json.replies.length, 50)
  assert.deepEqual(summaryKeys(json.replies[0]), ['authorTitle', 'body', 'id', 'seq', 'ts', 'workspaceLabel'])
  assert.equal(json.replies[0].workspaceLabel, 'auth-service')
  assert.deepEqual(summaryKeys(json.replies[1]), ['authorTitle', 'body', 'id', 'seq', 'ts', 'workspaceLabel'])
  assert.equal(json.replies[1].workspaceLabel, 'docs-site')
  assert.deepEqual(summaryKeys(json.replies[2]), ['authorTitle', 'body', 'id', 'seq', 'ts'])
  const serialized = JSON.stringify(json)
  assert.equal(serialized.includes(WS_KEY), false)
  assert.equal(serialized.includes('C:\\\\work'), false)
  mounted.dispose()
})

test('WO-13 missing or malformed entry ids return 400/404', async () => {
  const mounted = mount({})
  const missing = await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { ws: WS_KEY } })
  assert.equal(missing.res.statusCode, 400)

  const malformed = await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { ws: WS_KEY, id: 'nope' } })
  assert.equal(malformed.res.statusCode, 404)

  const absent = await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { ws: WS_KEY, id: ENTRY_ID } })
  assert.equal(absent.res.statusCode, 404)
  assert.equal(absent.json.error.code, 'CONFLUENCE_NOT_FOUND')
  mounted.dispose()
})

test('WO-14 entry route enforces the 64 KiB cap with explicit truncation', async () => {
  const bigReplies = []
  for (let index = 0; index < 50; index += 1) {
    bigReplies.push({
      id: makeEntryId(index),
      seq: '01JBQ8Z4K2',
      body: 'r'.repeat(4096),
      authorTitle: 'Session',
      ts: '2026-11-13T03:56:00.000Z',
    })
  }
  const mounted = mount({
    entry: {
      entry: {
        id: ENTRY_ID,
        seq: '01JBQ8Z4K1',
        kind: 'finding',
        title: 'Huge note',
        body: 'b'.repeat(200_000),
        tags: [],
        files: [],
        authorTitle: 'Auth work',
        ts: '2026-11-13T03:55:00.000Z',
        status: 'active',
      },
      replies: bigReplies,
    },
  })
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { id: ENTRY_ID } })
  assert.equal(res.statusCode, 200)
  assert.ok(Buffer.byteLength(res.body, 'utf8') <= MAX_RESPONSE_BYTES, 'response must stay under the cap')
  assert.ok(json.entry.body.length < 200_000)
  assert.equal(json.truncated, true)
  mounted.dispose()
})

test('WO-15 only the two global read facade methods are called (no workspace listing, no writes)', async () => {
  const calls = []
  const facade = {
    calls,
    async overview(requested) {
      calls.push(['overview', requested])
      return emptyOverview()
    },
    async entry(id) {
      calls.push(['entry', id])
      return { entry: null, replies: [] }
    },
    async listWorkspaces() {
      calls.push(['listWorkspaces'])
      throw new Error('must not be called')
    },
    async post() {
      calls.push(['post'])
      throw new Error('write method must not be called')
    },
  }
  const mounted = mount({}, { facade })
  await invoke(mounted.webServer, ROUTE_PATHS.ping)
  await invoke(mounted.webServer, ROUTE_PATHS.overview)
  await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { id: ENTRY_ID } })
  const methods = new Set(mounted.facade.calls.map((call) => call[0]))
  assert.deepEqual([...methods].sort(), ['entry', 'overview'])
  mounted.dispose()
})

test('WO-16 invalid facade shapes degrade to stable errors, never a crash', async () => {
  const nullFacade = createFacade()
  nullFacade.overview = async () => null
  const nullMounted = mount({}, { facade: nullFacade })
  const nullResult = await invoke(nullMounted.webServer, ROUTE_PATHS.overview)
  assert.equal(nullResult.res.statusCode, 503)
  assert.equal(nullResult.json.error.code, 'CONFLUENCE_STORE_UNAVAILABLE')

  const listFacade = createFacade()
  listFacade.overview = async () => []
  const listMounted = mount({}, { facade: listFacade })
  const listResult = await invoke(listMounted.webServer, ROUTE_PATHS.overview)
  assert.equal(listResult.res.statusCode, 200)
  assert.deepEqual(listResult.json.entries, [])

  const badEntryFacade = createFacade()
  badEntryFacade.entry = async () => ({ entry: 'not-an-object', replies: [] })
  const badEntry = mount({}, { facade: badEntryFacade })
  const badEntryResult = await invoke(badEntry.webServer, ROUTE_PATHS.entry, { query: { id: ENTRY_ID } })
  assert.equal(badEntryResult.res.statusCode, 404)

  nullMounted.dispose()
  listMounted.dispose()
  badEntry.dispose()
})

test('WO-17 logger failures never break a response', async () => {
  const throwingLogger = {
    debug() {
      throw new Error('logger exploded')
    },
    info() {
      throw new Error('logger exploded')
    },
    warn() {
      throw new Error('logger exploded')
    },
    error() {
      throw new Error('logger exploded')
    },
  }
  const mounted = mount({}, { logger: throwingLogger })
  const ping = await invoke(mounted.webServer, ROUTE_PATHS.ping)
  assert.equal(ping.res.statusCode, 200)
  const overview = await invoke(mounted.webServer, ROUTE_PATHS.overview)
  assert.equal(overview.res.statusCode, 200)
  mounted.dispose()
})

test('WO-18 helpers keep provenance to basenames and enforce the global payload contract', () => {
  assert.equal(hostuiInternals.cleanRelativePath('D:\\work\\src\\a.ts'), 'work/src/a.ts')
  assert.equal(hostuiInternals.cleanRelativePath('/work/src/b.ts'), 'work/src/b.ts')
  assert.equal(hostuiInternals.cleanRelativePath('\\\\server\\share\\c.ts'), '')
  assert.equal(hostuiInternals.cleanRelativePath('../d.ts'), '')
  assert.equal(hostuiInternals.cleanRelativePath('src\\..\\e.ts'), '')
  assert.equal(hostuiInternals.cleanRelativePath('src/f.ts'), 'src/f.ts')

  assert.equal(hostuiInternals.cleanProvenanceLabel('C:\\work\\auth-service'), 'auth-service')
  assert.equal(hostuiInternals.cleanProvenanceLabel('/home/me/docs-site'), 'docs-site')
  assert.equal(hostuiInternals.cleanProvenanceLabel('solo-bench'), 'solo-bench')
  assert.equal(hostuiInternals.cleanProvenanceLabel(''), '')
  assert.equal(hostuiInternals.cleanProvenanceLabel('..'), '')

  const withOrigin = hostuiInternals.normalizeEntrySummary({
    id: ENTRY_ID,
    seq: 's',
    kind: 'finding',
    title: 't',
    ts: '2026-11-13T03:55:00.000Z',
    origin: { workspaceKey: WS_KEY, workspaceLabel: 'C:\\work\\auth-service' },
  })
  assert.equal(withOrigin.workspaceLabel, 'auth-service')
  const withoutOrigin = hostuiInternals.normalizeEntrySummary({
    id: ENTRY_ID,
    seq: 's',
    kind: 'finding',
    title: 't',
    ts: '2026-11-13T03:55:00.000Z',
  })
  assert.equal(Object.prototype.hasOwnProperty.call(withoutOrigin, 'workspaceLabel'), false)
  assert.deepEqual(hostuiInternals.normalizeStats({ unread: 9, total: 4 }), {
    total: 4,
    openQuestions: 0,
    openHandoffs: 0,
    unread: 0,
  })
  assert.deepEqual(hostuiInternals.normalizePeers([{ title: 'p', status: 'running', workspaceLabel: 'C:\\x\\y' }]), [
    { title: 'p', status: 'running', workspaceLabel: 'y' },
  ])

  const oversized = hostuiInternals.fitPayload('overview', {
    ok: true,
    scope: { key: 'global', label: 'All sessions' },
    entries: Array.from({ length: 50 }, (_, index) => ({
      id: makeEntryId(index),
      seq: '',
      kind: 'finding',
      title: 't'.repeat(200),
      authorTitle: 'a',
      ts: '',
      status: 'active',
      replyCount: 0,
    })),
    stats: {},
    peers: [],
    truncated: false,
  })
  assert.ok(Buffer.byteLength(JSON.stringify(oversized.payload), 'utf8') <= MAX_RESPONSE_BYTES)
  assert.equal(Object.prototype.hasOwnProperty.call(oversized.payload, 'workspace'), false)
  assert.equal(hostuiInternals.ROUTES.map((route) => route.name).sort().join(','), 'entry,overview,ping')
})

// ---------------------------------------------------------------------------
// UI: client module contract
// ---------------------------------------------------------------------------

function loadClientDefinition() {
  const captured = {}
  const window = { __ModuleLoader__: { load: (definition) => { captured.definition = definition } } }
  const sandbox = {
    window,
    console,
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Error,
    RegExp,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
  }
  runInContext(CLIENT_SOURCE, createContext(sandbox), { filename: 'client.js' })
  assert.ok(captured.definition !== undefined, 'client.js must call window.__ModuleLoader__.load')
  return captured.definition
}

function createClientHarness() {
  const registered = []
  const injectedOwners = []
  const localeRegistrations = []
  const effectLabels = []
  const panelSelections = []
  const ctx = {
    slots: {
      inject(ownerKey, factory) {
        injectedOwners.push(ownerKey)
        const value = factory()
        if (value !== null && typeof value === 'object' && typeof value.next === 'function') value.next()
        return () => {}
      },
      register(definition, component) {
        const record = { definition, component }
        registered.push(record)
        return record
      },
    },
    locale: {
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
        return () => {}
      },
      bind: () => (key) => (key === 'panel' ? 'Confluence' : key),
    },
    layout: {
      selectPanel(id) {
        panelSelections.push(id)
      },
    },
    effect(fn, label) {
      effectLabels.push(label)
      const cleanup = fn()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
  const reactShim = {
    createElement: (...args) => ({ type: 'element', args }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
  }
  return { ctx, registered, injectedOwners, localeRegistrations, effectLabels, panelSelections, reactShim }
}

test('UI-01 client.js loads through the ModuleLoader and registers locale + both slots', () => {
  const definition = loadClientDefinition()
  assert.equal(definition.id, 'dsh-confluence')
  assert.equal(typeof definition.factory, 'function')

  const harness = createClientHarness()
  const moduleValue = definition.factory((name) => {
    assert.equal(name, 'react')
    return harness.reactShim
  })
  // Values cross the VM realm boundary, so compare copied host-realm arrays.
  assert.deepEqual([...moduleValue.inject], ['slots', 'locale', 'layout'])
  assert.equal(typeof moduleValue.apply, 'function')
  moduleValue.apply(harness.ctx)

  assert.deepEqual(harness.injectedOwners.sort(), ['main', 'sidebar.panellist'])
  assert.equal(harness.registered.length, 2)

  const rail = harness.registered.find((record) => record.definition.name === 'sidebar.panellist')
  assert.ok(rail !== undefined)
  assert.equal(rail.definition.id, 'confluence')
  assert.equal(rail.definition.order, 30)
  assert.equal(rail.definition.locale, 'confluence')
  assert.equal(rail.definition.label(), 'Confluence')

  const main = harness.registered.find((record) => record.definition.name === 'main')
  assert.ok(main !== undefined)
  assert.equal(main.definition.key, 'confluence')
  assert.equal(main.definition.locale, 'confluence')
  const injectedProps = main.definition.inject()
  assert.equal(typeof injectedProps.t, 'function')
  assert.equal(typeof injectedProps.closePanel, 'function')
  injectedProps.closePanel()
  assert.deepEqual(harness.panelSelections, [null])

  assert.equal(harness.localeRegistrations.length, 1)
  assert.equal(harness.localeRegistrations[0].namespace, 'confluence')
  assert.equal(typeof harness.localeRegistrations[0].dictionaries.en, 'object')
  assert.equal(typeof harness.localeRegistrations[0].dictionaries.zh, 'object')
  assert.deepEqual(harness.effectLabels, ['dsh-confluence:locale'])
})

test('UI-02 client.js is offline, read-only, global-scope only and dependency-free', () => {
  const source = CLIENT_SOURCE
  // The real call site (anchored; comments may mention the loader without calling it).
  assert.equal((source.match(/^window\.__ModuleLoader__\.load\(/gm) ?? []).length, 1)
  assert.equal(source.includes("id: 'dsh-confluence'"), true)
  // Exactly one fetch call site; it is the single relative route adapter (polling).
  assert.equal((source.match(/\bfetch\(/g) ?? []).length, 1)
  assert.equal(source.includes('fetch(ROUTE_BASE'), true)
  assert.equal(source.includes("credentials: 'same-origin'"), true)
  assert.equal(source.includes("cache: 'no-store'"), true)
  assert.equal(source.includes("method: 'GET'"), true)
  assert.equal(source.includes("method: 'POST'"), false)
  assert.match(source, /const ROUTE_BASE = '\/confluence\/panel'/)
  assert.match(source, /const POLL_MS = 5000/)
  assert.match(source, /visibilityState/)
  // Universal scope: no workspace switcher, listing or workspace parameter.
  assert.equal(source.includes("'/workspaces'"), false)
  assert.equal(source.includes('api.workspaces'), false)
  assert.equal(source.includes('workspaceKey'), false)
  assert.equal(source.includes('/confluence/panel/workspaces'), false)
  assert.doesNotMatch(source, /\bws\s*:/)
  // Global rendering contract: fixed bilingual title, host scope label, provenance chip.
  assert.equal(source.includes("PANEL_TITLE = '高级记忆 / Confluence memory'"), true)
  assert.equal(source.includes('scope.label'), true)
  assert.equal(source.includes('cf-workspace'), true)
  assert.equal(source.includes('entry.workspaceLabel'), true)
  for (const forbidden of [
    'http://',
    'https://',
    '<iframe',
    'innerHTML',
    'dangerouslySetInnerHTML',
    'document.write',
    'document.body',
    'postMessage',
    'WebSocket',
    'EventSource',
    'XMLHttpRequest',
    "require('@deepseek-ai/",
    'require("@deepseek-ai/',
    'localStorage',
  ]) {
    assert.equal(source.includes(forbidden), false, `client.js must not contain ${forbidden}`)
  }
  assert.doesNotMatch(source, /^\s*import\s/m, 'client.js must be a plain browser module, not ESM imports')
  // Every CSS custom property is a verified theme token.
  const variables = [...source.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((match) => match[1])
  assert.ok(variables.length > 10)
  for (const variable of variables) assert.match(variable, /^--dsw-alias-/, `unexpected theme variable ${variable}`)
  // No literal colors; artwork uses currentColor.
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(source, /\b(?:rgb|hsl)a?\(/)
  assert.equal(source.includes('currentColor'), true)
})

test('UI-03 locale dictionaries cover every used key and stay inside the shipped inventory', () => {
  const harness = createClientHarness()
  const definition = loadClientDefinition()
  definition.factory(() => harness.reactShim).apply(harness.ctx)
  const dictionaries = harness.localeRegistrations[0].dictionaries
  const enKeys = Object.keys(dictionaries.en).sort()
  const zhKeys = Object.keys(dictionaries.zh).sort()
  assert.deepEqual(enKeys, zhKeys, 'inline en/zh dictionaries must expose the same keys')

  const rawKeys = [...CLIENT_SOURCE.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1])
  const usedKeys = new Set()
  for (const key of rawKeys) {
    if (/^[A-Za-z][A-Za-z0-9.-]*$/.test(key) === false) continue
    if (key.endsWith('.')) {
      if (key === 'kind.') {
        for (const kind of ['finding', 'decision', 'gotcha', 'question', 'handoff', 'warning']) usedKeys.add('kind.' + kind)
      }
      continue
    }
    usedKeys.add(key)
  }
  assert.ok(usedKeys.size > 20, 'expected the panel to translate a meaningful set of strings')
  const missingEn = [...usedKeys].filter((key) => typeof dictionaries.en[key] !== 'string' || dictionaries.en[key] === '')
  const missingZh = [...usedKeys].filter((key) => typeof dictionaries.zh[key] !== 'string' || dictionaries.zh[key] === '')
  assert.deepEqual(missingEn, [], 'missing English strings: ' + missingEn.join(', '))
  assert.deepEqual(missingZh, [], 'missing Chinese strings: ' + missingZh.join(', '))

  // Packaging owns locale/*.json: v0.2.0 introduces no new key, so every key the
  // client uses (and registers) must already exist in the shipped inventory.
  const hostEn = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'en.json'), 'utf8')).ui
  const hostZh = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'zh.json'), 'utf8')).ui
  const outsideInventory = [...usedKeys].filter((key) => !(key in hostEn) || !(key in hostZh))
  assert.deepEqual(outsideInventory, [], 'locale keys must be added by packaging first: ' + outsideInventory.join(', '))
  const inlineOutsideInventory = enKeys.filter((key) => !(key in hostEn) || !(key in hostZh))
  assert.deepEqual(inlineOutsideInventory, [])

  // Placeholder consistency: keys used with params must keep them in both languages.
  assert.match(dictionaries.en['peers.live'], /\{n\}/)
  assert.match(dictionaries.zh['peers.live'], /\{n\}/)
  assert.match(dictionaries.en['entry.replies'], /\{n\}/)
  assert.match(dictionaries.zh['entry.replies'], /\{n\}/)
  assert.match(dictionaries.en['detail.provenance'], /\{author\}/)
  assert.match(dictionaries.zh['detail.provenance'], /\{author\}/)
  assert.match(dictionaries.en.updatedAt, /\{time\}/)
  assert.match(dictionaries.zh.updatedAt, /\{time\}/)
  assert.match(dictionaries.en['state.stale'], /\{time\}/)
  assert.match(dictionaries.zh['state.stale'], /\{time\}/)
})

test('UI-04 client.js parses in the ModuleLoader sandbox and tolerates missing slots', () => {
  const definition = loadClientDefinition()
  const harness = createClientHarness()
  const moduleValue = definition.factory(() => harness.reactShim)
  assert.doesNotThrow(() => moduleValue.apply({ locale: undefined, layout: undefined, slots: undefined, effect: undefined }))
  assert.doesNotThrow(() => moduleValue.apply({}))
})

test('UI-05 the registered page renders the global timeline chrome (no workspace switcher)', () => {
  const definition = loadClientDefinition()
  const harness = createClientHarness()
  definition.factory(() => harness.reactShim).apply(harness.ctx)
  const main = harness.registered.find((record) => record.definition.name === 'main')
  assert.equal(typeof main.component, 'function')

  // No effects run in the shim, so this is the loading phase: header, toolbar and
  // footer render without any data request (the single fetch stays in effects).
  const tree = main.component({
    t: (key) => 'T:' + key,
    closePanel: () => {},
  })
  assert.equal(tree.type, 'element')
  assert.equal(tree.args[0], 'section')
  const serialized = JSON.stringify(tree)
  assert.equal(serialized.includes('高级记忆 / Confluence memory'), true)
  assert.equal(serialized.includes('T:panel.subtitle'), true)
  assert.equal(serialized.includes('T:search.label'), true)
  assert.equal(serialized.includes('T:questions.open'), true)
  assert.equal(serialized.includes('T:peers.none'), true)
  assert.equal(serialized.includes('T:state.loading'), true)
  assert.equal(serialized.includes('<select'), false)
  assert.equal(serialized.includes('aria-busy'), true)
})
