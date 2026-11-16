// WP1 unit tests — lib/config.js
// Covers implementation-interfaces.md §2, config.md §2–§3 and UT-CONFIG-01..03:
// DEFAULTS == shipped cordis.patch.yml row config, deterministic warnings,
// never-throwing resolution, sanitized public view.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, publicConfig, resolveConfig } from '../lib/config.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PATCH_PATH = path.join(ROOT, 'cordis.patch.yml')

// ---------------------------------------------------------------------------
// Minimal YAML-subset reader for the one bundle patch file (test-local only;
// the plugin itself carries no YAML dependency).
// ---------------------------------------------------------------------------

/** @param {string} line */
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/** @param {string} raw */
function parseScalar(raw) {
  if (raw === '' || raw === '~' || raw === 'null') return null
  if (raw === '[]') return []
  if (raw === '{}') return {}
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1)
  }
  return raw
}

/** @param {{indent: number, text: string}[]} lines @param {number} index @param {number} indent */
function parseMapping(lines, index, indent) {
  const value = {}
  let i = index
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent) {
      i += 1
      continue
    }
    if (line.text.startsWith('- ')) break
    const colon = line.text.indexOf(':')
    if (colon < 0) {
      i += 1
      continue
    }
    const key = line.text.slice(0, colon).trim()
    const rest = line.text.slice(colon + 1).trim()
    if (rest !== '') {
      value[key] = parseScalar(rest)
      i += 1
      continue
    }
    if (i + 1 < lines.length && lines[i + 1].indent > indent) {
      const child = parseNode(lines, i + 1, lines[i + 1].indent)
      value[key] = child.value
      i = child.next
    } else {
      value[key] = null
      i += 1
    }
  }
  return { value, next: i }
}

/** @param {{indent: number, text: string}[]} lines @param {number} index @param {number} indent */
function parseSequence(lines, index, indent) {
  const value = []
  let i = index
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent !== indent || !line.text.startsWith('- ')) break
    const rest = line.text.slice(2).trim()
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const child = parseNode(lines, i + 1, lines[i + 1].indent)
        value.push(child.value)
        i = child.next
      } else {
        value.push(null)
        i += 1
      }
      continue
    }
    if (/^[^:'"]+:/.test(rest) && !rest.startsWith("'") && !rest.startsWith('"')) {
      const virtual = [{ indent: indent + 2, text: rest }, ...lines.slice(i + 1)]
      const child = parseMapping(virtual, 0, indent + 2)
      value.push(child.value)
      i += child.next
      continue
    }
    value.push(parseScalar(rest))
    i += 1
  }
  return { value, next: i }
}

/** @param {{indent: number, text: string}[]} lines @param {number} index @param {number} indent */
function parseNode(lines, index, indent) {
  return lines[index].text.startsWith('- ') ? parseSequence(lines, index, indent) : parseMapping(lines, index, indent)
}

/** @param {string} source */
function parseYamlSubset(source) {
  const lines = []
  for (const raw of source.split(/\r?\n/)) {
    const stripped = stripComment(raw)
    if (stripped.trim() === '') continue
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim() })
  }
  const root = parseNode(lines, 0, lines[0].indent)
  assert.equal(root.next, lines.length, 'test YAML reader must consume the whole patch file')
  return root.value
}

/** @returns {object} the bundle row config from cordis.patch.yml */
function readPatchRowConfig() {
  const parsed = parseYamlSubset(readFileSync(PATCH_PATH, 'utf8'))
  assert.ok(Array.isArray(parsed) && parsed.length === 1, 'patch has one top-level list')
  const insert = parsed[0].insert
  assert.ok(Array.isArray(insert) && insert.length === 1, 'patch inserts one row')
  assert.equal(insert[0].id, 'confluence')
  return insert[0].config
}

// ---------------------------------------------------------------------------
// UT-CONFIG-01..03
// ---------------------------------------------------------------------------

test('UT-CONFIG-01 DEFAULTS deep-equal the shipped cordis.patch.yml row config and are frozen', () => {
  const patchConfig = readPatchRowConfig()
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULTS)), patchConfig)
  assert.ok(Object.isFrozen(DEFAULTS), 'DEFAULTS must be frozen')
  for (const section of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[section] === 'object' && DEFAULTS[section] !== null) {
      assert.ok(Object.isFrozen(DEFAULTS[section]), `${section} must be frozen`)
    }
  }
  assert.ok(Object.isFrozen(DEFAULTS.privacy.denyPathPatterns))
  assert.ok(Object.isFrozen(DEFAULTS.privacy.redactPatterns))
  assert.deepEqual(DEFAULTS.privacy.redactPatterns, [], 'V3: redactPatterns ships as []')
  assert.equal(DEFAULTS.store.maxEntriesPerWorkspace, 2000)
  assert.equal(DEFAULTS.store.maxBodyBytes, 8192)
})

test('UT-CONFIG-02 bad values fall back with stable sorted warnings and never throw', () => {
  const raw = {
    enabled: 'yes',
    store: {
      retentionDays: 3,
      maxBodyBytes: 'big',
      pollMs: 5,
      watch: 'no',
      dir: 123,
    },
    pulse: { maxHeadlines: 9, maxPeers: -1, maxChars: 2000 },
    ledger: { maxFilesPerSession: 99 },
    recall: { timeoutMs: 10 },
    privacy: { redactTitles: false, denyPathPatterns: ['**/*.pem', 'bad['], redactPatterns: ['(', 'ok.*'] },
    ui: { pollMs: 999999 },
    export: { dir: 'C:\\absolute\\export' },
    debug: { logFile: 'relative.txt' },
  }
  const { config, warnings } = resolveConfig(raw)

  assert.equal(config.enabled, true)
  assert.equal(config.store.retentionDays, 90)
  assert.equal(config.store.maxBodyBytes, 8192)
  assert.equal(config.store.pollMs, 4000)
  assert.equal(config.store.watch, true)
  assert.equal(config.store.dir, '')
  assert.equal(config.pulse.maxHeadlines, 3)
  assert.equal(config.pulse.maxPeers, 2)
  assert.equal(config.pulse.maxChars, 1400)
  assert.equal(config.ledger.maxFilesPerSession, 8)
  assert.equal(config.recall.timeoutMs, 5000)
  assert.equal(config.privacy.redactTitles, false, 'false is accepted (documented tradeoff)')
  assert.deepEqual(config.privacy.denyPathPatterns, ['**/*.pem'], 'bad glob dropped')
  assert.deepEqual(config.privacy.redactPatterns, ['ok.*'], 'bad regex dropped')
  assert.equal(config.ui.pollMs, 30000, 'ui.pollMs is clamped, not reset')
  assert.equal(config.export.dir, '.confluence/export')
  assert.equal(config.debug.logFile, '')

  const expected = [
    'CONFIG_INVALID_VALUE enabled',
    'CONFIG_INVALID_VALUE ledger.maxFilesPerSession',
    'CONFIG_INVALID_VALUE pulse.maxChars',
    'CONFIG_INVALID_VALUE pulse.maxHeadlines',
    'CONFIG_INVALID_VALUE pulse.maxPeers',
    'CONFIG_INVALID_VALUE recall.timeoutMs',
    'CONFIG_INVALID_VALUE store.dir',
    'CONFIG_INVALID_VALUE store.maxBodyBytes',
    'CONFIG_INVALID_VALUE store.pollMs',
    'CONFIG_INVALID_VALUE store.retentionDays',
    'CONFIG_INVALID_VALUE store.watch',
    'CONFIG_INVALID_VALUE ui.pollMs',
    'CONFIG_PATH_INVALID debug.logFile',
    'CONFIG_PATH_INVALID export.dir',
    'CONFIG_PATTERN_INVALID privacy.denyPathPatterns#1',
    'CONFIG_PATTERN_INVALID privacy.redactPatterns#0',
    'PRIVACY_TITLES_UNREDACTED privacy.redactTitles',
  ].sort()
  assert.deepEqual([...warnings].sort(), expected)
  for (const line of warnings) assert.match(line, /^[A-Z_]+ [a-z][A-Za-z0-9.#]*$/)
  assert.deepEqual(warnings, [...warnings].sort(), 'warnings are sorted by (CODE, field, index)')
})

test('UT-CONFIG-02b out-of-range/unknown-typed values never throw and stay capped at 20 warnings', () => {
  const raw = { store: 'not-an-object', privacy: ['no'], pulse: { maxHeadlines: 4 } }
  const { config, warnings } = resolveConfig(raw)
  assert.equal(config.store.pollMs, DEFAULTS.store.pollMs)
  assert.equal(config.pulse.maxHeadlines, 4, '4 is in range and accepted')
  assert.ok(warnings.includes('PULSE_BUDGET_RISK pulse.maxHeadlines'))
  assert.ok(warnings.includes('CONFIG_INVALID_VALUE store'))
  assert.ok(warnings.includes('CONFIG_INVALID_VALUE privacy'))

  const many = {}
  for (let i = 0; i < 30; i += 1) many[`unknown${i}`] = i
  const capped = resolveConfig(many)
  assert.equal(capped.warnings.length, 20, 'warnings are capped at 20')
  assert.ok(capped.warnings.every((line) => line.startsWith('CONFIG_UNKNOWN_FIELD')))

  for (const weird of [undefined, null, 'nope', 42, [], { store: null }, { privacy: { denyPathPatterns: 'x' } }]) {
    assert.doesNotThrow(() => resolveConfig(weird))
    const result = resolveConfig(weird)
    assert.equal(typeof result.config, 'object')
    assert.ok(Array.isArray(result.warnings))
  }
})

test('UT-CONFIG-03 unknown keys are ignored; a whole-object override still yields complete defaults', () => {
  const { config, warnings } = resolveConfig({ foo: 1, store: { bar: 2 }, pulse: { baz: 3 } })
  assert.ok(warnings.includes('CONFIG_UNKNOWN_FIELD foo'))
  assert.ok(warnings.includes('CONFIG_UNKNOWN_FIELD store.bar'))
  assert.ok(warnings.includes('CONFIG_UNKNOWN_FIELD pulse.baz'))
  assert.deepEqual(JSON.parse(JSON.stringify(config)), JSON.parse(JSON.stringify(DEFAULTS)))

  // A Loader-level override replaces the whole config object: partial input,
  // complete resolved output.
  const partial = { store: { pollMs: 8000 }, privacy: { denyPathPatterns: ['**/secret*'] } }
  const resolved = resolveConfig(partial).config
  assert.equal(resolved.store.pollMs, 8000)
  assert.equal(resolved.store.maxBodyBytes, 8192)
  assert.deepEqual(resolved.privacy.denyPathPatterns, ['**/secret*'])
  assert.equal(resolved.recall.maxHits, 5)
})

test('UT-CONFIG-04 boundary values are accepted without warnings', () => {
  const raw = {
    store: {
      retentionDays: 7,
      maxEntriesPerWorkspace: 20000,
      maxBodyBytes: 49152,
      pollMs: 1000,
      dir: 'D:\\stores\\confluence',
    },
    pulse: { maxChars: 400, maxPeers: 0, maxHeadlines: 0 },
    ledger: { maxFilesPerSession: 0, maxSessions: 20 },
    recall: { maxSessions: 10, maxHits: 20, timeoutMs: 30000 },
    ui: { pollMs: 2000 },
    export: { dir: 'nested/dir' },
  }
  const { config, warnings } = resolveConfig(raw)
  assert.deepEqual(warnings, [])
  assert.equal(config.store.retentionDays, 7)
  assert.equal(config.store.maxEntriesPerWorkspace, 20000)
  assert.equal(config.store.maxBodyBytes, 49152)
  assert.equal(config.store.pollMs, 1000)
  assert.equal(config.ui.pollMs, 2000)
  assert.equal(config.export.dir, 'nested/dir')
})

test('UT-CONFIG-05 privacy lists: valid session ids accepted, invalid dropped; per-workspace opt-out is deprecated', () => {
  const { config, warnings } = resolveConfig({
    privacy: {
      privateSessions: ['session-abc-123', 'x', 'ok_id-2'],
      disabledWorkspaces: ['ws_0123456789abcdef', 'D:\\05_Code\\scratch'],
    },
  })
  assert.deepEqual(config.privacy.privateSessions, ['session-abc-123', 'ok_id-2'])
  assert.equal('disabledWorkspaces' in config.privacy, false, 'v0.2.0 has no per-workspace boundary')
  assert.ok(warnings.includes('CONFIG_INVALID_VALUE privacy.privateSessions#1'))
  assert.ok(warnings.includes('CONFIG_DEPRECATED privacy.disabledWorkspaces'))
})

test('UT-CONFIG-05b deprecated ledger cap is mapped to the global ledger cap', () => {
  const { config, warnings } = resolveConfig({ ledger: { maxSessionsPerWorkspace: 50 } })
  assert.equal(config.ledger.maxSessions, 50)
  assert.ok(warnings.includes('CONFIG_DEPRECATED ledger.maxSessionsPerWorkspace'))
  const modern = resolveConfig({ ledger: { maxSessions: 50, maxSessionsPerWorkspace: 900 } })
  assert.equal(modern.config.ledger.maxSessions, 50, 'new key wins when both are present')
})

test('UT-CONFIG-06 publicConfig strips list contents to counts', () => {
  const { config } = resolveConfig({
    privacy: {
      privateSessions: ['session-super-secret'],
      redactPatterns: ['secret-pattern-.*'],
      denyPathPatterns: ['**/*.pem'],
    },
    debug: { logFile: 'C:\\Users\\someone\\debug.jsonl' },
  })
  const safe = publicConfig(config)
  const serialized = JSON.stringify(safe)
  assert.ok(!serialized.includes('session-super-secret'))
  assert.ok(!serialized.includes('secret-pattern'))
  assert.ok(!serialized.includes('Users'))
  assert.equal(safe.privacy.privateSessionsCount, 1)
  assert.equal(safe.privacy.redactPatternsCount, 1)
  assert.equal(safe.privacy.denyPathPatternsCount, 1)
  assert.equal('disabledWorkspacesCount' in safe.privacy, false)
  assert.equal(safe.debug.logFileEnabled, true)
  assert.doesNotThrow(() => publicConfig(undefined))
})
