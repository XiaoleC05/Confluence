// Confluence / 汇流 — WP6 tests: Host UI routes (lib/hostui.js) and the Web panel
// client half (client.js). Dependency-free: node:test + node:assert/strict + node:vm.
//
// Coverage:
//   WO-01..WO-18  hostui registration, route guards, payload contract, caps, errors
//   UI-01..UI-04  client ModuleLoader contract, slot registrations, static scan, i18n
//
// Run from the repository root: node --test "test/*.test.js"

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

import {
  HOSTUI_PREFIX,
  MAX_RESPONSE_BYTES,
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
  workspaces: `${HOSTUI_PREFIX}/workspaces`,
  overview: `${HOSTUI_PREFIX}/overview`,
  entry: `${HOSTUI_PREFIX}/entry`,
}
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

function createFacade(data = {}) {
  const calls = []
  const facade = {
    calls,
    async listWorkspaces() {
      calls.push(['listWorkspaces'])
      return data.workspaces ?? []
    },
    async overview(wsKey, options) {
      calls.push(['overview', wsKey, options])
      return data.overview ?? null
    },
    async entry(wsKey, id) {
      calls.push(['entry', wsKey, id])
      return data.entry ?? null
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
    workspaceResolver: { resolve: () => null },
    config: config ?? { ui: { enabled: true } },
    logger: logger ?? ctx.logger,
  })
  return { webServer, ctx, facade: usedFacade, dispose }
}

function summaryKeys(entry) {
  return Object.keys(entry).sort()
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

test('WO-04 registers exactly the four exact routes and disposes them idempotently', () => {
  const mounted = mount({})
  assert.deepEqual([...mounted.webServer.routes.keys()].sort(), Object.values(ROUTE_PATHS).sort())
  assert.equal(mounted.ctx.effects.length, 4)
  mounted.dispose()
  assert.equal(mounted.webServer.routes.size, 0)
  assert.doesNotThrow(() => mounted.dispose())
})

test('WO-05 ping returns the fixed shape with no-store JSON and supports HEAD', async () => {
  const mounted = mount({})
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.ping)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(json.ok, true)
  assert.equal(json.name, PLUGIN_NAME)
  assert.equal(json.version, PLUGIN_VERSION)

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
    const { res } = await invoke(mounted.webServer, ROUTE_PATHS.workspaces, { method })
    assert.equal(res.statusCode, 405, `${method} must be rejected`)
    assert.equal(res.headers.allow, 'GET, HEAD')
    assert.equal(res.ended, true)
  }
  assert.equal(mounted.facade.calls.length, 0, 'guarded requests must not touch the facade')
  mounted.dispose()
})

test('WO-07 the optional connection fence answers before routing', async () => {
  const connection = { requestRejection: (req) => (req.headers['x-fence'] === '1' ? 403 : undefined) }
  const mounted = mount({}, { connection })
  const fenced = await invoke(mounted.webServer, ROUTE_PATHS.workspaces, { headers: { 'x-fence': '1' } })
  assert.equal(fenced.res.statusCode, 403)
  assert.equal(fenced.facade, undefined)
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
// WO: payload contract
// ---------------------------------------------------------------------------

test('WO-09 workspaces payload is normalized and capped at 20', async () => {
  const workspaces = []
  for (let index = 0; index < 25; index += 1) {
    const suffix = index.toString(16).padStart(16, '0')
    workspaces.push({ key: `ws_${suffix}`, label: 'W' + String(index), canonicalPath: 'C:\\work\\' + String(index), entries: 3, openQuestions: 1, live: index === 0, extra: 'must not leak' })
  }
  workspaces[1].key = 'not-a-workspace-key'
  workspaces[2].label = 'x'.repeat(400)
  workspaces[3].entries = -7
  const mounted = mount({ workspaces })
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.workspaces)
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.workspaces.length, 20)
  assert.ok(json.workspaces.every((workspace) => workspace.key !== 'not-a-workspace-key'))
  assert.deepEqual(summaryKeys(json.workspaces[0]), ['canonicalPath', 'entries', 'key', 'label', 'live', 'openQuestions'])
  assert.equal(json.workspaces[0].live, true)
  assert.ok(json.workspaces[1].label.length <= 120 || json.workspaces[1].label.length > 0)
  assert.ok(json.workspaces.every((workspace) => workspace.entries >= 0))
  assert.equal(JSON.stringify(json).includes('must not leak'), false)
  mounted.dispose()
})

test('WO-10 overview lists summaries only (no bodies/previews) and forwards filters', async () => {
  const mounted = mount({
    overview: {
      workspace: { key: WS_KEY, label: 'solo-bench' },
      entries: [{
        id: ENTRY_ID,
        seq: '01JBQ8Z4K1',
        kind: 'gotcha',
        title: 'Windows rename retries',
        authorTitle: 'Auth work',
        ts: '2026-11-13T03:55:00.000Z',
        status: 'open',
        replyCount: 2,
        body: 'SECRET BODY',
        preview: 'SECRET PREVIEW',
        author: { sessionId: 'session-x' },
      }],
      stats: { total: 12, openQuestions: 2, openHandoffs: 1, unread: 3 },
      peers: [{ title: 'Auth work', status: 'running', sessionId: 'session-x' }],
      truncated: false,
    },
  })
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.overview, {
    query: { ws: WS_KEY, q: 'rename', kind: 'gotcha', limit: '10' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(json.workspace, { key: WS_KEY, label: 'solo-bench' })
  assert.deepEqual(summaryKeys(json.entries[0]), ['authorTitle', 'id', 'kind', 'replyCount', 'seq', 'status', 'title', 'ts'])
  assert.equal(JSON.stringify(json).includes('SECRET'), false)
  assert.deepEqual(json.stats, { total: 12, openQuestions: 2, openHandoffs: 1, unread: 3 })
  assert.deepEqual(json.peers, [{ title: 'Auth work', status: 'running' }])
  assert.equal(json.truncated, false)
  assert.deepEqual(mounted.facade.calls[0], ['overview', WS_KEY, { q: 'rename', kind: 'gotcha', limit: 10 }])
  mounted.dispose()
})

test('WO-11 overview validates the workspace key and maps facade errors', async () => {
  const mounted = mount({})
  const missing = await invoke(mounted.webServer, ROUTE_PATHS.overview)
  assert.equal(missing.res.statusCode, 400)
  assert.equal(missing.json.error.code, 'CONFLUENCE_INVALID_ARGUMENT')

  const malformed = await invoke(mounted.webServer, ROUTE_PATHS.overview, { query: { ws: 'ws_zzz' } })
  assert.equal(malformed.res.statusCode, 404)
  assert.equal(malformed.json.error.code, 'CONFLUENCE_NOT_FOUND')

  const throwingFacade = createFacade()
  throwingFacade.overview = async () => {
    const error = new Error('store is unavailable')
    error.code = 'STORE_UNAVAILABLE'
    throw error
  }
  const mountedThrowing = mount({}, { facade: throwingFacade })
  const unavailable = await invoke(mountedThrowing.webServer, ROUTE_PATHS.overview, { query: { ws: WS_KEY } })
  assert.equal(unavailable.res.statusCode, 503)
  assert.equal(unavailable.json.error.code, 'CONFLUENCE_STORE_UNAVAILABLE')

  const genericFacade = createFacade()
  genericFacade.overview = async () => {
    throw new Error('unexpected\nfailure at C:\\secret\\path')
  }
  const mountedGeneric = mount({}, { facade: genericFacade })
  const failed = await invoke(mountedGeneric.webServer, ROUTE_PATHS.overview, { query: { ws: WS_KEY } })
  assert.equal(failed.res.statusCode, 500)
  assert.equal(failed.json.error.code, 'CONFLUENCE_INTERNAL')
  assert.equal(failed.json.error.message.includes('\n'), false)
  mounted.dispose()
  mountedThrowing.dispose()
  mountedGeneric.dispose()
})

test('WO-12 entry returns body/tags/relative files and bounded replies', async () => {
  const replies = []
  for (let index = 0; index < 60; index += 1) {
    const idSuffix = index.toString(16).padStart(26, '0').toUpperCase()
    replies.push({ id: `cnf_${idSuffix}`, seq: '01JBQ8Z4K2', body: 'reply ' + String(index), authorTitle: 'Data migration', ts: '2026-11-13T03:56:00.000Z' })
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
        ts: '2026-11-13T03:55:00.000Z',
        status: 'active',
      },
      replies,
    },
  })
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { ws: WS_KEY, id: ENTRY_ID } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(summaryKeys(json.entry), ['authorTitle', 'body', 'files', 'id', 'kind', 'seq', 'status', 'tags', 'title', 'ts'])
  assert.equal(json.entry.body.includes('\u0000'), false)
  assert.equal(json.entry.body.includes('\n'), true)
  assert.deepEqual(json.entry.tags, ['windows', 'io'])
  assert.deepEqual(json.entry.files, ['work/src/win/rename.ts', 'src/auth/index.ts'])
  assert.equal(json.replies.length, 50)
  assert.deepEqual(summaryKeys(json.replies[0]), ['authorTitle', 'body', 'id', 'seq', 'ts'])
  mounted.dispose()
})

test('WO-13 missing or malformed entry ids return 404', async () => {
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

test('WO-14 enforces the 64 KiB response cap with explicit truncation', async () => {
  const bigReplies = []
  for (let index = 0; index < 50; index += 1) {
    const idSuffix = index.toString(16).padStart(26, '0').toUpperCase()
    bigReplies.push({
      id: `cnf_${idSuffix}`,
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
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { ws: WS_KEY, id: ENTRY_ID } })
  assert.equal(res.statusCode, 200)
  assert.ok(Buffer.byteLength(res.body, 'utf8') <= MAX_RESPONSE_BYTES, 'response must stay under the cap')
  assert.ok(json.entry.body.length < 200_000)
  assert.equal(json.truncated, true)
  mounted.dispose()
})

test('WO-15 only read facade methods are called (no mutation surface)', async () => {
  const workspaces = [{ key: WS_KEY, label: 'solo', canonicalPath: 'C:\\solo', entries: 1, openQuestions: 0, live: true }]
  const mounted = mount({
    workspaces,
    overview: { workspace: { key: WS_KEY, label: 'solo' }, entries: [], stats: {}, peers: [], truncated: false },
    entry: { entry: null, replies: [] },
  })
  await invoke(mounted.webServer, ROUTE_PATHS.workspaces)
  await invoke(mounted.webServer, ROUTE_PATHS.overview, { query: { ws: WS_KEY } })
  await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { ws: WS_KEY, id: ENTRY_ID } })
  const methods = new Set(mounted.facade.calls.map((call) => call[0]))
  assert.deepEqual([...methods].sort(), ['entry', 'listWorkspaces', 'overview'])
  mounted.dispose()
})

test('WO-16 workspaces non-array facade result degrades to 503', async () => {
  const facade = createFacade()
  facade.listWorkspaces = async () => undefined
  const mounted = mount({}, { facade })
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.workspaces)
  assert.equal(res.statusCode, 503)
  assert.equal(json.error.code, 'CONFLUENCE_STORE_UNAVAILABLE')
  mounted.dispose()
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
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.ping)
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  mounted.dispose()
})

test('WO-18 internal helpers keep file hints workspace-relative only', () => {
  assert.equal(hostuiInternals.cleanRelativePath('D:\\work\\src\\a.ts'), 'work/src/a.ts')
  assert.equal(hostuiInternals.cleanRelativePath('/work/src/b.ts'), 'work/src/b.ts')
  assert.equal(hostuiInternals.cleanRelativePath('\\\\server\\share\\c.ts'), '')
  assert.equal(hostuiInternals.cleanRelativePath('../d.ts'), '')
  assert.equal(hostuiInternals.cleanRelativePath('src\\..\\e.ts'), '')
  assert.equal(hostuiInternals.cleanRelativePath('src/f.ts'), 'src/f.ts')
  const oversized = hostuiInternals.fitPayload('overview', {
    ok: true,
    workspace: { key: WS_KEY, label: 'big' },
    entries: Array.from({ length: 50 }, (_, index) => ({ id: `cnf_${String(index).padStart(26, '0').toUpperCase()}`, title: 't'.repeat(200), seq: '', kind: 'finding', authorTitle: 'a', ts: '', status: 'active', replyCount: 0 })),
    stats: {},
    peers: [],
    truncated: false,
  })
  assert.ok(Buffer.byteLength(JSON.stringify(oversized.payload), 'utf8') <= MAX_RESPONSE_BYTES)
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
  assert.equal(rail.definition.name, 'sidebar.panellist')
  assert.equal(rail.definition.id, 'confluence')
  assert.equal(rail.definition.order, 30)
  assert.equal(rail.definition.locale, 'confluence')
  assert.equal(typeof rail.definition.label, 'function')
  assert.equal(rail.definition.label(), 'Confluence')

  const main = harness.registered.find((record) => record.definition.name === 'main')
  assert.ok(main !== undefined)
  assert.equal(main.definition.key, 'confluence')
  assert.equal(main.definition.locale, 'confluence')
  assert.equal(typeof main.definition.inject, 'function')
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

test('UI-02 client.js is offline, read-only and dependency-free by static scan', () => {
  const source = CLIENT_SOURCE
  // The real call site (anchored; comments may mention the loader without calling it).
  assert.equal((source.match(/^window\.__ModuleLoader__\.load\(/gm) ?? []).length, 1)
  assert.equal(source.includes("id: 'dsh-confluence'"), true)
  // Exactly one fetch call site; it is the relative route adapter.
  assert.equal((source.match(/\bfetch\(/g) ?? []).length, 1)
  assert.equal(source.includes("credentials: 'same-origin'"), true)
  assert.equal(source.includes("cache: 'no-store'"), true)
  assert.match(source, /const ROUTE_BASE = '\/confluence\/panel'/)
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
  assert.match(source, /const POLL_MS = 5000/)
  assert.match(source, /visibilityState/)
})

test('UI-03 locale dictionary matches the shipped locale inventory and covers every used key', () => {
  const harness = createClientHarness()
  const definition = loadClientDefinition()
  definition.factory(() => harness.reactShim).apply(harness.ctx)
  const dictionaries = harness.localeRegistrations[0].dictionaries
  const hostEn = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'en.json'), 'utf8')).ui
  const hostZh = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'zh.json'), 'utf8')).ui
  // ui.md §5 parity: the client dictionary is the flattened locale `ui` object.
  assert.deepEqual(JSON.parse(JSON.stringify(dictionaries.en)), hostEn)
  assert.deepEqual(JSON.parse(JSON.stringify(dictionaries.zh)), hostZh)
  const rawKeys = [...CLIENT_SOURCE.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1])
  // Static keys only: `kind.` is dynamically concatenated with a closed kind list,
  // and prose/comments containing t('…') are not dictionary lookups.
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
  // Placeholder consistency: keys used with params must keep them in both languages.
  assert.match(dictionaries.en['peers.live'], /\{n\}/)
  assert.match(dictionaries.zh['peers.live'], /\{n\}/)
  assert.match(dictionaries.en['entry.replies'], /\{n\}/)
  assert.match(dictionaries.zh['entry.replies'], /\{n\}/)
  assert.match(dictionaries.en['detail.provenance'], /\{author\}/)
  assert.match(dictionaries.zh['detail.provenance'], /\{author\}/)
  assert.match(dictionaries.en.updatedAt, /\{time\}/)
  assert.match(dictionaries.zh.updatedAt, /\{time\}/)
})

test('UI-04 client.js parses in the ModuleLoader sandbox and tolerates missing slots', () => {
  const definition = loadClientDefinition()
  const harness = createClientHarness()
  const moduleValue = definition.factory(() => harness.reactShim)
  // A degraded host page without a slot registry must not throw.
  assert.doesNotThrow(() => moduleValue.apply({ locale: undefined, layout: undefined, slots: undefined, effect: undefined }))
  assert.doesNotThrow(() => moduleValue.apply({}))
})
