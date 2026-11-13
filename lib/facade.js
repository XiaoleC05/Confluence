// Confluence / 汇流 — integration facade (Lead-owned).
//
// The facade is the only object the model-facing tools (`lib/tools.js`) and the
// read-only panel routes (`lib/hostui.js`) talk to. It owns:
//   - workspace resolution + journal/board attachment per session (cache),
//   - author/title derivation for board records,
//   - the synchronous board/presence/cursor reads the pulse needs,
//   - the read-only panel payloads (workspaces / overview / entry).
//
// Everything here is derived from `docs/plan/implementation-interfaces.md` §11,
// `docs/design/data-model.md`, `docs/design/store-format.md` and the concrete
// module APIs that landed in the build round. No network, no DSH package imports.

import path from 'node:path'

import { ConfluenceError } from './util.js'

const WS_KEY_RE = /^ws_[0-9a-f]{16}$/
const ENTRY_ID_RE = /^(?:cnf|tmb)_[0-9A-HJKMNP-TV-Z]{26}$/
const MAX_OVERVIEW = 100
const MAX_WORKSPACES = 64

/** @param {unknown} value @returns {string} */
function asString(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

/** @param {unknown} value @returns {number} */
function asNumber(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** @param {unknown} agent @returns {object | null} */
function sessionOf(agent) {
  if (agent === null || typeof agent !== 'object') return null
  const session = agent.session
  return session !== null && typeof session === 'object' ? session : null
}

/**
 * @param {unknown} agent
 * @returns {string | null}
 */
function sessionIdOf(agent) {
  const session = sessionOf(agent)
  if (session !== null) {
    const id = asString(session.id)
    if (id !== '') return id
    const headerId = asString(session.header && session.header.id)
    if (headerId !== '') return headerId
  }
  if (agent !== null && typeof agent === 'object') {
    const id = asString(agent.id)
    if (id !== '') return id
  }
  return null
}

/** @param {unknown} session @returns {string | null} */
function idOfSession(session) {
  if (session === null || typeof session !== 'object') return null
  const id = asString(session.id)
  if (id !== '') return id
  const headerId = asString(session.header && session.header.id)
  return headerId !== '' ? headerId : null
}

/** @param {unknown} value @returns {string | null} */
function titleFrom(value) {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim()
  if (value === null || typeof value !== 'object') return null
  for (const key of ['title', 'displayTitle', 'label']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return null
}

/** @param {unknown} entry @returns {{ id: string, seq: string, kind: string, title: string, ts: string, status: string, replyTo: string, authorTitle: string, deleted: boolean, tags: string[], files: string[], body: string }} */
function entrySummary(entry) {
  const record = entry && typeof entry === 'object' ? entry : {}
  const author = record.author && typeof record.author === 'object' ? record.author : {}
  return {
    id: asString(record.id),
    seq: asString(record.seq),
    kind: asString(record.kind) || 'warning',
    title: asString(record.title),
    ts: asString(record.ts ?? record.createdAt),
    status: asString(record.status) || 'active',
    replyTo: asString(record.replyTo),
    authorTitle: asString(author.title ?? record.authorTitle ?? record.sessionTitle),
    deleted: record.deleted === true,
    tags: Array.isArray(record.tags) ? record.tags.filter((t) => typeof t === 'string') : [],
    files: Array.isArray(record.files) ? record.files.filter((f) => typeof f === 'string') : [],
    body: asString(record.body),
  }
}

export class ConfluenceFacade {
  /**
   * @param {object} options
   * @param {object} options.config resolved config
   * @param {object} options.logger structured logger
   * @param {object} options.workspaceResolver `createWorkspaceResolver()` result
   * @param {object} options.store JournalStore
   * @param {object} options.board BoardService
   * @param {object} options.presence Presence
   * @param {object} options.watermark WatermarkTracker
   * @param {object} [options.recall] RecallService (optional)
   * @param {object | null} [options.sessionQuery] optional host service
   * @param {object | null} [options.sessionTitle] optional host service
   * @param {(wsKey: string) => void} [options.onBoardChanged]
   */
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {}
    this.config = opts.config && typeof opts.config === 'object' ? opts.config : {}
    this.logger = opts.logger
    this.workspaceResolver = opts.workspaceResolver
    this.store = opts.store
    this.board = opts.board
    this.presence = opts.presence
    this.watermark = opts.watermark
    this.recallService = opts.recall ?? null
    this.sessionQuery = opts.sessionQuery ?? null
    this.sessionTitle = opts.sessionTitle ?? null
    this.onBoardChanged = typeof opts.onBoardChanged === 'function' ? opts.onBoardChanged : null

    /** @type {Map<string, {key: string, label?: string, canonicalPath?: string}>} */
    this.workspaces = new Map()
    /** @type {Map<string, object>} live Session objects by id (pulse cursor reads) */
    this.sessions = new Map()
    /** @type {Map<string, string>} wsKey -> workspace view cache for panel payloads */
    this.views = new Map()
  }

  // ── session / workspace plumbing ────────────────────────────────────────

  /** @param {object | null} session */
  trackSession(session) {
    const id = idOfSession(session)
    if (id !== null) this.sessions.set(id, session)
  }

  /** @param {string} sessionId @returns {object | null} */
  sessionFor(sessionId) {
    const session = this.sessions.get(sessionId)
    return session === undefined ? null : session
  }

  /** @param {string} sessionId @returns {{key: string, label?: string, canonicalPath?: string} | null} */
  cachedWorkspace(sessionId) {
    const ws = this.workspaces.get(sessionId)
    return ws === undefined ? null : ws
  }

  /** @returns {string[]} known workspace keys (cache order) */
  workspaceKeys() {
    const keys = new Set()
    for (const ws of this.workspaces.values()) keys.add(ws.key)
    return [...keys]
  }

  /**
   * Resolve, open and attach the workspace for one agent. Cached per session;
   * concurrent calls share one promise. Throws NO_WORKSPACE when unresolvable.
   * @param {object} agent
   * @returns {Promise<{key: string, label?: string, canonicalPath?: string}>}
   */
  async ensureWorkspace(agent) {
    const session = sessionOf(agent)
    const sessionId = sessionIdOf(agent)
    if (session === null || sessionId === null) {
      throw new ConfluenceError('NO_WORKSPACE', 'this session has no workspace directory.')
    }
    this.trackSession(session)
    const cached = this.workspaces.get(sessionId)
    if (cached !== undefined) return cached

    let resolved
    try {
      resolved = await this.workspaceResolver.resolve(session)
    } catch (error) {
      throw new ConfluenceError('NO_WORKSPACE', 'cannot resolve this session\'s workspace directory.', { cause: error })
    }
    if (!resolved || typeof resolved.key !== 'string' || resolved.key === '') {
      throw new ConfluenceError('NO_WORKSPACE', 'this session has no workspace directory.')
    }
    const ws = Object.freeze({
      key: resolved.key,
      label: typeof resolved.label === 'string' && resolved.label !== '' ? resolved.label : undefined,
      canonicalPath: typeof resolved.canonicalPath === 'string' ? resolved.canonicalPath : undefined,
    })
    try {
      await this.board.attach(ws.key, { canonicalPath: ws.canonicalPath, label: ws.label })
    } catch (error) {
      throw new ConfluenceError('STORE_UNAVAILABLE', 'the workspace memory store is unavailable.', { cause: error })
    }
    this.workspaces.set(sessionId, ws)
    return ws
  }

  /** @param {object} agent @returns {Promise<{key: string, label?: string, canonicalPath?: string}>} */
  async workspaceFor(agent) {
    return await this.ensureWorkspace(agent)
  }

  /** @param {string} sessionId @returns {Promise<{key: string, label?: string, canonicalPath?: string} | null>} */
  async workspaceBySessionId(sessionId) {
    const cached = this.workspaces.get(sessionId)
    if (cached !== undefined) return cached
    const session = this.sessions.get(sessionId)
    if (session === undefined) return null
    try {
      return await this.workspaceResolver.resolve(session)
    } catch {
      return null
    }
  }

  /** @param {object} agent @returns {Promise<string>} */
  async titleFor(agent) {
    const session = sessionOf(agent)
    const sessionId = sessionIdOf(agent)
    if (sessionId === null) return ''
    this.trackSession(session)
    const cached = this.workspaces.get(`title:${sessionId}`)
    if (cached !== undefined && cached.label !== undefined) return cached.label
    let title = null
    try {
      if (this.sessionQuery && typeof this.sessionQuery.readTitle === 'function') {
        title = titleFrom(await Promise.resolve(this.sessionQuery.readTitle(sessionId)))
      }
    } catch {
      title = null
    }
    if (title === null && this.sessionTitle && typeof this.sessionTitle.get === 'function' && session !== null) {
      try {
        title = titleFrom(this.sessionTitle.get(session))
      } catch {
        title = null
      }
    }
    if (title === null && session !== null) {
      title = titleFrom(session.header && session.header.title)
    }
    const value = title === null ? '' : title
    this.workspaces.set(`title:${sessionId}`, { key: `title:${sessionId}`, label: value })
    return value
  }

  // ── model-facing reads/writes (tools) ───────────────────────────────────

  /**
   * Synchronous board view for the tools/pulse. Requires a warmed workspace
   * (tools call `workspaceFor()` first, which the facade caches).
   * @param {object} agent
   * @returns {object}
   */
  boardView(agent) {
    const sessionId = sessionIdOf(agent)
    const ws = sessionId === null ? null : this.cachedWorkspace(sessionId)
    if (ws === null) throw new ConfluenceError('NO_WORKSPACE', 'this session has no workspace directory.')
    const view = this.board.view(ws.key)
    const session = sessionId === null ? null : this.sessionFor(sessionId)
    const cursor = session === null ? { digestSeq: null, boardReadSeq: null } : this.watermark.get(session)
    const boardReadSeq = cursor && typeof cursor.boardReadSeq === 'string' ? cursor.boardReadSeq : null
    const roots = Array.isArray(view.roots) ? view.roots : []
    const entries = roots.map(entrySummary)
    const unreadEntries = entries.filter((entry) => boardReadSeq === null || entry.seq > boardReadSeq)
    const peers = this.peersFor(ws.key).filter((peer) => peer.sessionId !== sessionId)
    const replyCounts = new Map()
    for (const entry of view.entries.values()) {
      const parent = asString(entry.replyTo)
      if (parent !== '') replyCounts.set(parent, (replyCounts.get(parent) ?? 0) + 1)
    }
    return {
      workspace: ws,
      entries,
      roots,
      openQuestions: Array.isArray(view.openQuestions) ? view.openQuestions.map(entrySummary) : [],
      openHandoffs: Array.isArray(view.openHandoffs) ? view.openHandoffs.map(entrySummary) : [],
      questions: Array.isArray(view.questions) ? view.questions.map(entrySummary) : [],
      handoffs: Array.isArray(view.handoffs) ? view.handoffs.map(entrySummary) : [],
      stats: { ...(view.stats || {}), total: asNumber(view.stats && view.stats.entries), unread: unreadEntries.length },
      peers,
      unread: unreadEntries.length,
      maxSeq: asString(view.maxSeq),
      replyCounts,
    }
  }

  /**
   * @param {object} agent
   * @param {{kind: string, title: string, body?: string, tags?: string[], files?: string[], replyTo?: string, resolves?: boolean, supersedes?: string}} input
   * @returns {Promise<{id: string, seq: string, kind: string, status: string}>}
   */
  async post(agent, input) {
    const ws = await this.ensureWorkspace(agent)
    const author = { sessionId: sessionIdOf(agent) ?? '', title: await this.titleFor(agent), origin: 'agent' }
    const result = await this.board.post(ws.key, input, author)
    this.notifyChanged(ws.key)
    return result
  }

  /**
   * Reply to an entry (or resolve/reopen a question/handoff). The reply keeps
   * the root's kind and is stored as a normal entry with `replyTo`.
   * @param {object} agent
   * @param {{id: string, body: string, resolves?: boolean}} input
   * @returns {Promise<{id: string, seq: string, resolved: boolean, threadId: string}>}
   */
  async reply(agent, input) {
    const ws = await this.ensureWorkspace(agent)
    const target = asString(input && input.id)
    if (target === '') throw new ConfluenceError('BAD_ARGUMENT', 'id is required.')
    const thread = await this.board.thread(ws.key, target)
    if (!thread || thread.notFound || !thread.entry) {
      throw new ConfluenceError('NOT_FOUND', `no note "${target}" in this workspace.`)
    }
    const root = thread.entry.replyTo ? await this.board.thread(ws.key, asString(thread.entry.replyTo)) : thread
    const rootEntry = root && root.entry ? root.entry : thread.entry
    const rootId = asString(rootEntry && rootEntry.id) || target
    const kind = asString(rootEntry && rootEntry.kind) || 'warning'
    const title = `Re: ${asString(rootEntry && rootEntry.title)}`
    const body = asString(input && input.body)
    if (body.trim() === '') throw new ConfluenceError('BAD_ARGUMENT', 'body is required.')
    const result = await this.board.post(
      ws.key,
      {
        kind: ['finding', 'decision', 'gotcha', 'question', 'handoff', 'warning'].includes(kind) ? kind : 'warning',
        title,
        body,
        replyTo: rootId,
        resolves: input && typeof input.resolves === 'boolean' ? input.resolves : undefined,
      },
      { sessionId: sessionIdOf(agent) ?? '', title: await this.titleFor(agent), origin: 'agent' },
    )
    this.notifyChanged(ws.key)
    return { id: result.id, seq: result.seq, resolved: Boolean(input && input.resolves === true), threadId: rootId }
  }

  /**
   * Read one board entry with its thread.
   * @param {object} agent
   * @param {string} ref entry id
   * @returns {Promise<object>}
   */
  async readEntry(agent, ref) {
    if (typeof ref !== 'string' || ref.trim() === '') {
      throw new ConfluenceError('BAD_ARGUMENT', 'ref is required.')
    }
    if (ref.startsWith('session:')) return await this.readRef(agent, ref)
    const ws = await this.ensureWorkspace(agent)
    const thread = await this.board.thread(ws.key, ref.trim())
    if (!thread || thread.notFound || !thread.entry) {
      throw new ConfluenceError('NOT_FOUND', `no note "${ref}" in this workspace.`)
    }
    const entry = entrySummary(thread.entry)
    const replies = (thread.replies || []).map(entrySummary)
    const through = [entry.seq, ...replies.map((reply) => reply.seq)].filter(Boolean).sort().pop() || ''
    return { entry, replies, resolved: thread.resolved === true, superseded: thread.superseded === true, through }
  }

  /**
   * @param {object} agent
   * @param {{query: string, kind?: string, tag?: string, limit?: number}} input
   * @returns {Promise<{hits: object[], truncated: boolean}>}
   */
  async search(agent, input) {
    const ws = await this.ensureWorkspace(agent)
    const result = await this.board.search(ws.key, input || {})
    const hits = (result.hits || []).map((hit) => ({
      entry: entrySummary(hit.entry),
      snippet: asString(hit.snippet),
      score: asNumber(hit.score),
    }))
    return { hits, truncated: result.truncated === true }
  }

  /**
   * @param {object} agent
   * @param {{query: string, limit?: number}} input
   * @returns {Promise<object>}
   */
  async recall(agent, input) {
    if (this.recallService === null || typeof this.recallService.recall !== 'function' || !this.recallService.enabled()) {
      throw new ConfluenceError('RECALL_UNAVAILABLE', 'session history is not readable in this profile.')
    }
    return await this.recallService.recall({ agent, query: input && input.query, limit: input && input.limit })
  }

  /**
   * @param {object} agent
   * @param {string} ref `session:<id>:<seq>` (or a recall hit ref)
   * @returns {Promise<object>}
   */
  async readRef(agent, ref) {
    if (this.recallService === null || typeof this.recallService.readRef !== 'function' || !this.recallService.enabled()) {
      throw new ConfluenceError('RECALL_UNAVAILABLE', 'session history is not readable in this profile.')
    }
    return await this.recallService.readRef({ agent, ref })
  }

  // ── read-only panel payloads (hostui) ───────────────────────────────────

  /** @returns {Promise<object[]>} */
  async listWorkspaces() {
    let rows = []
    try {
      rows = await this.store.listWorkspaces()
    } catch (error) {
      this.warn('facade.list_workspaces_failed', { message: String(error) })
      return []
    }
    const out = []
    for (const row of rows) {
      if (out.length >= MAX_WORKSPACES) break
      const wsKey = asString(row && (row.wsKey ?? row.key))
      if (!WS_KEY_RE.test(wsKey)) continue
      const label = asString(row && (row.label ?? row.name)) || labelFromPath(row && row.canonicalPath) || wsKey
      let entries = 0
      let openQuestions = 0
      try {
        await this.board.attach(wsKey, { canonicalPath: row && row.canonicalPath, label })
        const view = this.board.view(wsKey)
        entries = asNumber(view.stats && view.stats.entries)
        openQuestions = asNumber(view.stats && view.stats.openQuestions)
      } catch {
        // A broken workspace is still listed with zero counts.
      }
      out.push({
        key: wsKey,
        label,
        canonicalPath: asString(row && row.canonicalPath),
        entries,
        openQuestions,
        live: this.peersFor(wsKey).length > 0,
      })
    }
    return out
  }

  /**
   * @param {string} wsKey
   * @param {{q?: string, kind?: string, limit?: number}} [requested]
   * @returns {Promise<object | null>}
   */
  async overview(wsKey, requested = {}) {
    if (!WS_KEY_RE.test(asString(wsKey))) throw new ConfluenceError('NOT_FOUND', 'workspace not found.')
    const meta = await this.openForPanel(wsKey)
    if (meta === null) throw new ConfluenceError('NOT_FOUND', 'workspace not found.')
    const view = this.board.view(wsKey)
    const query = asString(requested && requested.q).trim()
    const kind = asString(requested && requested.kind).trim()
    const limit = Math.max(1, Math.min(MAX_OVERVIEW, Math.trunc(asNumber(requested && requested.limit) || 20)))
    const replyCounts = new Map()
    for (const entry of view.entries.values()) {
      const parent = asString(entry.replyTo)
      if (parent !== '') replyCounts.set(parent, (replyCounts.get(parent) ?? 0) + 1)
    }
    let rows
    if (query !== '') {
      const result = await this.board.search(wsKey, { query, kind: kind === '' ? undefined : kind, limit })
      rows = result.hits.map((hit) => hit.entry)
    } else {
      rows = Array.isArray(view.roots) ? view.roots : []
      if (kind !== '') rows = rows.filter((entry) => asString(entry.kind) === kind)
    }
    const entries = rows.slice(0, limit).map((entry) => {
      const summary = entrySummary(entry)
      return {
        id: summary.id,
        seq: summary.seq,
        kind: summary.kind,
        title: summary.title,
        authorTitle: summary.authorTitle,
        ts: summary.ts,
        status: summary.status,
        replyCount: replyCounts.get(summary.id) ?? 0,
      }
    })
    return {
      workspace: { key: wsKey, label: meta.label, canonicalPath: meta.canonicalPath },
      entries,
      stats: {
        total: asNumber(view.stats && view.stats.entries),
        openQuestions: asNumber(view.stats && view.stats.openQuestions),
        openHandoffs: asNumber(view.stats && view.stats.openHandoffs),
        unread: 0,
      },
      peers: this.peersFor(wsKey).map((peer) => ({ title: peer.title, status: peer.status })),
      truncated: rows.length > limit,
    }
  }

  /**
   * @param {string} wsKey
   * @param {string} id entry id
   * @returns {Promise<object | null>}
   */
  async entry(wsKey, id) {
    if (!WS_KEY_RE.test(asString(wsKey))) throw new ConfluenceError('NOT_FOUND', 'workspace not found.')
    if (!ENTRY_ID_RE.test(asString(id))) throw new ConfluenceError('NOT_FOUND', 'entry not found.')
    const meta = await this.openForPanel(wsKey)
    if (meta === null) throw new ConfluenceError('NOT_FOUND', 'workspace not found.')
    const thread = await this.board.thread(wsKey, id)
    if (!thread || thread.notFound || !thread.entry) throw new ConfluenceError('NOT_FOUND', 'entry not found.')
    const summary = entrySummary(thread.entry)
    return {
      entry: {
        id: summary.id,
        seq: summary.seq,
        kind: summary.kind,
        title: summary.title,
        body: summary.body,
        tags: summary.tags,
        files: summary.files,
        authorTitle: summary.authorTitle,
        ts: summary.ts,
        status: summary.status,
      },
      replies: (thread.replies || []).map((reply) => {
        const row = entrySummary(reply)
        return { id: row.id, seq: row.seq, body: row.body, authorTitle: row.authorTitle, ts: row.ts }
      }),
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** @param {string} wsKey @returns {Promise<{label: string, canonicalPath: string} | null>} */
  async openForPanel(wsKey) {
    let meta = null
    try {
      meta = typeof this.store.workspaceMeta === 'function' ? this.store.workspaceMeta(wsKey) : null
    } catch {
      meta = null
    }
    if (meta === null) {
      try {
        const rows = await this.store.listWorkspaces()
        meta = (rows || []).find((row) => asString(row && (row.wsKey ?? row.key)) === wsKey) ?? null
      } catch {
        meta = null
      }
    }
    if (meta === null) return null
    const canonicalPath = asString(meta.canonicalPath)
    const label = asString(meta.label) || labelFromPath(canonicalPath) || wsKey
    await this.board.attach(wsKey, { canonicalPath, label })
    return { label, canonicalPath }
  }

  /** @param {string} wsKey @returns {Array<{sessionId?: string, title: string, status: string}>} */
  peersFor(wsKey) {
    let peers = []
    try {
      peers = typeof this.presence.live === 'function' ? this.presence.live(wsKey) : []
    } catch {
      peers = []
    }
    if (!Array.isArray(peers)) return []
    return peers.map((peer) => ({
      sessionId: asString(peer && (peer.sessionId ?? peer.id)),
      title: asString(peer && (peer.title ?? peer.sessionTitle)) || 'session',
      status: asString(peer && peer.status) || 'unknown',
    }))
  }

  /** @param {string} wsKey */
  notifyChanged(wsKey) {
    try {
      if (this.onBoardChanged !== null) this.onBoardChanged(wsKey)
    } catch {
      // Notification is best-effort.
    }
  }

  /** @param {string} event @param {object} [fields] */
  warn(event, fields) {
    try {
      if (this.logger && typeof this.logger.warn === 'function') this.logger.warn({ event, ...fields })
    } catch {
      // Logging must never throw.
    }
  }
}

/** @param {unknown} canonicalPath @returns {string} */
function labelFromPath(canonicalPath) {
  const value = asString(canonicalPath)
  if (value === '') return ''
  return path.basename(value.replace(/[\\/]+$/, '')) || value
}
