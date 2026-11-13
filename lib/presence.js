// Confluence / 汇流 — WP3b: presence heartbeat files + synchronous live-peer cache.
//
// Contract: docs/plan/implementation-interfaces.md §7; the Lead's WP3 addendum (live() is
// SYNCHRONOUS and reads an in-memory snapshot refreshed by a poll timer and on turn/end;
// `refreshPresence()` is the async refresh seam for polls/tests; heartbeat writes stay async);
// docs/design/ledger-recall.md §3; docs/design/data-model.md §4.6; store-format.md §10.
//
// Presence is metadata only and NEVER touches the journal: it writes one heartbeat file per
// plugin mount per workspace: `presence/<writerId>.json`, atomically replaced by the store's
// `journal.writePresence`. The file carries session IDs only — no titles, no bodies, no paths,
// no prompts, no status (data-model §4.6 is authoritative). Titles/status for the panel/pulse are
// joined at read time from (a) the host's live-session descriptor callback and (b) the merged
// journal `session` ledger rows, so they never leave the process inside the heartbeat file.
//
// Readers ignore malformed or stale files (>30 s) and never participate in journal merge order.
import path from 'node:path'
import * as nodeFs from 'node:fs/promises'

/** Heartbeat cadence while this process has live sessions in a workspace (ADR-0001 §6). */
const HEARTBEAT_INTERVAL_MS = 10000
/** A heartbeat older than this means offline (ADR-0001 §6). */
const PRESENCE_STALE_MS = 30000
/** Poll interval fallback when config.store.pollMs is absent. */
const DEFAULT_POLL_MS = 5000
const MIN_POLL_MS = 1000
const MAX_POLL_MS = 30000
const MAX_SESSIONS_PER_FILE = 32
const PLUGIN_NAME = 'dsh-confluence'
const PLUGIN_VERSION = '0.1.0'

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string | undefined} */
function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/** @param {number} ms @returns {string} */
function isoFromMs(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now())
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
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

/**
 * Normalise the heartbeat `sessions` field: v1 writers store `[sessionId, …]` (data-model §4.6);
 * readers tolerate an object form defensively so a future/older writer cannot crash a refresh.
 * @param {unknown} value
 * @returns {string[]}
 */
function sessionIdsOf(value) {
  if (!Array.isArray(value)) return []
  const ids = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) {
      ids.push(entry)
      continue
    }
    if (isPlainObject(entry)) {
      const id =
        optionalString(entry.sessionId) ?? optionalString(entry.session_id) ?? optionalString(entry.id)
      if (id !== undefined) ids.push(id)
    }
  }
  return [...new Set(ids)]
}

export class Presence {
  /**
   * @param {object} options
   * @param {object} options.store JournalStore (implementation-interfaces §5)
   * @param {object} [options.config] resolved config
   * @param {object} [options.logger] structured logger
   * @param {object} [options.deps] { now, writerId, pid, plugin, fs, setInterval, clearInterval,
   *   workspaceMeta }
   */
  constructor({ store, config, logger, deps } = {}) {
    if (!store || typeof store.openWorkspace !== 'function') {
      throw new TypeError('Presence requires a store with openWorkspace()')
    }
    this.store = store
    this.config = config ?? {}
    this.logger = logger
    this.deps = deps ?? {}
    this.now = typeof this.deps.now === 'function' ? this.deps.now : () => Date.now()
    this.fs = this.deps.fs ?? nodeFs
    this.setIntervalFn = typeof this.deps.setInterval === 'function' ? this.deps.setInterval : setInterval
    this.clearIntervalFn =
      typeof this.deps.clearInterval === 'function' ? this.deps.clearInterval : clearInterval
    this.writerId =
      optionalString(this.deps.writerId) ??
      optionalString(this.store.writerId) ??
      `${typeof this.deps.pid === 'number' ? this.deps.pid : process.pid}-00000000`
    this.pid = typeof this.deps.pid === 'number' ? this.deps.pid : process.pid
    this.plugin = isPlainObject(this.deps.plugin)
      ? this.deps.plugin
      : { name: PLUGIN_NAME, version: PLUGIN_VERSION }
    this.pollMs = clampInt(this.config?.store?.pollMs, DEFAULT_POLL_MS, MIN_POLL_MS, MAX_POLL_MS)
    this.journals = new Map() // wsKey -> WorkspaceJournal
    this.journalPromises = new Map() // wsKey -> Promise<WorkspaceJournal>
    this.writtenKeys = new Set() // workspaces this writer has a heartbeat file for
    this.cache = new Map() // wsKey -> { at, entries: [{sessionId,title,writerId,updatedAt,status}] }
    this.localDescriptors = [] // descriptor snapshots from listLiveSessionsFn (async-refreshed)
    this.knownKeys = new Set()
    this.pollTimer = null
    this.heartbeatTimer = null
    this.disposers = []
    this.chain = Promise.resolve() // serialise presence writes/refreshes
    this.disposed = false
  }

  /**
   * Attach to the host: subscribe to turn/end for an immediate heartbeat+refresh, start the
   * heartbeat (10 s) and presence-poll timers, and seed the cache. Call inside the plugin effect;
   * the returned function stops everything (also `dispose()`).
   *
   * @param {object} ctx Cordis plugin context
   * @param {() => Array<object> | Promise<Array<object>>} listLiveSessionsFn returns the host's
   *   current live session descriptors `{ id|sessionId, title?, wsKey|key, status? }`
   * @returns {() => void}
   */
  attach(ctx, listLiveSessionsFn) {
    this.listLiveSessionsFn = typeof listLiveSessionsFn === 'function' ? listLiveSessionsFn : () => []
    if (ctx && typeof ctx.on === 'function') {
      try {
        const off = ctx.on('session/event', (session, event) => {
          const type = optionalString(event?.type)
          if (type === 'turn/end' || type === 'session/flush') void this.tick()
        })
        if (typeof off === 'function') this.disposers.push(off)
      } catch {
        // Optional host event in restricted contexts.
      }
      try {
        const offDisposed = ctx.on('session/disposed', () => void this.tick())
        if (typeof offDisposed === 'function') this.disposers.push(offDisposed)
      } catch {
        // Optional event.
      }
    }
    this.heartbeatTimer = this.setIntervalFn(() => void this.tick(), HEARTBEAT_INTERVAL_MS)
    this.pollTimer = this.setIntervalFn(() => void this.refreshPresence(), this.pollMs)
    for (const timer of [this.heartbeatTimer, this.pollTimer]) {
      if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    }
    void this.tick()
    return () => this.dispose()
  }

  /** One heartbeat + poll refresh cycle (also the turn/end hook). */
  async tick() {
    if (this.disposed) return
    try {
      await this.writeHeartbeat()
    } catch (error) {
      this.warn({ event: 'presence.heartbeat_failed', error: String(error) })
    }
    try {
      await this.refreshPresence()
    } catch (error) {
      this.warn({ event: 'presence.refresh_failed', error: String(error) })
    }
  }

  /**
   * Write this mount's heartbeat file(s). Only workspaces where the host reports live, non-private
   * sessions get a file; a workspace that loses all its sessions gets its file removed. Content:
   * `{v:1, ws, writerId, pid, plugin, updatedAt, sessions:[sessionId…]}` (data-model §4.6).
   * @returns {Promise<void>}
   */
  async writeHeartbeat() {
    if (this.disposed) return
    const descriptors = await this.resolveDescriptors()
    const byWorkspace = new Map()
    for (const descriptor of descriptors) {
      const wsKey = descriptor.wsKey
      if (wsKey === undefined) continue
      if (this.isSuppressed(descriptor.sessionId, wsKey)) continue
      if (!byWorkspace.has(wsKey)) byWorkspace.set(wsKey, [])
      byWorkspace.get(wsKey).push(descriptor.sessionId)
    }
    const keys = new Set([...this.writtenKeys, ...byWorkspace.keys()])
    for (const wsKey of keys) {
      if (this.isDisabledWorkspace(wsKey)) continue
      const journal = await this.openJournal(wsKey)
      if (journal === null) continue
      const sessions = [...new Set(byWorkspace.get(wsKey) ?? [])].sort().slice(0, MAX_SESSIONS_PER_FILE)
      if (sessions.length === 0) {
        if (this.writtenKeys.has(wsKey)) {
          await this.removeHeartbeat(journal, wsKey)
          this.writtenKeys.delete(wsKey)
        }
        continue
      }
      const data = {
        v: 1,
        ws: wsKey,
        writerId: this.writerId,
        pid: this.pid,
        plugin: { name: this.plugin.name ?? PLUGIN_NAME, version: this.plugin.version ?? PLUGIN_VERSION },
        updatedAt: isoFromMs(this.now()),
        sessions,
      }
      try {
        await journal.writePresence(data)
        this.writtenKeys.add(wsKey)
      } catch (error) {
        this.warn({ event: 'presence.write_failed', wsKey, error: String(error) })
      }
    }
  }

  /**
   * Refresh the synchronous live-peer cache from all heartbeat files (all workspaces, or one).
   * Tolerant of absent/corrupt files; joins titles/status from the host descriptors and the merged
   * journal session rows. Also used directly by tests and the poll timer.
   *
   * @param {string} [wsKey] restrict to one workspace
   * @param {string} [writerId] restrict to one heartbeat writer (tests/diagnostics)
   * @returns {Promise<Record<string, Array<object>>>}
   */
  async refreshPresence(wsKey, writerId) {
    if (this.disposed) return {}
    const descriptors = await this.resolveDescriptors()
    const keys = new Set()
    if (wsKey !== undefined) {
      keys.add(wsKey)
    } else {
      for (const key of this.writtenKeys) keys.add(key)
      for (const descriptor of descriptors) if (descriptor.wsKey) keys.add(descriptor.wsKey)
      for (const key of this.cache.keys()) keys.add(key)
    }
    const result = {}
    const nowMs = this.now()
    for (const key of keys) {
      if (this.isDisabledWorkspace(key)) {
        this.cache.set(key, { at: nowMs, entries: [] })
        result[key] = []
        continue
      }
      const journal = await this.openJournal(key)
      if (journal === null) {
        this.cache.delete(key)
        result[key] = []
        continue
      }
      let files
      try {
        files = await journal.readPresence()
      } catch (error) {
        this.warn({ event: 'presence.read_failed', wsKey: key, error: String(error) })
        files = {}
      }
      const rows = this.sessionRowsFor(key)
      const descriptorById = new Map()
      for (const descriptor of descriptors) {
        if (descriptor.wsKey === key) descriptorById.set(descriptor.sessionId, descriptor)
      }
      const bySession = new Map()
      for (const [otherWriter, data] of Object.entries(isPlainObject(files) ? files : {})) {
        if (writerId !== undefined && otherWriter !== writerId) continue
        if (!isPlainObject(data)) continue
        const updatedAt = optionalString(data.updatedAt)
        const updatedMs = toMillis(updatedAt)
        if (!Number.isFinite(updatedMs)) continue
        if (nowMs - updatedMs > PRESENCE_STALE_MS) continue
        for (const sessionId of sessionIdsOf(data.sessions)) {
          if (this.isSuppressed(sessionId, key)) continue
          const previous = bySession.get(sessionId)
          if (previous !== undefined && previous.updatedMs >= updatedMs) continue
          const local = descriptorById.get(sessionId)
          const row = rows.get(sessionId)
          bySession.set(sessionId, {
            sessionId,
            title: optionalString(local?.title) ?? optionalString(row?.title) ?? '',
            writerId: otherWriter,
            updatedAt,
            status: optionalString(local?.status) ?? optionalString(row?.status) ?? 'idle',
            updatedMs,
          })
        }
      }
      const entries = [...bySession.values()]
        .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
        .map(({ updatedMs, ...entry }) => entry)
      this.cache.set(key, { at: nowMs, entries })
      result[key] = entries
    }
    return result
  }

  /**
   * SYNCHRONOUS live-peer view for one workspace, from the in-memory snapshot cache, filtered to
   * heartbeats younger than 30 s. Safe to call from the pulse provider (never touches disk).
   * @param {string} wsKey
   * @returns {Array<{sessionId: string, title: string, writerId: string, updatedAt: string, status: string}>}
   */
  live(wsKey) {
    if (typeof wsKey !== 'string' || wsKey.length === 0) return []
    const cached = this.cache.get(wsKey)
    if (cached === undefined) return []
    const nowMs = this.now()
    const out = []
    for (const entry of cached.entries) {
      const updatedMs = toMillis(entry.updatedAt)
      if (!Number.isFinite(updatedMs) || nowMs - updatedMs >= PRESENCE_STALE_MS) continue
      out.push({
        sessionId: entry.sessionId,
        title: entry.title,
        writerId: entry.writerId,
        updatedAt: entry.updatedAt,
        status: entry.status,
      })
    }
    return out
  }

  /** Resolve the host's live-session descriptors (sync array or Promise; both tolerated). */
  async resolveDescriptors() {
    const fn = this.listLiveSessionsFn
    if (typeof fn !== 'function') return []
    let raw
    try {
      raw = await fn()
    } catch (error) {
      this.warn({ event: 'presence.list_live_failed', error: String(error) })
      return this.localDescriptors
    }
    const descriptors = []
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!isPlainObject(item)) continue
      const sessionId =
        optionalString(item.sessionId) ?? optionalString(item.session_id) ?? optionalString(item.id)
      const wsKey = optionalString(item.wsKey) ?? optionalString(item.key)
      if (sessionId === undefined || wsKey === undefined) continue
      descriptors.push({
        sessionId,
        wsKey,
        title: optionalString(item.title),
        status: optionalString(item.status),
      })
    }
    this.localDescriptors = descriptors
    for (const descriptor of descriptors) this.knownKeys.add(descriptor.wsKey)
    return descriptors
  }

  /** Merged journal session rows for one workspace: id -> { title, status } (last-wins). */
  sessionRowsFor(wsKey) {
    const journal = this.journals.get(wsKey)
    if (!journal || typeof journal.records !== 'function') return new Map()
    let records
    try {
      records = journal.records()
    } catch {
      return new Map()
    }
    const latest = new Map()
    for (const record of records) {
      if (!isPlainObject(record) || record.type !== 'session' || record.ws !== wsKey) continue
      const id = optionalString(record.id)
      if (id === undefined) continue
      const previous = latest.get(id)
      if (previous === undefined || String(record.seq ?? '') > String(previous.seq ?? '')) {
        latest.set(id, { title: optionalString(record.title) ?? '', status: optionalString(record.status) ?? 'idle' })
      }
    }
    return latest
  }

  /** @param {string} wsKey */
  async openJournal(wsKey) {
    if (this.journals.has(wsKey)) return this.journals.get(wsKey)
    if (this.journalPromises.has(wsKey)) return this.journalPromises.get(wsKey)
    const meta =
      typeof this.deps.workspaceMeta === 'function'
        ? this.deps.workspaceMeta(wsKey) ?? { key: wsKey }
        : { key: wsKey }
    const promise = Promise.resolve()
      .then(() => this.store.openWorkspace(wsKey, meta))
      .then((journal) => {
        if (journal && typeof journal === 'object') this.journals.set(wsKey, journal)
        return journal ?? null
      })
      .catch((error) => {
        this.warn({ event: 'presence.open_workspace_failed', wsKey, error: String(error) })
        return null
      })
      .finally(() => {
        this.journalPromises.delete(wsKey)
      })
    this.journalPromises.set(wsKey, promise)
    return promise
  }

  /** Remove this writer's heartbeat file best-effort (file empty or dispose). */
  async removeHeartbeat(journal, wsKey) {
    try {
      if (typeof journal.deletePresence === 'function') {
        await journal.deletePresence(this.writerId)
        return
      }
      const dir = typeof journal.dir === 'string' ? journal.dir : undefined
      if (dir === undefined) return
      const file = path.join(dir, 'presence', `${this.writerId}.json`)
      await this.fs.unlink(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.warn({ event: 'presence.delete_failed', wsKey, error: String(error) })
      }
    }
  }

  /** @param {string} sessionId @param {string} wsKey @returns {boolean} */
  isSuppressed(sessionId, wsKey) {
    if (this.isDisabledWorkspace(wsKey)) return true
    const privacy = isPlainObject(this.config.privacy) ? this.config.privacy : {}
    return Array.isArray(privacy.privateSessions) && privacy.privateSessions.includes(sessionId)
  }

  /** @param {string} wsKey @returns {boolean} */
  isDisabledWorkspace(wsKey) {
    const privacy = isPlainObject(this.config.privacy) ? this.config.privacy : {}
    if (!Array.isArray(privacy.disabledWorkspaces)) return false
    return privacy.disabledWorkspaces.some((entry) => typeof entry === 'string' && entry === wsKey)
  }

  /** Stop timers/listeners and remove heartbeat files best-effort. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const timer of [this.pollTimer, this.heartbeatTimer]) {
      if (timer !== null) {
        try {
          this.clearIntervalFn(timer)
        } catch {
          // ignore
        }
      }
    }
    this.pollTimer = null
    this.heartbeatTimer = null
    for (const off of this.disposers.splice(0)) {
      try {
        off()
      } catch {
        // ignore
      }
    }
    for (const wsKey of [...this.writtenKeys]) {
      const journal = this.journals.get(wsKey)
      if (journal !== undefined) await this.removeHeartbeat(journal, wsKey)
      this.writtenKeys.delete(wsKey)
    }
    this.cache.clear()
  }

  /** @param {object} record */
  warn(record) {
    try {
      this.logger?.warn?.(record)
    } catch {
      // Logging is best-effort and never throws.
    }
  }
}

export const presenceConstants = Object.freeze({
  HEARTBEAT_INTERVAL_MS,
  PRESENCE_STALE_MS,
  DEFAULT_POLL_MS,
  MAX_SESSIONS_PER_FILE,
  PLUGIN_NAME,
  PLUGIN_VERSION,
})
