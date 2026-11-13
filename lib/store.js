// Confluence / 汇流 — append-only JSONL journal store.
//
// Layout (store-format.md §3):
//   <rootDir>/workspaces/<wsKey>/MANIFEST.v1.json
//   <rootDir>/workspaces/<wsKey>/journal.<writerId>.v1.jsonl
//   <rootDir>/workspaces/<wsKey>/presence/<writerId>.json
//
// One writer per shard: this process holds one O_APPEND fd and writes complete
// UTF-8 lines with fs.writeSync (≤64 KiB each). Readers merge all shards, sort
// by `seq` and dedupe: entry ids first-by-seq wins, session rows max-seq wins.
// Torn trailing lines are ignored and their byte offset remembered. Polling is
// the freshness contract; fs.watch is a best-effort accelerator.
//
// Contract: docs/plan/implementation-interfaces.md §5 (plus the round-1
// addendum: listWorkspaces/workspaceMeta/viewedRecords/view/isOpen).

import nodeFs from 'node:fs'
import nodeFsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ConfluenceError,
  createLogger,
  createUlidFactory,
  isUlid,
  isoNow,
  makeWriterId,
  safeJsonParse,
} from './util.js'

const FORMAT = 'confluence.store/v1'
const FORMAT_VERSION = 1
const MAX_LINE_BYTES = 65536
const MANIFEST_NAME = 'MANIFEST.v1.json'
const SHARD_PATTERN = /^journal\.([0-9]{1,10}-[0-9a-f]{8})\.v1\.jsonl$/
const PRESENCE_FILE_PATTERN = /^([0-9]{1,10}-[0-9a-f]{8})\.json$/
const WS_KEY_PATTERN = /^ws_[0-9a-f]{16}$/
const KNOWN_RECORD_TYPES = new Set(['entry', 'session', 'tombstone'])
const DEFAULT_RETRY_DELAYS = [50, 150, 400]
const WATCH_DEBOUNCE_MS = 400
const MAX_PRESENCE_SCAN = 256
const MAX_POLL_MS = 10 * 60 * 1000
const EMPTY_RECORDS = Object.freeze([])

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {string} a @param {string} b @returns {number} */
function compareStrings(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => {
    if (!(ms > 0)) setImmediate(resolve)
    else setTimeout(resolve, ms)
  })
}

/** @param {unknown} error @returns {boolean} */
function isTransientError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EMFILE' || code === 'ENFILE'
}

/**
 * @param {unknown} logger
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
function normalizeLogger(logger) {
  const silent = createLogger(false)
  if (!logger || typeof logger !== 'object') return silent
  const out = {}
  for (const level of ['debug', 'info', 'warn', 'error']) {
    const fn = typeof logger[level] === 'function' ? logger[level] : null
    out[level] = (record) => {
      if (!fn) return
      try {
        fn.call(logger, record)
      } catch {
        // never let diagnostics break storage
      }
    }
  }
  return Object.freeze(out)
}

/** @param {Record<string, unknown>} record @returns {string | null} */
function dedupeKeyFor(record) {
  if (record.type === 'session') {
    const id = record.sessionId !== undefined && record.sessionId !== null ? record.sessionId : record.id
    return typeof id === 'string' && id !== '' ? `session:${id}` : null
  }
  if (typeof record.id === 'string' && record.id !== '') return `${record.type}:${record.id}`
  return null
}

/** @param {Record<string, unknown>} a @param {Record<string, unknown>} b @returns {number} */
function compareRecords(a, b) {
  const bySeq = compareStrings(String(a.seq ?? ''), String(b.seq ?? ''))
  if (bySeq !== 0) return bySeq
  const aId = a.id !== undefined ? a.id : a.sessionId
  const bId = b.id !== undefined ? b.id : b.sessionId
  return compareStrings(String(aId ?? ''), String(bId ?? ''))
}

/** @param {unknown} value @returns {boolean} */
function looksLikeId(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * @param {unknown} record
 * @returns {boolean} envelope-valid known record (type-specific minimal shape)
 */
function isValidKnownRecord(record) {
  if (record.v !== 1) return false
  if (!isUlid(record.seq)) return false
  if (typeof record.ts !== 'string' || record.ts === '') return false
  if (record.type === 'entry') return looksLikeId(record.id)
  if (record.type === 'session') return looksLikeId(record.sessionId) || looksLikeId(record.id)
  if (record.type === 'tombstone') return looksLikeId(record.target) || looksLikeId(record.id)
  return false
}

/**
 * Parse the new bytes of one shard. Complete lines become records; an
 * unterminated trailing line is left unconsumed (its offset is remembered by
 * the caller for the next refresh).
 *
 * @param {Buffer} chunk bytes starting at the previous consumed offset
 * @param {string} wsKey expected workspace key
 * @param {{invalid: number, unsupported: number}} stats
 * @returns {{records: object[], consumedBytes: number}}
 */
function parseShardChunk(chunk, wsKey, stats) {
  const records = []
  let lineStart = 0
  let lastNewline = -1
  for (let index = 0; index < chunk.length; index += 1) {
    if (chunk[index] !== 0x0a) continue
    processLine(chunk.subarray(lineStart, index))
    lastNewline = index
    lineStart = index + 1
  }
  const tailBytes = chunk.length - (lastNewline + 1)
  // A tail that has grown absurdly large can never become a valid line; drop it
  // instead of retaining unbounded garbage (store-format.md §6).
  if (tailBytes > MAX_LINE_BYTES * 4) {
    stats.invalid += 1
    return { records, consumedBytes: chunk.length }
  }
  return { records, consumedBytes: lastNewline + 1 }

  /** @param {Buffer} lineBuffer */
  function processLine(lineBuffer) {
    if (lineBuffer.length === 0) {
      stats.invalid += 1
      return
    }
    if (lineBuffer.length + 1 > MAX_LINE_BYTES) {
      stats.invalid += 1
      return
    }
    const parsed = safeJsonParse(lineBuffer.toString('utf8'))
    if (!parsed.ok || !isPlainObject(parsed.value)) {
      stats.invalid += 1
      return
    }
    const record = parsed.value
    if (record.ws !== wsKey) {
      stats.invalid += 1
      return
    }
    if (typeof record.type !== 'string') {
      stats.invalid += 1
      return
    }
    if (!KNOWN_RECORD_TYPES.has(record.type)) {
      stats.unsupported += 1
      return
    }
    if (!isValidKnownRecord(record)) {
      stats.invalid += 1
      return
    }
    records.push(record)
  }
}

/**
 * JournalStore — one per plugin mount. Owns the writer id, the store root and
 * the per-workspace journals (merged read caches).
 */
export class JournalStore {
  /**
   * @param {{config?: object, logger?: object, deps?: object}} [options]
   * deps: { fs, fsSync, now, random, pid, env, homedir, platform, watch, retryDelays }
   */
  constructor({ config, logger, deps } = {}) {
    this.config = isPlainObject(config) ? config : {}
    this.logger = normalizeLogger(logger)
    this.deps = isPlainObject(deps) ? deps : {}

    this._fsp = this.deps.fs && typeof this.deps.fs.readFile === 'function' ? this.deps.fs : nodeFsPromises
    this._fsSync = this.deps.fsSync && typeof this.deps.fsSync.openSync === 'function' ? this.deps.fsSync : nodeFs
    this._now = typeof this.deps.now === 'function' ? this.deps.now : () => Date.now()
    this._random = typeof this.deps.random === 'function' ? this.deps.random : Math.random
    this._retryDelays = Array.isArray(this.deps.retryDelays) ? this.deps.retryDelays.slice() : DEFAULT_RETRY_DELAYS.slice()
    this._platform = typeof this.deps.platform === 'string' ? this.deps.platform : process.platform
    this._watchImpl =
      typeof this.deps.watch === 'function'
        ? this.deps.watch
        : typeof this.deps.watchImpl === 'function'
          ? this.deps.watchImpl
          : nodeFs.watch

    const env = isPlainObject(this.deps.env) ? this.deps.env : process.env
    this._dshHome =
      typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : this._defaultDshHome()
    this._defaultRootDir = path.join(this._dshHome, 'storages', 'confluence', 'v1')
    this._rootDir = this._resolveRootDir(this.config.store && this.config.store.dir)

    this.writerId = makeWriterId(this.deps.pid !== undefined ? this.deps.pid : process.pid, this._random)
    this._ulid = createUlidFactory(this._now, this._random)

    /** @type {Map<string, WorkspaceJournal>} */
    this._journals = new Map()
    /** @type {Map<string, {wsKey: string, canonicalPath: string, createdAt: string | null}>} */
    this._meta = new Map()
    this._inited = false
    this._closed = false
  }

  /** Resolved store root (`<DSH_HOME>/storages/confluence/v1` by default). */
  get rootDir() {
    return this._rootDir
  }

  /** @returns {string} */
  _defaultDshHome() {
    try {
      const homedir = typeof this.deps.homedir === 'function' ? this.deps.homedir : os.homedir
      return path.join(homedir(), '.dsh')
    } catch {
      return path.join(process.cwd(), '.dsh')
    }
  }

  /**
   * @param {unknown} dir config.store.dir
   * @returns {string}
   */
  _resolveRootDir(dir) {
    if (typeof dir === 'string' && dir.trim() !== '') {
      const trimmed = dir.replace(/[\\/]+$/, '')
      if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
        if (/^\\\\[.?]\\/.test(trimmed)) return this._defaultRootDir
        return trimmed
      }
      const cleaned = trimmed.replace(/^[\\/]+/, '')
      return path.join(this._dshHome, 'storages', 'confluence', cleaned)
    }
    return this._defaultRootDir
  }

  /** @param {() => Promise<any>} operation @returns {Promise<any>} retry on transient Windows errors */
  async _retry(operation) {
    let lastError
    for (let attempt = 0; attempt <= this._retryDelays.length; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (!isTransientError(error) || attempt === this._retryDelays.length) throw error
        await delay(this._retryDelays[attempt])
      }
    }
    throw lastError
  }

  /**
   * Prepare the store root. Idempotent; safe to call before any other method.
   * @returns {Promise<this>}
   */
  async init() {
    if (this._inited) return this
    if (this._closed) throw new ConfluenceError('STORE_UNAVAILABLE', 'store is closed')
    try {
      const stat = await this._fsp.stat(this._rootDir).catch((error) => {
        if (error && error.code === 'ENOENT') return null
        throw error
      })
      if (stat && !stat.isDirectory()) {
        this.logger.warn({ event: 'store.root_is_file', rootDir: this._rootDir })
        this._rootDir = this._defaultRootDir
      }
      await this._fsp.mkdir(this._rootDir, { recursive: true })
    } catch (error) {
      throw new ConfluenceError('STORE_UNAVAILABLE', `cannot prepare store root: ${error?.message ?? error}`, {
        cause: error,
      })
    }
    this._inited = true
    return this
  }

  /**
   * Open (or reuse) one workspace journal.
   *
   * @param {string} wsKey `ws_` + 16 hex
   * @param {{canonicalPath?: string, label?: string}} [meta]
   * @returns {Promise<WorkspaceJournal>}
   */
  async openWorkspace(wsKey, meta = {}) {
    if (typeof wsKey !== 'string' || !WS_KEY_PATTERN.test(wsKey)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid workspace key: ${String(wsKey)}`)
    }
    if (this._closed) throw new ConfluenceError('STORE_UNAVAILABLE', 'store is closed')
    await this.init()
    const existing = this._journals.get(wsKey)
    if (existing) return existing

    const dir = path.join(this._rootDir, 'workspaces', wsKey)
    await this._fsp.mkdir(path.join(dir, 'presence'), { recursive: true })
    const manifest = await this._loadOrCreateManifest(wsKey, dir, isPlainObject(meta) ? meta : {})
    const canonicalPath = manifest.workspace.canonicalPath
    const createdAt = typeof manifest.workspace.createdAt === 'string' ? manifest.workspace.createdAt : null
    this._meta.set(wsKey, Object.freeze({ wsKey, canonicalPath, createdAt }))

    const journal = new WorkspaceJournal({
      store: this,
      wsKey,
      dir,
      config: this.config,
      deps: this.deps,
      fsp: this._fsp,
      fsSync: this._fsSync,
      logger: this.logger,
      ulid: this._ulid,
      now: this._now,
    })
    await journal.refresh({ force: true })
    journal.start()
    this._journals.set(wsKey, journal)
    this.logger.debug({ event: 'store.workspace_opened', wsKey })
    return journal
  }

  /**
   * @param {string} wsKey
   * @param {string} dir
   * @param {{canonicalPath?: string}} meta
   * @returns {Promise<object>} manifest
   */
  async _loadOrCreateManifest(wsKey, dir, meta) {
    const file = path.join(dir, MANIFEST_NAME)
    const createdAt = isoNow(this._now())
    const initial = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      ws: wsKey,
      workspace: {
        key: wsKey,
        canonicalPath: typeof meta.canonicalPath === 'string' ? meta.canonicalPath : '',
        createdAt,
      },
      generation: 0,
      snapshot: null,
      shards: [],
      seqRange: { min: null, max: null },
      updatedAt: createdAt,
    }
    try {
      const fd = this._fsSync.openSync(file, 'wx', 0o600)
      try {
        this._fsSync.writeSync(fd, JSON.stringify(initial))
        this._fsSync.fsyncSync(fd)
      } finally {
        this._fsSync.closeSync(fd)
      }
      return initial
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw new ConfluenceError('STORE_UNAVAILABLE', `cannot create store manifest: ${error?.message ?? error}`, {
          cause: error,
        })
      }
    }

    let raw
    try {
      raw = await this._retry(() => this._fsp.readFile(file, 'utf8'))
    } catch (error) {
      throw new ConfluenceError('STORE_UNAVAILABLE', `cannot read store manifest: ${error?.message ?? error}`, {
        cause: error,
      })
    }
    const parsed = safeJsonParse(raw)
    const manifest = parsed.ok ? parsed.value : null
    if (
      !isPlainObject(manifest) ||
      manifest.format !== FORMAT ||
      manifest.formatVersion !== FORMAT_VERSION ||
      manifest.ws !== wsKey ||
      !isPlainObject(manifest.workspace) ||
      typeof manifest.workspace.canonicalPath !== 'string'
    ) {
      throw new ConfluenceError('STORE_UNAVAILABLE', `invalid store manifest for ${wsKey}`)
    }
    if (
      typeof meta.canonicalPath === 'string' &&
      meta.canonicalPath !== '' &&
      manifest.workspace.canonicalPath !== '' &&
      manifest.workspace.canonicalPath !== meta.canonicalPath
    ) {
      throw new ConfluenceError(
        'STORE_UNAVAILABLE',
        `workspace key collision: ${wsKey} is already bound to another canonical path`,
      )
    }
    return manifest
  }

  /**
   * List every valid workspace manifest under the store root. Tolerant: one bad
   * directory/manifest never fails the listing.
   *
   * @returns {Promise<{wsKey: string, canonicalPath: string, label: string, createdAt: string | null, generation?: number, entries?: number}[]>}
   */
  async listWorkspaces() {
    await this.init()
    const out = []
    let dirents
    try {
      dirents = await this._fsp.readdir(path.join(this._rootDir, 'workspaces'), { withFileTypes: true })
    } catch {
      return out
    }
    for (const dirent of dirents) {
      if (!dirent || typeof dirent.isDirectory !== 'function' || !dirent.isDirectory()) continue
      const wsKey = dirent.name
      if (typeof wsKey !== 'string' || !WS_KEY_PATTERN.test(wsKey)) continue
      try {
        const raw = await this._retry(() =>
          this._fsp.readFile(path.join(this._rootDir, 'workspaces', wsKey, MANIFEST_NAME), 'utf8'),
        )
        const parsed = safeJsonParse(raw)
        const manifest = parsed.ok ? parsed.value : null
        if (
          !isPlainObject(manifest) ||
          manifest.format !== FORMAT ||
          manifest.formatVersion !== FORMAT_VERSION ||
          manifest.ws !== wsKey ||
          !isPlainObject(manifest.workspace) ||
          typeof manifest.workspace.canonicalPath !== 'string'
        ) {
          continue
        }
        const canonicalPath = manifest.workspace.canonicalPath
        const createdAt =
          typeof manifest.workspace.createdAt === 'string' ? manifest.workspace.createdAt : null
        const item = {
          wsKey,
          canonicalPath,
          label: this._labelFor(canonicalPath),
          createdAt,
        }
        if (Number.isInteger(manifest.generation) && manifest.generation >= 0) item.generation = manifest.generation
        const journal = this._journals.get(wsKey)
        if (journal) item.entries = journal.records().filter((record) => record.type === 'entry').length
        this._meta.set(wsKey, Object.freeze({ wsKey, canonicalPath, createdAt }))
        out.push(item)
      } catch {
        // tolerant by contract: skip the bad workspace only
      }
    }
    out.sort((a, b) => compareStrings(a.wsKey, b.wsKey))
    return out
  }

  /**
   * Cached workspace metadata from the manifest read at open/list time.
   *
   * @param {string} wsKey
   * @returns {{wsKey: string, canonicalPath: string, createdAt: string | null} | null}
   */
  workspaceMeta(wsKey) {
    if (typeof wsKey !== 'string') return null
    const cached = this._meta.get(wsKey)
    if (!cached) return null
    return { wsKey: cached.wsKey, canonicalPath: cached.canonicalPath, createdAt: cached.createdAt }
  }

  /**
   * Synchronous alias for the facade: merged records of an already-open
   * workspace, or an empty frozen array when it is not open.
   *
   * @param {string} wsKey
   * @returns {readonly object[]}
   */
  viewedRecords(wsKey) {
    const journal = typeof wsKey === 'string' ? this._journals.get(wsKey) : undefined
    return journal ? journal.records() : EMPTY_RECORDS
  }

  /** @param {string} canonicalPath @returns {string} */
  _labelFor(canonicalPath) {
    if (typeof canonicalPath !== 'string' || canonicalPath === '') return ''
    const basename =
      this._platform === 'win32' ? path.win32.basename(canonicalPath) : path.basename(canonicalPath)
    return basename !== '' ? basename : canonicalPath
  }

  /** Close every open journal (flush + close fds) and stop timers/watchers. */
  async close() {
    if (this._closed) return
    this._closed = true
    for (const journal of this._journals.values()) {
      try {
        await journal.close()
      } catch (error) {
        this.logger.warn({ event: 'store.close_failed', message: error?.message })
      }
    }
    this._journals.clear()
  }
}

/**
 * One workspace's journal: this process's append fd plus the merged read cache
 * over all shards in the directory.
 */
export class WorkspaceJournal {
  /** @param {object} options */
  constructor({ store, wsKey, dir, config, deps, fsp, fsSync, logger, ulid, now }) {
    this.store = store
    this.wsKey = wsKey
    this.dir = dir
    this.config = config
    this.deps = deps
    this._fsp = fsp
    this._fsSync = fsSync
    this.logger = logger
    this._ulid = ulid
    this._now = now
    this._shardPath = path.join(dir, `journal.${store.writerId}.v1.jsonl`)
    this._presenceDir = path.join(dir, 'presence')
    this._fd = null
    this._open = true
    this._closed = false
    /** @type {Map<string, {consumedBytes: number, records: object[], size: number, mtimeMs: number}>} */
    this._fileStates = new Map()
    this._records = EMPTY_RECORDS
    this._signature = ''
    /** @type {Set<(viewChanged: boolean) => void>} */
    this._listeners = new Set()
    this._timer = null
    this._watcher = null
    this._debounce = null
    this._refreshPromise = null
    this._presenceCounter = 0
    this._stats = { invalid: 0, unsupported: 0 }
    this._retryDelays = Array.isArray(deps.retryDelays) ? deps.retryDelays : DEFAULT_RETRY_DELAYS
    const pollCandidate = Number(config && config.store ? config.store.pollMs : 4000)
    this._pollMs = Number.isFinite(pollCandidate) && pollCandidate > 0 ? Math.min(MAX_POLL_MS, pollCandidate) : 4000
    this._watchEnabled = !(config && config.store && config.store.watch === false)
  }

  /** True while the journal is open (append/poll/watch active). */
  get isOpen() {
    return this._open && !this._closed
  }

  /** @param {() => Promise<any>} operation @returns {Promise<any>} shared transient-error retry */
  async _retry(operation) {
    return this.store._retry(operation)
  }

  /** Merged records, sorted by seq: entries first-by-seq, sessions max-seq, tombstones kept. */
  records() {
    return this._records
  }

  /** Synchronous alias of records() for the facade's board folds. */
  view() {
    return this._records
  }

  /** @param {(viewChanged: boolean) => void} callback @returns {() => void} */
  onChange(callback) {
    if (typeof callback !== 'function') return () => {}
    this._listeners.add(callback)
    return () => {
      this._listeners.delete(callback)
    }
  }

  /** @param {boolean} changed */
  _emit(changed) {
    for (const listener of [...this._listeners]) {
      try {
        listener(changed)
      } catch (error) {
        this.logger.warn({ event: 'store.change_listener_failed', message: error?.message })
      }
    }
  }

  /** Start polling (and fs.watch when enabled and available). Called once by the store. */
  start() {
    if (!this.isOpen || this._timer || this._closed) return
    this._timer = setInterval(() => {
      void this.refresh().catch((error) => {
        this.logger.debug({ event: 'store.poll_failed', message: error?.message })
      })
    }, this._pollMs)
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref()

    if (!this._watchEnabled) return
    try {
      const watcher = this.store._watchImpl(this.dir, { persistent: false }, () => this._scheduleWatchRefresh())
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', (error) => {
          this.logger.warn({ event: 'store.watch_error', message: error?.message })
          try {
            watcher.close()
          } catch {
            // ignore close failures
          }
          if (this._watcher === watcher) this._watcher = null
        })
      }
      this._watcher = watcher
    } catch (error) {
      this.logger.warn({ event: 'store.watch_unavailable', message: error?.message ?? String(error) })
      this._watcher = null
    }
  }

  _scheduleWatchRefresh() {
    if (!this.isOpen || this._debounce) return
    this._debounce = setTimeout(() => {
      this._debounce = null
      void this.refresh().catch((error) => {
        this.logger.debug({ event: 'store.watch_refresh_failed', message: error?.message })
      })
    }, WATCH_DEBOUNCE_MS)
    if (this._debounce && typeof this._debounce.unref === 'function') this._debounce.unref()
  }

  /**
   * Rescan changed shard tails and rebuild the merged view.
   *
   * @param {{force?: boolean}} [options]
   * @returns {Promise<boolean>} true when the merged view changed
   */
  async refresh({ force = false } = {}) {
    if (!this.isOpen) return false
    if (this._refreshPromise) return this._refreshPromise
    this._refreshPromise = this._doRefresh(force).finally(() => {
      this._refreshPromise = null
    })
    return this._refreshPromise
  }

  /** @param {boolean} force @returns {Promise<boolean>} */
  async _doRefresh(force) {
    let names
    try {
      names = (await this._retry(() => this._fsp.readdir(this.dir))).filter((name) => SHARD_PATTERN.test(name))
    } catch (error) {
      this.logger.warn({ event: 'store.readdir_failed', message: error?.message })
      return false
    }
    names.sort()
    const present = new Set(names)
    let dirty = false
    for (const name of [...this._fileStates.keys()]) {
      if (!present.has(name)) {
        this._fileStates.delete(name)
        dirty = true
      }
    }
    for (const name of names) {
      const changed = await this._refreshShard(name, force)
      if (changed) dirty = true
    }
    if (!dirty) return false
    const changed = this._rebuild()
    if (changed) this._emit(true)
    return changed
  }

  /**
   * @param {string} name shard basename
   * @param {boolean} force
   * @returns {Promise<boolean>} whether this shard contributed new/changed records
   */
  async _refreshShard(name, force) {
    const filePath = path.join(this.dir, name)
    let stat
    try {
      stat = await this._retry(() => this._fsp.stat(filePath))
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this._fileStates.delete(name)
        return true
      }
      this.logger.warn({ event: 'store.shard_stat_failed', file: name, message: error?.message })
      return false
    }
    let state = this._fileStates.get(name)
    if (state && !force && state.size === stat.size && state.mtimeMs === stat.mtimeMs) return false

    let buffer
    try {
      buffer = await this._retry(() => this._fsp.readFile(filePath))
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this._fileStates.delete(name)
        return true
      }
      this.logger.warn({ event: 'store.shard_read_failed', file: name, message: error?.message })
      return false
    }
    if (!state) state = { consumedBytes: 0, records: [], size: -1, mtimeMs: -1 }
    if (buffer.length < state.consumedBytes) {
      // The file shrank (compaction/prune or replacement): rebuild from byte 0.
      state.consumedBytes = 0
      state.records = []
    }
    const before = state.records.length
    const chunk = buffer.subarray(state.consumedBytes)
    if (chunk.length > 0) {
      const parsed = parseShardChunk(chunk, this.wsKey, this._stats)
      if (parsed.records.length > 0) state.records.push(...parsed.records)
      state.consumedBytes += parsed.consumedBytes
    }
    state.size = stat.size
    state.mtimeMs = stat.mtimeMs
    this._fileStates.set(name, state)
    return force || state.records.length !== before
  }

  /**
   * Fold shard records into the merged view. Pure with respect to the record
   * set: deterministic for any traversal order.
   *
   * @returns {boolean} whether the view changed
   */
  _rebuild() {
    const all = []
    for (const name of [...this._fileStates.keys()].sort()) {
      const state = this._fileStates.get(name)
      if (state && state.records.length > 0) all.push(...state.records)
    }
    all.sort(compareRecords)
    /** @type {Map<string, Record<string, unknown>>} */
    const byKey = new Map()
    for (const record of all) {
      const key = dedupeKeyFor(record)
      if (key === null) continue
      const existing = byKey.get(key)
      if (!existing) {
        byKey.set(key, record)
        continue
      }
      const cmp = compareStrings(String(record.seq ?? ''), String(existing.seq ?? ''))
      if (record.type === 'session') {
        if (cmp > 0) byKey.set(key, record)
        else if (cmp === 0 && JSON.stringify(record) < JSON.stringify(existing)) byKey.set(key, record)
      } else if (cmp < 0) {
        byKey.set(key, record)
      } else if (cmp === 0 && JSON.stringify(record) < JSON.stringify(existing)) {
        byKey.set(key, record)
      }
    }
    const merged = [...byKey.values()].sort(compareRecords)
    const signature = merged
      .map((record) => `${String(record.seq)}|${String(record.type)}|${String(record.id ?? record.sessionId ?? '')}`)
      .join(';')
    const changed = signature !== this._signature
    this._records = Object.freeze(merged)
    this._signature = signature
    return changed
  }

  /** Ensure the held O_APPEND fd exists. */
  async _ensureFd() {
    if (this._fd !== null) return
    try {
      await this._fsp.mkdir(this.dir, { recursive: true })
      this._fd = this._fsSync.openSync(this._shardPath, 'a', 0o600)
    } catch (error) {
      throw new ConfluenceError('STORE_UNAVAILABLE', `cannot open journal shard: ${error?.message ?? error}`, {
        cause: error,
      })
    }
  }

  /**
   * Append one record to this process's shard. Assigns `v/ws/seq/ts` when absent.
   * One complete UTF-8 line per write; rejects an encoded line over 64 KiB.
   *
   * @param {object} record
   * @returns {Promise<object>} stored record
   */
  async append(record) {
    if (!this.isOpen) throw new ConfluenceError('STORE_UNAVAILABLE', 'journal is closed')
    if (!isPlainObject(record) || typeof record.type !== 'string' || record.type === '') {
      throw new ConfluenceError('BAD_ARGUMENT', 'record must be an object with a type')
    }
    const stored = { ...record }
    if (stored.v === undefined) stored.v = 1
    if (stored.ws === undefined) stored.ws = this.wsKey
    if (stored.seq === undefined) stored.seq = this._ulid()
    if (stored.ts === undefined) stored.ts = isoNow(this._now())

    const line = `${JSON.stringify(stored)}\n`
    const bytes = Buffer.byteLength(line, 'utf8')
    if (bytes > MAX_LINE_BYTES) {
      throw new ConfluenceError(
        'BODY_TOO_LARGE',
        `record serialization is ${bytes} bytes; the journal line cap is ${MAX_LINE_BYTES}`,
      )
    }
    await this._ensureFd()
    try {
      this._fsSync.writeSync(this._fd, line)
    } catch (error) {
      throw new ConfluenceError('STORE_UNAVAILABLE', `journal append failed: ${error?.message ?? error}`, {
        cause: error,
      })
    }
    const name = path.basename(this._shardPath)
    let state = this._fileStates.get(name)
    if (!state) state = { consumedBytes: 0, records: [], size: -1, mtimeMs: -1 }
    state.consumedBytes += bytes
    state.records.push(stored)
    state.size = -1
    state.mtimeMs = -1
    this._fileStates.set(name, state)
    if (this._rebuild()) this._emit(true)
    return stored
  }

  /**
   * Board-post durability: append, then fsync before resolving. Throws
   * STORE_UNAVAILABLE when the fsync fails (the caller must not claim success).
   *
   * @param {object} record
   * @returns {Promise<object>}
   */
  async appendAndSync(record) {
    const stored = await this.append(record)
    await this.flush()
    return stored
  }

  /** fsync the held shard fd. No-op when nothing was written yet. */
  async flush() {
    if (this._fd === null) return
    try {
      this._fsSync.fsyncSync(this._fd)
    } catch (error) {
      this.logger.warn({ event: 'store.fsync_failed', wsKey: this.wsKey, message: error?.message })
      throw new ConfluenceError('STORE_UNAVAILABLE', `journal fsync failed: ${error?.message ?? error}`, {
        cause: error,
      })
    }
  }

  /**
   * Atomically rewrite this writer's presence heartbeat file.
   *
   * @param {object} data e.g. { sessions: [{sessionId, title, wsKey, status}] }
   * @returns {Promise<void>}
   */
  async writePresence(data) {
    if (!this.isOpen) return
    const body = { ...(isPlainObject(data) ? data : {}) }
    body.writerId = this.store.writerId
    body.updatedAt =
      isPlainObject(data) && typeof data.updatedAt === 'string' && data.updatedAt !== ''
        ? data.updatedAt
        : isoNow(this._now())
    const target = path.join(this._presenceDir, `${this.store.writerId}.json`)
    this._presenceCounter += 1
    const tmp = path.join(this._presenceDir, `.tmp-${this.store.writerId}-${this._presenceCounter}.json`)
    try {
      await this._fsp.mkdir(this._presenceDir, { recursive: true })
      await this._fsp.writeFile(tmp, JSON.stringify(body), 'utf8')
      await this._renameWithRetry(tmp, target)
    } catch (error) {
      try {
        this._fsSync.unlinkSync(tmp)
      } catch {
        // best effort cleanup
      }
      this.logger.warn({ event: 'store.presence_write_failed', wsKey: this.wsKey, message: error?.message })
    }
  }

  /** @param {string} from @param {string} to @returns {Promise<void>} */
  async _renameWithRetry(from, to) {
    let lastError
    for (let attempt = 0; attempt <= this._retryDelays.length; attempt += 1) {
      try {
        await this._fsp.rename(from, to)
        return
      } catch (error) {
        lastError = error
        if (!isTransientError(error) || attempt === this._retryDelays.length) break
        await delay(this._retryDelays[attempt])
      }
    }
    throw lastError
  }

  /**
   * Read every valid presence heartbeat in this workspace.
   *
   * @returns {Promise<Record<string, object>>}
   */
  async readPresence() {
    const out = {}
    let names
    try {
      names = await this._fsp.readdir(this._presenceDir)
    } catch {
      return out
    }
    names.sort()
    let seen = 0
    for (const name of names) {
      if (!PRESENCE_FILE_PATTERN.test(name)) continue
      seen += 1
      if (seen > MAX_PRESENCE_SCAN) break
      try {
        const raw = await this._retry(() => this._fsp.readFile(path.join(this._presenceDir, name), 'utf8'))
        const parsed = safeJsonParse(raw)
        if (!parsed.ok || !isPlainObject(parsed.value)) continue
        out[name.slice(0, -'.json'.length)] = parsed.value
      } catch {
        // ignore one unreadable heartbeat
      }
    }
    return out
  }

  /** @returns {Promise<{shards: number, bytes: number, entries: number}>} */
  async sizeInfo() {
    let shards = 0
    let bytes = 0
    try {
      const names = (await this._fsp.readdir(this.dir)).filter((name) => SHARD_PATTERN.test(name))
      shards = names.length
      for (const name of names) {
        try {
          const stat = await this._fsp.stat(path.join(this.dir, name))
          bytes += Number(stat.size) || 0
        } catch {
          // ignore a vanished shard
        }
      }
    } catch {
      // unreadable directory: report zeros
    }
    let entries = 0
    for (const record of this._records) if (record.type === 'entry') entries += 1
    return { shards, bytes, entries }
  }

  /** Flush, close the shard fd, stop timers/watchers. Idempotent. */
  async close() {
    if (this._closed) return
    this._open = false
    this._closed = true
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._debounce) {
      clearTimeout(this._debounce)
      this._debounce = null
    }
    if (this._watcher) {
      try {
        this._watcher.close()
      } catch {
        // ignore
      }
      this._watcher = null
    }
    if (this._fd !== null) {
      try {
        this._fsSync.fsyncSync(this._fd)
      } catch (error) {
        this.logger.debug({ event: 'store.close_fsync_failed', message: error?.message })
      }
      try {
        this._fsSync.closeSync(this._fd)
      } catch (error) {
        this.logger.debug({ event: 'store.close_fd_failed', message: error?.message })
      }
      this._fd = null
    }
  }
}
