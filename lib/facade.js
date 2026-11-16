// Confluence / 汇流 — integration facade (Lead-owned, v0.2.0 universal scope).
//
// The facade is the only object the model-facing tools (`lib/tools.js`) and the
// read-only panel routes (`lib/hostui.js`) talk to. In v0.2.0 memory is a
// UNIVERSAL profile-wide space: `scope = { key: 'global', label: 'All sessions' }`.
// Workspace/session data is provenance only (`origin`), never a partition or an
// authority boundary.
//
// It owns: one board attachment for the whole plugin, per-session origin/title
// caches, the synchronous board/presence/cursor reads the pulse needs, and the
// read-only panel payloads (overview / entry). No network, no DSH imports.

import { ConfluenceError } from './util.js'

/** The single universal memory scope (ADR-0007). */
export const MEMORY_SCOPE = Object.freeze({ key: 'global', label: 'All sessions' })

const ENTRY_ID_RE = /^(?:cnf|tmb)_[0-9A-HJKMNP-TV-Z]{26}$/
const MAX_OVERVIEW = 100

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

/** @param {unknown} agent @returns {string | null} */
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

/** @param {unknown} origin @returns {{workspaceKey?: string, workspaceLabel?: string}} */
function normalizeOrigin(origin) {
  const record = origin && typeof origin === 'object' ? origin : {}
  const workspaceKey = asString(record.workspaceKey)
  const workspaceLabel = asString(record.workspaceLabel)
  const out = {}
  if (workspaceKey !== '') out.workspaceKey = workspaceKey
  if (workspaceLabel !== '') out.workspaceLabel = workspaceLabel
  return out
}

/**
 * @param {unknown} entry
 * @returns {{id:string,seq:string,kind:string,title:string,ts:string,status:string,replyTo:string,
 *   authorTitle:string,workspaceLabel:string,deleted:boolean,tags:string[],files:string[],body:string}}
 */
function entrySummary(entry) {
  const record = entry && typeof entry === 'object' ? entry : {}
  const author = record.author && typeof record.author === 'object' ? record.author : {}
  const origin = normalizeOrigin(record.origin)
  return {
    id: asString(record.id),
    seq: asString(record.seq),
    kind: asString(record.kind) || 'warning',
    title: asString(record.title),
    ts: asString(record.ts ?? record.createdAt),
    status: asString(record.status) || 'active',
    replyTo: asString(record.replyTo),
    authorTitle: asString(author.title ?? record.authorTitle ?? record.sessionTitle),
    workspaceLabel: asString(origin.workspaceLabel),
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
   * @param {object} [options.logger] structured logger
   * @param {object} options.originResolver `createOriginResolver()` result (provenance only)
   * @param {object} options.store JournalStore
   * @param {object} options.board BoardService
   * @param {object} options.presence Presence
   * @param {object} options.watermark WatermarkTracker
   * @param {object} [options.recall] RecallService (optional)
   * @param {object | null} [options.sessionQuery] optional host service
   * @param {object | null} [options.sessionTitle] optional host service
   * @param {() => void} [options.onBoardChanged]
   */
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {}
    this.config = opts.config && typeof opts.config === 'object' ? opts.config : {}
    this.logger = opts.logger
    this.originResolver = opts.originResolver
    this.store = opts.store
    this.board = opts.board
    this.presence = opts.presence
    this.watermark = opts.watermark
    this.recallService = opts.recall ?? null
    this.sessionQuery = opts.sessionQuery ?? null
    this.sessionTitle = opts.sessionTitle ?? null
    this.onBoardChanged = typeof opts.onBoardChanged === 'function' ? opts.onBoardChanged : null

    /** @type {Map<string, object>} live Session objects by id (cursor reads) */
    this.sessions = new Map()
    /** @type {Map<string, {workspaceKey?: string, workspaceLabel?: string} | null>} origin by session id */
    this.origins = new Map()
    /** @type {Map<string, string>} session title cache */
    this.titles = new Map()
    /** @type {Promise<void> | null} board attachment (one universal board) */
    this.boardReady = null
  }

  // ── scope / session plumbing ────────────────────────────────────────────

  /** @returns {{key: string, label: string}} the one universal memory scope */
  scope() {
    return MEMORY_SCOPE
  }

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

  /** @param {string} sessionId @returns {{workspaceKey?: string, workspaceLabel?: string} | null} */
  originFor(sessionId) {
    const origin = this.origins.get(sessionId)
    return origin === undefined ? null : origin
  }

  /**
   * Idempotent board attachment for the universal scope.
   * @returns {Promise<void>}
   */
  async ensureBoard() {
    if (this.boardReady === null) {
      this.boardReady = Promise.resolve()
        .then(() => this.board.attach())
        .catch((error) => {
          this.boardReady = null
          throw new ConfluenceError('STORE_UNAVAILABLE', 'the shared memory store is unavailable.', { cause: error })
        })
    }
    return await this.boardReady
  }

  /**
   * Track the session, attach the board and resolve provenance once.
   * @param {object} agent
   * @returns {Promise<{scope: {key:string,label:string}, origin: object | null}>}
   */
  async ensureReady(agent) {
    this.assertSharedMemoryAllowed(agent)
    const session = sessionOf(agent)
    this.trackSession(session)
    await this.ensureBoard()
    const sessionId = sessionIdOf(agent)
    if (sessionId !== null && !this.origins.has(sessionId)) {
      let origin = null
      try {
        const resolved = await this.originResolver.resolve(session)
        if (resolved && typeof resolved === 'object') origin = normalizeOrigin(resolved)
      } catch {
        origin = null
      }
      this.origins.set(sessionId, origin)
    }
    const origin = sessionId === null ? null : this.origins.get(sessionId) ?? null
    return { scope: MEMORY_SCOPE, origin }
  }

  /**
   * Compatibility alias used by the tools: universal memory has no workspace
   * requirement, so this always resolves to the global scope.
   * @param {object} [_agent]
   * @returns {Promise<{key: string, label: string}>}
   */
  async workspaceFor(_agent) {
    return MEMORY_SCOPE
  }

  /** @param {string} [_sessionId] @returns {{key: string, label: string} | null} */
  cachedWorkspace(_sessionId) {
    return MEMORY_SCOPE
  }

  /**
   * `privacy.privateSessions` opts a session out of shared memory entirely
   * (ADR-0007 §2.8): no tools, no pulse, no ledger/presence, no recall.
   * @param {object} agent
   * @returns {boolean}
   */
  isPrivateSession(agent) {
    const sessionId = sessionIdOf(agent)
    if (sessionId === null) return false
    const privacy = this.config && typeof this.config === 'object' ? this.config.privacy : null
    const list = privacy && Array.isArray(privacy.privateSessions) ? privacy.privateSessions : []
    return list.includes(sessionId)
  }

  /**
   * @param {object} agent
   * @throws {ConfluenceError} UNAVAILABLE for a private session
   */
  assertSharedMemoryAllowed(agent) {
    if (this.isPrivateSession(agent)) {
      throw new ConfluenceError(
        'UNAVAILABLE',
        'this session is listed in privacy.privateSessions; Confluence shared memory is disabled for it.',
      )
    }
  }

  /** @param {object} agent @returns {Promise<string>} */
  async titleFor(agent) {
    const session = sessionOf(agent)
    const sessionId = sessionIdOf(agent)
    if (sessionId === null) return ''
    this.trackSession(session)
    const cached = this.titles.get(sessionId)
    if (cached !== undefined) return cached
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
    if (title === null && session !== null) title = titleFrom(session.header && session.header.title)
    const value = title === null ? '' : title
    this.titles.set(sessionId, value)
    return value
  }

  // ── model-facing reads/writes (tools) ───────────────────────────────────

  /**
   * Synchronous global board view for tools/pulse.
   * @param {object} agent
   * @returns {object}
   */
  boardView(agent) {
    this.assertSharedMemoryAllowed(agent)
    const sessionId = sessionIdOf(agent)
    const view = this.board.view()
    const session = sessionId === null ? null : this.sessionFor(sessionId)
    const cursor = session === null ? { digestSeq: null, boardReadSeq: null } : this.watermark.get(session)
    const boardReadSeq = cursor && typeof cursor.boardReadSeq === 'string' ? cursor.boardReadSeq : null
    const roots = Array.isArray(view.roots) ? view.roots : []
    const entries = roots.map(entrySummary)
    const unreadEntries = entries.filter((entry) => boardReadSeq === null || entry.seq > boardReadSeq)
    const peers = this.peersFor().filter((peer) => peer.sessionId !== sessionId)
    const replyCounts = new Map()
    for (const entry of view.entries.values()) {
      const parent = asString(entry.replyTo)
      if (parent !== '') replyCounts.set(parent, (replyCounts.get(parent) ?? 0) + 1)
    }
    return {
      scope: MEMORY_SCOPE,
      workspace: MEMORY_SCOPE,
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
   * @param {{kind:string,title:string,body?:string,tags?:string[],files?:string[],replyTo?:string,resolves?:boolean,supersedes?:string}} input
   * @returns {Promise<{id:string,seq:string,kind:string,status:string}>}
   */
  async post(agent, input) {
    const { origin } = await this.ensureReady(agent)
    const author = { sessionId: sessionIdOf(agent) ?? '', title: await this.titleFor(agent), origin: 'agent' }
    const result = await this.board.post(input, author, origin)
    this.notifyChanged()
    return result
  }

  /**
   * @param {object} agent
   * @param {{id:string,body:string,resolves?:boolean}} input
   * @returns {Promise<{id:string,seq:string,resolved:boolean,threadId:string}>}
   */
  async reply(agent, input) {
    const { origin } = await this.ensureReady(agent)
    const target = asString(input && input.id)
    if (target === '') throw new ConfluenceError('BAD_ARGUMENT', 'id is required.')
    const thread = await this.board.thread(target)
    if (!thread || thread.notFound || !thread.entry) {
      throw new ConfluenceError('NOT_FOUND', `no shared note "${target}".`)
    }
    const root = thread.entry.replyTo ? await this.board.thread(asString(thread.entry.replyTo)) : thread
    const rootEntry = root && root.entry ? root.entry : thread.entry
    const rootId = asString(rootEntry && rootEntry.id) || target
    const kind = asString(rootEntry && rootEntry.kind) || 'warning'
    const title = `Re: ${asString(rootEntry && rootEntry.title)}`
    const body = asString(input && input.body)
    if (body.trim() === '') throw new ConfluenceError('BAD_ARGUMENT', 'body is required.')
    const result = await this.board.post(
      {
        kind: ['finding', 'decision', 'gotcha', 'question', 'handoff', 'warning'].includes(kind) ? kind : 'warning',
        title,
        body,
        replyTo: rootId,
        resolves: input && typeof input.resolves === 'boolean' ? input.resolves : undefined,
      },
      { sessionId: sessionIdOf(agent) ?? '', title: await this.titleFor(agent), origin: 'agent' },
      origin,
    )
    this.notifyChanged()
    return { id: result.id, seq: result.seq, resolved: Boolean(input && input.resolves === true), threadId: rootId }
  }

  /**
   * @param {object} agent
   * @param {string} ref entry id or session ref
   * @returns {Promise<object>}
   */
  async readEntry(agent, ref) {
    if (typeof ref !== 'string' || ref.trim() === '') {
      throw new ConfluenceError('BAD_ARGUMENT', 'ref is required.')
    }
    if (ref.startsWith('session:')) return await this.readRef(agent, ref)
    await this.ensureReady(agent)
    const thread = await this.board.thread(ref.trim())
    if (!thread || thread.notFound || !thread.entry) {
      throw new ConfluenceError('NOT_FOUND', `no shared note "${ref}".`)
    }
    const entry = entrySummary(thread.entry)
    const replies = (thread.replies || []).map(entrySummary)
    const through = [entry.seq, ...replies.map((reply) => reply.seq)].filter(Boolean).sort().pop() || ''
    return { entry, replies, resolved: thread.resolved === true, superseded: thread.superseded === true, through }
  }

  /**
   * @param {object} agent
   * @param {{query:string,kind?:string,tag?:string,limit?:number}} input
   * @returns {Promise<{hits:object[],truncated:boolean}>}
   */
  async search(agent, input) {
    await this.ensureReady(agent)
    const result = await this.board.search(input || {})
    const hits = (result.hits || []).map((hit) => ({
      entry: entrySummary(hit.entry),
      snippet: asString(hit.snippet),
      score: asNumber(hit.score),
    }))
    return { hits, truncated: result.truncated === true }
  }

  /**
   * @param {object} agent
   * @param {{query:string,limit?:number}} input
   * @returns {Promise<object>}
   */
  async recall(agent, input) {
    this.assertSharedMemoryAllowed(agent)
    if (this.recallService === null || typeof this.recallService.recall !== 'function' || !this.recallService.enabled()) {
      throw new ConfluenceError('RECALL_UNAVAILABLE', 'session history is not readable in this profile.')
    }
    return await this.recallService.recall({ agent, query: input && input.query, limit: input && input.limit })
  }

  /**
   * @param {object} agent
   * @param {string} ref `session:<id>:<seq>`
   * @returns {Promise<object>}
   */
  async readRef(agent, ref) {
    this.assertSharedMemoryAllowed(agent)
    if (this.recallService === null || typeof this.recallService.readRef !== 'function' || !this.recallService.enabled()) {
      throw new ConfluenceError('RECALL_UNAVAILABLE', 'session history is not readable in this profile.')
    }
    return await this.recallService.readRef({ agent, ref })
  }

  // ── read-only panel payloads (hostui) ───────────────────────────────────

  /**
   * Universal memory overview for the panel.
   * @param {{q?:string,kind?:string,limit?:number}} [requested]
   * @returns {Promise<object>}
   */
  async overview(requested = {}) {
    await this.ensureBoard()
    const view = this.board.view()
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
      const result = await this.board.search({ query, kind: kind === '' ? undefined : kind, limit })
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
        workspaceLabel: summary.workspaceLabel,
        ts: summary.ts,
        status: summary.status,
        replyCount: replyCounts.get(summary.id) ?? 0,
      }
    })
    return {
      scope: { key: MEMORY_SCOPE.key, label: MEMORY_SCOPE.label },
      entries,
      stats: {
        total: asNumber(view.stats && view.stats.entries),
        openQuestions: asNumber(view.stats && view.stats.openQuestions),
        openHandoffs: asNumber(view.stats && view.stats.openHandoffs),
        unread: 0,
      },
      peers: this.peersFor().map((peer) => ({
        title: peer.title,
        status: peer.status,
        workspaceLabel: peer.workspaceLabel,
      })),
      truncated: rows.length > limit,
    }
  }

  /**
   * @param {string} id entry id
   * @returns {Promise<object>}
   */
  async entry(id) {
    if (!ENTRY_ID_RE.test(asString(id))) throw new ConfluenceError('NOT_FOUND', 'entry not found.')
    await this.ensureBoard()
    const thread = await this.board.thread(id)
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
        workspaceLabel: summary.workspaceLabel,
        ts: summary.ts,
        status: summary.status,
      },
      replies: (thread.replies || []).map((reply) => {
        const row = entrySummary(reply)
        return {
          id: row.id,
          seq: row.seq,
          body: row.body,
          authorTitle: row.authorTitle,
          workspaceLabel: row.workspaceLabel,
          ts: row.ts,
        }
      }),
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** @returns {Array<{sessionId: string, title: string, status: string, workspaceLabel: string}>} */
  peersFor() {
    let peers = []
    try {
      peers = typeof this.presence.live === 'function' ? this.presence.live() : []
    } catch {
      peers = []
    }
    if (!Array.isArray(peers)) return []
    return peers.map((peer) => {
      const sessionId = asString(peer && (peer.sessionId ?? peer.id))
      return {
        sessionId,
        title: asString(peer && (peer.title ?? peer.sessionTitle)) || 'session',
        status: asString(peer && peer.status) || 'unknown',
        workspaceLabel: asString(peer && peer.workspaceLabel),
      }
    })
  }

  notifyChanged() {
    try {
      if (this.onBoardChanged !== null) this.onBoardChanged()
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
