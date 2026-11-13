// Confluence / 汇流 — Host plugin entry (v0.1.0 implementation).
//
// Wires the modules described by the binding design (docs/adr/0001-*.md,
// docs/plan/implementation-interfaces.md) onto the live Cordis context:
//
//   config -> workspace resolver -> journal store -> board
//          -> ledger / presence -> watermark -> pulse
//          -> facade -> six model tools
//          -> read-only panel routes (optional `webServer`)
//
// Runtime constraints (ADR §3/§11): plain ESM + Node builtins only; no static
// `@deepseek-ai/*` imports; no network calls; no additional listening port; no
// child processes; no model calls. Shared content is untrusted data: it is
// bounded, escaped and redacted before it reaches a model.
//
// Activation is asynchronous (store/projection attachment is I/O): `apply()`
// starts the bootstrap and returns; registrations that arrive late are normal
// (the host re-reads tool/prompt contributions on the next step). A bootstrap
// failure is logged and degrades to "plugin inactive", never a thrown plugin.

import fsSync from 'node:fs'
import fsPromises from 'node:fs/promises'

import { ConfluenceError, createLogger, isoNow, makeWriterId } from './lib/util.js'
import { DEFAULTS, publicConfig, resolveConfig } from './lib/config.js'
import { canonicalizeDir, createWorkspaceResolver } from './lib/workspace.js'
import { createRedactor } from './lib/redact.js'
import { JournalStore } from './lib/store.js'
import { BoardService } from './lib/board.js'
import { SessionLedger } from './lib/ledger.js'
import { Presence } from './lib/presence.js'
import { WatermarkTracker } from './lib/watermark.js'
import { PulseService } from './lib/pulse.js'
import { RecallService } from './lib/recall.js'
import { createTools, registerTools } from './lib/tools.js'
import { registerHostUi } from './lib/hostui.js'
import { ConfluenceFacade } from './lib/facade.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'confluence'

/** Required services: the tool registry is the plugin's primary surface. */
export const inject = ['tools']

/** Complete v1 default configuration (single source of truth: lib/config.js). */
export { DEFAULTS }

/** Plugin version reported by the panel ping route. */
export const VERSION = '0.1.0'

/**
 * Host plugin entry.
 *
 * @param {object} ctx Cordis plugin context
 * @param {object} [rawConfig] Loader row config (defensive object; see lib/config.js)
 * @returns {undefined}
 */
export function apply(ctx, rawConfig) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  /** @type {{disposed: boolean, booted: boolean, services: object | null}} */
  const state = { disposed: false, booted: false, services: null }

  const boot = bootstrap(ctx, rawConfig).then(
    (services) => {
      if (state.disposed) {
        services.dispose()
        return
      }
      state.services = services
      state.booted = true
      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            state.disposed = true
            try {
              services.dispose()
            } catch {
              // Teardown must never throw.
            }
          },
          'confluence:lifecycle',
        )
      }
    },
    (error) => {
      state.disposed = true
      logActivationFailure(ctx, error)
    },
  )

  return boot.then(() => undefined)
}

/**
 * Test/embedding seam: same activation with injected service seams. Not used by
 * the Loader; kept small so hermetic tests can drive the facade without a host.
 *
 * @param {object} ctx Cordis-like context (`get`, `on`, `effect`)
 * @param {object} [rawConfig]
 * @param {object} [deps] extra dependencies merged into the bootstrap
 * @returns {Promise<object>} services handle (has `dispose()`)
 */
export async function applyWithDeps(ctx, rawConfig, deps = {}) {
  const services = await bootstrap(ctx, rawConfig, deps)
  return services
}

/**
 * @param {object} ctx
 * @param {object} [rawConfig]
 * @param {object} [injected]
 * @returns {Promise<object>}
 */
async function bootstrap(ctx, rawConfig, injected = {}) {
  const { config, warnings } = resolveConfig(rawConfig)
  const logger = createLogger(true, createLogSink(config, injected))
  for (const warning of warnings) logger.warn({ event: 'confluence.config.warning', warning })

  const deps = {
    fs: injected.fs ?? fsPromises,
    fsSync: injected.fsSync ?? fsSync,
    now: typeof injected.now === 'function' ? injected.now : () => Date.now(),
    random: typeof injected.random === 'function' ? injected.random : Math.random,
    pid: injected.pid ?? process.pid,
    ...injected.deps,
  }

  const workspaceResolver =
    injected.workspaceResolver ??
    createWorkspaceResolver({
      workingDirectory: safeGet(ctx, 'workingDirectory') ?? null,
      fs: deps.fs,
      platform: process.platform,
    })

  const store = injected.store ?? new JournalStore({ config, logger, deps })
  if (typeof store.init === 'function') await store.init()

  const redactor = injected.redactor ?? createRedactor(config, { logger })
  const board = injected.board ?? new BoardService({ store, config, redactor, logger, deps })

  const getService = (name) => safeGet(ctx, name)
  const ledgerDeps = {
    now: deps.now,
    workspaceResolver,
    canonicalizeDir: (raw) => canonicalizeDir(raw, { fs: deps.fs, platform: process.platform }),
    redactor,
    getService,
  }
  const ledger = injected.ledger ?? new SessionLedger({ store, config, logger, deps: ledgerDeps })
  const presence = injected.presence ?? new Presence({ store, config, logger, deps: { now: deps.now } })
  const watermark = injected.watermark ?? new WatermarkTracker({ config, logger, deps: { now: deps.now } })

  const sessionQuery = getService('sessionQuery') ?? null
  const sessionTitle = getService('sessionTitle') ?? null
  const recall =
    injected.recall ??
    new RecallService({
      config,
      logger,
      deps: {
        sessionQuery,
        redactor,
        now: deps.now,
        canonicalizeDir: (raw) => canonicalizeDir(raw, { fs: deps.fs, platform: process.platform }),
      },
    })

  /** @type {Array<() => void>} */
  const disposers = []
  const disposeOnce = (() => {
    let done = false
    return () => {
      if (done) return
      done = true
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          // Teardown is best-effort.
        }
      }
    }
  })()

  /** @type {ConfluenceFacade} */
  const facade =
    injected.facade ??
    new ConfluenceFacade({
      config,
      logger,
      workspaceResolver,
      store,
      board,
      redactor,
      presence,
      watermark,
      recall,
      sessionQuery,
      sessionTitle,
      onBoardChanged: (wsKey) => {
        try {
          pulse.refresh(wsKey)
        } catch {
          // Best-effort refresh.
        }
      },
    })

  const pulse =
    injected.pulse ??
    new PulseService({
      config,
      logger,
      deps: {
        getWorkspace: (sessionId) => facade.cachedWorkspace(sessionId),
        getView: (wsKey) => {
          try {
            return board.view(wsKey)
          } catch {
            return null
          }
        },
        getPeers: (wsKey) => {
          try {
            return presence.live(wsKey)
          } catch {
            return []
          }
        },
        getCursor: (sessionId) => {
          const session = facade.sessionFor(sessionId)
          return session === null ? null : watermark.get(session)
        },
        now: deps.now,
      },
    })

  // ── host events: session tracking + workspace warming ───────────────────
  const onAgentCreated = (payload) => {
    try {
      const agent = payload && payload.agent
      const session = agent && agent.session
      if (session) facade.trackSession(session)
      if (agent) {
        void facade
          .ensureWorkspace(agent)
          .then((ws) => {
            pulse.refresh(ws.key)
          })
          .catch(() => {})
      }
    } catch {
      // Event handlers must never throw into the host.
    }
  }
  const onSessionEvent = (session, event) => {
    try {
      if (session) facade.trackSession(session)
      if (event && event.type === 'turn/end' && session) {
        const sessionId = session.id
        const ws = sessionId === undefined ? null : facade.cachedWorkspace(sessionId)
        if (ws !== null) pulse.refresh(ws.key)
      }
    } catch {
      // Event handlers must never throw into the host.
    }
  }
  const onSessionDisposed = (payload) => {
    try {
      const sessionId = payload && (payload.sessionId ?? (payload.session && payload.session.id))
      if (typeof sessionId === 'string') facade.sessions.delete(sessionId)
    } catch {
      // Event handlers must never throw into the host.
    }
  }

  const offAgentCreated = ctx.on('agent/created', onAgentCreated)
  if (typeof offAgentCreated === 'function') disposers.push(offAgentCreated)
  const offSessionEvent = ctx.on('session/event', onSessionEvent)
  if (typeof offSessionEvent === 'function') disposers.push(offSessionEvent)
  try {
    const offDisposed = ctx.on('session/disposed', onSessionDisposed)
    if (typeof offDisposed === 'function') disposers.push(offDisposed)
  } catch {
    // Optional event.
  }

  // ── component attachment ────────────────────────────────────────────────
  try {
    await watermark.attach(ctx)
  } catch (error) {
    logger.warn({ event: 'confluence.watermark.attach-failed', message: String(error) })
  }
  try {
    const offLedger = ledger.attach(ctx)
    if (typeof offLedger === 'function') disposers.push(offLedger)
  } catch (error) {
    logger.warn({ event: 'confluence.ledger.attach-failed', message: String(error) })
  }

  const listLiveSessions = () => {
    const agents = safeGet(ctx, 'agents')
    const rows = []
    if (!agents || typeof agents.list !== 'function') return rows
    try {
      for (const agent of agents.list() || []) {
        const session = agent && agent.session
        const sessionId = session && session.id
        if (typeof sessionId !== 'string' || sessionId === '') continue
        const ws = facade.cachedWorkspace(sessionId)
        rows.push({
          id: sessionId,
          sessionId,
          title: typeof agent.title === 'string' ? agent.title : '',
          wsKey: ws === null ? undefined : ws.key,
          status: typeof agent.status === 'string' ? agent.status : 'idle',
        })
      }
    } catch {
      // Presence degrades to "no peers".
    }
    return rows
  }
  try {
    const offPresence = presence.attach(ctx, listLiveSessions)
    if (typeof offPresence === 'function') disposers.push(offPresence)
  } catch (error) {
    logger.warn({ event: 'confluence.presence.attach-failed', message: String(error) })
  }
  try {
    pulse.attach(ctx)
  } catch (error) {
    logger.warn({ event: 'confluence.pulse.attach-failed', message: String(error) })
  }

  // ── model-facing tools ──────────────────────────────────────────────────
  let unregisterTools = null
  try {
    const definitions = createTools(facade, config)
    unregisterTools = registerTools(ctx, definitions)
    if (typeof unregisterTools === 'function') disposers.push(unregisterTools)
    logger.info({ event: 'confluence.tools.registered', count: definitions.length })
  } catch (error) {
    logger.warn({ event: 'confluence.tools.register-failed', message: String(error) })
  }

  // ── read-only panel routes (optional web server) ────────────────────────
  let unregisterUi = null
  try {
    unregisterUi = registerHostUi(ctx, { facade, workspaceResolver, config, logger })
    if (typeof unregisterUi === 'function') disposers.push(unregisterUi)
  } catch (error) {
    logger.warn({ event: 'confluence.ui.register-failed', message: String(error) })
  }

  // ── warm currently live agents, then keep mirrors fresh ─────────────────
  for (const agent of listAgents(ctx)) onAgentCreated({ agent })
  for (const wsKey of facade.workspaceKeys()) pulse.refresh(wsKey)

  const pollMs = Math.max(4000, Math.min(10000, Math.trunc(Number(config.store && config.store.pollMs) || 4000)))
  const timer = setInterval(() => {
    void (async () => {
      for (const wsKey of facade.workspaceKeys()) {
        try {
          await board.refresh(wsKey)
          pulse.refresh(wsKey)
        } catch {
          // Cross-window refresh is best-effort; the prompt stays byte-stable.
        }
      }
      try {
        if (presence && typeof presence.refreshPresence === 'function') await presence.refreshPresence()
      } catch {
        // Presence polling is best-effort.
      }
    })()
  }, pollMs)
  if (timer && typeof timer.unref === 'function') timer.unref()
  disposers.push(() => clearInterval(timer))

  // ── ordered teardown ────────────────────────────────────────────────────
  disposers.push(() => {
    try {
      pulse.dispose()
    } catch {
      /* best-effort */
    }
  })
  disposers.push(() => {
    try {
      presence.dispose()
    } catch {
      /* best-effort */
    }
  })
  disposers.push(() => {
    try {
      ledger.dispose()
    } catch {
      /* best-effort */
    }
  })
  disposers.push(() => {
    void (async () => {
      try {
        await watermark.dispose()
      } catch {
        /* best-effort */
      }
      try {
        if (typeof store.close === 'function') await store.close()
      } catch {
        /* best-effort */
      }
    })()
  })

  return {
    version: VERSION,
    config,
    publicConfig: publicConfig(config),
    warnings,
    logger,
    services: { store, board, ledger, presence, watermark, pulse, recall, facade, workspaceResolver },
    dispose: disposeOnce,
    /**
     * Awaitable teardown for tests and embedders: same as `dispose()` plus the
     * asynchronous store/projection close. Idempotent; never throws.
     * @returns {Promise<void>}
     */
    async disposeAsync() {
      disposeOnce()
      try {
        await watermark.dispose()
      } catch {
        /* best-effort */
      }
      try {
        if (typeof store.close === 'function') await store.close()
      } catch {
        /* best-effort */
      }
    },
  }
}

// ── small host helpers ────────────────────────────────────────────────────

/** @param {object} ctx @param {string} name @returns {any} */
function safeGet(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    return undefined
  }
  return undefined
}

/** @param {object} ctx @returns {object[]} */
function listAgents(ctx) {
  const agents = safeGet(ctx, 'agents')
  if (!agents || typeof agents.list !== 'function') return []
  try {
    return [...(agents.list() || [])]
  } catch {
    return []
  }
}

/** @param {object} config @param {object} injected @returns {object} logger sink */
function createLogSink(config, injected) {
  const debug = config && config.debug && typeof config.debug === 'object' ? config.debug : {}
  const logFile = typeof debug.logFile === 'string' && debug.logFile !== '' ? debug.logFile : ''
  const write = (level) => (record) => {
    const line = JSON.stringify({ time: isoNow(Date.now()), level, plugin: 'confluence', ...record })
    if (logFile !== '') {
      try {
        fsPromises.appendFile(logFile, `${line}\n`, 'utf8').catch(() => {})
        return
      } catch {
        // Fall through to stderr.
      }
    }
    if (level === 'warn' || level === 'error') {
      try {
        process.stderr.write(`[confluence] ${line}\n`)
      } catch {
        // Never throw from logging.
      }
    }
  }
  if (injected && injected.logSink) return injected.logSink
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

/** @param {object} ctx @param {unknown} error */
function logActivationFailure(ctx, error) {
  try {
    const message = error instanceof Error ? error.message : String(error)
    const record = { event: 'confluence.activation-failed', message, code: error && error.code ? error.code : undefined }
    if (ctx && typeof ctx.logger === 'object' && ctx.logger && typeof ctx.logger.error === 'function') {
      ctx.logger.error(record)
      return
    }
    process.stderr.write(`[confluence] ${JSON.stringify(record)}\n`)
  } catch {
    // Never throw from the failure path.
  }
}

// Re-export the error class for embedding/tests (no side effects).
export { ConfluenceError, makeWriterId }
