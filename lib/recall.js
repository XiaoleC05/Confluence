// Confluence / 汇流 — WP3c: on-demand, bounded, literal recall over same-workspace session logs.
//
// Contract: docs/plan/implementation-interfaces.md §10 (+ the Lead's WP3 addendum: `recall` and
// `readRef` accept `agent` and derive authority ONLY from `agent.session.header.cwd`, canonicalized
// — never from model arguments and never from a workspace resolver's ambient state);
// docs/design/ledger-recall.md §5–§6, §8 R1–R10; docs/design/tool-api.md §2 (recall/read refs).
//
// Read-only: this service never writes, edits or deletes a session log and never touches the
// Confluence store. Every call is explicit (tool handler only), bounded (≤3 sessions, ≤5 hits,
// ≤600-char excerpts), deadlined (cooperative `recall.timeoutMs`, 5 s default; partial results are
// returned and marked) and untrusted-framed by the tools layer. It never runs in the pulse provider.
//
// Canonicalisation: the caller's frozen project is `session.header.cwd`; `canonicalizeDir` (injected
// from lib/workspace.js when available, otherwise node:fs realpath + win32 lowercase fold) turns it
// into a workspace key. A realpath failure means no workspace (ADR-0001 §5); callers without a key
// get NO_WORKSPACE.
//
// Privacy (design §6): a private/caller-suppressed session gets RECALL_UNAVAILABLE; private or
// opted-out *target* sessions are excluded from enumeration and direct refs to them behave as
// NOT_FOUND, so a ref reveals nothing about suppressed sessions.
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRedactor } from './redact.js'

/** Hard caps from ADR-0001 §10 / ledger-recall §5. */
const MAX_SESSIONS_CEILING = 3
const MAX_HITS_CEILING = 5
const MIN_QUERY_CHARS = 2
const MAX_QUERY_CHARS = 200
const MAX_EXCERPT_CHARS = 600
const EXCERPT_CONTEXT_CHARS = 300
const MAX_READ_WINDOW_EVENTS = 3
const MAX_READ_TEXT_CHARS = 1200
const MAX_READ_CACHE_ENTRIES = 128
const READ_AUTH_CACHE_TTL_MS = 60000

/** Local error class until lib/util.js is present (final integration uses its ConfluenceError). */
class LocalConfluenceError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'ConfluenceError'
    this.code = code
    if (options && options.cause !== undefined) this.cause = options.cause
  }
}

/** Prefer the shared error class when the util module exists (dynamic import keeps this module
 *  unit-testable while the build round is concurrent). */
let ConfluenceError = LocalConfluenceError
try {
  const util = await import('./util.js')
  if (util && typeof util.ConfluenceError === 'function') ConfluenceError = util.ConfluenceError
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') throw error
}

/** @param {string} code @param {string} message @param {object} [options] */
function conf(code, message, options) {
  return new ConfluenceError(code, message, options)
}

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string | undefined} */
function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Unicode code-point length (the query cap is in characters, not code units). */
function charLength(value) {
  return typeof value === 'string' ? [...value].length : 0
}

/** Truncate to `maxChars` code points without splitting a surrogate pair; add `…` when clipped. */
function clip(value, maxChars) {
  if (typeof value !== 'string') return { text: '', truncated: false }
  const chars = [...value]
  if (chars.length <= maxChars) return { text: value, truncated: false }
  return { text: chars.slice(0, Math.max(0, maxChars - 1)).join('') + '…', truncated: true }
}

/** @param {unknown} value @returns {number} */
function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  return Number.NaN
}

/** Escape a literal query into a case-insensitive, whitespace-flexible RegExp. */
function literalMatcher(query) {
  const words = String(query)
    .trim()
    .split(/\s+/u)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter((word) => word.length > 0)
  if (words.length === 0) return null
  try {
    return new RegExp(words.join('\\s+'), 'iu')
  } catch {
    try {
      return new RegExp(words.join('\\s+'), 'i')
    } catch {
      return null
    }
  }
}

/** Neutralise excerpt text for untrusted rendering: strip controls, escape < & U+2028/2029. */
function neutralize(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u2028\u2029]/g, (char) => (char === '\u2028' ? '\\u2028' : '\\u2029'))
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
}

/**
 * Build a bounded excerpt around the first literal match (ledger-recall §5.2 "Excerpt
 * extraction"): ±300 chars of context, whitespace collapsed, ≤600 chars, `…` marks clipping.
 * @param {string} text
 * @param {string} query
 * @returns {string}
 */
function buildExcerpt(text, query) {
  const source = String(text ?? '')
  const matcher = literalMatcher(query)
  let start = 0
  let end = 0
  if (matcher !== null) {
    const match = matcher.exec(source)
    if (match && typeof match.index === 'number') {
      start = Math.max(0, match.index - EXCERPT_CONTEXT_CHARS)
      end = Math.min(source.length, match.index + match[0].length + EXCERPT_CONTEXT_CHARS)
    }
  }
  if (start === 0 && end === 0) {
    end = Math.min(source.length, MAX_EXCERPT_CHARS)
    start = 0
  }
  let excerpt = source.slice(start, end).replace(/\s+/gu, ' ').trim()
  const clipped = clip(excerpt, MAX_EXCERPT_CHARS)
  excerpt = clipped.text
  if (start > 0 && excerpt.length > 0 && !excerpt.startsWith('…')) excerpt = '…' + excerpt
  if (end < source.length && excerpt.length > 0 && !excerpt.endsWith('…')) excerpt += '…'
  if ([...excerpt].length > MAX_EXCERPT_CHARS) excerpt = clip(excerpt, MAX_EXCERPT_CHARS).text
  return excerpt
}

/** @param {unknown} role */
function roleOf(type) {
  switch (type) {
    case 'user/message':
      return 'user'
    case 'assistant/message':
      return 'assistant'
    case 'tool/call':
      return 'tool-call'
    case 'tool/result':
      return 'tool-result'
    case 'turn/end':
      return 'turn'
    default:
      return 'event'
  }
}

/**
 * Extract plain text from a message/result content value without reading reasoning blocks.
 * Accepts a string, a block array or a message object.
 * @param {unknown} value
 * @returns {string}
 */
function textFromContent(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = []
    for (const block of value) {
      if (!isPlainObject(block)) continue
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
        const nested = textFromContent(block.content)
        if (nested.length > 0) parts.push(nested)
      }
      // `reasoning` / `thinking` / image blocks are intentionally dropped.
    }
    return parts.join('\n')
  }
  if (isPlainObject(value)) {
    if (Array.isArray(value.content)) return textFromContent(value.content)
    if (typeof value.text === 'string') return value.text
    if (typeof value.message === 'string') return value.message
  }
  return ''
}

/**
 * Bounded text for one readRef window event. Tool output/arguments are model-visible only inside
 * this explicit read (never stored by the plugin), redacted by the caller.
 * @param {{type?: string, data?: object, seq?: number}} event
 * @param {(text: unknown) => {value: string, hits: number}} redactText
 * @returns {{role: string, text: string}}
 */
function readEventText(event, redactText) {
  const type = optionalString(event?.type) ?? 'event'
  const data = isPlainObject(event?.data) ? event.data : {}
  let text = ''
  switch (type) {
    case 'user/message':
    case 'assistant/message':
    case 'tool/result': {
      text = textFromContent(data.content ?? data.message ?? data.text)
      break
    }
    case 'tool/call': {
      const name = optionalString(data.name) ?? 'tool'
      const args = typeof data.arguments === 'string' ? data.arguments : safeStringify(data.arguments)
      const clipped = clip(args ?? '', 300)
      text = `${name}${clipped.text.length > 0 ? ': ' + clipped.text : ''}`
      break
    }
    case 'turn/end': {
      const kind = optionalString(data.reason?.kind) ?? optionalString(data.reason) ?? 'completed'
      text = `turn end: ${kind}`
      break
    }
    default:
      text = type
      break
  }
  const redacted = redactText(text)
  return { role: roleOf(type), text: redacted?.value ?? String(text) }
}

/** @param {unknown} value @returns {string | undefined} */
function safeStringify(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

export class RecallService {
  /**
   * @param {object} options
   * @param {object} [options.config] resolved config
   * @param {object} [options.logger] structured logger
   * @param {object} [options.deps] { sessionQuery, redactor, now, canonicalizeDir, setTimeout,
   *   clearTimeout, signal, ledger? (optional read-only ledger view for recency) }
   */
  constructor({ config, logger, deps } = {}) {
    this.config = config ?? {}
    this.logger = logger
    this.deps = deps ?? {}
    this.now = typeof this.deps.now === 'function' ? this.deps.now : () => Date.now()
    this.setTimeoutFn = typeof this.deps.setTimeout === 'function' ? this.deps.setTimeout : setTimeout
    this.clearTimeoutFn = typeof this.deps.clearTimeout === 'function' ? this.deps.clearTimeout : clearTimeout
    this.maxSessions = Math.min(
      clampInt(this.config?.recall?.maxSessions, MAX_SESSIONS_CEILING, 1, 10),
      MAX_SESSIONS_CEILING,
    )
    this.maxHits = clampInt(this.config?.recall?.maxHits, MAX_HITS_CEILING, 1, 20)
    this.timeoutMs = clampInt(this.config?.recall?.timeoutMs, 5000, 500, 30000)
    this.redactor =
      this.deps.redactor && typeof this.deps.redactor.text === 'function'
        ? this.deps.redactor
        : createRedactor(this.config, { logger: this.logger })
    this.readAuthCache = new Map() // `${callerWsKey}:${targetId}` -> { at, allowed }
    this.listCache = null // { at, records }
  }

  /** @returns {boolean} */
  enabled() {
    return Boolean(this.deps.sessionQuery && typeof this.deps.sessionQuery.listSessions === 'function')
  }

  /** @returns {object} */
  sessionQuery() {
    return this.deps.sessionQuery ?? null
  }

  /**
   * Literal search over earlier same-workspace sessions.
   * @param {object} input
   * @param {object} input.agent calling agent (authority: `agent.session.header.cwd`)
   * @param {string} input.query literal query (2–200 chars)
   * @param {number} [input.limit] requested hits (1–10; capped by `recall.maxHits`)
   * @returns {Promise<{hits: object[], truncated: boolean, tookMs: number, sessions_searched: number,
   *   sessions_matched: number, eligible_sessions: number, partial: boolean, timed_out: boolean,
   *   sessionsSearched: number, sessionsMatched: number, eligibleSessions: number,
   *   timedOut: boolean, took_ms: number}>}
   */
  async recall({ agent, query, limit } = {}) {
    const sq = this.sessionQuery()
    if (!sq) throw conf('RECALL_UNAVAILABLE', 'session history is not readable in this profile.')
    const caller = await this.callerWorkspace(agent)
    const rawQuery = typeof query === 'string' ? query : ''
    if (charLength(rawQuery) < MIN_QUERY_CHARS) {
      throw conf('BAD_ARGUMENT', `query must be at least ${MIN_QUERY_CHARS} characters.`)
    }
    if (charLength(rawQuery) > MAX_QUERY_CHARS) {
      throw conf('BAD_ARGUMENT', `query is too long (${charLength(rawQuery)} characters).`)
    }
    const requested = clampInt(limit, this.maxHits, 1, 10)
    const hitCap = Math.min(requested, this.maxHits, MAX_HITS_CEILING)
    const startedAt = this.now()
    const deadline = startedAt + this.timeoutMs
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timeoutTimer = this.setTimeoutFn(() => controller?.abort(), this.timeoutMs)
    if (timeoutTimer && typeof timeoutTimer.unref === 'function') timeoutTimer.unref()

    let records
    try {
      records = await sq.listSessions(controller?.signal)
    } catch (error) {
      this.cleanupTimer(timeoutTimer)
      throw conf('RECALL_UNAVAILABLE', `session history listing failed: ${String(error?.message ?? error)}`, {
        cause: error,
      })
    }
    if (!Array.isArray(records)) records = []

    // Canonicalize + filter: same frozen workspace as the caller, never the caller itself, never a
    // private/disabled target. Authority comes from the header cwd only (addendum).
    const canonicalCache = new Map()
    const candidates = []
    for (const record of records) {
      if (!isPlainObject(record) || !isPlainObject(record.header)) continue
      const id = optionalString(record.header.id)
      const cwd = optionalString(record.header.cwd)
      if (id === undefined || cwd === undefined) continue
      if (id === caller.sessionId) continue
      if (this.isPrivateSession(id)) continue
      let canonical = canonicalCache.get(cwd)
      if (canonical === undefined) {
        canonical = await this.canonicalize(cwd)
        canonicalCache.set(cwd, canonical)
      }
      if (canonical === null) continue
      const wsKey = workspaceKeyFor(canonical)
      if (wsKey !== caller.wsKey) continue
      if (this.isDisabledWorkspace(wsKey)) continue
      candidates.push({ record, sessionId: id, createdAtMs: toMillis(record.header.createdAt) })
    }

    // Recency order: ledger lastActivityTs when a ledger view is injected, else header.createdAt;
    // deterministic tie-break by session id ascending (ledger-recall §5.2 step 4).
    const ledgerRows = this.ledgerView(caller.wsKey)
    const recencyOf = (candidate) => {
      const row = ledgerRows?.get?.(candidate.sessionId)
      const fromLedger = row !== undefined ? toMillis(row.lastActivityTs) : Number.NaN
      if (Number.isFinite(fromLedger)) return fromLedger
      return Number.isFinite(candidate.createdAtMs) ? candidate.createdAtMs : 0
    }
    candidates.sort((a, b) => {
      const delta = recencyOf(b) - recencyOf(a)
      if (delta !== 0) return delta
      return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0
    })
    const eligibleSessions = candidates.length
    const selected = candidates.slice(0, this.maxSessions)

    let timedOut = false
    let failed = 0
    let searched = 0
    const perSession = []
    for (const candidate of selected) {
      const remaining = deadline - this.now()
      if (remaining <= 0) {
        timedOut = true
        break
      }
      let outcome
      try {
        outcome = await raceDeadline(
          Promise.resolve().then(() =>
            sq.filterEvents(candidate.sessionId, [{ kind: 'text', text: rawQuery }]),
          ),
          remaining,
          this,
        )
      } catch (error) {
        failed += 1
        this.warn({ event: 'recall.session_failed', sessionId: candidate.sessionId, error: String(error) })
        continue
      }
      if (outcome.timedOut) {
        timedOut = true
        break
      }
      searched += 1
      const docs = Array.isArray(outcome.value) ? outcome.value : []
      perSession.push({ sessionId: candidate.sessionId, docs: docs.slice() })
    }
    this.cleanupTimer(timeoutTimer)

    const ring = roundRobin(perSession, hitCap)
    const hits = []
    const titles = await this.titlesFor(selected.map((candidate) => candidate.sessionId))
    for (const item of ring) {
      const excerpt = neutralize(this.redact(buildExcerpt(item.docText, rawQuery)).value)
      const seq = Number.isInteger(item.seq) ? item.seq : Number.parseInt(item.seq, 10)
      hits.push({
        sessionId: item.sessionId,
        session_id: item.sessionId,
        title: titles.get(item.sessionId) ?? '',
        seq: Number.isFinite(seq) ? seq : 0,
        type: item.type,
        excerpt,
        ref: `session:${item.sessionId}:${Number.isFinite(seq) ? seq : 0}`,
      })
    }
    const tookMs = Math.max(0, this.now() - startedAt)
    if (hits.length === 0 && timedOut) {
      throw conf('RECALL_TIMEOUT', `no literal matches before the ${this.timeoutMs} ms cap.`)
    }
    const result = {
      hits,
      truncated: ring.length < perSession.reduce((sum, session) => sum + session.docs.length, 0) ||
        hits.length >= hitCap,
      tookMs,
      took_ms: tookMs,
      sessions_searched: searched,
      sessionsSearched: searched,
      sessions_matched: perSession.filter((session) => session.docs.length > 0).length,
      sessionsMatched: perSession.filter((session) => session.docs.length > 0).length,
      eligible_sessions: eligibleSessions,
      eligibleSessions,
      partial: timedOut || failed > 0,
      timed_out: timedOut,
      timedOut,
    }
    // Counters are also mirrored on the hit list consumers that expect the raw arrays.
    result.partial = timedOut || failed > 0
    if (failed > 0) result.failed_sessions = failed
    return result
  }

  /**
   * Expand one `session:<id>:<seq>` recall reference into a bounded window (target ±1 event).
   * Authority: caller workspace from `agent.session.header.cwd`; a target in another workspace,
   * an unknown/private/disabled target, or an out-of-range seq is NOT_FOUND (no existence oracle).
   * @param {object} input
   * @param {object} input.agent calling agent
   * @param {string} input.ref `session:<id>:<seq>`
   * @param {number} [input.limit] accepted for interface compatibility; the v1 window is fixed
   * @returns {Promise<{sessionId: string, title: string, events: object[], truncated: boolean}>}
   */
  async readRef({ agent, ref, limit } = {}) {
    const sq = this.sessionQuery()
    if (!sq) throw conf('RECALL_UNAVAILABLE', 'session history is not readable in this profile.')
    const parsed = parseSessionRef(ref)
    if (parsed === null) throw conf('INVALID_REF', `"${clip(String(ref ?? ''), 80).text}" is not a session reference.`)
    const caller = await this.callerWorkspace(agent)
    const targetId = parsed.sessionId
    if (targetId !== caller.sessionId) {
      if (this.isPrivateSession(targetId)) throw conf('NOT_FOUND', 'no such session reference.')
      const targetKey = await this.targetWorkspaceKey(targetId)
      if (targetKey === null) throw conf('NOT_FOUND', 'no such session reference.')
      if (targetKey !== caller.wsKey) throw conf('NOT_FOUND', 'no such session reference.')
    }
    const startedAt = this.now()
    const deadline = startedAt + this.timeoutMs
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timeoutTimer = this.setTimeoutFn(() => controller?.abort(), this.timeoutMs)
    if (timeoutTimer && typeof timeoutTimer.unref === 'function') timeoutTimer.unref()
    let window
    try {
      window = await raceDeadline(
        Promise.resolve().then(() =>
          sq.readEvent({
            sessionId: targetId,
            seq: parsed.seq,
            before: 1,
            after: 1,
            signal: controller?.signal,
          }),
        ),
        deadline - this.now(),
        this,
      )
    } catch (error) {
      if (error && error.code === 'RECALL_TIMEOUT') throw error
      this.cleanupTimer(timeoutTimer)
      throw conf('NOT_FOUND', 'no such session reference.', { cause: error })
    }
    this.cleanupTimer(timeoutTimer)
    if (window.timedOut) throw conf('RECALL_TIMEOUT', `session read exceeded the ${this.timeoutMs} ms cap.`)
    const value = window.value
    if (!isPlainObject(value) || !Array.isArray(value.events)) {
      throw conf('NOT_FOUND', 'no such session reference.')
    }
    const events = []
    let truncated = false
    let used = 0
    for (const event of value.events.slice(0, MAX_READ_WINDOW_EVENTS)) {
      const text = readEventText(event, (input) => this.redact(input))
      if (used + text.text.length > MAX_READ_TEXT_CHARS) {
        const remaining = Math.max(0, MAX_READ_TEXT_CHARS - used)
        const clipped = clip(text.text, remaining)
        events.push({
          seq: Number.isFinite(event?.seq) ? event.seq : Number.parseInt(event?.seq, 10) || 0,
          role: text.role,
          type: optionalString(event?.type) ?? 'event',
          text: clipped.text,
        })
        truncated = true
        break
      }
      used += text.text.length
      events.push({
        seq: Number.isFinite(event?.seq) ? event.seq : Number.parseInt(event?.seq, 10) || 0,
        role: text.role,
        type: optionalString(event?.type) ?? 'event',
        text: text.text,
      })
    }
    if (value.events.length > MAX_READ_WINDOW_EVENTS) truncated = true
    const title = (await this.titlesFor([targetId])).get(targetId) ?? ''
    return {
      sessionId: targetId,
      session_id: targetId,
      title,
      events,
      truncated,
    }
  }

  /** @param {object} [input] */
  async titlesFor(sessionIds) {
    const titles = new Map()
    const ids = [...new Set(Array.isArray(sessionIds) ? sessionIds : [])].filter(
      (id) => typeof id === 'string' && id.length > 0,
    )
    if (ids.length === 0) return titles
    const sq = this.sessionQuery()
    if (!sq) return titles
    try {
      if (typeof sq.readTitleSnapshots === 'function') {
        const snapshots = await sq.readTitleSnapshots(ids)
        collectTitles(snapshots, titles)
      }
    } catch {
      // optional; fall through
    }
    for (const id of ids) {
      if (titles.has(id)) continue
      try {
        if (typeof sq.readTitle === 'function') {
          const title = await sq.readTitle(id)
          const text = typeof title === 'string' ? title : title?.title
          if (typeof text === 'string' && text.length > 0) titles.set(id, text)
        }
      } catch {
        // best-effort title join; hits still carry session ids
      }
    }
    return titles
  }

  /** Resolve the caller workspace from `agent.session.header.cwd` only (addendum). */
  async callerWorkspace(agent) {
    const sessionId =
      optionalString(agent?.id) ?? optionalString(agent?.session?.id) ?? optionalString(agent?.session?.header?.id)
    if (sessionId === undefined) throw conf('NO_WORKSPACE', 'this session has no resolvable workspace.')
    if (this.isPrivateSession(sessionId)) {
      throw conf('RECALL_UNAVAILABLE', 'session history is not available for this session.')
    }
    const cwd = optionalString(agent?.session?.header?.cwd)
    if (cwd === undefined) throw conf('NO_WORKSPACE', 'this session has no resolvable workspace.')
    const canonical = await this.canonicalize(cwd)
    if (canonical === null) throw conf('NO_WORKSPACE', 'this session has no resolvable workspace.')
    const wsKey = workspaceKeyFor(canonical)
    if (this.isDisabledWorkspace(wsKey)) {
      throw conf('RECALL_UNAVAILABLE', 'session history is not available in this workspace.')
    }
    return { sessionId, wsKey, canonicalPath: canonical }
  }

  /** Authorize a target session's workspace using the same canonicalization; null when unknown. */
  async targetWorkspaceKey(targetId) {
    const sq = this.sessionQuery()
    if (!sq) return null
    const cached = this.listCache !== null && this.now() - this.listCache.at < READ_AUTH_CACHE_TTL_MS
      ? this.listCache
      : null
    let records = cached?.records
    if (!records) {
      try {
        records = await sq.listSessions()
      } catch {
        return null
      }
      if (!Array.isArray(records)) records = []
      this.listCache = { at: this.now(), records }
    }
    let record = records.find((item) => isPlainObject(item) && item.header?.id === targetId)
    if (!record) {
      // Targeted, still-bounded refresh: the session may have been created after the cache fill.
      try {
        const fresh = await sq.listSessions()
        if (Array.isArray(fresh)) {
          records = fresh
          this.listCache = { at: this.now(), records }
          record = records.find((item) => isPlainObject(item) && item.header?.id === targetId)
        }
      } catch {
        return null
      }
    }
    if (!record) return null
    const cwd = optionalString(record.header?.cwd)
    if (cwd === undefined) return null
    const canonical = await this.canonicalize(cwd)
    return canonical === null ? null : workspaceKeyFor(canonical)
  }

  /** Canonicalize a directory: injected workspace helper first, else realpath + win32 fold. */
  async canonicalize(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return null
    const injected = this.deps.canonicalizeDir
    if (typeof injected === 'function') {
      try {
        const value = await injected(raw)
        return typeof value === 'string' && value.length > 0 ? foldPath(value) : null
      } catch {
        return null
      }
    }
    try {
      const { realpath } = await import('node:fs/promises')
      return foldPath(await realpath(raw))
    } catch {
      return null
    }
  }

  /** @param {string} sessionId */
  isPrivateSession(sessionId) {
    const privacy = isPlainObject(this.config.privacy) ? this.config.privacy : {}
    return Array.isArray(privacy.privateSessions) && privacy.privateSessions.includes(sessionId)
  }

  /** @param {string} wsKey */
  isDisabledWorkspace(wsKey) {
    const privacy = isPlainObject(this.config.privacy) ? this.config.privacy : {}
    if (!Array.isArray(privacy.disabledWorkspaces)) return false
    return privacy.disabledWorkspaces.some((entry) => typeof entry === 'string' && entry === wsKey)
  }

  /**
   * Optional read-only ledger view for recency ordering (pure read, may be absent).
   * @param {string} wsKey
   */
  ledgerView(wsKey) {
    const ledger = this.deps.ledger
    if (!ledger) return null
    try {
      if (typeof ledger.ledger === 'function') return ledger.ledger(wsKey)
      if (typeof ledger === 'function') return ledger(wsKey)
    } catch {
      return null
    }
    return null
  }

  /** @param {unknown} input @returns {{value: string, hits: number}} */
  redact(input) {
    try {
      const result = this.redactor.text(input)
      if (result && typeof result.value === 'string') return result
    } catch {
      // Fall through to the raw string.
    }
    return { value: typeof input === 'string' ? input : String(input ?? ''), hits: 0 }
  }

  /** Read the first match of a text value for the excerpt builder (test seam). */
  excerptFor(text, query) {
    return buildExcerpt(text, query)
  }

  /** @param {unknown} timer */
  cleanupTimer(timer) {
    if (timer === null || timer === undefined) return
    try {
      this.clearTimeoutFn(timer)
    } catch {
      // ignore
    }
  }

  /** @param {object} record */
  warn(record) {
    try {
      this.logger?.warn?.(record)
    } catch {
      // Best-effort logging.
    }
  }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** Parse `session:<id>:<seq>` (ledger-recall §5.4); null when malformed. */
export function parseSessionRef(ref) {
  if (typeof ref !== 'string') return null
  const match = /^session:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([0-9]{1,9})$/.exec(ref.trim())
  if (match === null) return null
  const seq = Number.parseInt(match[2], 10)
  if (!Number.isInteger(seq) || seq < 0) return null
  return { sessionId: match[1], seq }
}

/** `ws_` + 16 hex chars of sha256(canonicalPath) (data-model §2.1). */
export function workspaceKeyFor(canonicalPath) {
  return 'ws_' + createHash('sha256').update(String(canonicalPath), 'utf8').digest('hex').slice(0, 16)
}

/** @param {string} value */
function foldPath(value) {
  const trimmed = value.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/** Collect title entries from a variety of title-snapshot service shapes. */
function collectTitles(snapshots, out) {
  if (!snapshots) return
  if (Array.isArray(snapshots)) {
    for (const entry of snapshots) {
      if (typeof entry === 'string' && entry.length > 0) continue
      if (!isPlainObject(entry)) continue
      const id = optionalString(entry.id) ?? optionalString(entry.sessionId) ?? optionalString(entry.session_id)
      const title = optionalString(entry.title)
      if (id !== undefined && title !== undefined) out.set(id, title)
    }
    return
  }
  if (isPlainObject(snapshots)) {
    for (const [id, value] of Object.entries(snapshots)) {
      const title = typeof value === 'string' ? value : optionalString(value?.title)
      if (typeof id === 'string' && typeof title === 'string' && title.length > 0) out.set(id, title)
    }
  }
}

/**
 * Round-robin merge of per-session documents in session-recency order, ascending `seq` within a
 * session, capped at `limit` — one long session cannot occupy the whole result (ledger-recall
 * §5.2 step 6).
 * @param {Array<{sessionId: string, docs: object[]}>} perSession
 * @param {number} limit
 * @returns {Array<{sessionId: string, seq: number, type: string, docText: string}>}
 */
export function roundRobin(perSession, limit) {
  const ordered = perSession.map((session) => {
    const docs = session.docs
      .map((doc) => ({
        sessionId: session.sessionId,
        seq: Number.isFinite(doc?.seq) ? doc.seq : Number.parseInt(doc?.seq, 10) || 0,
        type: optionalString(doc?.type) ?? optionalString(doc?.eventType) ?? 'message',
        docText: typeof doc?.text === 'string' ? doc.text : textFromContent(doc?.content),
      }))
      .filter((doc) => doc.docText.length > 0)
      .sort((a, b) => a.seq - b.seq)
    return docs
  })
  const out = []
  let index = 0
  let added = true
  while (out.length < limit && added) {
    added = false
    for (const docs of ordered) {
      if (out.length >= limit) break
      if (index < docs.length) {
        out.push(docs[index])
        added = true
      }
    }
    index += 1
  }
  return out
}

/**
 * Race a promise against a relative deadline; the loser's rejection is contained (no unhandled
 * rejection). `filterEvents` cannot be cancelled, so a timed-out load is abandoned, not awaited
 * (ledger-recall §5.2 "Timeout honesty").
 * @param {Promise<unknown>} promise
 * @param {number} remainingMs
 * @param {{setTimeoutFn: Function, clearTimeoutFn: Function}} timers
 * @returns {Promise<{timedOut: boolean, value?: unknown}>}
 */
function raceDeadline(promise, remainingMs, timers) {
  const safe = Promise.resolve(promise)
  safe.catch(() => {})
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = timers.setTimeoutFn(() => {
      if (settled) return
      settled = true
      resolve({ timedOut: true })
    }, Math.max(0, remainingMs))
    if (timer && typeof timer.unref === 'function') timer.unref()
    safe.then(
      (value) => {
        if (settled) return
        settled = true
        timers.clearTimeoutFn(timer)
        resolve({ timedOut: false, value })
      },
      (error) => {
        if (settled) return
        settled = true
        timers.clearTimeoutFn(timer)
        reject(error)
      },
    )
  })
}
