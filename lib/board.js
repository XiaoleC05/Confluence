// Confluence / 汇流 — WP2: shared board records, folds, posting, threads and search.
//
// Contract: docs/plan/implementation-interfaces.md §6 (binding signatures), docs/design/data-model.md
// §4 (entry/tombstone/session record shapes), §5 (derived status, threads), §7 (merge/order rules),
// §8 (validation), docs/design/config.md §2.2/§2.6, docs/design/store-format.md (append durability:
// board writes use `journal.appendAndSync` and resolve only after fsync).
//
// Everything here is plain ESM with Node builtins only, no network, no child process, no
// @deepseek-ai imports. The board never mutates a stored entry: it is append-only. Derived state
// (statuses, threads, stats) is a pure function of the merged record set (`foldRecords`).
//
// Tombstones are not created by v0.1.0 (no delete tool); the reader honours them for M4/export
// compatibility and for fixtures, accepting both the interface shape (`target`) and the
// data-model shape (`targetId`).

import {
  ConfluenceError,
  createUlidFactory,
  isUlid,
  truncateChars,
  truncateUtf8,
} from './util.js'

/** Closed write-time kind vocabulary (data-model §3). */
export const KINDS = Object.freeze([
  'finding',
  'decision',
  'gotcha',
  'question',
  'handoff',
  'warning',
])
const KIND_SET = new Set(KINDS)
const ROOT_RESOLVABLE = new Set(['question', 'handoff'])

/** data-model §6 constants enforced by the writer. */
const MAX_TITLE_CHARS = 160
const MAX_TAGS = 8
const MAX_TAG_CHARS = 32
const MAX_FILES = 8
const MAX_PATH_CHARS = 240
const DEFAULT_MAX_ENTRIES = 2000
const DEFAULT_MAX_BODY_BYTES = 8192

/** Search ranking weights (Lead build-round requirement: title 3, tags 2, body 1). */
const WEIGHT_TITLE = 3
const WEIGHT_TAGS = 2
const WEIGHT_BODY = 1
const SEARCH_MAX_LIMIT = 10
const SEARCH_DEFAULT_LIMIT = 5
const SNIPPET_MAX_CHARS = 200

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string} */
function asString(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/** @param {unknown} value @returns {number} */
function asFiniteNumber(value, fallback = 0) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

/** @param {unknown} value @param {number} maxChars @returns {string | undefined} */
function clampText(value, maxChars) {
  if (typeof value !== 'string') return undefined
  return truncateChars(value, maxChars)
}

/** @param {unknown} value @param {number} maxItems @param {number} maxItemChars @returns {string[] | undefined} */
function clampStringArray(value, maxItems, maxItemChars) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) continue
    out.push(truncateChars(item, maxItemChars))
    if (out.length >= maxItems) break
  }
  return out.length > 0 ? out : undefined
}

/** @param {string} code @param {string} message @param {{cause?: unknown}} [options] @returns {ConfluenceError} */
function boardError(code, message, options) {
  return new ConfluenceError(code, message, options)
}

/**
 * Normalise the author block of an entry: `{ sessionId, title?, origin }` (interface §6).
 * Flat data-model fields are accepted on read for tolerance (older/hand-written records).
 * @param {unknown} raw
 * @returns {{ sessionId: string, title?: string, origin: 'agent' | 'user' }}
 */
function normalizeAuthor(raw) {
  if (!isPlainObject(raw)) return { sessionId: '', origin: 'agent' }
  const sessionId = asString(raw.sessionId ?? raw.authorSessionId)
  const title = typeof raw.title === 'string' ? raw.title : undefined
  const origin = raw.origin === 'user' ? 'user' : 'agent'
  return title === undefined ? { sessionId, origin } : { sessionId, title, origin }
}

/**
 * Normalise one stored `entry` record for the derived view. Reader-side clamping only
 * (data-model §8.2); the original record object is never mutated.
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
function normalizeEntry(record) {
  const entry = {
    ...record,
    title: truncateChars(asString(record.title), MAX_TITLE_CHARS),
    author: normalizeAuthor(
      isPlainObject(record.author)
        ? record.author
        : {
            sessionId: record.sessionId,
            title: record.sessionTitle,
            origin: record.origin,
          },
    ),
  }
  if (record.body !== undefined) entry.body = truncateUtf8(asString(record.body), DEFAULT_MAX_BODY_BYTES)
  else delete entry.body
  if (record.tags !== undefined) {
    const tags = clampStringArray(record.tags, MAX_TAGS, MAX_TAG_CHARS)
    if (tags === undefined) delete entry.tags
    else entry.tags = tags
  }
  if (record.files !== undefined) {
    const files = clampStringArray(record.files, MAX_FILES, MAX_PATH_CHARS)
    if (files === undefined) delete entry.files
    else entry.files = files
  }
  if (typeof record.replyTo === 'string' && record.replyTo.length > 0) entry.replyTo = record.replyTo
  else delete entry.replyTo
  if (typeof record.resolves === 'boolean') entry.resolves = record.resolves
  else delete entry.resolves
  if (typeof record.supersedes === 'string' && record.supersedes.length > 0) entry.supersedes = record.supersedes
  else delete entry.supersedes
  return entry
}

/**
 * Normalise one stored `session` ledger record for the derived view. No content fields exist on
 * these rows by design (metadata only).
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
function normalizeSession(record) {
  const sessionId = asString(record.sessionId ?? record.id)
  const row = {
    ...record,
    sessionId,
    status: record.status === 'live' || record.status === 'idle' ? record.status : 'idle',
    turns: Math.max(0, Math.trunc(asFiniteNumber(record.turns, 0))),
  }
  if (typeof record.title === 'string') row.title = truncateChars(record.title, MAX_TITLE_CHARS)
  else delete row.title
  if (typeof record.lastActivityTs === 'string') row.lastActivityTs = record.lastActivityTs
  else delete row.lastActivityTs
  if (typeof record.effectiveDir === 'string') row.effectiveDir = record.effectiveDir
  else delete row.effectiveDir
  const files = clampStringArray(record.files, MAX_FILES, MAX_PATH_CHARS)
  if (files === undefined) delete row.files
  else row.files = files
  return row
}

/**
 * Validate the parts of a record envelope that make it usable for the fold. Invalid lines are
 * skipped (data-model §8.2: a reader never throws on stored data); `v: 2` and unknown types are
 * skipped as unsupported.
 * @param {unknown} record
 * @returns {record is Record<string, unknown>}
 */
function isFoldableRecord(record) {
  if (!isPlainObject(record)) return false
  if (record.v !== 1) return false
  if (typeof record.type !== 'string') return false
  if (typeof record.ws !== 'string' || record.ws.length === 0) return false
  if (!isUlid(record.seq)) return false
  return record.type === 'entry' || record.type === 'tombstone' || record.type === 'session'
}

/** @param {Record<string, unknown>} a @param {Record<string, unknown>} b @returns {number} */
function compareRecords(a, b) {
  const seqA = asString(a.seq)
  const seqB = asString(b.seq)
  if (seqA !== seqB) return seqA < seqB ? -1 : 1
  const idA = asString(a.id)
  const idB = asString(b.id)
  if (idA !== idB) return idA < idB ? -1 : 1
  const typeA = asString(a.type)
  const typeB = asString(b.type)
  return typeA === typeB ? 0 : typeA < typeB ? -1 : 1
}

/** @param {Record<string, unknown> | undefined} entry @returns {string} */
function statusOf(entry) {
  return entry && typeof entry.status === 'string' ? entry.status : 'active'
}

/**
 * Pure merge/derive fold over journal records (data-model §7.1, §5). Returns the BoardView used
 * by every synchronous read path and by the pulse. Never throws on malformed input.
 *
 * - entries: first occurrence of an id wins after the global `seq` sort (immutable facts);
 * - tombstones: union by target, hiding the target and its thread at read time;
 * - sessions: last-wins per session id (ledger upsert stream);
 * - unknown types / v:2 / invalid envelopes / unknown fields are skipped or preserved untouched.
 *
 * @param {readonly unknown[]} records
 * @returns {{
 *   entries: Map<string, Record<string, unknown>>,
 *   roots: Array<Record<string, unknown>>,
 *   sessions: Map<string, Record<string, unknown>>,
 *   openQuestions: Array<Record<string, unknown>>,
 *   openHandoffs: Array<Record<string, unknown>>,
 *   questions: Array<Record<string, unknown>>,
 *   handoffs: Array<Record<string, unknown>>,
 *   stats: { entries: number, openQuestions: number, openHandoffs: number, byKind: Record<string, number> },
 *   maxSeq: string,
 *   entryCount: number,
 *   tombstones: Map<string, Record<string, unknown>>,
 *   hiddenEntries: Map<string, Record<string, unknown>>,
 * }}
 */
export function foldRecords(records) {
  const valid = []
  if (Array.isArray(records)) {
    for (const record of records) if (isFoldableRecord(record)) valid.push(record)
  }
  valid.sort(compareRecords)

  /** @type {Map<string, Record<string, unknown>>} */
  const entriesById = new Map()
  /** @type {Map<string, Record<string, unknown>>} */
  const tombstones = new Map()
  /** @type {Map<string, Record<string, unknown>>} */
  const sessions = new Map()

  for (const record of valid) {
    if (record.type === 'entry') {
      const id = asString(record.id)
      if (id.length === 0) continue
      if (!entriesById.has(id)) entriesById.set(id, normalizeEntry(record))
    } else if (record.type === 'tombstone') {
      const target = asString(record.target ?? record.targetId)
      if (target.length === 0) continue
      if (!tombstones.has(target)) tombstones.set(target, { id: record.id, seq: record.seq, target })
    } else if (record.type === 'session') {
      const key = asString(record.sessionId ?? record.id)
      if (key.length === 0) continue
      sessions.set(key, normalizeSession(record))
    }
  }

  // Tombstones cascade: a hidden root hides every reply whose `replyTo` chain reaches it
  // (threads are one level in v1, so one pass over the sorted entries suffices; the loop keeps
  // the rule correct even for hand-written multi-level data).
  const hidden = new Set(tombstones.keys())
  let changed = true
  while (changed) {
    changed = false
    for (const [id, entry] of entriesById) {
      if (hidden.has(id)) continue
      const parent = asString(entry.replyTo)
      if (parent.length > 0 && hidden.has(parent)) {
        hidden.add(id)
        changed = true
      }
    }
  }

  const hiddenEntries = new Map()
  for (const id of hidden) {
    const entry = entriesById.get(id)
    if (entry !== undefined) hiddenEntries.set(id, entry)
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const visible = new Map()
  for (const [id, entry] of entriesById) if (!hidden.has(id)) visible.set(id, entry)

  // Replies grouped by their root (one level; replies to replies were re-targeted by the writer).
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const repliesByRoot = new Map()
  const supersededTargets = new Set()
  for (const entry of visible.values()) {
    const replyTo = asString(entry.replyTo)
    if (replyTo.length > 0) {
      const replies = repliesByRoot.get(replyTo)
      if (replies === undefined) repliesByRoot.set(replyTo, [entry])
      else replies.push(entry)
    }
    const supersedes = asString(entry.supersedes)
    if (supersedes.length > 0 && visible.has(supersedes)) supersededTargets.add(supersedes)
  }

  /** @param {Record<string, unknown>} entry @returns {string} */
  function deriveStatus(entry) {
    const id = asString(entry.id)
    const replyTo = asString(entry.replyTo)
    if (replyTo.length > 0) return supersededTargets.has(id) ? 'superseded' : 'active'
    const kind = asString(entry.kind)
    if (ROOT_RESOLVABLE.has(kind)) {
      const replies = repliesByRoot.get(id) ?? []
      let marker
      for (const reply of replies) {
        if (typeof reply.resolves !== 'boolean') continue
        if (marker === undefined || asString(reply.seq) > asString(marker.seq)) marker = reply
      }
      if (marker !== undefined) return marker.resolves === true ? 'resolved' : 'open'
      return 'open'
    }
    return supersededTargets.has(id) ? 'superseded' : 'active'
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const entries = new Map()
  for (const [id, entry] of visible) entries.set(id, { ...entry, status: deriveStatus(entry) })

  const roots = [...entries.values()]
    .filter((entry) => asString(entry.replyTo).length === 0)
    .sort((a, b) => (asString(a.seq) > asString(b.seq) ? -1 : 1))
  const openQuestions = [...entries.values()]
    .filter((entry) => entry.kind === 'question' && statusOf(entry) === 'open')
    .sort((a, b) => (asString(a.seq) < asString(b.seq) ? -1 : 1))
  const openHandoffs = [...entries.values()]
    .filter((entry) => entry.kind === 'handoff' && statusOf(entry) === 'open')
    .sort((a, b) => (asString(a.seq) < asString(b.seq) ? -1 : 1))
  // Convenience lists for callers that need resolved items too (the board tool's
  // `include_resolved` path); the open-only lists above stay the pulse/panel source.
  const questions = [...entries.values()]
    .filter((entry) => entry.kind === 'question')
    .sort((a, b) => (asString(a.seq) > asString(b.seq) ? -1 : 1))
  const handoffs = [...entries.values()]
    .filter((entry) => entry.kind === 'handoff')
    .sort((a, b) => (asString(a.seq) > asString(b.seq) ? -1 : 1))

  const byKind = {}
  for (const entry of entries.values()) {
    const kind = asString(entry.kind)
    byKind[kind] = (byKind[kind] ?? 0) + 1
  }

  const maxSeq = valid.length > 0 ? asString(valid[valid.length - 1].seq) : ''

  return {
    entries,
    roots,
    sessions,
    openQuestions,
    openHandoffs,
    questions,
    handoffs,
    stats: {
      entries: entries.size,
      openQuestions: openQuestions.length,
      openHandoffs: openHandoffs.length,
      byKind,
    },
    maxSeq,
    entryCount: entries.size,
    tombstones,
    hiddenEntries,
  }
}

/** @returns {ReturnType<typeof foldRecords>} */
function emptyView() {
  return foldRecords([])
}

/**
 * BoardService — one instance per plugin mount; journals are cached per workspace key.
 *
 * Constructor deps: `{ store, config, redactor, logger, deps }` (interface §6). `store` is a
 * `JournalStore`; tests inject a fake with the same async surface.
 */
export class BoardService {
  /**
   * @param {{
   *   store: { openWorkspace(wsKey: string, meta?: unknown): Promise<any> },
   *   config: Record<string, unknown>,
   *   redactor: { text(s: unknown): {value: string, hits: number}, title(s: unknown): {value: string, hits: number}, files(p: unknown): string[], tags(t: unknown): string[] },
   *   logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function},
   *   deps?: {now?: () => number, random?: () => number, pid?: number},
   * }} options
   */
  constructor({ store, config, redactor, logger, deps = {} } = {}) {
    if (!store) throw new TypeError('BoardService requires a store with openWorkspace()')
    if (!redactor) throw new TypeError('BoardService requires a redactor')
    this.store = store
    this.config = isPlainObject(config) ? config : {}
    this.redactor = redactor
    this.logger = logger
    this.deps = isPlainObject(deps) ? deps : {}
    this.now = typeof this.deps.now === 'function' ? this.deps.now : () => Date.now()
    this.ulid = createUlidFactory(this.now, this.deps.random ?? Math.random)
    /** @type {Map<string, any>} */
    this.journals = new Map()
    /** @type {Map<string, ReturnType<typeof foldRecords>>} */
    this.views = new Map()
    /** @type {Map<string, Array<() => void>>} */
    this.unsubscribes = new Map()
    this.storeMaxEntries = this.intConfig('maxEntriesPerWorkspace', DEFAULT_MAX_ENTRIES, 1, 20000)
    this.storeMaxBodyBytes = this.intConfig('maxBodyBytes', DEFAULT_MAX_BODY_BYTES, 1, 49152)
  }

  /**
   * Read an integer store config value with bounds fallback (config.resolveConfig already
   * clamps; this is defence in depth for hand-built configs in tests).
   * @param {string} key
   * @param {number} fallback
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  intConfig(key, fallback, min, max) {
    const store = isPlainObject(this.config.store) ? this.config.store : {}
    const value = asFiniteNumber(store[key], fallback)
    return Math.max(min, Math.min(max, Math.trunc(value)))
  }

  /**
   * Open (and cache) the workspace journal and subscribe to its change feed so `view()` stays
   * synchronous and coherent.
   * @param {string} wsKey
   * @param {unknown} [meta] workspace metadata for `store.openWorkspace` (manifest §15)
   * @returns {Promise<this>}
   */
  async attach(wsKey, meta) {
    if (typeof wsKey !== 'string' || wsKey.length === 0) throw boardError('BAD_ARGUMENT', 'workspace key is required')
    if (this.journals.has(wsKey)) return this
    const journal = await this.store.openWorkspace(wsKey, meta)
    this.journals.set(wsKey, journal)
    if (typeof journal?.onChange === 'function') {
      const unsubscribe = journal.onChange(() => {
        this.views.delete(wsKey)
      })
      const list = this.unsubscribes.get(wsKey) ?? []
      list.push(typeof unsubscribe === 'function' ? unsubscribe : () => {})
      this.unsubscribes.set(wsKey, list)
    }
    this.views.delete(wsKey)
    return this
  }

  /**
   * @param {string} wsKey
   * @returns {any | undefined}
   */
  journalFor(wsKey) {
    return this.journals.get(wsKey)
  }

  /**
   * Synchronous merged view from the in-memory record cache (interface §6).
   * @param {string} wsKey
   * @returns {ReturnType<typeof foldRecords>}
   */
  view(wsKey) {
    const cached = this.views.get(wsKey)
    if (cached !== undefined) return cached
    const journal = this.journals.get(wsKey)
    let records = []
    if (journal !== undefined) {
      try {
        records = typeof journal.records === 'function' ? journal.records() : []
      } catch (error) {
        // A reader never throws on stored data; an empty board is the safe degraded view.
        this.debug('board.view_failed', { wsKey, message: String(error) })
        records = []
      }
    }
    const view = foldRecords(records)
    this.views.set(wsKey, view)
    return view
  }

  /**
   * Rescan the workspace journal (store poll contract) and drop the derived cache.
   * @param {string} wsKey
   * @returns {Promise<void>}
   */
  async refresh(wsKey) {
    const journal = this.journals.get(wsKey)
    if (journal === undefined) return
    if (typeof journal.refresh === 'function') await journal.refresh()
    this.views.delete(wsKey)
  }

  /** @param {string} event @param {Record<string, unknown>} [fields] */
  debug(event, fields) {
    try {
      this.logger?.debug?.({ event, ...(fields ?? {}) })
    } catch {
      // Logging must never break a board operation.
    }
  }

  /**
   * Append one entry. Validation → redaction → cap check → durable append (fsync) → derived
   * status. The entry record is immutable after this call (data-model §4.1).
   *
   * @param {string} wsKey
   * @param {{kind: string, title: string, body?: string, tags?: string[], files?: string[], replyTo?: string, resolves?: boolean, supersedes?: string}} input
   * @param {{sessionId: string, title?: string, origin?: 'agent'|'user'}} author
   * @returns {Promise<{id: string, seq: string, kind: string, status: string}>}
   */
  async post(wsKey, input, author) {
    const journal = this.journals.get(wsKey)
    if (journal === undefined) throw boardError('STORE_UNAVAILABLE', 'workspace store is not attached')
    if (!isPlainObject(input)) throw boardError('BAD_ARGUMENT', 'post input must be an object')

    const kind = asString(input.kind)
    if (!KIND_SET.has(kind)) throw boardError('BAD_ARGUMENT', `unknown note kind "${kind}"`)

    const titleInput = input.title
    if (typeof titleInput !== 'string' || titleInput.trim().length === 0) {
      throw boardError('BAD_ARGUMENT', 'title is required')
    }
    const titleResult = this.redactor.title(titleInput)
    const title = titleResult.value
    if (title.length === 0) {
      throw titleResult.hits > 0
        ? boardError('REDACTED', 'the title was entirely sensitive and cannot be stored')
        : boardError('BAD_ARGUMENT', 'title is required')
    }

    let body
    if (input.body !== undefined) {
      if (typeof input.body !== 'string') throw boardError('BAD_ARGUMENT', 'body must be a string')
      const bodyResult = this.redactor.text(input.body)
      if (bodyResult.value.trim().length === 0 && input.body.trim().length > 0) {
        throw boardError('REDACTED', 'the body was entirely sensitive and cannot be stored')
      }
      if (Buffer.byteLength(bodyResult.value, 'utf8') > this.storeMaxBodyBytes) {
        throw boardError(
          'BODY_TOO_LARGE',
          `body is ${Buffer.byteLength(bodyResult.value, 'utf8')} bytes; the cap is ${this.storeMaxBodyBytes}`,
        )
      }
      body = bodyResult.value
    }

    const tags = this.redactor.tags(input.tags)
    const files = this.redactor.files(input.files)
    const view = this.view(wsKey)
    if (view.entryCount >= this.storeMaxEntries) {
      throw boardError('BOARD_FULL', `this workspace has reached ${this.storeMaxEntries} notes`)
    }

    const authorRecord = this.normalizePostAuthor(author)

    let replyTo
    if (input.replyTo !== undefined) {
      if (typeof input.replyTo !== 'string' || input.replyTo.length === 0) {
        throw boardError('BAD_ARGUMENT', 'replyTo must be a note id')
      }
      const target = view.entries.get(input.replyTo)
      if (target === undefined) throw boardError('UNKNOWN_REF', `no note "${input.replyTo}" in this workspace`)
      // Threads are one level deep: a reply to a reply re-targets the thread root (data-model §5.4).
      const targetParent = asString(target.replyTo)
      if (targetParent.length > 0) {
        const root = view.entries.get(targetParent)
        if (root === undefined) throw boardError('UNKNOWN_REF', `no note "${targetParent}" in this workspace`)
        replyTo = asString(root.id)
      } else {
        replyTo = asString(target.id)
      }
    }

    let resolves
    if (input.resolves !== undefined) {
      if (typeof input.resolves !== 'boolean') throw boardError('BAD_ARGUMENT', 'resolves must be a boolean')
      if (replyTo === undefined) throw boardError('BAD_ARGUMENT', 'resolves requires replyTo')
      const root = view.entries.get(replyTo)
      if (root === undefined || !ROOT_RESOLVABLE.has(asString(root.kind))) {
        throw boardError('BAD_ARGUMENT', 'only questions and handoffs can be resolved')
      }
      resolves = input.resolves
    }

    let supersedes
    if (input.supersedes !== undefined) {
      if (typeof input.supersedes !== 'string' || input.supersedes.length === 0) {
        throw boardError('BAD_ARGUMENT', 'supersedes must be a note id')
      }
      const target = view.entries.get(input.supersedes)
      if (target === undefined) throw boardError('UNKNOWN_REF', `no note "${input.supersedes}" in this workspace`)
      if (asString(target.replyTo).length > 0) {
        throw boardError('BAD_ARGUMENT', 'only root notes can be superseded')
      }
      supersedes = asString(target.id)
    }

    const id = `cnf_${this.ulid()}`
    const record = {
      v: 1,
      type: 'entry',
      id,
      ws: wsKey,
      kind,
      title,
      author: authorRecord,
      ...(body !== undefined ? { body } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(replyTo !== undefined ? { replyTo } : {}),
      ...(resolves !== undefined ? { resolves } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
    }

    let stored
    try {
      stored = await journal.appendAndSync(record)
    } catch (error) {
      throw boardError('STORE_UNAVAILABLE', 'the board write could not be persisted', { cause: error })
    }
    this.views.delete(wsKey)
    const status =
      replyTo !== undefined
        ? resolves === true
          ? 'resolved'
          : 'active'
        : ROOT_RESOLVABLE.has(kind)
          ? 'open'
          : 'active'
    return {
      id: asString(stored?.id) || id,
      seq: asString(stored?.seq),
      kind,
      status,
    }
  }

  /**
   * Validate and normalise the posting author. Authority for sessionId comes from the caller
   * (the tool layer passes `exec.agent`), never from model arguments.
   * @param {unknown} author
   * @returns {{sessionId: string, title?: string, origin: 'agent'|'user'}}
   */
  normalizePostAuthor(author) {
    if (!isPlainObject(author)) throw boardError('BAD_ARGUMENT', 'author is required')
    const sessionId = asString(author.sessionId)
    if (sessionId.length === 0) throw boardError('BAD_ARGUMENT', 'author.sessionId is required')
    const origin = author.origin === 'user' ? 'user' : 'agent'
    if (author.title === undefined) return { sessionId, origin }
    if (typeof author.title !== 'string') throw boardError('BAD_ARGUMENT', 'author.title must be a string')
    const title = this.redactor.title(author.title).value
    return title.length > 0 ? { sessionId, title, origin } : { sessionId, origin }
  }

  /**
   * Read one entry plus its replies. Tombstoned entries return a content-free deleted stub
   * (data-model I5); an unknown ref returns `notFound: true` (the tool maps it to NOT_FOUND).
   * @param {string} wsKey
   * @param {string} ref
   * @returns {Promise<{entry: Record<string, unknown> | null, replies: Array<Record<string, unknown>>, resolved: boolean, superseded: boolean, notFound: boolean}>}
   */
  async thread(wsKey, ref) {
    if (typeof ref !== 'string' || ref.length === 0) throw boardError('BAD_ARGUMENT', 'entry ref is required')
    const view = this.view(wsKey)
    const entry = view.entries.get(ref)
    if (entry === undefined) {
      const hidden = view.hiddenEntries?.get(ref)
      if (hidden !== undefined) {
        return {
          entry: { id: ref, type: 'entry', kind: asString(hidden.kind) || 'note', deleted: true },
          replies: [],
          resolved: false,
          superseded: false,
          notFound: false,
        }
      }
      return { entry: null, replies: [], resolved: false, superseded: false, notFound: true }
    }
    const replies = [...view.entries.values()]
      .filter((candidate) => asString(candidate.replyTo) === asString(entry.id))
      .sort((a, b) => (asString(a.seq) < asString(b.seq) ? -1 : 1))
    return {
      entry,
      replies,
      resolved: statusOf(entry) === 'resolved',
      superseded: statusOf(entry) === 'superseded',
      notFound: false,
    }
  }

  /**
   * Case-insensitive literal board search with deterministic ranking:
   * title = 3, tags = 2, body = 1; superseded notes are down-ranked by 0.5. Snippet ≤200 chars.
   * @param {string} wsKey
   * @param {{query: string, kind?: string, tag?: string, limit?: number}} options
   * @returns {Promise<{hits: Array<{entry: Record<string, unknown>, snippet: string, score: number}>, truncated: boolean}>}
   */
  async search(wsKey, options = {}) {
    if (!isPlainObject(options)) throw boardError('BAD_ARGUMENT', 'search options must be an object')
    const query = asString(options.query).trim()
    if (query.length === 0) throw boardError('BAD_ARGUMENT', 'query is required')
    let kind
    if (options.kind !== undefined) {
      kind = asString(options.kind)
      if (!KIND_SET.has(kind)) throw boardError('BAD_ARGUMENT', `unknown note kind "${kind}"`)
    }
    const tag = options.tag === undefined ? undefined : asString(options.tag).trim().toLowerCase()
    const requestedLimit = Math.trunc(asFiniteNumber(options.limit, SEARCH_DEFAULT_LIMIT))
    const limit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, requestedLimit))
    const needle = query.toLowerCase()

    const view = this.view(wsKey)
    const ranked = []
    for (const entry of view.entries.values()) {
      if (kind !== undefined && entry.kind !== kind) continue
      if (tag !== undefined) {
        const tags = Array.isArray(entry.tags) ? entry.tags : []
        if (!tags.some((candidate) => asString(candidate).toLowerCase() === tag)) continue
      }
      const title = asString(entry.title).toLowerCase()
      const body = asString(entry.body).toLowerCase()
      const tags = Array.isArray(entry.tags) ? entry.tags.map((candidate) => asString(candidate).toLowerCase()) : []
      let score = 0
      if (title.includes(needle)) score += WEIGHT_TITLE
      if (tags.some((candidate) => candidate.includes(needle))) score += WEIGHT_TAGS
      if (body.includes(needle)) score += WEIGHT_BODY
      if (score === 0) continue
      ranked.push({
        entry,
        snippet: buildSnippet(entry, needle),
        score,
        rank: score - (statusOf(entry) === 'superseded' ? 0.5 : 0),
      })
    }

    ranked.sort((a, b) => b.rank - a.rank || (asString(a.entry.seq) > asString(b.entry.seq) ? -1 : 1))
    const truncated = ranked.length > limit
    return {
      hits: ranked.slice(0, limit).map(({ entry, snippet, score }) => ({ entry, snippet, score })),
      truncated,
    }
  }

  /**
   * Deterministic counts for the pulse/panel/tools.
   * @param {string} wsKey
   * @returns {{entries: number, openQuestions: number, openHandoffs: number, byKind: Record<string, number>}}
   */
  stats(wsKey) {
    return this.view(wsKey).stats
  }
}

/**
 * Build a ≤200-character snippet around the first literal match in the body (fallback: title).
 * @param {Record<string, unknown>} entry
 * @param {string} needle already lower-cased query
 * @returns {string}
 */
function buildSnippet(entry, needle) {
  const body = asString(entry.body)
  const title = asString(entry.title)
  const source = body.length > 0 ? body : title
  if (source.length === 0) return ''
  const lower = source.toLowerCase()
  const index = lower.indexOf(needle)
  const chars = [...source]
  // Work in code points so a window never splits a surrogate pair.
  let charIndex = index
  if (index >= 0 && index !== lower.length) {
    charIndex = [...lower.slice(0, index)].length
  } else if (index < 0) {
    charIndex = 0
  }
  const remaining = chars.length - charIndex
  const hasLeadingEllipsis = charIndex > 40
  const hasTrailing = remaining > SNIPPET_MAX_CHARS
  let available = SNIPPET_MAX_CHARS - (hasLeadingEllipsis ? 1 : 0) - (hasTrailing ? 1 : 0)
  available = Math.max(0, available)
  const start = hasLeadingEllipsis ? Math.max(0, charIndex - 40) : Math.max(0, charIndex)
  const window = chars.slice(start, start + available).join('')
  return `${hasLeadingEllipsis ? '…' : ''}${window}${hasTrailing ? '…' : ''}`
}
