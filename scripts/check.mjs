#!/usr/bin/env node
// Confluence / 汇流 — standalone packaging contract check (v0.2.0 implementation, universal memory).
//
// Mirrors the packaging checks in test/contract.test.js so CI or a human can run one
// command without the test runner:
//   node scripts/check.mjs
//
// Since v0.2.0 the memory scope is UNIVERSAL (ADR 0007): one global scope
// `{ key: 'global', label: 'All sessions' }` backed by the reserved store key
// `ws_0000000000000000`; workspaces are provenance only.
//
// Node builtins only; no network, no installs, no profile changes. Exit code 0 means
// every check passed. This script does not run the plugin or test its behaviour —
// behaviour is covered by the per-module tests and test/integration.test.js.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
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
  'board.js': ['BoardService', 'GLOBAL_SCOPE_KEY', 'KINDS', 'foldRecords'],
  'config.js': ['DEFAULTS', 'publicConfig', 'resolveConfig'],
  'export.js': [
    'EXPORT_ERROR_CODES',
    'EXPORT_FORMAT_VERSION',
    'EXPORT_MANIFEST_FILE',
    'EXPORT_MAX_BYTES',
    'EXPORT_PRODUCER',
    'EXPORT_SCHEMA',
    'EXPORT_SCOPE',
    'GLOBAL_SCOPE_KEY',
    'GLOBAL_SCOPE_LABEL',
    'MAX_EXPORT_LINE_BYTES',
    'MEMORIES_FILE',
    'exportMemories',
    'stripAbsolutePaths',
    'validateExportDir',
    'workspaceLabelFor',
  ],
  'facade.js': ['ConfluenceFacade', 'MEMORY_SCOPE'],
  'hostui.js': ['HOSTUI_PREFIX', 'MAX_RESPONSE_BYTES', 'PANEL_SCOPE', 'PLUGIN_NAME', 'PLUGIN_VERSION', 'registerHostUi', 'hostuiInternals'],
  'ledger.js': ['SessionLedger', 'foldSessionRows', 'workspaceKeyFor'],
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
  'recall.js': ['RecallService', 'parseSessionRef', 'roundRobin'],
  'redact.js': ['REDACT_POLICY', 'createRedactor'],
  'store.js': ['GLOBAL_SCOPE_KEY', 'GLOBAL_SCOPE_LABEL', 'JournalStore', 'WorkspaceJournal'],
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
  'workspace.js': [
    'canonicalizeDir',
    'createOriginResolver',
    'createWorkspaceResolver',
    'resolveOrigin',
    'resolveWorkspace',
    'workspaceKeyFor',
  ],
}

/** v0.2.0 universal-memory contract constants (delta §0). */
const GLOBAL_SCOPE_KEY = 'ws_0000000000000000'
const GLOBAL_SCOPE_LABEL = 'All sessions'
const MEMORY_SCOPE = { key: 'global', label: GLOBAL_SCOPE_LABEL }
const PULSE_TAG_NAME = 'confluence-memory'
/** Panel routes in v0.2.0; the v0.1.0 `/workspaces` route is gone. */
const PANEL_ROUTES = ['ping', 'overview', 'entry']

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
  'adr/0007-universal-memory-scope.md',
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
  'plan/scope-refactor-delta.md',
  'upgrade-v0.2.md',
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

async function checkAsync(name, fn) {
  try {
    await fn()
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

check('manifest: implemented v0.2.0 bundle + declared Web client half', () => {
  assertEquals(packageJson.name, 'dsh-confluence', 'name')
  assertEquals(packageJson.version, '0.2.0', 'version')
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
  assert(/shared memory/i.test(packageJson.description), 'description must mention shared memory')
  assert(/working directory/i.test(packageJson.description), 'description must state directory independence')
  assert(!/workspace memory/i.test(packageJson.description), 'description must not claim workspace scope')
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
  // v0.2.0 breaking config change: workspace opt-out removed, ledger cap renamed.
  assert(!patchText.includes('disabledWorkspaces'), 'patch must not carry the removed privacy.disabledWorkspaces')
  assert(!patchText.includes('maxSessionsPerWorkspace'), 'patch must use ledger.maxSessions, not the old key')
  assertEquals(row.config.ledger.maxSessions, 200, 'ledger.maxSessions default')
  assertEquals(row.config.privacy.disabledWorkspaces, undefined, 'privacy.disabledWorkspaces must be gone')
  assertEquals(row.config.ledger.maxSessionsPerWorkspace, undefined, 'ledger.maxSessionsPerWorkspace must be gone')
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
  assertEquals(indexModule.VERSION, '0.2.0', 'VERSION')
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
  // v0.2.0: global panel, provenance instead of a workspace switcher.
  assert(/汇流记忆 \/ Confluence memory/.test(client), 'the panel title must be the global memory title')
  assert(/['"]\/overview['"]/.test(client), 'the panel must call the global overview route')
  assert(/['"]\/entry['"]/.test(client), 'the panel must call the global entry route')
  assert(!/\/workspaces/.test(client), 'the removed /workspaces route must not be called')
  assert(!/workspaceKey|workspace_key/.test(client), 'panel requests must not carry a workspace key')
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
    'One shared memory for every session in this profile, fully offline.',
    'en meta.description',
  )
  assertEquals(zhLocale.meta.description, '本配置文件内所有会话共享同一份记忆，完全离线运行。', 'zh meta.description')
  assert(!/workspace/i.test(enLocale.meta.description), 'display metadata must not claim workspace scope')
  const enKeys = Object.keys(enLocale.ui).sort()
  const zhKeys = Object.keys(zhLocale.ui).sort()
  deepEqual(enKeys, zhKeys, 'en/zh UI key parity')
  assertEquals(enKeys.length, 86, 'expected the v0.2.0 inventory (86 keys)')
  for (const key of SCAFFOLD_UI_KEYS) {
    assert(enLocale.ui[key] !== undefined, `missing scaffold string ${key}`)
    assert(zhLocale.ui[key] !== undefined, `missing zh scaffold string ${key}`)
  }
  assertEquals(enLocale.ui['scope.global'], 'All sessions', 'en scope.global')
  assertEquals(zhLocale.ui['scope.global'], '全部会话', 'zh scope.global')
  for (const key of enKeys) {
    assert(
      !/this workspace|the same workspace|workspace board/i.test(enLocale.ui[key]),
      `en ui.${key} still says workspace-scoped: ${enLocale.ui[key]}`,
    )
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
  for (const marker of [
    'Confluence / 汇流',
    'v0.2.0',
    'v0.1.0',
    'universal',
    'implemented',
    'Host',
    'panel',
    '256',
    'ws_0000000000000000',
    'All sessions',
    'confluence-memory',
    'legacy',
    'profile',
    'privateSessions',
    'docs/install.md',
    'docs/upgrade-v0.2.md',
    'docs/adr/0007-universal-memory-scope.md',
    'docs/plan/scope-refactor-delta.md',
    'node --test',
    'MIT',
  ]) {
    assert(en.includes(marker), `README.md missing: ${marker}`)
  }
  for (const marker of ['汇流', 'v0.2.0', '全部会话', '256', 'docs/install.md', 'upgrade-v0.2.md', 'node --test', 'MIT']) {
    assert(zh.includes(marker), `README.zh-CN.md missing: ${marker}`)
  }
  assert(/not (been )?(installed|verified|executed)/i.test(en), 'README must keep the not-executed claims')
  assert(/not been visually verified/i.test(en.replace(/\s+/g, ' ')), 'README must keep the panel-rendering honesty')
  assert(!/workspace is the consent boundary/i.test(en), 'README must not claim the v0.1.0 privacy boundary')
  assert(existsSync(path.join(ROOT, 'docs', 'plan', 'implementation-status.md')), 'missing implementation-status.md')
  const status = readFileSync(path.join(ROOT, 'docs', 'plan', 'implementation-status.md'), 'utf8')
  for (const marker of ['Executed', 'Not executed', '256']) {
    assert(status.includes(marker), `implementation-status.md missing: ${marker}`)
  }
  const install = readFileSync(path.join(ROOT, 'docs', 'install.md'), 'utf8')
  for (const marker of ['install_bundle', 'dsh plugin --profile', 'not executed', 'scratch', 'rollback', 'restart', 'maxsessions']) {
    assert(install.toLowerCase().includes(marker), `install.md missing: ${marker}`)
  }
  const publishing = readFileSync(path.join(ROOT, 'docs', 'publishing.md'), 'utf8')
  for (const marker of ['npm pack', 'checksum', 'nothing was published', 'github', '0.2.0']) {
    assert(publishing.toLowerCase().includes(marker), `publishing.md missing: ${marker}`)
  }
  const upgrade = readFileSync(path.join(ROOT, 'docs', 'upgrade-v0.2.md'), 'utf8')
  for (const marker of ['privacy.disabledworkspaces', 'ledger.maxsessions', 'config_deprecated', 'restart', 'rollback', 'read-only']) {
    assert(upgrade.toLowerCase().includes(marker), `upgrade-v0.2.md missing: ${marker}`)
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
// universal memory scope (v0.2.0, ADR 0007)
// ---------------------------------------------------------------------------

check('v0.2.0 universal-memory constants agree across the Host modules', () => {
  for (const name of ['store.js', 'board.js', 'export.js']) {
    assertEquals(libModules[name].GLOBAL_SCOPE_KEY, GLOBAL_SCOPE_KEY, `${name} global key`)
  }
  assertEquals(libModules['store.js'].GLOBAL_SCOPE_LABEL, GLOBAL_SCOPE_LABEL, 'store global label')
  assertEquals(libModules['export.js'].EXPORT_SCOPE, 'global', 'export scope')
  assert(libModules['workspace.js'].resolveOrigin !== undefined, 'workspace.js must expose the origin resolver')
  assert(libModules['workspace.js'].createOriginResolver !== undefined, 'workspace.js must expose createOriginResolver')
  deepEqual({ ...libModules['facade.js'].MEMORY_SCOPE }, MEMORY_SCOPE, 'facade memory scope')
  deepEqual({ ...libModules['hostui.js'].PANEL_SCOPE }, MEMORY_SCOPE, 'panel scope')
  assertEquals(libModules['watermark.js'].PULSE_TAG_NAME, PULSE_TAG_NAME, 'pulse tag name')
  const pulseSource = readFileSync(path.join(LIB_DIR, 'pulse.js'), 'utf8')
  assert(pulseSource.includes('<confluence-memory scope="global"'), 'pulse must emit the v0.2.0 tag')
  const watermarkSource = readFileSync(path.join(LIB_DIR, 'watermark.js'), 'utf8')
  assert(watermarkSource.includes('confluence-workspace'), 'legacy <confluence-workspace> snapshots must stay parseable')
})

check('tools: the six descriptions are universal (no workspace scoping)', () => {
  const source = readFileSync(path.join(LIB_DIR, 'tools.js'), 'utf8')
  assert(!/this workspace/i.test(source), 'tool descriptions must not say "this workspace"')
  assert(!/NO_WORKSPACE/.test(source), 'the v0.2.0 tools have no NO_WORKSPACE error path')
  assert(/shared memory across sessions/i.test(source), 'board/post/search must describe shared memory')
  assert(/all earlier sessions on this machine/i.test(source), 'recall must cover the whole profile')
  assert(/untrusted data/i.test(source), 'tool results must keep the untrusted-data rule')
  for (const name of [
    'confluence_board',
    'confluence_post',
    'confluence_read',
    'confluence_search',
    'confluence_reply',
    'confluence_recall',
  ]) {
    assert(source.includes(`name: '${name}'`), `missing tool definition ${name}`)
  }
})

check('panel routes: exactly ping/overview/entry, no /workspaces route', () => {
  const source = readFileSync(path.join(LIB_DIR, 'hostui.js'), 'utf8')
  const matches = [...source.matchAll(/name: '([a-z-]+)', path: `\$\{HOSTUI_PREFIX\}\/([a-z-]+)`/g)]
  deepEqual(matches.map((match) => match[1]), PANEL_ROUTES, 'panel route names')
  deepEqual(matches.map((match) => match[2]), PANEL_ROUTES, 'panel route paths')
  assert(!/\/workspaces/.test(source), 'the v0.1.0 /workspaces route was removed')
  assert(!/workspaceKey/.test(source), 'panel payloads must not carry a workspace key')
})

check('config: removed workspace opt-out and renamed ledger cap warn and map', () => {
  const { DEFAULTS: libDefaults, resolveConfig } = libModules['config.js']
  assertEquals(libDefaults.ledger.maxSessions, 200, 'ledger.maxSessions default')
  assertEquals(libDefaults.privacy.disabledWorkspaces, undefined, 'workspace opt-out removed')
  const deprecated = resolveConfig({
    privacy: { privateSessions: [], disabledWorkspaces: ['ws_0123456789abcdef'] },
    ledger: { maxSessionsPerWorkspace: 50 },
  })
  assert(
    deprecated.warnings.includes('CONFIG_DEPRECATED privacy.disabledWorkspaces'),
    'stale privacy.disabledWorkspaces must warn',
  )
  assert(
    deprecated.warnings.includes('CONFIG_DEPRECATED ledger.maxSessionsPerWorkspace'),
    'the old ledger cap name must warn',
  )
  assertEquals(deprecated.config.ledger.maxSessions, 50, 'deprecated ledger cap value must be mapped')
  assertEquals(deprecated.config.privacy.disabledWorkspaces, undefined, 'workspace opt-out is dropped')
  const clean = resolveConfig({ ledger: { maxSessions: 50 } })
  assertEquals(clean.warnings.length, 0, 'no warnings for the new key')
  assertEquals(clean.config.ledger.maxSessions, 50, 'new ledger cap value')
})

await checkAsync('store: global journal directory is reserved and legacy journals are only scanned', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'confluence-check-store-'))
  try {
    const store = new libModules['store.js'].JournalStore({ config: { store: { dir: root } } })
    const journal = await store.openGlobal()
    assertEquals(journal.wsKey, GLOBAL_SCOPE_KEY, 'global journal scope key')
    deepEqual(
      path.relative(root, journal.dir).split(path.sep),
      ['workspaces', GLOBAL_SCOPE_KEY],
      'global journal directory',
    )
    deepEqual(store.legacyWorkspaceMeta(), [], 'fresh store has no legacy workspaces')
    deepEqual(store.mergedRecords(), [], 'fresh store has an empty merged view')
  } finally {
    rmSync(root, { recursive: true, force: true })
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
  console.log('All packaging contract checks passed (v0.2.0 universal-memory implementation; behaviour is covered by the test suite).')
}
