// Confluence / 汇流 — WP2: universal shared board records, folds, posting, threads and search.
//
// v0.2.0 (ADR-0007): memory is UNIVERSAL. There is one global board per DSH profile; every session
// in every workspace reads and writes the same journal. A workspace is provenance only — the
// optional `origin: { workspaceKey, workspaceLabel }` field — never a partition, filter or permission
// boundary. Binding contract: docs/plan/scope-refactor-delta.md §3; unchanged record/fold rules:
// docs/plan/implementation-interfaces.md §6 and docs/design/data-model.md §4 (shapes), §5 (derived
// status/threads), §6 (caps), §7 (merge/order), §8 (validation).
//
// Everything here is plain ESM with Node builtins only, no network, no child process, no
// @deepseek-ai imports. The board never mutates a stored entry: it is append-only. Derived state
// (statuses, threads, stats) is a pure function of the merged record set (`foldRecords`).
//
// Freshness: `view()` synchronously folds the merged record list. The list comes from
// `store.mergedRecords()` (global journal + read-only legacy merge, ordered/deduped by the store).
// Subscriptions to `store.onMergedChange` / the global journal's `onChange` invalidate the derived
// cache; the cache is keyed on the identity of the record list and labels map, so a store that swaps
// in a new list is picked up even when no listener fires. A reader never throws on stored data.
//
// Legacy v1 entries (written per workspace by v0.1.0) carry no `origin`; their provenance label is
// derived from `legacyLabels.get(record.ws)` and exposed as `entry.origin.workspaceLabel`. Labels are
// basenames only: a hand-written absolute path can never leak through the fold.
//
// Tombstones are not created by the tool surface (no delete tool); the reader honours them for
// M4/export compatibility and fixtures, accepting both the interface shape (`target`) and the
// data-model shape (`targetId`).

import {
  ConfluenceError,
  createUlidFactory,
  isUlid,
  truncateChars,
  truncateUtf8,
} from './util.js'

/**
 * Reserved key of the single universal memory scope (delta §0). `lib/store.js` exports the same
 * constant; it is declared here so the fold can label legacy provenance without importing storage.
 * Never a real workspace key.
 * @type {string}
 */
export const GLOBAL_SCOPE_KEY = 'ws_0000000000000000'

const WS_KEY_PATTERN = /^ws_[0-9a-f]{16}$/
const EMPTY_RECORDS = Object.freeze([])

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

/** Search ranking weights (title 3, tags 2, body 1). */
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
 * Reduce an untrusted provenance label to a basename-ish display label. Labels are never paths
 * (data-model privacy rule; delta §0): separators are dropped, `.`/`..` segments removed.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function sanitizeLabel(value) {
  if (typeof value !== 'string') return undefined
  const segments = value
    .trim()
    .split(/[\\/]+/u)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
  const last = segments.length > 0 ? segments[segments.length - 1] : ''
  const label = truncateChars(last.trim(), MAX_TITLE_CHARS).trim()
  return label.length > 0 ? label : undefined
}

/**
 * Normalise an untrusted `origin` provenance block. Only a reserved-shape workspace key and a
 * basename-only label survive; everything else is dropped (provenance is optional, never blocking).
 * @param {unknown} raw
 * @returns {{workspaceKey?: string, workspaceLabel?: string} | undefined}
 */
function normalizeOrigin(raw) {
  if (!isPlainObject(raw)) return undefined
  const workspaceKey =
    typeof raw.workspaceKey === 'string' && WS_KEY_PATTERN.test(raw.workspaceKey) ? raw.workspaceKey : undefined
  const workspaceLabel = sanitizeLabel(raw.workspaceLabel)
  if (workspaceKey === undefined && workspaceLabel === undefined) return undefined
  const origin = {}
  if (workspaceKey !== undefined) origin.workspaceKey = workspaceKey
  if (workspaceLabel !== undefined) origin.workspaceLabel = workspaceLabel
  return origin
}

/**
 * Provenance for a legacy v1 record: the old journal only knows its `ws` key, so the label comes
 * from the store's legacy manifest scan. Best effort: no label means no origin block.
 * @param {Record<string, unknown>} record
 * @param {Map<string, string> | null | undefined} legacyLabels
 * @returns {{workspaceKey?: string, workspaceLabel?: string} | undefined}
 */
function legacyOriginFor(record, legacyLabels) {
  if (!(legacyLabels instanceof Map)) return undefined
  const ws = asString(record.ws)
  if (!WS_KEY_PATTERN.test(ws) || ws === GLOBAL_SCOPE_KEY) return undefined
  const label = sanitizeLabel(legacyLabels.get(ws))
  if (label === undefined) return undefined
  return { workspaceKey: ws, workspaceLabel: label }
}

/**
 * Normalise the author block of an entry: `{ sessionId, title?, origin }` (interface §6).
 * Flat data-model fields are accepted on read for tolerance (older/hand-written records); the
 * record-level `origin` provenance object must never be mistaken for the author's `agent|user`.
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
 * @param {Map<string, string> | null | undefined} legacyLabels
 * @returns {Record<string, unknown>}
 */
function normalizeEntry(record, legacyLabels) {
  let origin = normalizeOrigin(record.origin)
  const legacyOrigin = legacyOriginFor(record, legacyLabels)
  if (legacyOrigin !== undefined) {
    if (origin === undefined) origin = legacyOrigin
    else if (origin.workspaceLabel === undefined) origin = { ...origin, workspaceLabel: legacyOrigin.workspaceLabel }
  }
  const flatOrigin =
    record.origin === 'agent' || record.origin === 'user' ? record.origin : undefined
  const entry = {
    ...record,
    title: truncateChars(asString(record.title), MAX_TITLE_CHARS),
    author: normalizeAuthor(
      isPlainObject(record.author)
        ? record.author
        : {
            sessionId: record.sessionId,
            title: record.sessionTitle,
            origin: flatOrigin,
          },
    ),
  }
  if (origin !== undefined) entry.origin = origin
  else delete entry.origin
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
 * these rows by design (metadata only). Provenance (`origin`) passes through untouched here; the
 * ledger owns its shape.
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
 * skipped as unsupported. Any workspace key is accepted: the global view merges every journal.
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
 * Pure merge/derive fold over journal records (data-model §7.1, §5). Returns the BoardView used by
 * every synchronous read path and by the pulse. Never throws on malformed input, and never filters
 * on a workspace key — the universal board merges every journal.
 *
 * - entries: first occurrence of an id wins after the global `seq` sort (immutable facts);
 * - tombstones: union by target, hiding the target and its thread at read time;
 * - sessions: last-wins per session id (ledger upsert stream);
 * - provenance: stored `origin` is sanitised; legacy v1 entries derive `origin.workspaceLabel`
 *   from `legacyLabels.get(record.ws)`; unknown types / v:2 / invalid envelopes are skipped.
 *
 * @param {readonly unknown[]} records
 * @param {Map<string, string> | null} [legacyLabels] `wsKey -> label` from `store.legacyView()`
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
export function foldRecords(records, legacyLabels) {
  const labels = legacyLabels instanceof Map ? legacyLabels : null
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
      if (!entriesById.has(id)) entriesById.set(id, normalizeEntry(record, labels))
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

/**
 * BoardService — one instance per plugin mount over the single universal (global) journal.
 *
 * Constructor deps: `{ store, config, redactor, logger, deps }` (interface §6). `store` is a
 * `JournalStore` with the delta §2 global surface (`openGlobal`, `mergedRecords`, `legacyView`,
 * `onMergedChange`, `refreshMerged`, `globalJournal`); tests inject a fake with the same surface.
 *
 * @typedef {{
 *   openGlobal(): Promise<object>,
 *   mergedRecords?: () => readonly object[],
 *   legacyView?: () => {records?: object[], labels?: Map<string, string>},
 *   onMergedChange?: (callback: (changed: boolean) => void) => (() => void),
 *   refreshMerged?: () => Promise<boolean>,
 *   globalJournal?: () => object | null,
 * }} GlobalStore
 */
export class BoardService {
  /**
   * @param {{
   *   store: GlobalStore,
   *   config: Record<string, unknown>,
   *   redactor: { text(s: unknown): {value: string, hits: number}, title(s: unknown): {value: string, hits: number}, files(p: unknown): string[], tags(t: unknown): string[] },
   *   logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function},
   *   deps?: {now?: () => number, random?: () => number, pid?: number},
   * }} options
   */
  constructor({ store, config, redactor, logger, deps = {} } = {}) {
    if (!store) throw new TypeError('BoardService requires a store with openGlobal()')
    if (!redactor) throw new TypeError('BoardService requires a redactor')
    this.store = store
    this.config = isPlainObject(config) ? config : {}
    this.redactor = redactor
    this.logger = logger
    this.deps = isPlainObject(deps) ? deps : {}
    this.now = typeof this.deps.now === 'function' ? this.deps.now : () => Date.now()
    this.ulid = createUlidFactory(this.now, this.deps.random ?? Math.random)
    /** @type {object | null} the global journal opened by attach() */
    this.journal = null
    /** @type {Promise<void> | null} */
    this._attachPromise = null
    this._subscribed = false
    /** @type {Array<() => void>} */
    this._unsubscribes = []
    /** @type {ReturnType<typeof foldRecords> | null} */
    this._view = null
    /** @type {readonly object[] | null} */
    this._viewRecords = null
    /** @type {Map<string, string> | undefined} */
    this._viewLabels = undefined
    this.storeMaxEntries = this.intConfig('maxEntriesPerWorkspace', DEFAULT_MAX_ENTRIES, 1, 20000)
    this.storeMaxBodyBytes = this.intConfig('maxBodyBytes', DEFAULT_MAX_BODY_BYTES, 1, 49152)
  }

  /**
   * Read an integer store config value with bounds fallback (config.resolveConfig already
   * clamps; this is defence in depth for hand-built configs in tests). The name is kept from
   * v0.1.0 per delta §3; it now caps the single global board.
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

  /** @param {string} event @param {Record<string, unknown>} [fields] */
  debug(event, fields) {
    try {
      this.logger?.debug?.({ event, ...(fields ?? {}) })
    } catch {
      // Logging must never break a board operation.
    }
  }

  /**
   * Open the global journal, subscribe to merged-view changes and build the board. Idempotent;
   * safe under concurrent callers. There is no workspace argument: the scope is universal.
   * @returns {Promise<this>}
   */
  async attach() {
    if (this.journal !== null) return this
    if (this._attachPromise === null) {
      this._attachPromise = this._attachOnce().finally(() => {
        this._attachPromise = null
      })
    }
    await this._attachPromise
    return this
  }

  /** @returns {Promise<void>} */
  async _attachOnce() {
    if (this.journal !== null) return
    if (typeof this.store.openGlobal !== 'function') {
      throw boardError('STORE_UNAVAILABLE', 'the store does not support the universal memory scope')
    }
    const journal = await this.store.openGlobal()
    if (!journal || typeof journal !== 'object') {
      throw boardError('STORE_UNAVAILABLE', 'the global memory journal is unavailable')
    }
    this.journal = journal
    this._subscribeToChanges()
    try {
      if (typeof this.store.refreshMerged === 'function') await this.store.refreshMerged()
      else if (typeof journal.refresh === 'function') await journal.refresh()
    } catch (error) {
      // Legacy merge is best-effort: a failed scan must never block universal memory.
      this.debug('board.attach_refresh_failed', { message: String(error) })
    }
    this._invalidate()
    // Build the merged view once so subsequent synchronous reads are warm.
    this.view()
  }

  /** Subscribe to merged-view changes (store feed first, global journal feed as a second source). */
  _subscribeToChanges() {
    if (this._subscribed) return
    this._subscribed = true
    const track = (unsubscribe) => {
      if (typeof unsubscribe === 'function') this._unsubscribes.push(unsubscribe)
    }
    try {
      if (typeof this.store.onMergedChange === 'function') {
        track(this.store.onMergedChange(() => this._invalidate()))
      }
    } catch (error) {
      this.debug('board.subscribe_failed', { source: 'store', message: String(error) })
    }
    try {
      if (this.journal && typeof this.journal.onChange === 'function') {
        track(this.journal.onChange(() => this._invalidate()))
      }
    } catch (error) {
      this.debug('board.subscribe_failed', { source: 'journal', message: String(error) })
    }
  }

  /** Drop the derived fold so the next `view()` re-reads the store. */
  _invalidate() {
    this._view = null
    this._viewRecords = null
    this._viewLabels = undefined
  }

  /**
   * The merged record list: global journal plus the read-only legacy merge. Prefers the store's
   * `mergedRecords()`; falls back to the global journal's own merged records so the board keeps
   * working if the store only exposes the journal surface.
   * @returns {readonly object[]}
   */
  _mergedRecords() {
    try {
      if (typeof this.store.mergedRecords === 'function') {
        const records = this.store.mergedRecords()
        if (Array.isArray(records)) return records
      }
      const journal = this.journal ?? this.globalJournal()
      if (journal && typeof journal.records === 'function') {
        const records = journal.records()
        if (Array.isArray(records)) return records
      }
    } catch (error) {
      // A reader never throws on stored data; an empty board is the safe degraded view.
      this.debug('board.merged_records_failed', { message: String(error) })
    }
    return EMPTY_RECORDS
  }

  /**
   * Provenance labels for legacy per-workspace journals (`wsKey -> label`), or undefined when the
   * store cannot provide them (legacy entries then simply have no origin block).
   * @returns {Map<string, string> | undefined}
   */
  _legacyLabels() {
    try {
      if (typeof this.store.legacyView === 'function') {
        const legacy = this.store.legacyView()
        if (legacy && legacy.labels instanceof Map) return legacy.labels
      }
    } catch (error) {
      this.debug('board.legacy_view_failed', { message: String(error) })
    }
    return undefined
  }

  /** @returns {object | null} the global journal opened by attach(), or the store's cached one */
  globalJournal() {
    try {
      if (typeof this.store.globalJournal === 'function') return this.store.globalJournal() ?? null
    } catch {
      // treat as unavailable
    }
    return this.journal
  }

  /**
   * Synchronous universal board view derived from the merged record list (fresh-friendly cache).
   * @returns {ReturnType<typeof foldRecords>}
   */
  view() {
    const records = this._mergedRecords()
    const labels = this._legacyLabels()
    if (this._view !== null && this._viewRecords === records && this._viewLabels === labels) {
      return this._view
    }
    const view = foldRecords(records, labels)
    this._view = view
    this._viewRecords = records
    this._viewLabels = labels
    return view
  }

  /**
   * Rescan the global journal plus the first legacy scan, then drop the derived cache (store poll
   * contract). No workspace argument.
   * @returns {Promise<void>}
   */
  async refresh() {
    try {
      if (typeof this.store.refreshMerged === 'function') {
        await this.store.refreshMerged()
      } else if (this.journal && typeof this.journal.refresh === 'function') {
        await this.journal.refresh()
      }
    } finally {
      this._invalidate()
    }
  }

  /**
   * Append one entry to the universal board. Validation → redaction → cap check → durable append
   * (fsync) → derived status. The entry record is immutable after this call (data-model §4.1).
   *
   * @param {{kind: string, title: string, body?: string, tags?: string[], files?: string[], replyTo?: string, resolves?: boolean, supersedes?: string}} input
   * @param {{sessionId: string, title?: string, origin?: 'agent'|'user'}} author
   * @param {{workspaceKey?: string, workspaceLabel?: string}} [origin] provenance only
   * @returns {Promise<{id: string, seq: string, kind: string, status: string}>}
   */
  async post(input, author, origin) {
    const journal = this.journal
    if (journal === null) throw boardError('STORE_UNAVAILABLE', 'the shared memory store is not attached')
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
    const view = this.view()
    if (view.entryCount >= this.storeMaxEntries) {
      throw boardError('BOARD_FULL', `shared memory has reached ${this.storeMaxEntries} notes`)
    }

    const authorRecord = this.normalizePostAuthor(author)
    const originRecord = normalizeOrigin(origin)

    let replyTo
    if (input.replyTo !== undefined) {
      if (typeof input.replyTo !== 'string' || input.replyTo.length === 0) {
        throw boardError('BAD_ARGUMENT', 'replyTo must be a note id')
      }
      const target = view.entries.get(input.replyTo)
      if (target === undefined) throw boardError('UNKNOWN_REF', `no note "${input.replyTo}" on the shared board`)
      // Threads are one level deep: a reply to a reply re-targets the thread root (data-model §5.4).
      const targetParent = asString(target.replyTo)
      if (targetParent.length > 0) {
        const root = view.entries.get(targetParent)
        if (root === undefined) throw boardError('UNKNOWN_REF', `no note "${targetParent}" on the shared board`)
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
      if (target === undefined) throw boardError('UNKNOWN_REF', `no note "${input.supersedes}" on the shared board`)
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
      ws: GLOBAL_SCOPE_KEY,
      kind,
      title,
      ...(body !== undefined ? { body } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(files.length > 0 ? { files } : {}),
      author: authorRecord,
      ...(originRecord !== undefined ? { origin: originRecord } : {}),
      ...(replyTo !== undefined ? { replyTo } : {}),
      ...(resolves !== undefined ? { resolves } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
    }

    let stored
    try {
      // The journal assigns the durable `seq`/`ts`; the returned record is the stored one.
      stored = await journal.appendAndSync(record)
    } catch (error) {
      throw boardError('STORE_UNAVAILABLE', 'the note could not be persisted', { cause: error })
    }
    this._invalidate()
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
   * @param {string} ref
   * @returns {Promise<{entry: Record<string, unknown> | null, replies: Array<Record<string, unknown>>, resolved: boolean, superseded: boolean, notFound: boolean}>}
   */
  async thread(ref) {
    if (typeof ref !== 'string' || ref.length === 0) throw boardError('BAD_ARGUMENT', 'entry ref is required')
    const view = this.view()
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
   * Case-insensitive literal board search over the universal board with deterministic ranking:
   * title = 3, tags = 2, body = 1; superseded notes are down-ranked by 0.5. Snippet ≤200 chars.
   * @param {{query: string, kind?: string, tag?: string, limit?: number}} [options]
   * @returns {Promise<{hits: Array<{entry: Record<string, unknown>, snippet: string, score: number}>, truncated: boolean}>}
   */
  async search(options = {}) {
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

    const view = this.view()
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
   * Deterministic counts for the pulse/panel/tools across the universal board.
   * @returns {{entries: number, openQuestions: number, openHandoffs: number, byKind: Record<string, number>}}
   */
  stats() {
    return this.view().stats
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
