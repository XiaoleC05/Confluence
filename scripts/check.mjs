#!/usr/bin/env node
// Confluence / 汇流 — standalone packaging contract check (v0.1.0 implementation).
//
// Mirrors the packaging checks in test/contract.test.js so CI or a human can run one
// command without the test runner:
//   node scripts/check.mjs
//
// Node builtins only; no network, no installs, no profile changes. Exit code 0 means
// every check passed. This script does not run the plugin or test its behaviour —
// behaviour is covered by the per-module tests and test/integration.test.js.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INDEX_PATH = path.join(ROOT, 'index.js')
const CLIENT_PATH = path.join(ROOT, 'client.js')
const PATCH_PATH = path.join(ROOT, 'cordis.patch.yml')
const ICON_PATH = path.join(ROOT, 'icon.svg')
const LIB_DIR = path.join(ROOT, 'lib')
const DOCS_README = path.join(ROOT, 'docs', 'README.md')

const LIB_MODULES = [
  'board.js',
  'config.js',
  'export.js',
  'facade.js',
  'hostui.js',
  'ledger.js',
  'presence.js',
  'pulse.js',
  'recall.js',
  'redact.js',
  'store.js',
  'tools.js',
  'util.js',
  'watermark.js',
  'workspace.js',
]

const EXPECTED_LIB_EXPORTS = {
  'board.js': ['KINDS', 'foldRecords', 'BoardService'],
  'config.js': ['DEFAULTS', 'resolveConfig', 'publicConfig'],
  'export.js': [
    'EXPORT_SCHEMA',
    'EXPORT_FORMAT_VERSION',
    'MEMORIES_FILE',
    'EXPORT_MANIFEST_FILE',
    'EXPORT_MAX_BYTES',
    'MAX_EXPORT_LINE_BYTES',
    'EXPORT_ERROR_CODES',
    'workspaceLabelFor',
    'stripAbsolutePaths',
    'validateExportDir',
    'exportWorkspace',
  ],
  'facade.js': ['ConfluenceFacade'],
  'hostui.js': ['HOSTUI_PREFIX', 'PLUGIN_VERSION', 'PLUGIN_NAME', 'MAX_RESPONSE_BYTES', 'registerHostUi', 'hostuiInternals'],
  'ledger.js': ['workspaceKeyFor', 'foldSessionRows', 'SessionLedger'],
  'presence.js': ['Presence', 'presenceConstants'],
  'pulse.js': [
    'PULSE_CONTEXT_NAME',
    'PULSE_CONTEXT_ORDER',
    'PULSE_MAX_TOKENS',
    'PULSE_DEFAULT_MAX_CHARS',
    'PULSE_DEFAULT_MAX_HEADLINES',
    'PULSE_DEFAULT_MAX_PEERS',
    'PULSE_STALE_AFTER_MS',
    'estimateTokens',
    'normalizePulseText',
    'buildPulseText',
    'PulseService',
  ],
  'recall.js': ['RecallService', 'parseSessionRef', 'workspaceKeyFor', 'roundRobin'],
  'redact.js': ['REDACT_POLICY', 'createRedactor'],
  'store.js': ['JournalStore', 'WorkspaceJournal'],
  'tools.js': ['createTools', 'registerTools'],
  'util.js': [
    'ConfluenceError',
    'createUlidFactory',
    'isUlid',
    'sha256Hex',
    'shortHash',
    'isoNow',
    'truncateUtf8',
    'truncateChars',
    'safeJsonParse',
    'createLogger',
    'makeWriterId',
    'escapePulseText',
    'once',
  ],
  'watermark.js': [
    'WATERMARK_KEY',
    'WATERMARK_STATE_VERSION',
    'PULSE_SECTION_NAME',
    'PULSE_TAG_NAME',
    'BOARD_READ_TOOLS',
    'createInitialState',
    'normalizeWatermarkState',
    'parseDigestMarker',
    'parseThroughMarker',
    'foldWatermarks',
    'createWatermarkProjectionDefinition',
    'WatermarkTracker',
    'isHostOnlyProjectionActive',
  ],
  'workspace.js': ['canonicalizeDir', 'workspaceKeyFor', 'resolveWorkspace', 'createWorkspaceResolver'],
}

const EXPECTED_DSH_CLIENT = {
  platform: 'web',
  immediately: true,
  inject: ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-layout'],
}

const EXPECTED_FILES = [
  'index.js',
  'client.js',
  ...LIB_MODULES.map((name) => `lib/${name}`),
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
]

const SCAFFOLD_UI_KEYS = [
  'panel',
  'board.title',
  'board.subtitle',
  'board.empty',
  'board.unread',
  'pulse.title',
  'pulse.empty',
  'recall.title',
  'recall.empty',
  'workspace.label',
  'workspace.unavailable',
  'search.label',
  'search.placeholder',
  'search.empty',
  'questions.open',
  'handoffs.open',
  'peers.live',
  'markRead',
  'markRead.done',
  'entry.open',
  'entry.resolved',
  'ledger.title',
]

const REQUIRED_DOCS = [
  'research/dsh-internals.md',
  'research/prior-art.md',
  'research/external-patterns.md',
  'discussion/round-1.md',
  'discussion/round-2.md',
  'discussion/position-a.md',
  'discussion/position-b.md',
  'adr/0001-confluence-architecture.md',
  'adr/0002-store-format-and-concurrency.md',
  'adr/0003-pulse-and-watermarks.md',
  'adr/0004-privacy-and-consent.md',
  'adr/0005-ui-transport.md',
  'adr/0006-solo-bench-integration.md',
  'design/architecture.md',
  'design/data-model.md',
  'design/store-format.md',
  'design/tool-api.md',
  'design/pulse.md',
  'design/ledger-recall.md',
  'design/ui.md',
  'design/config.md',
  'design/security-privacy.md',
  'design/testing.md',
  'design/solo-bench-integration.md',
  'plan/execution-plan.md',
  'plan/m0-spikes.md',
  'plan/implementation-interfaces.md',
  'plan/implementation-status.md',
  'publishing.md',
  'install.md',
  'planning/team-brief.md',
]

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, message })
    console.log(`FAIL  ${name}`)
    console.log(`      ${message.replace(/\n/g, '\n      ')}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEquals(actual, expected, label) {
  assert(
    Object.is(actual, expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  )
}

// ---------------------------------------------------------------------------
// dependency-free YAML subset parser (only what cordis.patch.yml needs)
// ---------------------------------------------------------------------------

function stripComment(line) {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#') ? null : line
}

/** @param {string} text @returns {any} */
function parseYamlSubset(text) {
  const lines = []
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw)
    if (line === null) continue
    lines.push({ indent: line.length - line.trimStart().length, text: line.trim() })
  }
  let index = 0

  function parseScalar(raw) {
    if (raw === '[]') return []
    if (raw === '{}') return {}
    if (/^'(.*)'$/.test(raw)) return raw.slice(1, -1)
    if (/^"(.*)"$/.test(raw)) return raw.slice(1, -1)
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (/^-?\d+$/.test(raw)) return Number(raw)
    return raw
  }

  function parseBlock(indent) {
    const first = lines[index]
    if (first === undefined || first.indent !== indent) throw new Error(`unexpected YAML at line ${index + 1}`)
    return first.text === '-' || first.text.startsWith('- ') ? parseSequence(indent) : parseMapping(indent)
  }

  function parseValueAfter(indent) {
    const next = lines[index]
    if (next === undefined || next.indent <= indent) return null
    return parseBlock(next.indent)
  }

  function parseMapping(indent) {
    const out = {}
    while (index < lines.length && lines[index].indent === indent) {
      const line = lines[index]
      const match = line.text.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/)
      if (match === null) throw new Error(`unexpected YAML mapping entry: ${line.text}`)
      index += 1
      out[match[1]] = match[2] === undefined ? parseValueAfter(indent) : parseScalar(match[2])
    }
    return out
  }

  function parseSequence(indent) {
    const out = []
    while (
      index < lines.length &&
      lines[index].indent === indent &&
      (lines[index].text === '-' || lines[index].text.startsWith('- '))
    ) {
      const rest = lines[index].text === '-' ? '' : lines[index].text.slice(2).trim()
      index += 1
      if (rest === '') {
        out.push(parseValueAfter(indent))
        continue
      }
      const match = rest.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/)
      if (match === null) {
        out.push(parseScalar(rest))
        continue
      }
      const map = {}
      const keyIndent = indent + 2
      map[match[1]] = match[2] === undefined ? parseValueAfter(indent) : parseScalar(match[2])
      while (index < lines.length && lines[index].indent >= keyIndent) {
        const line = lines[index]
        if (line.indent !== keyIndent) throw new Error(`unexpected YAML indentation: ${line.text}`)
        const entry = line.text.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/)
        if (entry === null) throw new Error(`unexpected YAML sequence entry: ${line.text}`)
        index += 1
        map[entry[1]] = entry[2] === undefined ? parseValueAfter(keyIndent) : parseScalar(entry[2])
      }
      out.push(map)
    }
    return out
  }

  return parseBlock(0)
}

/** Canonical JSON (sorted object keys) for order-insensitive deep equality. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function deepEqual(actual, expected, label) {
  const a = canonicalJson(actual)
  const b = canonicalJson(expected)
  assert(a === b, `${label} differs:\nactual:   ${a.slice(0, 600)}\nexpected: ${b.slice(0, 600)}`)
}

function markdownLinkTargets(text) {
  const targets = []
  const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const target = match[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    if (target.startsWith('#')) continue
    targets.push(target.split('#')[0])
  }
  return targets
}

function filesPatternMatches(pattern, relPath) {
  if (pattern === relPath) return true
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp('^' + escaped + '$').test(relPath)
}

// ---------------------------------------------------------------------------
// shared fixtures (loaded once; no side effects)
// ---------------------------------------------------------------------------

const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const patchText = readFileSync(PATCH_PATH, 'utf8')
const patch = parseYamlSubset(patchText)
const row = patch[0].insert[0]
const { DEFAULTS } = await import(pathToFileURL(path.join(LIB_DIR, 'config.js')).href)
const indexModule = await import(pathToFileURL(INDEX_PATH).href)
const libModules = {}
for (const name of LIB_MODULES) {
  libModules[name] = await import(pathToFileURL(path.join(LIB_DIR, name)).href)
}
const enLocale = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'en.json'), 'utf8'))
const zhLocale = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'zh.json'), 'utf8'))

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

check('manifest: implemented v0.1.0 bundle + declared Web client half', () => {
  assertEquals(packageJson.name, 'dsh-confluence', 'name')
  assertEquals(packageJson.version, '0.1.0', 'version')
  assertEquals(packageJson.private, true, 'private')
  assertEquals(packageJson.type, 'module', 'type')
  assertEquals(packageJson.main, './index.js', 'main')
  assertEquals(packageJson.license, 'MIT', 'license')
  assertEquals(packageJson.engines.node, '>=22.19.0', 'engines.node')
  assertEquals(packageJson.engines.dsh, '>=0.2.2-rc.1', 'engines.dsh')
  assertEquals(packageJson.scripts.test, 'node --test --test-force-exit "test/*.test.js"', 'scripts.test')
  assertEquals(packageJson.scripts.check, 'node scripts/check.mjs', 'scripts.check')
  assertEquals(packageJson.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch')
  deepEqual(packageJson.dsh.client, EXPECTED_DSH_CLIENT, 'dsh.client')
  assert(/workspace memory/i.test(packageJson.description), 'description must mention workspace memory')
  assert(!/design-stage/i.test(packageJson.description), 'description must not describe a design-stage scaffold')
  assert(/XiaoleC05/.test(packageJson.author), 'author')
  assert(/github\.com\/XiaoleC05\/Confluence\.git$/.test(packageJson.repository.url), 'repository.url')
  assertEquals(packageJson.dependencies, undefined, 'dependency-free runtime')
  assertEquals(packageJson.devDependencies, undefined, 'dependency-free runtime')
})

check('files/exports: the implemented runtime surface is complete and nothing dev-only ships', () => {
  assertEquals(packageJson.exports['.'], './index.js', 'exports[.]')
  assertEquals(packageJson.exports['./client'], './client.js', 'exports[./client]')
  assertEquals(packageJson.exports['./locale/*.json'], './locale/*.json', 'exports[locale]')
  assertEquals(packageJson.exports['./icon'], './icon.svg', 'exports[icon]')
  assert(packageJson.files.includes('lib/*.js'), 'files must include lib/*.js')
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert(packageJson.files.includes(required), `files must include ${required}`)
  }
  for (const relPath of EXPECTED_FILES) {
    assert(existsSync(path.join(ROOT, relPath)), `missing runtime file ${relPath}`)
    assert(
      packageJson.files.some((pattern) => filesPatternMatches(pattern, relPath)),
      `runtime file ${relPath} is not covered by files`,
    )
  }
  for (const relPath of ['test/contract.test.js', 'docs/README.md', 'examples/profile-patch.yml', 'scripts/check.mjs']) {
    assert(!packageJson.files.some((pattern) => filesPatternMatches(pattern, relPath)), `dev file ${relPath} would ship`)
  }
})

check('patch: one confluence row; parsed config deep-equals lib/config.js DEFAULTS', () => {
  assertEquals(patch.length, 1, 'top-level patch entries')
  assert(Array.isArray(patch[0].insert), 'patch must contain insert:')
  assertEquals(patch[0].insert.length, 1, 'insert row count')
  assertEquals(row.id, 'confluence', 'row id')
  assertEquals(row.name, 'dsh-confluence', 'row name')
  assert(!patchText.includes('!!js'), 'patch must not use !!js expressions')
  deepEqual(row.config, DEFAULTS, 'bundle row config vs lib/config.js DEFAULTS')
  assert(Array.isArray(row.config.privacy.redactPatterns), 'privacy.redactPatterns default must be an array')
})

check('lib modules: exactly the 15 implemented files are present', () => {
  const actual = readdirSync(LIB_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
  deepEqual(actual, LIB_MODULES.slice().sort(), 'lib/ module inventory')
  assertEquals(LIB_MODULES.length, 15, 'expected module count')
})

check('lib modules: every expected public export is present', () => {
  for (const [moduleName, expected] of Object.entries(EXPECTED_LIB_EXPORTS)) {
    const module = libModules[moduleName]
    for (const name of expected) {
      assert(module[name] !== undefined, `lib/${moduleName} is missing export ${name}`)
    }
  }
})

check('index.js: implemented Host entry surface, quiet import, required services declared', () => {
  const quiet = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(INDEX_PATH).href)})`],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
  )
  assertEquals(quiet.status, 0, 'quiet import exit status')
  assertEquals(quiet.stdout.trim(), '', 'quiet import stdout')
  assertEquals(quiet.stderr.trim(), '', 'quiet import stderr')
  assertEquals(indexModule.name, 'confluence', 'exported name')
  assertEquals(typeof indexModule.apply, 'function', 'apply export')
  assertEquals(typeof indexModule.applyWithDeps, 'function', 'applyWithDeps export')
  assertEquals(indexModule.default, undefined, 'must use the apply() export form')
  assertEquals(indexModule.VERSION, '0.1.0', 'VERSION')
  assertEquals(typeof indexModule.DEFAULTS, 'object', 'DEFAULTS export')
  deepEqual(JSON.parse(JSON.stringify(indexModule.DEFAULTS)), DEFAULTS, 'index.js DEFAULTS vs lib/config.js DEFAULTS')
  assert(Array.isArray(indexModule.inject) && indexModule.inject.includes('tools'), "inject must include 'tools'")
})

check('client.js: Dynamic ModuleLoader module id, read-only same-origin panel', () => {
  const client = readFileSync(CLIENT_PATH, 'utf8')
  assert(/window\.__ModuleLoader__\.load\(\{/.test(client), 'client.js must use window.__ModuleLoader__.load')
  assert(/id:\s*'dsh-confluence'/.test(client), "module id must be 'dsh-confluence'")
  assert(!/^\s*import\s/m.test(client), 'client.js must be a plain browser module')
  assert(!/from\s+['"]@deepseek-ai\//.test(client), 'client.js must not import @deepseek-ai packages')
  assertEquals((client.match(/\bfetch\s*\(/g) ?? []).length, 1, 'exactly one fetch call')
  assert(/fetch\(ROUTE_BASE/.test(client), 'the only fetch must target ROUTE_BASE')
  assert(!/https?:\/\//.test(client), 'client.js must not contain absolute URLs')
  assert(!/\binnerHTML\b|dangerouslySetInnerHTML/.test(client), 'no HTML injection of untrusted text')
  assert(/inject:\s*\[\s*'slots'\s*,\s*'locale'\s*,\s*'layout'\s*\]/.test(client), 'client inject list changed')
  assert(/name:\s*'sidebar\.panellist'[\s\S]{0,160}id:\s*'confluence'[\s\S]{0,160}order:\s*30/.test(client), 'sidebar entry registration changed')
  assert(/name:\s*'main'[\s\S]{0,160}key:\s*'confluence'/.test(client), 'keyed main page registration changed')
})

check('offline posture: no network/child-process/DSH imports in index.js or lib/', () => {
  const networkImport =
    /from\s+['"]node:(?:http|https|net|tls|dgram|child_process)['"]|require\(\s*['"]node:(?:http|https|net|tls|dgram|child_process)['"]\s*\)/
  const harnessImport = /from\s+['"]@deepseek-ai\/|require\(\s*['"]@deepseek-ai\//
  const parserBase = /['"]http:\/\/127\.0\.0\.1['"]/g
  const sources = LIB_MODULES.map((name) => ({ relPath: `lib/${name}`, source: readFileSync(path.join(LIB_DIR, name), 'utf8') }))
  sources.push({ relPath: 'index.js', source: readFileSync(INDEX_PATH, 'utf8') })
  for (const { relPath, source } of sources) {
    assert(!networkImport.test(source), `${relPath} imports a network/child-process module`)
    assert(!harnessImport.test(source), `${relPath} imports a @deepseek-ai package`)
    assert(!/\bfetch\s*\(/.test(source), `${relPath} calls fetch()`)
    assert(!/https?:\/\//.test(source.replace(parserBase, "''")), `${relPath} contains a network URL literal`)
  }
})

check('locale: metadata, full inventory and en/zh parity', () => {
  assertEquals(enLocale.meta.title, 'Confluence', 'en meta.title')
  assertEquals(zhLocale.meta.title, '汇流', 'zh meta.title')
  assertEquals(
    enLocale.meta.description,
    'Shares workspace memory between sessions that run in the same project, fully offline.',
    'en meta.description',
  )
  assertEquals(zhLocale.meta.description, '同一工作区内的会话共享记忆，完全离线运行。', 'zh meta.description')
  const enKeys = Object.keys(enLocale.ui).sort()
  const zhKeys = Object.keys(zhLocale.ui).sort()
  deepEqual(enKeys, zhKeys, 'en/zh UI key parity')
  assert(enKeys.length >= 85, `expected >=85 UI strings, found ${enKeys.length}`)
  for (const key of SCAFFOLD_UI_KEYS) {
    assert(enLocale.ui[key] !== undefined, `missing scaffold string ${key}`)
    assert(zhLocale.ui[key] !== undefined, `missing zh scaffold string ${key}`)
  }
})

check('icon: original, standalone, script-free SVG within limits', () => {
  const buffer = readFileSync(ICON_PATH)
  assert(buffer.length > 200 && buffer.length < 256 * 1024, 'icon size outside 200 B – 256 KiB')
  const svg = buffer.toString('utf8')
  assert(/^<svg\b/.test(svg), 'icon must start with <svg')
  assert(svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'icon must declare the SVG namespace')
  assert(svg.includes('viewBox="'), 'icon must declare a viewBox')
  assert(!/<script/i.test(svg), 'icon must not contain script')
  assert(!/<text/i.test(svg), 'icon must not contain text')
  assert(!/<image\b/i.test(svg), 'icon must not embed raster images')
  assert(!/\b(?:href|src)\s*=\s*["'](?:https?:)?\/\//i.test(svg), 'icon must not reference external URLs')
  assert((svg.match(/<path\b/g) ?? []).length >= 3, 'icon must contain multi-stream geometry')
})

check('docs: README/install/publishing/status keep the executed-vs-not-executed honesty', () => {
  const enPath = path.join(ROOT, 'README.md')
  const zhPath = path.join(ROOT, 'README.zh-CN.md')
  assert(existsSync(enPath), 'missing README.md')
  assert(existsSync(zhPath), 'missing README.zh-CN.md')
  const en = readFileSync(enPath, 'utf8')
  const zh = readFileSync(zhPath, 'utf8')
  for (const marker of ['Confluence / 汇流', 'v0.1.0', 'implemented', 'Host', 'panel', '256', 'docs/install.md', 'node --test', 'MIT']) {
    assert(en.includes(marker), `README.md missing: ${marker}`)
  }
  for (const marker of ['汇流', 'v0.1.0', '256', 'docs/install.md', 'node --test', 'MIT']) {
    assert(zh.includes(marker), `README.zh-CN.md missing: ${marker}`)
  }
  assert(/not (been )?(installed|verified|executed)/i.test(en), 'README must keep the not-executed claims')
  assert(existsSync(path.join(ROOT, 'docs', 'plan', 'implementation-status.md')), 'missing implementation-status.md')
  const status = readFileSync(path.join(ROOT, 'docs', 'plan', 'implementation-status.md'), 'utf8')
  for (const marker of ['Executed', 'Not executed', '256']) {
    assert(status.includes(marker), `implementation-status.md missing: ${marker}`)
  }
  const install = readFileSync(path.join(ROOT, 'docs', 'install.md'), 'utf8')
  for (const marker of ['install_bundle', 'dsh plugin --profile', 'not executed', 'scratch', 'rollback']) {
    assert(install.toLowerCase().includes(marker), `install.md missing: ${marker}`)
  }
  const publishing = readFileSync(path.join(ROOT, 'docs', 'publishing.md'), 'utf8')
  for (const marker of ['npm pack', 'checksum', 'nothing was published', 'github']) {
    assert(publishing.toLowerCase().includes(marker), `publishing.md missing: ${marker}`)
  }
})

check('docs index: links resolve and every promised document is named', () => {
  assert(existsSync(DOCS_README), 'missing docs/README.md')
  const text = readFileSync(DOCS_README, 'utf8')
  for (const target of markdownLinkTargets(text)) {
    const resolved = path.resolve(path.join(ROOT, 'docs'), target)
    assert(existsSync(resolved) && statSync(resolved).isFile(), `broken docs/README.md link: ${target}`)
  }
  for (const required of REQUIRED_DOCS) {
    assert(text.includes(required), `docs/README.md must mention ${required}`)
    assert(existsSync(path.join(ROOT, 'docs', required)), `docs/README.md promises a missing doc: ${required}`)
  }
})

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

const passed = results.filter((result) => result.ok).length
const failed = results.length - passed
console.log('')
console.log(`Confluence packaging check — ${results.length} checks, ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('Repository root: ' + ROOT)
  process.exitCode = 1
} else {
  console.log('All packaging contract checks passed (v0.1.0 implementation; behaviour is covered by the test suite).')
}
