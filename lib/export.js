// Confluence / 高级记忆 — WP8/M4: deterministic universal export (`confluence.memories/v1`).
//
// Contract authority: docs/adr/0007-universal-memory-scope.md §2 item 7,
// docs/plan/scope-refactor-delta.md §8, docs/design/store-format.md §13.3/§14 (bytes, mapping,
// integrity rules) and docs/design/solo-bench-integration.md §6. Plain ESM, Node builtins only,
// no network, no child process, no @deepseek-ai imports. The plugin never reads an export back.
//
// Shape of the export (no absolute paths anywhere, ADR-0001 §11 / ADR-0007 §2.7):
//   <out>/memories.v1.jsonl   one entry per line, sorted (seq,id)
//   <out>/manifest.json       commit marker, written LAST, atomically
//
// Memory is universal (one logical scope `global` per profile): the store is read through
// `store.mergedRecords()` — the global journal merged read-only with any legacy per-workspace
// journals — so pre-0.2.0 notes still appear in the export. Every record carries the reserved
// global `wsKey`; the originating workspace is additive provenance in `origin` (workspace key +
// basename label only, never a path).
//
// Integrity rules from store-format §14 (the V7 resolution — one reading only):
//   - `recordCount` / `firstSeq` / `lastSeq` count LIVE (non-stub) records only;
//   - `files[0].bytes` / `files[0].sha256` cover the complete file INCLUDING tombstone stubs;
//   - a naive line-count == recordCount check is wrong by design.
//
// Tombstones are not created by the plugin (no delete tool); this module honours them for
// fixtures, M4 compatibility and any future delete surface: a directly tombstoned entry becomes a
// content-free `deleted` stub and a tombstoned thread root's replies are not exported.

import { createHash } from 'node:crypto'
import { promises as nodeFsPromises } from 'node:fs'
import path from 'node:path'

import { foldRecords } from './board.js'
import { ConfluenceError, isoNow, truncateChars } from './util.js'

/** Named export format; the manifest is the version authority. */
export const EXPORT_SCHEMA = 'confluence.memories/v1'
export const EXPORT_FORMAT_VERSION = 1
export const MEMORIES_FILE = 'memories.v1.jsonl'
export const EXPORT_MANIFEST_FILE = 'manifest.json'

/** The single logical memory scope of a profile (ADR-0007 §2.1). */
export const EXPORT_SCOPE = 'global'
export const GLOBAL_SCOPE_KEY = 'ws_0000000000000000'
export const GLOBAL_SCOPE_LABEL = 'All sessions'

/** Producer stamp carried by every manifest (diagnostics only for consumers). */
export const EXPORT_PRODUCER = Object.freeze({
  name: 'dsh-confluence',
  version: '0.2.1',
  dsh: '0.2.2-rc.1',
})

/** Contract caps (store-format §14 step 3, §6 constants). */
export const EXPORT_MAX_BYTES = 8 * 1024 * 1024
export const MAX_EXPORT_LINE_BYTES = 64 * 1024
const DEFAULT_MAX_ENTRIES = 2000
const DEFAULT_RETENTION_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

const WS_KEY_PATTERN = /^ws_[0-9a-f]{16}$/
const MAX_ORIGIN_LABEL_CHARS = 80

/**
 * Export-only failure codes (documented in docs/design/solo-bench-integration.md §6.5).
 * The CLI maps every failure to a non-zero exit with `export-memories: <code>: <message>`.
 */
export const EXPORT_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  BAD_ARGUMENT: 'BAD_ARGUMENT',
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  EXPORT_FAILED: 'EXPORT_FAILED',
})

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

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

/** @param {string} code @param {string} message @param {{cause?: unknown}} [options] */
function exportError(code, message, options) {
  return new ConfluenceError(code, message, options)
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function intValue(value, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback
}

/** Workspace label from a canonical path (provenance is a basename, never a path). */
export function workspaceLabelFor(canonicalPath) {
  const text = asString(canonicalPath)
  if (text === '') return ''
  const isWindows = /^[A-Za-z]:[\\/]/.test(text) || text.includes('\\')
  const basename = isWindows ? path.win32.basename(text) : path.basename(text)
  return basename !== '' ? basename : text
}

/**
 * Strip absolute and home paths from free text (title/body/author title/provenance label). The
 * export must never carry machine-specific locations (ADR 0001 §11/§17 E3); the redactor handles
 * file hints and secrets, this handles prose that mentions a path.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAbsolutePaths(text) {
  let out = asString(text)
  // Windows drive paths (C:\..., C:/...). A URL's "s://" is not a match because of the \b boundary.
  out = out.replace(/\b[A-Za-z]:[\\/][^\s"'`<>|)]*/g, '<path>')
  // UNC paths (\\server\share\...).
  out = out.replace(/(^|[\s"'(])\\\\[^\s"'`<>|)]+/g, '$1<path>')
  // Any POSIX absolute path (`/opt/...`, `/etc/...`, `/srv/...`) and home paths (`~/...`).
  // URLs are not matched because the leading `/` follows `:` rather than a boundary.
  out = out.replace(/(^|[\s"'(])\/(?!\/)[^\s"'`<>|)]+/g, '$1<path>')
  out = out.replace(/(^|[\s"'(])~\/[^\s"'`<>|)]*/g, '$1<path>')
  return out
}

/** @param {unknown} a @param {unknown} b @returns {number} */
function compareSeqId(a, b) {
  const seqA = asString(a && a.seq)
  const seqB = asString(b && b.seq)
  if (seqA !== seqB) return seqA < seqB ? -1 : 1
  const idA = asString(a && a.id)
  const idB = asString(b && b.id)
  if (idA !== idB) return idA < idB ? -1 : 1
  return 0
}

/**
 * Apply one redactor function, failing closed: an export must never ship unredacted content when
 * the redactor misbehaves, so a throw aborts the export instead of silently passing text through.
 *
 * @param {Record<string, Function>} redactor
 * @param {string} fn
 * @param {unknown} value
 * @returns {{ value: string, hits: number }}
 */
function redactWith(redactor, fn, value) {
  const implementation = redactor[fn]
  if (typeof implementation !== 'function') {
    throw exportError(EXPORT_ERROR_CODES.EXPORT_FAILED, `redactor.${fn}() is unavailable; refusing to export unredacted content`)
  }
  try {
    const result = implementation.call(redactor, value)
    if (typeof result === 'string') return { value: result, hits: 0 }
    if (isPlainObject(result) && typeof result.value === 'string') {
      return { value: result.value, hits: intValue(result.hits, 0) }
    }
    throw new Error('redactor returned an unsupported value')
  } catch (error) {
    throw exportError(EXPORT_ERROR_CODES.EXPORT_FAILED, `redactor.${fn}() failed: ${error?.message ?? error}`, {
      cause: error,
    })
  }
}

/** @param {Record<string, Function>} redactor @param {unknown} paths @returns {string[]} */
function redactFiles(redactor, paths) {
  if (typeof redactor.files !== 'function') return []
  try {
    const value = redactor.files.call(redactor, paths)
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []
  } catch (error) {
    throw exportError(EXPORT_ERROR_CODES.EXPORT_FAILED, `redactor.files() failed: ${error?.message ?? error}`, {
      cause: error,
    })
  }
}

/** @param {Record<string, Function>} redactor @param {unknown} tags @returns {string[]} */
function redactTags(redactor, tags) {
  if (typeof redactor.tags !== 'function') return []
  try {
    const value = redactor.tags.call(redactor, tags)
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []
  } catch (error) {
    throw exportError(EXPORT_ERROR_CODES.EXPORT_FAILED, `redactor.tags() failed: ${error?.message ?? error}`, {
      cause: error,
    })
  }
}

/** @param {string} value @returns {{ value: string, hits: number }} truncated to a single line */
function singleLine(value) {
  return { value: asString(value).replace(/\s+/g, ' ').trim(), hits: 0 }
}

/**
 * Normalise a provenance label to a safe basename-ish single line (never a path).
 * @param {unknown} raw
 * @returns {string} `''` when no usable label is present
 */
function sanitizeWorkspaceLabel(raw) {
  let text = asString(raw).trim()
  if (text === '') return ''
  // A label is a basename by contract; reduce an accidental path to its last segment first.
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('/')) {
    text = workspaceLabelFor(text)
  }
  text = singleLine(stripAbsolutePaths(text)).value
  text = truncateChars(text, MAX_ORIGIN_LABEL_CHARS)
  return text === '<path>' ? '' : text
}

// ---------------------------------------------------------------------------
// output path safety
// ---------------------------------------------------------------------------

/**
 * Validate an export directory: absolute, no literal `..` segment, not inside the store root.
 * The CLI resolves the default `<dshHome>/storages/confluence-exports/<UTC-stamp>/`; this function
 * is the second line of defence shared by the CLI and library callers.
 *
 * @param {unknown} outDir
 * @param {string} storeRoot
 * @returns {string} resolved absolute directory
 */
export function validateExportDir(outDir, storeRoot) {
  if (typeof outDir !== 'string' || outDir.trim() === '') {
    throw exportError(EXPORT_ERROR_CODES.BAD_ARGUMENT, 'outDir must be a non-empty absolute directory path')
  }
  const raw = outDir.trim()
  if (raw.split(/[\\/]+/).includes('..')) {
    throw exportError(EXPORT_ERROR_CODES.BAD_ARGUMENT, `export directory must not contain "..": ${raw}`)
  }
  if (!path.isAbsolute(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) {
    throw exportError(EXPORT_ERROR_CODES.BAD_ARGUMENT, `export directory must be absolute: ${raw}`)
  }
  const resolved = path.resolve(raw)
  if (typeof storeRoot === 'string' && storeRoot !== '') {
    const relativeToStore = path.relative(path.resolve(storeRoot), resolved)
    const insideStore = relativeToStore === '' || (!relativeToStore.startsWith('..') && !path.isAbsolute(relativeToStore))
    if (insideStore) {
      throw exportError(EXPORT_ERROR_CODES.BAD_ARGUMENT, 'export directory must not be inside the Confluence store root')
    }
  }
  return resolved
}

// ---------------------------------------------------------------------------
// universal-scope reads
// ---------------------------------------------------------------------------

/**
 * Refresh the store's merged view before reading it. `merge` is owned by `lib/store.js`
 * (delta §2: `refreshMerged()`); the board fallback keeps library callers working when a test
 * double only exposes the board. A refresh failure aborts the export (fail closed).
 *
 * @param {{refreshMerged?: Function}} store
 * @param {{refresh?: Function} | undefined} board
 * @returns {Promise<void>}
 */
async function refreshMergedView(store, board) {
  try {
    if (store && typeof store.refreshMerged === 'function') {
      await store.refreshMerged()
      return
    }
    if (board && typeof board.refresh === 'function') {
      await board.refresh()
      return
    }
    if (store && typeof store.globalJournal === 'function') {
      const journal = store.globalJournal()
      if (journal && typeof journal.refresh === 'function') await journal.refresh({ force: true })
    }
  } catch (error) {
    throw exportError(EXPORT_ERROR_CODES.STORE_UNAVAILABLE, 'cannot refresh the shared memory store', {
      cause: error,
    })
  }
}

/**
 * Read the merged universal record set (global journal + read-only legacy journals). This is the
 * only store read the export performs; nothing is ever written back to the store.
 *
 * @param {{mergedRecords?: Function}} store
 * @returns {Promise<readonly unknown[]>}
 */
async function readMergedRecords(store) {
  if (!store || typeof store !== 'object' || typeof store.mergedRecords !== 'function') {
    throw exportError(
      EXPORT_ERROR_CODES.STORE_UNAVAILABLE,
      'the Confluence store does not expose mergedRecords(); the universal export needs the merged global journal',
    )
  }
  let records
  try {
    records = await Promise.resolve(store.mergedRecords())
  } catch (error) {
    throw exportError(EXPORT_ERROR_CODES.STORE_UNAVAILABLE, 'cannot read the merged shared memory store', {
      cause: error,
    })
  }
  if (!Array.isArray(records)) {
    throw exportError(EXPORT_ERROR_CODES.STORE_UNAVAILABLE, 'store.mergedRecords() did not return an array')
  }
  return records
}

/**
 * Legacy workspace provenance labels: `wsKey -> basename label` from `legacyWorkspaceMeta()`
 * (preferred) and/or `legacyView().labels`. Labels are display data only; unknown labels are
 * simply omitted from `origin`.
 *
 * @param {{legacyWorkspaceMeta?: Function, legacyView?: Function}} store
 * @returns {Promise<Map<string, string>>}
 */
async function legacyLabels(store) {
  /** @type {Map<string, string>} */
  const labels = new Map()
  /** @param {unknown} wsKey @param {unknown} label */
  const add = (wsKey, label) => {
    const key = asString(wsKey)
    if (!WS_KEY_PATTERN.test(key) || key === GLOBAL_SCOPE_KEY || labels.has(key)) return
    const clean = sanitizeWorkspaceLabel(label)
    if (clean !== '') labels.set(key, clean)
  }
  if (store && typeof store.legacyWorkspaceMeta === 'function') {
    try {
      const rows = await Promise.resolve(store.legacyWorkspaceMeta())
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (!isPlainObject(row)) continue
          add(
            row.wsKey ?? row.key,
            row.label ?? row.name ?? workspaceLabelFor(row.canonicalPath ?? row.path),
          )
        }
      }
    } catch {
      // Provenance labels are optional; a broken legacy manifest must not fail the export.
    }
  }
  if (store && typeof store.legacyView === 'function') {
    try {
      const view = await Promise.resolve(store.legacyView())
      const map = view && view.labels
      if (map instanceof Map) {
        for (const [key, label] of map) add(key, label)
      } else if (isPlainObject(map)) {
        for (const [key, label] of Object.entries(map)) add(key, label)
      }
    } catch {
      // Same as above: labels are best-effort provenance.
    }
  }
  return labels
}

/**
 * Build the additive `origin` provenance block for one stored entry. Unknown/absolute labels are
 * dropped rather than leaked; a legacy record's own `ws` provides its key when no `origin` exists.
 *
 * @param {Record<string, unknown>} entry
 * @param {Map<string, string>} labels
 * @returns {{workspaceKey?: string, workspaceLabel?: string} | null}
 */
function originFor(entry, labels) {
  const raw = isPlainObject(entry.origin) ? entry.origin : {}
  let workspaceKey = asString(raw.workspaceKey ?? raw.key ?? raw.wsKey)
  let workspaceLabel = sanitizeWorkspaceLabel(raw.workspaceLabel ?? raw.label ?? raw.name)
  if (workspaceKey === '') {
    const ws = asString(entry.ws)
    if (ws !== '' && ws !== GLOBAL_SCOPE_KEY) workspaceKey = ws
  }
  if (!WS_KEY_PATTERN.test(workspaceKey)) workspaceKey = ''
  if (workspaceLabel === '' && workspaceKey !== '' && labels.has(workspaceKey)) {
    workspaceLabel = labels.get(workspaceKey) ?? ''
  }
  if (workspaceKey === '' && workspaceLabel === '') return null
  /** @type {{workspaceKey?: string, workspaceLabel?: string}} */
  const origin = {}
  if (workspaceKey !== '') origin.workspaceKey = workspaceKey
  if (workspaceLabel !== '') origin.workspaceLabel = workspaceLabel
  return origin
}

// ---------------------------------------------------------------------------
// record building
// ---------------------------------------------------------------------------

/**
 * Build one live export record from a folded entry (normalized, content clamped) and the
 * folder's own redactor. Property order is fixed because deterministic bytes are part of the
 * contract. `wsKey` is the reserved global scope; provenance travels in the additive `origin`.
 *
 * @param {Record<string, unknown>} entry
 * @param {Record<string, Function>} redactor
 * @param {Map<string, string>} labels
 * @returns {Record<string, unknown>}
 */
function liveExportRecord(entry, redactor, labels) {
  const id = asString(entry.id)
  const seq = asString(entry.seq)
  const kind = asString(entry.kind)
  const titleResult = redactWith(redactor, 'title', entry.title)
  const bodyResult = redactWith(redactor, 'text', entry.body)
  const title = stripAbsolutePaths(singleLine(titleResult.value).value)
  const body = stripAbsolutePaths(bodyResult.value)
  const tags = redactTags(redactor, entry.tags)
  const files = redactFiles(redactor, entry.files)
  const author = isPlainObject(entry.author) ? entry.author : {}
  const authorSessionId = asString(author.sessionId)
  const authorOrigin = author.origin === 'user' ? 'user' : 'agent'
  const authorTitle = stripAbsolutePaths(singleLine(redactWith(redactor, 'title', author.title ?? '').value).value)
  const replyTo = asString(entry.replyTo) !== '' ? asString(entry.replyTo) : null
  const storedResolves = entry.resolves === true
  const resolves = storedResolves ? replyTo : null
  const supersedes = asString(entry.supersedes) !== '' ? asString(entry.supersedes) : null
  const origin = originFor(entry, labels)

  /** @type {Record<string, unknown>} */
  const record = {
    v: 1,
    schema: EXPORT_SCHEMA,
    type: 'entry',
    id,
    wsKey: GLOBAL_SCOPE_KEY,
    seq,
    ts: asString(entry.ts),
    kind,
    title,
  }
  if (body !== '') record.body = body
  if (tags.length > 0) record.tags = tags
  if (files.length > 0) record.files = files
  record.author = { sessionId: authorSessionId, title: authorTitle, origin: authorOrigin }
  if (origin !== null) record.origin = origin
  record.replyTo = replyTo
  record.resolves = resolves
  record.supersedes = supersedes
  record.deleted = false
  record.deletedAt = null
  return record
}

/**
 * Content-free tombstone stub (store-format §14): keeps envelope identity, drops all content,
 * reduces the author, records when the tombstone was committed and keeps provenance only.
 *
 * @param {Record<string, unknown>} entry folded hidden entry (normalized)
 * @param {string} deletedAt
 * @param {Map<string, string>} labels
 * @returns {Record<string, unknown>}
 */
function tombstoneStub(entry, deletedAt, labels) {
  const author = isPlainObject(entry.author) ? entry.author : {}
  const origin = originFor(entry, labels)
  /** @type {Record<string, unknown>} */
  const record = {
    v: 1,
    schema: EXPORT_SCHEMA,
    type: 'entry',
    id: asString(entry.id),
    wsKey: GLOBAL_SCOPE_KEY,
    seq: asString(entry.seq),
    ts: asString(entry.ts),
    kind: asString(entry.kind),
    title: '',
    body: '',
    author: { sessionId: asString(author.sessionId), origin: author.origin === 'user' ? 'user' : 'agent' },
  }
  if (origin !== null) record.origin = origin
  record.replyTo = null
  record.resolves = null
  record.supersedes = null
  record.deleted = true
  record.deletedAt = deletedAt
  return record
}

/**
 * @param {readonly unknown[]} records merged journal records (store order is already sorted)
 * @returns {Map<string, string>} target entry id -> tombstone `ts` (first tombstone wins)
 */
function tombstoneTimestamps(records) {
  const timestamps = new Map()
  if (!Array.isArray(records)) return timestamps
  for (const record of records) {
    if (!isPlainObject(record) || record.type !== 'tombstone') continue
    const target = asString(record.target ?? record.targetId)
    if (target === '' || timestamps.has(target)) continue
    const ts = asString(record.ts)
    timestamps.set(target, ts !== '' ? ts : new Date(0).toISOString())
  }
  return timestamps
}

// ---------------------------------------------------------------------------
// atomic writing
// ---------------------------------------------------------------------------

/**
 * Temp + fsync + rename. Windows transient rename contention is retried a few times; a failed
 * write leaves the previous file untouched and removes the temp file (best effort).
 *
 * @param {string} target absolute file path
 * @param {string} content utf8 content
 * @param {{fs?: typeof nodeFsPromises, writerId?: string}} [options]
 * @returns {Promise<void>}
 */
async function writeFileAtomically(target, content, options = {}) {
  const fsImpl = options.fs && typeof options.fs.open === 'function' ? options.fs : nodeFsPromises
  const writerId = typeof options.writerId === 'string' && options.writerId !== '' ? options.writerId : 'export'
  const tmp = `${target}.tmp-${writerId.replace(/[^A-Za-z0-9._-]/g, '_')}`
  let handle
  try {
    handle = await fsImpl.open(tmp, 'w')
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } catch (error) {
    // A failed write/sync must not leave .tmp-* litter behind.
    try {
      await fsImpl.unlink(tmp)
    } catch {
      // best effort
    }
    throw error
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // best effort
      }
    }
  }
  const delays = [25, 100, 300]
  let lastError
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await fsImpl.rename(tmp, target)
      return
    } catch (error) {
      lastError = error
      const transient = error && (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES')
      if (!transient || attempt === delays.length) break
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
    }
  }
  try {
    await fsImpl.unlink(tmp)
  } catch {
    // best effort
  }
  throw exportError(EXPORT_ERROR_CODES.STORE_UNAVAILABLE, `cannot publish ${path.basename(target)}: ${lastError?.message ?? lastError}`, {
    cause: lastError,
  })
}

/** Best-effort directory fsync (POSIX); silently skipped where unsupported (Windows). */
async function syncDirectory(dir, fsImpl) {
  let handle
  try {
    handle = await fsImpl.open(dir, 'r')
    await handle.sync()
  } catch {
    // directory fsync is not part of the contract on Windows
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // best effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// exportMemories
// ---------------------------------------------------------------------------

/**
 * Export the profile's universal shared memory as the `confluence.memories/v1` pair.
 *
 * The store is only READ: `store.mergedRecords()` (global + read-only legacy merge) is folded in
 * memory, filtered and mapped by this module, then written outside the store. Nothing is read
 * back, nothing is compacted, no store file is modified.
 *
 * @param {{
 *   store: {mergedRecords?: Function, refreshMerged?: Function, legacyWorkspaceMeta?: Function, legacyView?: Function, globalJournal?: Function, rootDir?: string},
 *   board?: {refresh?: Function},
 *   config?: Record<string, unknown>,
 *   redactor: {title: Function, text: Function, files?: Function, tags?: Function},
 *   outDir: string,
 *   fs?: typeof nodeFsPromises,
 *   now?: () => number,
 *   dryRun?: boolean,
 *   logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function},
 *   writerId?: string,
 * }} options
 * @returns {Promise<{
 *   schema: string, formatVersion: number, scope: string, outDir: string,
 *   jsonlPath?: string, manifestPath?: string,
 *   files: Array<{name: string, bytes: number, sha256: string}>,
 *   manifest: Record<string, unknown>,
 *   recordCount: number, firstSeq: string | null, lastSeq: string | null,
 *   tombstoneStubs: number, skippedReplies: number, skippedRetention: number,
 *   truncated: boolean, dryRun: boolean, jsonlText?: string,
 * }>}
 */
export async function exportMemories({
  store,
  board,
  config,
  redactor,
  outDir,
  fs = nodeFsPromises,
  now = () => Date.now(),
  dryRun = false,
  logger,
  writerId,
} = {}) {
  if (!store || typeof store !== 'object') {
    throw exportError(EXPORT_ERROR_CODES.BAD_ARGUMENT, 'exportMemories requires a JournalStore-like store')
  }
  if (!redactor || typeof redactor.title !== 'function' || typeof redactor.text !== 'function') {
    throw exportError(EXPORT_ERROR_CODES.BAD_ARGUMENT, 'exportMemories requires a redactor with title() and text()')
  }
  const cfg = (() => {
    const raw = isPlainObject(config) ? config : {}
    // Accept both the resolved config and the `resolveConfig()` wrapper `{config, warnings}`.
    if (isPlainObject(raw.store)) return raw
    if (isPlainObject(raw.config) && isPlainObject(raw.config.store)) return raw.config
    return raw
  })()
  const storeCfg = isPlainObject(cfg.store) ? cfg.store : {}
  const retentionDays = Math.max(0, intValue(storeCfg.retentionDays, DEFAULT_RETENTION_DAYS))
  const maxEntriesPerWorkspace = Math.max(1, intValue(storeCfg.maxEntriesPerWorkspace, DEFAULT_MAX_ENTRIES))
  const storeRoot = asString(store.rootDir)
  const resolvedOutDir = validateExportDir(outDir, storeRoot)
  const nowMs = typeof now === 'function' ? Number(now()) : Date.now()
  const generatedAt = isoNow(nowMs)

  await refreshMergedView(store, board)
  const records = await readMergedRecords(store)
  const labels = await legacyLabels(store)
  const view = foldRecords(records)

  // Retention hides older entries from every default read surface, including the export (§14 step 2).
  const cutoffIso = new Date(nowMs - retentionDays * DAY_MS).toISOString()
  /** @param {Record<string, unknown>} entry */
  const withinRetention = (entry) => {
    const ts = asString(entry.ts)
    if (ts === '') return false
    return ts >= cutoffIso
  }

  const deletedAtByTarget = tombstoneTimestamps(records)
  const tombstonedIds = new Set(view.tombstones.keys())

  let skippedRetention = 0
  /** @type {Array<Record<string, unknown>>} */
  const recordsToExport = []
  for (const entry of view.entries.values()) {
    if (!withinRetention(entry)) {
      skippedRetention += 1
      continue
    }
    recordsToExport.push(liveExportRecord(entry, redactor, labels))
  }

  // Directly tombstoned entries become content-free stubs; a tombstoned root's replies are not
  // exported at all (store-format §14 mapping). Cascaded hidden entries that are not direct
  // tombstone targets are replies and are dropped.
  let tombstoneStubs = 0
  let skippedReplies = 0
  for (const [id, entry] of view.hiddenEntries) {
    if (!tombstonedIds.has(id)) {
      skippedReplies += 1
      continue
    }
    if (!withinRetention(entry)) {
      skippedRetention += 1
      continue
    }
    const deletedAt = deletedAtByTarget.get(id) ?? asString(entry.ts) ?? generatedAt
    recordsToExport.push(tombstoneStub(entry, deletedAt, labels))
    tombstoneStubs += 1
  }

  recordsToExport.sort(compareSeqId)

  // Serialize in sorted order, enforcing the per-line cap and the 8 MiB total cap deterministically
  // (drop from the tail: highest seq first). Tombstone stubs never dominate the cap in practice.
  let truncated = false
  const lines = []
  for (const record of recordsToExport) {
    const line = JSON.stringify(record)
    const bytes = Buffer.byteLength(line, 'utf8')
    if (bytes > MAX_EXPORT_LINE_BYTES) {
      throw exportError(
        EXPORT_ERROR_CODES.EXPORT_FAILED,
        `record ${asString(record.id)} serializes to ${bytes} bytes, over the ${MAX_EXPORT_LINE_BYTES}-byte line cap`,
      )
    }
    lines.push({ record, line, bytes: bytes + 1 })
  }
  let totalBytes = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (totalBytes + lines[index].bytes > EXPORT_MAX_BYTES) {
      truncated = true
      lines.length = index
      break
    }
    totalBytes += lines[index].bytes
  }
  const jsonlText = lines.length === 0 ? '' : lines.map((item) => item.line).join('\n') + '\n'
  const keptBytes = Buffer.byteLength(jsonlText, 'utf8')
  const sha256 = createHash('sha256').update(jsonlText, 'utf8').digest('hex')

  // Integrity fields count live records only; stubs are file content, not counted (V7 contract).
  const liveRecords = lines.map((item) => item.record).filter((record) => record.deleted !== true)
  const liveSeqs = liveRecords.map((record) => asString(record.seq)).filter((seq) => seq !== '')
  const firstSeq = liveSeqs.length > 0 ? liveSeqs.reduce((min, seq) => (seq < min ? seq : min)) : null
  const lastSeq = liveSeqs.length > 0 ? liveSeqs.reduce((max, seq) => (seq > max ? seq : max)) : null
  const recordCount = liveRecords.length

  const manifest = {
    schema: EXPORT_SCHEMA,
    formatVersion: EXPORT_FORMAT_VERSION,
    scope: EXPORT_SCOPE,
    producer: { ...EXPORT_PRODUCER },
    generatedAt,
    workspace: { wsKey: GLOBAL_SCOPE_KEY, name: GLOBAL_SCOPE_LABEL },
    recordCount,
    firstSeq,
    lastSeq,
    files: [{ name: MEMORIES_FILE, bytes: keptBytes, sha256 }],
    redaction: {
      applied: !(isPlainObject(cfg.privacy) && cfg.privacy.redact === false),
      policy: 'confluence.redact/v1',
    },
    limits: { truncated, maxEntriesPerWorkspace },
  }

  const result = {
    schema: EXPORT_SCHEMA,
    formatVersion: EXPORT_FORMAT_VERSION,
    scope: EXPORT_SCOPE,
    outDir: resolvedOutDir,
    files: manifest.files,
    manifest,
    recordCount,
    firstSeq,
    lastSeq,
    tombstoneStubs,
    skippedReplies,
    skippedRetention,
    truncated,
    dryRun: dryRun === true,
  }
  if (dryRun === true) {
    result.jsonlText = jsonlText
    return result
  }

  try {
    await fs.mkdir(resolvedOutDir, { recursive: true })
  } catch (error) {
    throw exportError(EXPORT_ERROR_CODES.STORE_UNAVAILABLE, `cannot create export directory: ${error?.message ?? error}`, {
      cause: error,
    })
  }
  const jsonlPath = path.join(resolvedOutDir, MEMORIES_FILE)
  const manifestPath = path.join(resolvedOutDir, EXPORT_MANIFEST_FILE)
  await writeFileAtomically(jsonlPath, jsonlText, { fs, writerId })
  // The manifest is the commit marker: it is written LAST, after the JSONL is durable.
  await writeFileAtomically(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { fs, writerId })
  await syncDirectory(resolvedOutDir, fs)
  result.jsonlPath = jsonlPath
  result.manifestPath = manifestPath
  logger?.info?.({
    event: 'export.written',
    scope: EXPORT_SCOPE,
    outDir: resolvedOutDir,
    recordCount,
    tombstoneStubs,
    bytes: keptBytes,
    truncated,
  })
  return result
}
