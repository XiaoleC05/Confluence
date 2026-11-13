// Confluence / 汇流 — configuration contract (v1).
//
// The Loader row config is untrusted JSON: every field is defaulted here, bad
// values fall back with a stable warning line, and resolveConfig never throws.
// Contract: docs/design/config.md and docs/plan/implementation-interfaces.md §2.
//
// Warning format: "<CODE> <field>[#<index>]", sorted by (CODE, field, index),
// capped at 20 (config.md §3). DEFAULTS must deep-equal the bundle row config
// in cordis.patch.yml (packaging contract test asserts it).

const RAW_DEFAULTS = {
  enabled: true,
  store: {
    dir: '',
    retentionDays: 90,
    maxEntriesPerWorkspace: 2000,
    maxBodyBytes: 8192,
    pollMs: 4000,
    watch: true,
  },
  pulse: { enabled: true, maxHeadlines: 3, maxPeers: 2, maxChars: 1400 },
  ledger: {
    enabled: true,
    maxFilesPerSession: 8,
    maxSessionsPerWorkspace: 200,
    fileHintsInPulse: false,
  },
  recall: { enabled: true, maxSessions: 3, maxHits: 5, timeoutMs: 5000 },
  privacy: {
    redact: true,
    redactTitles: true,
    denyPathPatterns: ['**/.env*', '**/*.pem'],
    privateSessions: [],
    disabledWorkspaces: [],
    redactPatterns: [],
  },
  ui: { enabled: true, pollMs: 5000 },
  export: { enabled: false, dir: '.confluence/export' },
  debug: { logFile: '' },
}

/** @param {unknown} value */
function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    return Object.freeze(value)
  }
  return value
}

/** Complete v1 defaults (frozen, shared). */
export const DEFAULTS = deepFreeze(RAW_DEFAULTS)

const MAX_WARNINGS = 20
const TOP_LEVEL_KEYS = ['enabled', 'store', 'pulse', 'ledger', 'recall', 'privacy', 'ui', 'export', 'debug']
const SECTIONS = ['store', 'pulse', 'ledger', 'recall', 'ui', 'export', 'debug']

const INT_RANGES = {
  store: {
    retentionDays: [7, 3650],
    maxEntriesPerWorkspace: [50, 20000],
    maxBodyBytes: [256, 49152],
    pollMs: [1000, 60000],
  },
  pulse: { maxHeadlines: [0, 5], maxPeers: [0, 3], maxChars: [400, 1400] },
  ledger: { maxFilesPerSession: [0, 16], maxSessionsPerWorkspace: [20, 1000] },
  recall: { maxSessions: [1, 10], maxHits: [1, 20], timeoutMs: [500, 30000] },
  ui: { pollMs: [2000, 30000] },
}

// config.md: ui.pollMs is clamped (not reset) when out of range.
const CLAMP_FIELDS = new Set(['ui.pollMs'])
const STRING_LIMITS = { 'store.dir': 512, 'export.dir': 256, 'debug.logFile': 512 }
const PRIVACY_KEYS = [
  'redact',
  'redactTitles',
  'denyPathPatterns',
  'privateSessions',
  'disabledWorkspaces',
  'redactPatterns',
]

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value */
function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = clonePlain(item)
    return out
  }
  return value
}

/** @param {unknown} value @returns {boolean} windows device path (\\.\ or \\?\) */
function isDevicePath(value) {
  return typeof value === 'string' && /^\\\\[.?]\\/.test(value)
}

/** @param {unknown} value @returns {boolean} windows UNC path (\\server\share) */
function isUncPath(value) {
  return typeof value === 'string' && /^\\\\[^\\]/.test(value)
}

/** @param {unknown} value @returns {boolean} rooted path on either platform */
function isRootedPath(value) {
  return (
    typeof value === 'string' &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || isUncPath(value) || isDevicePath(value))
  )
}

/** @param {string} pattern @returns {boolean} simple `*`/`**` glob only */
function isGlobPattern(pattern) {
  return (
    typeof pattern === 'string' &&
    pattern.length > 0 &&
    pattern.length <= 200 &&
    /^[A-Za-z0-9._\-/\\*]+$/.test(pattern)
  )
}

/** @param {unknown} value @returns {boolean} valid regex source */
function isRegexSource(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false
  try {
    // eslint-disable-next-line no-new
    new RegExp(value, 'giu')
    return true
  } catch {
    return false
  }
}

/** @param {string} field @param {unknown} value @returns {boolean} */
function isValidPrivateSessionId(field) {
  return typeof field === 'string' && /^[A-Za-z0-9._-]{4,128}$/.test(field)
}

/** @param {unknown} value @returns {boolean} */
function isValidDisabledWorkspace(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
  if (/^ws_[0-9a-f]{16}$/.test(value)) return true
  return isRootedPath(value)
}

/**
 * Resolve the Loader row config against the v1 defaults.
 *
 * @param {unknown} raw untrusted row config (possibly absent)
 * @returns {{ config: object, warnings: string[] }}
 */
export function resolveConfig(raw) {
  /** @type {{code: string, field: string, index: number | null}[]} */
  const collected = []
  const add = (code, field, index = null) => {
    collected.push({ code: String(code), field: String(field), index })
  }

  try {
    if (raw !== undefined && raw !== null && !isPlainObject(raw)) add('CONFIG_INVALID_VALUE', 'config')
    const source = isPlainObject(raw) ? raw : {}

    for (const key of Object.keys(source)) {
      if (!TOP_LEVEL_KEYS.includes(key)) add('CONFIG_UNKNOWN_FIELD', key)
    }

    const config = {
      enabled: true,
      store: {},
      pulse: {},
      ledger: {},
      recall: {},
      privacy: {},
      ui: {},
      export: {},
      debug: {},
    }

    config.enabled = readBool(source, 'enabled', DEFAULTS.enabled, 'enabled', add)

    for (const section of SECTIONS) {
      const defaults = DEFAULTS[section]
      const rawSection = source[section]
      let sectionRaw = {}
      if (rawSection !== undefined) {
        if (isPlainObject(rawSection)) sectionRaw = rawSection
        else add('CONFIG_INVALID_VALUE', section)
      }
      for (const key of Object.keys(sectionRaw)) {
        if (!(key in defaults)) add('CONFIG_UNKNOWN_FIELD', `${section}.${key}`)
      }
      for (const [key, fallback] of Object.entries(defaults)) {
        const field = `${section}.${key}`
        if (typeof fallback === 'boolean') {
          config[section][key] = readBool(sectionRaw, key, fallback, field, add)
        } else if (typeof fallback === 'number') {
          config[section][key] = readInt(sectionRaw, key, fallback, field, INT_RANGES[section]?.[key], add, {
            clamp: CLAMP_FIELDS.has(field),
          })
        } else if (typeof fallback === 'string') {
          config[section][key] = readString(sectionRaw, key, fallback, field, add, STRING_LIMITS[field])
        }
      }
    }

    // Semantic path checks (syntactic only; the store resolves/validates roots).
    if (isDevicePath(config.store.dir) || isUncPath(config.store.dir)) {
      add('CONFIG_PATH_INVALID', 'store.dir')
      config.store.dir = DEFAULTS.store.dir
    }
    if (config.export.dir !== '' && (isRootedPath(config.export.dir) || config.export.dir.split(/[\\/]+/).includes('..'))) {
      add('CONFIG_PATH_INVALID', 'export.dir')
      config.export.dir = DEFAULTS.export.dir
    }
    if (config.debug.logFile !== '' && !isRootedPath(config.debug.logFile)) {
      add('CONFIG_PATH_INVALID', 'debug.logFile')
      config.debug.logFile = DEFAULTS.debug.logFile
    }

    if (config.pulse.maxHeadlines > 3) add('PULSE_BUDGET_RISK', 'pulse.maxHeadlines')

    // Privacy: booleans, then validated arrays.
    const privacy = config.privacy
    const privacyRaw = isPlainObject(source.privacy) ? source.privacy : {}
    if (source.privacy !== undefined && !isPlainObject(source.privacy)) {
      add('CONFIG_INVALID_VALUE', 'privacy')
    }
    for (const key of Object.keys(privacyRaw)) {
      if (!PRIVACY_KEYS.includes(key)) add('CONFIG_UNKNOWN_FIELD', `privacy.${key}`)
    }
    privacy.redact = readBool(privacyRaw, 'redact', DEFAULTS.privacy.redact, 'privacy.redact', add)
    privacy.redactTitles = readBool(
      privacyRaw,
      'redactTitles',
      DEFAULTS.privacy.redactTitles,
      'privacy.redactTitles',
      add,
    )
    if (typeof privacyRaw.redactTitles === 'boolean' && privacyRaw.redactTitles === false) {
      add('PRIVACY_TITLES_UNREDACTED', 'privacy.redactTitles')
    }

    privacy.denyPathPatterns = readArray(
      privacyRaw.denyPathPatterns,
      DEFAULTS.privacy.denyPathPatterns,
      'privacy.denyPathPatterns',
      { maxItems: 32, isValid: isGlobPattern, invalidCode: 'CONFIG_PATTERN_INVALID' },
      add,
    )
    privacy.privateSessions = readArray(
      privacyRaw.privateSessions,
      DEFAULTS.privacy.privateSessions,
      'privacy.privateSessions',
      { maxItems: 256, isValid: isValidPrivateSessionId, invalidCode: 'CONFIG_INVALID_VALUE' },
      add,
    )
    privacy.disabledWorkspaces = readArray(
      privacyRaw.disabledWorkspaces,
      DEFAULTS.privacy.disabledWorkspaces,
      'privacy.disabledWorkspaces',
      { maxItems: 64, isValid: isValidDisabledWorkspace, invalidCode: 'CONFIG_INVALID_VALUE' },
      add,
    )
    privacy.redactPatterns = readArray(
      privacyRaw.redactPatterns,
      DEFAULTS.privacy.redactPatterns,
      'privacy.redactPatterns',
      { maxItems: 20, isValid: isRegexSource, invalidCode: 'CONFIG_PATTERN_INVALID' },
      add,
    )

    return { config, warnings: formatWarnings(collected) }
  } catch {
    // Absolute safety net: this function must never throw on a bad config.
    add('CONFIG_INVALID_VALUE', 'config')
    return { config: clonePlain(DEFAULTS), warnings: formatWarnings(collected) }
  }
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {boolean} fallback
 * @param {string} field
 * @param {(code: string, field: string, index?: number | null) => void} add
 * @returns {boolean}
 */
function readBool(source, key, fallback, field, add) {
  if (!(key in source)) return fallback
  const value = source[key]
  if (typeof value === 'boolean') return value
  add('CONFIG_INVALID_VALUE', field)
  return fallback
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {number} fallback
 * @param {string} field
 * @param {[number, number] | undefined} range
 * @param {(code: string, field: string, index?: number | null) => void} add
 * @param {{ clamp?: boolean }} [options]
 * @returns {number}
 */
function readInt(source, key, fallback, field, range, add, options = {}) {
  if (!(key in source)) return fallback
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    add('CONFIG_INVALID_VALUE', field)
    return fallback
  }
  if (!range) return value
  const [min, max] = range
  if (value < min || value > max) {
    if (options.clamp) {
      add('CONFIG_INVALID_VALUE', field)
      return Math.min(max, Math.max(min, value))
    }
    add('CONFIG_INVALID_VALUE', field)
    return fallback
  }
  return value
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {string} fallback
 * @param {string} field
 * @param {(code: string, field: string, index?: number | null) => void} add
 * @param {number | undefined} maxChars
 * @returns {string}
 */
function readString(source, key, fallback, field, add, maxChars) {
  if (!(key in source)) return fallback
  const value = source[key]
  if (typeof value !== 'string' || (maxChars !== undefined && value.length > maxChars)) {
    add('CONFIG_INVALID_VALUE', field)
    return fallback
  }
  return value
}

/**
 * @param {unknown} value
 * @param {readonly string[]} fallback
 * @param {string} field
 * @param {{maxItems: number, isValid: (item: unknown) => boolean, invalidCode: string}} options
 * @param {(code: string, field: string, index?: number | null) => void} add
 * @returns {string[]}
 */
function readArray(value, fallback, field, options, add) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) {
    add('CONFIG_INVALID_VALUE', field)
    return [...fallback]
  }
  const out = []
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i]
    if (out.length >= options.maxItems) {
      add('CONFIG_INVALID_VALUE', field)
      break
    }
    if (!options.isValid(item)) {
      add(options.invalidCode, field, i)
      continue
    }
    out.push(item)
  }
  return out
}

/**
 * Sort/dedupe/cap warning records and render stable `"CODE field[#index]"` lines.
 *
 * @param {{code: string, field: string, index: number | null}[]} collected
 * @returns {string[]}
 */
function formatWarnings(collected) {
  const unique = new Map()
  for (const item of collected) {
    const line = item.index === null || item.index === undefined ? `${item.code} ${item.field}` : `${item.code} ${item.field}#${item.index}`
    unique.set(line, item)
  }
  const list = [...unique.values()]
  list.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    if (a.field !== b.field) return a.field < b.field ? -1 : 1
    const ai = a.index ?? -1
    const bi = b.index ?? -1
    return ai - bi
  })
  return list.slice(0, MAX_WARNINGS).map((item) =>
    item.index === null || item.index === undefined ? `${item.code} ${item.field}` : `${item.code} ${item.field}#${item.index}`,
  )
}

/**
 * Sanitized view of a resolved config for UI/status output: pattern lists,
 * private session ids and disabled workspace paths are reduced to counts so a
 * panel/ping payload can never leak them.
 *
 * @param {object} config resolved config (from resolveConfig)
 * @returns {object}
 */
export function publicConfig(config) {
  const value = isPlainObject(config) ? config : DEFAULTS
  const privacy = isPlainObject(value.privacy) ? value.privacy : DEFAULTS.privacy
  const exportSection = isPlainObject(value.export) ? value.export : DEFAULTS.export
  const debugSection = isPlainObject(value.debug) ? value.debug : DEFAULTS.debug
  const count = (list) => (Array.isArray(list) ? list.length : 0)
  return {
    enabled: value.enabled !== false,
    store: {
      dir: typeof value.store?.dir === 'string' ? value.store.dir : '',
      retentionDays: value.store?.retentionDays ?? DEFAULTS.store.retentionDays,
      maxEntriesPerWorkspace: value.store?.maxEntriesPerWorkspace ?? DEFAULTS.store.maxEntriesPerWorkspace,
      maxBodyBytes: value.store?.maxBodyBytes ?? DEFAULTS.store.maxBodyBytes,
      pollMs: value.store?.pollMs ?? DEFAULTS.store.pollMs,
      watch: value.store?.watch !== false,
    },
    pulse: {
      enabled: value.pulse?.enabled !== false,
      maxHeadlines: value.pulse?.maxHeadlines ?? DEFAULTS.pulse.maxHeadlines,
      maxPeers: value.pulse?.maxPeers ?? DEFAULTS.pulse.maxPeers,
      maxChars: value.pulse?.maxChars ?? DEFAULTS.pulse.maxChars,
    },
    ledger: {
      enabled: value.ledger?.enabled !== false,
      maxFilesPerSession: value.ledger?.maxFilesPerSession ?? DEFAULTS.ledger.maxFilesPerSession,
      maxSessionsPerWorkspace: value.ledger?.maxSessionsPerWorkspace ?? DEFAULTS.ledger.maxSessionsPerWorkspace,
      fileHintsInPulse: value.ledger?.fileHintsInPulse === true,
    },
    recall: {
      enabled: value.recall?.enabled !== false,
      maxSessions: value.recall?.maxSessions ?? DEFAULTS.recall.maxSessions,
      maxHits: value.recall?.maxHits ?? DEFAULTS.recall.maxHits,
      timeoutMs: value.recall?.timeoutMs ?? DEFAULTS.recall.timeoutMs,
    },
    privacy: {
      redact: privacy.redact !== false,
      redactTitles: privacy.redactTitles !== false,
      denyPathPatternsCount: count(privacy.denyPathPatterns),
      privateSessionsCount: count(privacy.privateSessions),
      disabledWorkspacesCount: count(privacy.disabledWorkspaces),
      redactPatternsCount: count(privacy.redactPatterns),
    },
    ui: {
      enabled: value.ui?.enabled !== false,
      pollMs: value.ui?.pollMs ?? DEFAULTS.ui.pollMs,
    },
    export: {
      enabled: exportSection.enabled === true,
      dir: typeof exportSection.dir === 'string' ? exportSection.dir : DEFAULTS.export.dir,
    },
    debug: { logFileEnabled: typeof debugSection.logFile === 'string' && debugSection.logFile !== '' },
  }
}
