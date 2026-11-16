// Confluence / 汇流 — WP6 Host UI (M3 v0.2.0 read-only panel data channel).
//
// v0.2.0 universal memory (ADR-0007): the panel serves ONE profile-wide `global`
// scope. Workspace data appears only as provenance metadata (`workspaceLabel`),
// never as a route parameter, partition or filter barrier.
//
// Plain ESM, Node builtins only, no `@deepseek-ai/*` imports, no network listeners.
// The panel reads board data through three same-origin JSON routes registered on the
// optional `webServer` service (proven Crisp/dsh-context route pattern; ADR-0005
// fallback decision — the client builtin `host.call` is deferred, and the route is
// the documented choice in this build).
//
// Privacy/security posture (unchanged from v0.1.0):
//   - GET/HEAD only, no mutating route, no POST/PUT/DELETE handling;
//   - `cache-control: no-store`, JSON only, `x-content-type-options: nosniff`;
//   - response body hard-capped at 64 KiB (truncation is explicit, never a silent cut);
//   - list views never carry note bodies or previews (note bodies only on the
//     single-entry route, where the user explicitly opened that note);
//   - file hints are workspace-relative only (drive letters, UNC roots and `..`
//     segments are removed) and errors carry no filesystem paths;
//   - provenance labels are basenames only; a path-looking label is reduced to its
//     final segment so the panel can never display an absolute path;
//   - the optional `connection.requestRejection(req)` fence is applied first when
//     the service exists (Crisp `lib/status.js:290-305` precedent);
//   - a present foreign `Origin` or a cross-site `Sec-Fetch-Site` is rejected.
//
// Everything here is read-only over the facade the plugin entry injects; this module
// never touches the store, the session log or the config.

/** Route prefix owned by this module (exact routes, one per page area). */
export const HOSTUI_PREFIX = '/confluence/panel'

/** Panel protocol/plugin version reported by the ping route (payload unchanged). */
export const PLUGIN_VERSION = '0.2.0'

/** Plugin package name reported by the ping route. */
export const PLUGIN_NAME = 'dsh-confluence'

/** Logical panel scope: one universal memory space per DSH profile (ADR-0007). */
export const PANEL_SCOPE = Object.freeze({ key: 'global', label: 'All sessions' })

/** Hard response ceiling for every panel route. */
export const MAX_RESPONSE_BYTES = 64 * 1024

const MAX_ENTRIES = 50
const MAX_REPLIES = 50
const MAX_PEERS = 8
const MAX_FILES = 8
const MAX_TAGS = 8
const DEFAULT_OVERVIEW_LIMIT = 20
const MAX_QUERY_CHARS = 200
const MAX_TITLE_CHARS = 200
const MAX_LABEL_CHARS = 120
const MAX_TS_CHARS = 40

const ENTRY_ID_RE = /^cnf_[0-9A-Za-z_-]{6,64}$/
const KIND_VALUES = new Set(['finding', 'decision', 'gotcha', 'question', 'handoff', 'warning'])
const ENTRY_STATUS_VALUES = new Set(['active', 'open', 'resolved', 'superseded'])
const PEER_STATUS_VALUES = new Set(['running', 'idle', 'cold', 'unknown'])
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const NEWLINE_RE = /\r\n?/g

const ROUTES = [
  { name: 'ping', path: `${HOSTUI_PREFIX}/ping`, run: pingPayload },
  { name: 'overview', path: `${HOSTUI_PREFIX}/overview`, run: overviewPayload },
  { name: 'entry', path: `${HOSTUI_PREFIX}/entry`, run: entryPayload },
]

// ---------------------------------------------------------------------------
// small defensive helpers
// ---------------------------------------------------------------------------

/** Bound logger that can never throw and never receives user content. */
function safeLogger(logger) {
  const noop = () => {}
  const bind = (name) => {
    const fn = logger !== null && typeof logger === 'object' ? logger[name] : undefined
    if (typeof fn !== 'function') return noop
    return (...args) => {
      try {
        fn(...args)
      } catch {
        // Diagnostics are best-effort; the panel must keep working.
      }
    }
  }
  return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') }
}

/** Run `fn` once, tolerating a throwing cleanup run. */
function once(fn) {
  let ran = false
  return (...args) => {
    if (ran) return undefined
    ran = true
    return fn(...args)
  }
}

/** Read the optional web-server service defensively (Crisp `getWebServer` shape). */
function getService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const value = ctx.get(name)
      if (value !== undefined) return value
    }
  } catch {
    // Optional service lookup must never break activation.
  }
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/** JSON byte length of one payload (UTF-8). */
function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** Single-line text sanitizer: control chars to spaces, newlines collapsed, capped. */
function cleanLine(value, maxChars) {
  if (typeof value !== 'string') return ''
  const cleaned = value
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(NEWLINE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned
}

/** Multi-line text sanitizer for note bodies: keeps \n and \t, strips the rest. */
function cleanBody(value, maxChars) {
  if (typeof value !== 'string') return ''
  const cleaned = value.replace(CONTROL_CHARS_RE, ' ').replace(NEWLINE_RE, '\n').trim()
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned
}

/** Coerce to int inside [min, max]; non-finite → fallback. */
function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  const truncated = Math.trunc(number)
  if (truncated < min) return min
  if (truncated > max) return max
  return truncated
}

/** ISO-8601 timestamp kept only when parseable; otherwise dropped (empty string). */
function cleanTimestamp(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_TS_CHARS) return ''
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? trimmed : ''
}

/**
 * Workspace-relative file hint. Absolute forms lose their root, any `..` segment
 * drops the entry, and separators normalize to `/` for display. Returns '' when the
 * path is unusable (the caller drops it).
 */
function cleanRelativePath(value) {
  if (typeof value !== 'string') return ''
  let text = value.replace(CONTROL_CHARS_RE, '').trim()
  if (text.length === 0) return ''
  if (text.startsWith('\\\\') || text.startsWith('//')) return '' // UNC: not displayable as relative
  text = text.replace(/^[A-Za-z]:[\\/]+/, '')
  text = text.replace(/^[\\/]+/, '')
  const parts = text.split(/[\\/]+/).filter((part) => part.length > 0 && part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '..')) return ''
  const relative = parts.join('/')
  return relative.length > MAX_TITLE_CHARS ? '' : relative
}

/**
 * Provenance label: basename only (delta §0). A facade that accidentally forwards
 * a path is reduced to its final segment; no absolute path can reach the panel.
 */
function cleanProvenanceLabel(value) {
  const line = cleanLine(typeof value === 'string' ? value : '', MAX_LABEL_CHARS)
  if (line === '') return ''
  const parts = line.split(/[\\/]+/).filter((part) => part !== '' && part !== '.' && part !== '..')
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

/** Error message for JSON: single line, capped, no stack. */
function cleanMessage(error) {
  const raw = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : ''
  const cleaned = raw.replace(CONTROL_CHARS_RE, ' ').replace(NEWLINE_RE, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > 300 ? cleaned.slice(0, 300) : cleaned
}

/** Extract a stable error code from a facade rejection. */
function errorCode(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') return error.code
  return ''
}

/**
 * Map a facade rejection to an HTTP status + error envelope. Facade errors use the
 * design's bare codes (implementation-interfaces.md §0); anything unknown is a 500
 * with no internal detail beyond a single-line message.
 */
function mapError(error) {
  const code = errorCode(error)
  const message = cleanMessage(error)
  const payload = (panelCode, fallbackMessage) => ({
    ok: false,
    error: { code: panelCode, message: message.length > 0 ? message : fallbackMessage },
  })
  switch (code) {
    case 'BAD_ARGUMENT':
    case 'CONFLUENCE_INVALID_ARGUMENT':
      return { status: 400, payload: payload('CONFLUENCE_INVALID_ARGUMENT', 'invalid panel argument') }
    case 'NOT_FOUND':
    case 'UNKNOWN_REF':
    case 'CONFLUENCE_NOT_FOUND':
      return { status: 404, payload: payload('CONFLUENCE_NOT_FOUND', 'not found') }
    case 'STORE_UNAVAILABLE':
      return { status: 503, payload: payload('CONFLUENCE_STORE_UNAVAILABLE', 'shared memory storage unavailable') }
    default:
      return { status: 500, payload: payload('CONFLUENCE_INTERNAL', 'panel request failed') }
  }
}

/** Header value as a trimmed lowercase string. */
function headerValue(req, name) {
  const headers = req !== null && typeof req === 'object' ? req.headers : undefined
  if (headers === null || typeof headers !== 'object') return ''
  const value = headers[name]
  if (typeof value === 'string') return value.trim().toLowerCase()
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim().toLowerCase()
  return ''
}

/**
 * Same-origin guard. Rejects an explicitly cross-site `Sec-Fetch-Site` and a present
 * `Origin` whose host differs from the request's own Host. Missing headers are
 * accepted (local tools and older browsers); the check adds defense in depth, not
 * the primary boundary.
 */
function originProblem(req, webServer) {
  const secFetchSite = headerValue(req, 'sec-fetch-site')
  if (secFetchSite !== '' && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return { status: 403, code: 'CONFLUENCE_FOREIGN_ORIGIN' }
  }
  const origin = req !== null && typeof req === 'object' && req.headers !== null && typeof req.headers === 'object'
    ? typeof req.headers.origin === 'string' ? req.headers.origin.trim() : ''
    : ''
  if (origin === '') return null
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    return { status: 403, code: 'CONFLUENCE_FOREIGN_ORIGIN' }
  }
  const host = headerValue(req, 'host')
  if (host !== '') {
    if (originHost !== host) return { status: 403, code: 'CONFLUENCE_FOREIGN_ORIGIN' }
    return null
  }
  try {
    const expected = typeof webServer?.getOrigin === 'function' ? new URL(webServer.getOrigin()) : undefined
    if (expected !== undefined && originHost === expected.host) return null
  } catch {
    // getOrigin can throw before the listener binds; fall through to rejection.
  }
  return { status: 403, code: 'CONFLUENCE_FOREIGN_ORIGIN' }
}

/** Optional connection fence; returns true when the request was answered. */
function rejectedByConnection(ctx, req, res) {
  let connection
  try {
    connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
  } catch {
    connection = undefined
  }
  if (connection === null || typeof connection !== 'object') return false
  if (typeof connection.requestRejection !== 'function') return false
  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch {
    return false
  }
  if (rejection === undefined || rejection === null || rejection === false) return false
  const status = typeof rejection === 'number' ? rejection : typeof rejection.status === 'number' ? rejection.status : 403
  res.statusCode = status
  res.setHeader('cache-control', 'no-store')
  res.end()
  return true
}

// ---------------------------------------------------------------------------
// payload normalization (facade shape → panel payload, allow-list only)
// ---------------------------------------------------------------------------

/**
 * Provenance label of one facade row: direct `workspaceLabel` first, then the
 * board record's additive `origin.workspaceLabel` (delta §3). Only the label is
 * exposed; workspace keys never reach the panel.
 */
function provenanceLabel(item) {
  if (item === null || typeof item !== 'object') return ''
  const direct = cleanProvenanceLabel(item.workspaceLabel)
  if (direct !== '') return direct
  const origin = item.origin
  if (origin === null || typeof origin !== 'object') return ''
  return cleanProvenanceLabel(origin.workspaceLabel)
}

/** Normalize a facade entry summary (list view: no bodies, no previews). */
function normalizeEntrySummary(item) {
  if (item === null || typeof item !== 'object') return null
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  if (!ENTRY_ID_RE.test(id)) return null
  const summary = {
    id,
    seq: cleanLine(item.seq, 64),
    kind: KIND_VALUES.has(item.kind) ? item.kind : 'warning',
    title: cleanLine(item.title, MAX_TITLE_CHARS),
    authorTitle: cleanLine(item.authorTitle ?? item.author ?? '', MAX_LABEL_CHARS),
  }
  const workspaceLabel = provenanceLabel(item)
  if (workspaceLabel !== '') summary.workspaceLabel = workspaceLabel
  summary.ts = cleanTimestamp(item.ts ?? item.createdAt ?? '')
  summary.status = ENTRY_STATUS_VALUES.has(item.status) ? item.status : 'active'
  summary.replyCount = clampInt(item.replyCount, 0, 100_000, 0)
  return summary
}

/** Normalize one reply row of the single-entry view (optional provenance label). */
function normalizeReply(item) {
  if (item === null || typeof item !== 'object') return null
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  if (!ENTRY_ID_RE.test(id)) return null
  const reply = {
    id,
    seq: cleanLine(item.seq, 64),
    body: cleanBody(item.body, 4096),
    authorTitle: cleanLine(item.authorTitle ?? item.author ?? '', MAX_LABEL_CHARS),
  }
  const workspaceLabel = provenanceLabel(item)
  if (workspaceLabel !== '') reply.workspaceLabel = workspaceLabel
  reply.ts = cleanTimestamp(item.ts ?? item.createdAt ?? '')
  return reply
}

/** Normalize one entry detail row (single-entry route only; body allowed here). */
function normalizeEntryDetail(item, maxBodyChars) {
  const summary = normalizeEntrySummary(item)
  if (summary === null) return null
  const tags = []
  if (Array.isArray(item.tags)) {
    for (const tag of item.tags) {
      const cleaned = cleanLine(typeof tag === 'string' ? tag : '', 32).toLowerCase()
      if (cleaned !== '' && !tags.includes(cleaned) && tags.length < MAX_TAGS) tags.push(cleaned)
    }
  }
  const files = []
  if (Array.isArray(item.files)) {
    for (const file of item.files) {
      const relative = cleanRelativePath(file)
      if (relative !== '' && !files.includes(relative) && files.length < MAX_FILES) files.push(relative)
    }
  }
  return {
    ...summary,
    body: cleanBody(item.body, maxBodyChars),
    tags,
    files,
  }
}

/** Strip reply-level internals from the detail row into the panel's exact shape. */
function entryDetailPayload(item, maxBodyChars) {
  const entry = normalizeEntryDetail(item, maxBodyChars)
  if (entry === null) return null
  const payload = {
    id: entry.id,
    seq: entry.seq,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    tags: entry.tags,
    files: entry.files,
    authorTitle: entry.authorTitle,
  }
  if (entry.workspaceLabel !== undefined) payload.workspaceLabel = entry.workspaceLabel
  payload.ts = entry.ts
  payload.status = entry.status
  return payload
}

/**
 * Normalize the overview `stats` object. `unread` is always 0 in v0.2.0: the panel
 * has no per-user unread model in the universal scope (the model watermark is
 * tool-derived and never advanced by a UI click).
 */
function normalizeStats(item) {
  const raw = item !== null && typeof item === 'object' ? item : {}
  return {
    total: clampInt(raw.total ?? raw.entries, 0, 1_000_000, 0),
    openQuestions: clampInt(raw.openQuestions, 0, 1_000_000, 0),
    openHandoffs: clampInt(raw.openHandoffs, 0, 1_000_000, 0),
    unread: 0,
  }
}

/** Normalize the live-peer list (title + status + optional provenance label). */
function normalizePeers(item) {
  if (!Array.isArray(item)) return []
  const peers = []
  for (const peer of item) {
    if (peer === null || typeof peer !== 'object') continue
    const title = cleanLine(peer.title ?? peer.sessionTitle ?? '', MAX_LABEL_CHARS)
    if (title === '') continue
    const row = {
      title,
      status: PEER_STATUS_VALUES.has(peer.status) ? peer.status : 'unknown',
    }
    const workspaceLabel = provenanceLabel(peer)
    if (workspaceLabel !== '') row.workspaceLabel = workspaceLabel
    peers.push(row)
    if (peers.length >= MAX_PEERS) break
  }
  return peers
}

/** Fit a payload under the response cap by dropping the least important content. */
function fitPayload(routeName, payload) {
  let body = JSON.stringify(payload)
  if (byteLength(body) <= MAX_RESPONSE_BYTES) return { payload, size: byteLength(body) }
  if (routeName === 'overview' && Array.isArray(payload.entries)) {
    const entries = payload.entries.slice()
    while (entries.length > 0) {
      entries.pop()
      const candidate = { ...payload, entries, truncated: true }
      body = JSON.stringify(candidate)
      if (byteLength(body) <= MAX_RESPONSE_BYTES) return { payload: candidate, size: byteLength(body) }
    }
  }
  if (routeName === 'entry' && payload.entry !== undefined) {
    const entry = { ...payload.entry }
    const replies = Array.isArray(payload.replies) ? payload.replies.slice() : []
    const bodyLimits = [4096, 1024, 256, 0]
    for (const limit of bodyLimits) {
      entry.body = entry.body.length > limit ? entry.body.slice(0, limit) : entry.body
      while (replies.length > 0) {
        const candidate = { ...payload, entry, replies: replies.slice(), truncated: true }
        body = JSON.stringify(candidate)
        if (byteLength(body) <= MAX_RESPONSE_BYTES) return { payload: candidate, size: byteLength(body) }
        replies.pop()
      }
      const candidate = { ...payload, entry, replies: [], truncated: true }
      body = JSON.stringify(candidate)
      if (byteLength(body) <= MAX_RESPONSE_BYTES) return { payload: candidate, size: byteLength(body) }
    }
  }
  return { payload: payload, size: byteLength(JSON.stringify(payload)) }
}

// ---------------------------------------------------------------------------
// route payloads (read-only over the facade)
// ---------------------------------------------------------------------------

/** Ping payload: fixed shape, no data access. */
function pingPayload() {
  return { ok: true, name: PLUGIN_NAME, version: PLUGIN_VERSION }
}

/**
 * Overview payload: the single global timeline (filtered by search/kind), stats and
 * live peers. No workspace parameter exists; provenance is an optional label.
 */
async function overviewPayload({ facade, url, log }) {
  const rawLimit = url.searchParams.get('limit')
  const requested = {
    q: parseQuery(url),
    kind: parseKind(url, log),
    limit: rawLimit === null || rawLimit.trim() === ''
      ? DEFAULT_OVERVIEW_LIMIT
      : clampInt(rawLimit, 1, MAX_ENTRIES, DEFAULT_OVERVIEW_LIMIT),
  }
  const raw = await callFacade(facade, 'overview', requested)
  if (raw === null || typeof raw !== 'object') throw facadeError('STORE_UNAVAILABLE', 'panel data source unavailable')
  const rows = Array.isArray(raw.entries) ? raw.entries : []
  const entries = []
  const seen = new Set()
  for (const item of rows) {
    const entry = normalizeEntrySummary(item)
    if (entry === null || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
    if (entries.length >= requested.limit) break
  }
  return {
    ok: true,
    scope: { key: PANEL_SCOPE.key, label: PANEL_SCOPE.label },
    entries,
    stats: normalizeStats(raw.stats),
    peers: normalizePeers(raw.peers),
    truncated: raw.truncated === true || rows.length > entries.length,
  }
}

/** Single-entry payload: note body + one level of replies (global id lookup). */
async function entryPayload({ facade, url, config, log }) {
  const id = parseEntryId(url)
  const maxBodyBytes = clampInt(config?.store?.maxBodyBytes, 256, 1_500_000, 8192)
  // Character budget stays well under the byte cap for UTF-8 bodies.
  const maxBodyChars = clampInt(Math.floor(maxBodyBytes / 4), 4096, 200_000, 4096)
  const raw = await callFacade(facade, 'entry', id)
  if (raw === null || typeof raw !== 'object' || raw.entry === null || typeof raw.entry !== 'object') {
    throw facadeError('NOT_FOUND', 'entry not found')
  }
  const entry = entryDetailPayload({ ...raw.entry, id: raw.entry.id ?? id }, maxBodyChars)
  if (entry === null) throw facadeError('NOT_FOUND', 'entry not found')
  const replies = []
  if (Array.isArray(raw.replies)) {
    for (const item of raw.replies) {
      const reply = normalizeReply(item)
      if (reply === null) continue
      replies.push(reply)
      if (replies.length >= MAX_REPLIES) break
    }
  }
  log.debug({ event: 'confluence.hostui.entry', bytes: byteLength(JSON.stringify(entry)) })
  return { ok: true, entry, replies }
}

/** Call one facade read method; a missing method is an explicit degraded state. */
async function callFacade(facade, method, ...args) {
  if (facade === null || typeof facade !== 'object' || typeof facade[method] !== 'function') {
    throw facadeError('STORE_UNAVAILABLE', 'panel data source unavailable')
  }
  return await facade[method](...args)
}

/** Build a facade-style error with a stable code. */
function facadeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Parse and validate the `id` query parameter. */
function parseEntryId(url) {
  const raw = url.searchParams.get('id')
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (id === '') throw facadeError('BAD_ARGUMENT', 'missing entry id')
  if (!ENTRY_ID_RE.test(id)) throw facadeError('NOT_FOUND', 'entry not found')
  return id
}

/** Trimmed, capped free-text search query (empty means "no filter"). */
function parseQuery(url) {
  const raw = url.searchParams.get('q')
  if (typeof raw !== 'string') return ''
  const trimmed = raw.replace(CONTROL_CHARS_RE, ' ').trim()
  return trimmed.length > MAX_QUERY_CHARS ? trimmed.slice(0, MAX_QUERY_CHARS) : trimmed
}

/** Optional kind filter; unknown values are ignored (not an error). */
function parseKind(url, log) {
  const raw = url.searchParams.get('kind')
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const kind = raw.trim()
  if (KIND_VALUES.has(kind)) return kind
  log.debug({ event: 'confluence.hostui.unknown-kind' })
  return undefined
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/** Send one JSON response honoring HEAD and the hard size cap. */
function sendJson(res, req, status, payload) {
  let serialized = JSON.stringify(payload)
  let currentStatus = status
  if (byteLength(serialized) > MAX_RESPONSE_BYTES) {
    currentStatus = 500
    serialized = JSON.stringify({
      ok: false,
      error: {
        code: 'CONFLUENCE_RESPONSE_TOO_LARGE',
        message: 'panel response exceeded the 64 KiB limit',
      },
    })
  }
  const size = byteLength(serialized)
  res.statusCode = currentStatus
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('content-length', String(size))
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(serialized)
}

/** Respond with an error envelope (used before a route runs). */
function sendError(res, req, status, code, message) {
  sendJson(res, req, status, { ok: false, error: { code, message } })
}

/**
 * Create the Node request handler for one exact route. The returned function may be
 * awaited by tests; the real web server accepts either a value or a promise.
 */
function createRouteHandler(context, route) {
  return function handleRequest(req, res) {
    return dispatch(context, route, req, res).catch((error) => {
      context.log.error({ event: 'confluence.hostui.dispatch-failed', message: cleanMessage(error) })
      try {
        sendError(res, req, 500, 'CONFLUENCE_INTERNAL', 'panel request failed')
      } catch {
        // The response is already gone; nothing else can be done.
      }
    })
  }
}

/** Dispatch one request through the guards, route and response cap. */
async function dispatch(context, route, req, res) {
  if (req === null || typeof req !== 'object' || res === null || typeof res !== 'object') return
  if (rejectedByConnection(context.ctx, req, res)) return
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('allow', 'GET, HEAD')
    res.setHeader('cache-control', 'no-store')
    res.end()
    return
  }
  const origin = originProblem(req, context.webServer)
  if (origin !== null) {
    sendError(res, req, origin.status, origin.code, 'cross-origin panel request rejected')
    return
  }
  let url
  try {
    url = new URL(typeof req.url === 'string' && req.url.length > 0 ? req.url : '/', 'http://127.0.0.1')
  } catch {
    sendError(res, req, 400, 'CONFLUENCE_INVALID_ARGUMENT', 'invalid request url')
    return
  }
  let payload
  try {
    payload = await route.run({ ...context, req, url })
  } catch (error) {
    const mapped = mapError(error)
    sendJson(res, req, mapped.status, mapped.payload)
    return
  }
  if (payload === null || typeof payload !== 'object') {
    sendError(res, req, 500, 'CONFLUENCE_INTERNAL', 'panel request failed')
    return
  }
  const fitted = fitPayload(route.name, payload)
  sendJson(res, req, 200, fitted.payload)
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Register the read-only panel data routes on the optional `webServer` service.
 *
 * @param {object} ctx Cordis plugin context (only `get`/`effect`/`logger` are used).
 * @param {object} options `{ facade, config, logger }` (the v0.1.0 `workspaceResolver`
 *   option is accepted and ignored so the plugin entry needs no signature change).
 * @returns {() => void} disposer; a no-op when the UI is disabled or cannot mount.
 */
export function registerHostUi(ctx, options = {}) {
  const log = safeLogger(options.logger)
  const noop = () => {}
  if (options.config?.ui?.enabled === false) {
    log.debug({ event: 'confluence.hostui.disabled' })
    return noop
  }
  if (options.facade === null || typeof options.facade !== 'object') {
    log.warn({ event: 'confluence.hostui.no-facade' })
    return noop
  }
  const webServer = getService(ctx, 'webServer')
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') {
    log.debug({ event: 'confluence.hostui.no-web-server' })
    return noop
  }
  const context = {
    ctx,
    webServer,
    facade: options.facade,
    config: options.config !== null && typeof options.config === 'object' ? options.config : {},
    log,
  }
  const disposers = []
  const disposeAll = once(() => {
    for (const dispose of disposers.splice(0)) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (error) {
        log.warn({ event: 'confluence.hostui.dispose-failed', message: cleanMessage(error) })
      }
    }
  })
  for (const route of ROUTES) {
    const handler = createRouteHandler(context, route)
    const register = () => webServer.register({ kind: 'exact', path: route.path, handler })
    try {
      const disposer = typeof ctx?.effect === 'function'
        ? ctx.effect(register, `confluence:hostui:${route.name}`)
        : register()
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      log.warn({ event: 'confluence.hostui.route-register-failed', path: route.path, message: cleanMessage(error) })
    }
  }
  if (disposers.length === 0) {
    log.warn({ event: 'confluence.hostui.no-routes' })
    return noop
  }
  log.info({ event: 'confluence.hostui.ready', routes: ROUTES.length })
  return disposeAll
}

// Internal helpers exported for the unit tests only (not used by the plugin entry).
export const hostuiInternals = {
  cleanRelativePath,
  cleanLine,
  cleanProvenanceLabel,
  normalizeEntrySummary,
  normalizeEntryDetail,
  normalizeStats,
  normalizePeers,
  fitPayload,
  mapError,
  ROUTES,
}
