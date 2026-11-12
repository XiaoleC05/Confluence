// Confluence / 汇流 — Host plugin entry (design-stage scaffold).
//
// This is the bundle's only runtime module in the design stage. It exists so
// the packaging contract (package.json -> dsh.bundle.patch -> this row) can be
// installed and inspected without pretending to work: `apply()` defensively
// resolves the configuration and logs exactly one activation warning. It
// registers no tools, no prompt context, no routes, no UI, no listeners, and
// returns nothing.
//
// Read before implementing (binding design):
//   docs/adr/0001-confluence-architecture.md   v1 architecture and config (§10)
//   docs/design/architecture.md                component boundaries (M1+)
//   docs/design/store-format.md                journal/store contract
//   docs/design/pulse.md                       passive digest contract
//   docs/design/tool-api.md                    six model-facing tools
//   docs/design/config.md                      configuration contract
//   docs/design/testing.md                     acceptance criteria and tests
//   docs/plan/execution-plan.md                milestones M0 -> M4
//
// M1 adds, behind `apply`: JournalStore, WorkspaceResolver, BoardService,
// PulseProvider (one systemPrompt.context registration), the Watermark
// projection and the six tools. Partial stubs are intentionally NOT shipped:
// an honest empty scaffold is safer than a fake implementation that looks real
// to a model or a user.
//
// Standing constraints (design §3, §11): plain ESM + Node builtins only; no
// static @deepseek-ai/* imports; no network calls; no additional listening
// port; no child processes; no model calls; all shared content is untrusted
// data and must be bounded, escaped and redacted.

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'confluence'

/**
 * Complete v1 default configuration.
 *
 * Mirrors docs/adr/0001-confluence-architecture.md §10 and the bundle's own
 * cordis.patch.yml default config. Frozen so that a later component cannot
 * mutate shared defaults by accident.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  store: Object.freeze({
    dir: '',
    retentionDays: 90,
    maxEntriesPerWorkspace: 2000,
    maxBodyBytes: 8192,
    pollMs: 4000,
    watch: true,
  }),
  pulse: Object.freeze({ enabled: true, maxHeadlines: 3, maxPeers: 2, maxChars: 1400 }),
  ledger: Object.freeze({
    enabled: true,
    maxFilesPerSession: 8,
    maxSessionsPerWorkspace: 200,
    fileHintsInPulse: false,
  }),
  recall: Object.freeze({ enabled: true, maxSessions: 3, maxHits: 5, timeoutMs: 5000 }),
  privacy: Object.freeze({
    redact: true,
    redactTitles: true,
    denyPathPatterns: Object.freeze(['**/.env*', '**/*.pem']),
    privateSessions: Object.freeze([]),
    disabledWorkspaces: Object.freeze([]),
  }),
  ui: Object.freeze({ enabled: true, pollMs: 5000 }),
  export: Object.freeze({ enabled: false, dir: '.confluence/export' }),
  debug: Object.freeze({ logFile: '' }),
})

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Copy a known scalar config field, or fall back to the default and record one
 * warning. Kept deliberately boring: every field is defaulted, and a bad value
 * degrades instead of throwing (ADR §10).
 *
 * @param {Record<string, unknown>} out
 * @param {Record<string, unknown>} raw
 * @param {string} section
 * @param {string} key
 * @param {boolean|number|string} fallback
 * @param {string[]} warnings
 */
function takeScalar(out, raw, section, key, fallback, warnings) {
  const source = isPlainObject(raw) ? raw : {}
  if (!(key in source)) {
    out[key] = fallback
    return
  }
  const value = source[key]
  const valid =
    typeof fallback === 'boolean'
      ? typeof value === 'boolean'
      : typeof fallback === 'number'
        ? typeof value === 'number' && Number.isFinite(value) && value >= 0
        : typeof value === 'string'
  if (valid) out[key] = value
  else {
    out[key] = fallback
    warnings.push(`${section}.${key} ignored (invalid value); using default`)
  }
}

/**
 * Copy a string-array config field, dropping non-string entries and falling
 * back to the default array when the value is not an array.
 *
 * @param {unknown} value
 * @param {readonly string[]} fallback
 * @returns {string[]}
 */
function takeStringArray(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  return value.filter((item) => typeof item === 'string')
}

/**
 * Resolve the Loader row config against the v1 defaults.
 *
 * @param {unknown} raw loader row config (untrusted, possibly absent)
 * @returns {{ config: Record<string, unknown>, warnings: string[] }}
 */
export function resolveConfig(raw) {
  const warnings = []
  const source = isPlainObject(raw) ? raw : {}
  const sections = {
    store: DEFAULTS.store,
    pulse: DEFAULTS.pulse,
    ledger: DEFAULTS.ledger,
    recall: DEFAULTS.recall,
    ui: DEFAULTS.ui,
    export: DEFAULTS.export,
    debug: DEFAULTS.debug,
  }

  const config = { enabled: DEFAULTS.enabled }
  const enabledRaw = source.enabled
  config.enabled = typeof enabledRaw === 'boolean' ? enabledRaw : DEFAULTS.enabled
  if ('enabled' in source && typeof enabledRaw !== 'boolean') {
    warnings.push('enabled ignored (invalid value); using default')
  }

  for (const [section, defaults] of Object.entries(sections)) {
    const sectionOut = {}
    const sectionRaw = source[section]
    if (sectionRaw !== undefined && !isPlainObject(sectionRaw)) {
      warnings.push(`${section} ignored (invalid section); using defaults`)
    }
    for (const [key, fallback] of Object.entries(defaults)) {
      takeScalar(sectionOut, isPlainObject(sectionRaw) ? sectionRaw : {}, section, key, fallback, warnings)
    }
    config[section] = sectionOut
  }

  const privacyRaw = isPlainObject(source.privacy) ? source.privacy : {}
  if (source.privacy !== undefined && !isPlainObject(source.privacy)) {
    warnings.push('privacy ignored (invalid section); using defaults')
  }
  const privacy = {}
  takeScalar(privacy, privacyRaw, 'privacy', 'redact', DEFAULTS.privacy.redact, warnings)
  takeScalar(privacy, privacyRaw, 'privacy', 'redactTitles', DEFAULTS.privacy.redactTitles, warnings)
  privacy.denyPathPatterns = takeStringArray(
    privacyRaw.denyPathPatterns,
    DEFAULTS.privacy.denyPathPatterns,
  )
  privacy.privateSessions = takeStringArray(privacyRaw.privateSessions, DEFAULTS.privacy.privateSessions)
  privacy.disabledWorkspaces = takeStringArray(
    privacyRaw.disabledWorkspaces,
    DEFAULTS.privacy.disabledWorkspaces,
  )
  config.privacy = privacy

  return { config, warnings }
}

/** Where the store will live once M1 implements it (reported in the warning). */
function storeLocationLabel(config) {
  if (typeof config.store.dir === 'string' && config.store.dir !== '') return config.store.dir
  return '$DSH_HOME/storages/confluence/v1 (default)'
}

/**
 * Host plugin entry point.
 *
 * Design stage: validate config, log once, register nothing, return nothing.
 * Every future registration belongs inside `apply` and must be owned by
 * `ctx.effect`/`ctx.on` so plugin unload removes it (Cordis lifecycle).
 *
 * @param {object} ctx Cordis plugin context (only `logger` is used here)
 * @param {unknown} config Loader row config from cordis.patch.yml
 * @returns {void}
 */
export function apply(ctx, config) {
  const { config: resolved, warnings } = resolveConfig(config)
  const stage = resolved.enabled ? 'no capabilities implemented' : 'disabled via config'
  const details = [
    `store: ${storeLocationLabel(resolved)}`,
    `pulse: ${resolved.pulse.enabled ? 'planned' : 'off'}`,
    `ledger: ${resolved.ledger.enabled ? 'planned' : 'off'}`,
    `recall: ${resolved.recall.enabled ? 'planned' : 'off'}`,
    `ui: ${resolved.ui.enabled ? 'planned (M3)' : 'off'}`,
  ]
  const configWarnings =
    warnings.length === 0 ? '' : ` config warnings: ${warnings.join('; ')}.`
  const message =
    `[confluence] design-stage scaffold, ${stage}: Confluence / 汇流 stores nothing, ` +
    `injects no pulse, and registers no tools or UI. Installation has no user-visible effect. ` +
    `Implementation starts at milestone M1 (docs/plan/execution-plan.md). ` +
    `Resolved: ${details.join('; ')}.${configWarnings}`

  try {
    ctx?.logger?.warn?.(message)
  } catch {
    // Diagnostics are best-effort; a broken logger must not break activation.
  }
  // Design stage ends here. M1 will continue with:
  //   store/journal -> workspace resolver -> board -> pulse -> tools.
  return undefined
}
