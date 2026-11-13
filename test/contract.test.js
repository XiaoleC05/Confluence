// Confluence / 汇流 — dependency-free packaging contract tests (v0.1.0 implementation).
//
// These tests verify the *packaging and entry-point contract* of the implemented plugin:
// bundle manifest/patch, runtime file coverage, locales, icon, the Host entry surface,
// the Web client module identity and the offline posture. Behaviour is covered by the
// per-module tests and test/integration.test.js. The standalone mirror of these checks
// is scripts/check.mjs.
//
// Run from the repository root:
//   node --test --test-force-exit "test/*.test.js"
//
// Node builtins only. Nothing here touches the network or the user's DSH profile.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_DIR = ROOT
const PACKAGE_JSON = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const INDEX_PATH = path.join(ROOT, 'index.js')
const CLIENT_PATH = path.join(ROOT, 'client.js')
const PATCH_PATH = path.join(ROOT, 'cordis.patch.yml')
const ICON_PATH = path.join(ROOT, 'icon.svg')
const DOCS_README = path.join(ROOT, 'docs', 'README.md')
const LIB_DIR = path.join(ROOT, 'lib')

/** The 15 Host modules named by docs/plan/implementation-interfaces.md §0. */
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

/** Runtime/display files that must be covered by package.json "files". */
const EXPECTED_FILES = [
  'index.js',
  'client.js',
  ...LIB_MODULES.map((name) => `lib/${name}`),
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
]

/** Declared Web-client manifest (confirmed by architect-a; client.js is the module id below). */
const EXPECTED_DSH_CLIENT = {
  platform: 'web',
  immediately: true,
  inject: ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-layout'],
}

/** The 22 scaffold UI keys from the design phase; they must stay present. */
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

const DEFAULTS = {
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
  ledger: { enabled: true, maxFilesPerSession: 8, maxSessionsPerWorkspace: 200, fileHintsInPulse: false },
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

/** Docs the index must name (design package + implementation docs). */
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
// helpers
// ---------------------------------------------------------------------------

/** @param {string} pattern @param {string} relPath */
function filesPatternMatches(pattern, relPath) {
  if (pattern === relPath) return true
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp('^' + escaped + '$').test(relPath)
}

/** All deep string keys of a parsed JSON object, sorted. */
function deepKeys(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  const out = []
  for (const key of Object.keys(value)) out.push(...deepKeys(value[key], prefix === '' ? key : `${prefix}.${key}`))
  return out.sort()
}

/** Markdown link targets in a document, excluding absolute URLs and anchors. */
function markdownLinkTargets(text) {
  const targets = []
  const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const target = match[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue // http:, https:, mailto:
    if (target.startsWith('#')) continue
    targets.push(target.split('#')[0])
  }
  return targets
}

/** Lines in a text file (trailing newline does not add a line). */
function lineCount(file) {
  const text = readFileSync(file, 'utf8')
  if (text === '') return 0
  const lines = text.split(/\r?\n/)
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

/** Import a module in a fresh Node process and require it to stay silent. */
function importQuietly(importUrl) {
  const code = `await import(${JSON.stringify(importUrl)})`
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  })
}

/** Read every lib module plus index.js as `{ relPath, source }`. */
function hostSources() {
  const sources = LIB_MODULES.map((name) => ({
    relPath: `lib/${name}`,
    source: readFileSync(path.join(LIB_DIR, name), 'utf8'),
  }))
  sources.push({ relPath: 'index.js', source: readFileSync(INDEX_PATH, 'utf8') })
  return sources
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

test('package.json is a private ESM v0.1.0 bundle manifest with the Web client half', () => {
  assert.equal(PACKAGE_JSON.name, 'dsh-confluence')
  assert.equal(PACKAGE_JSON.version, '0.1.0')
  assert.equal(PACKAGE_JSON.private, true)
  assert.equal(PACKAGE_JSON.type, 'module')
  assert.equal(PACKAGE_JSON.main, './index.js')
  assert.equal(PACKAGE_JSON.license, 'MIT')
  assert.match(PACKAGE_JSON.description, /workspace memory/i)
  assert.match(PACKAGE_JSON.description, /pulse/)
  assert.match(PACKAGE_JSON.description, /board/)
  assert.match(PACKAGE_JSON.description, /recall/i)
  assert.doesNotMatch(PACKAGE_JSON.description, /design-stage/i, 'the manifest must no longer describe a scaffold')
  assert.match(PACKAGE_JSON.author, /XiaoleC05/i)
  assert.match(PACKAGE_JSON.repository.url, /github\.com\/XiaoleC05\/Confluence\.git$/)
  assert.equal(PACKAGE_JSON.homepage, 'https://github.com/XiaoleC05/Confluence#readme')
  assert.match(PACKAGE_JSON.bugs.url, /github\.com\/XiaoleC05\/Confluence\/issues$/)
  assert.deepEqual(PACKAGE_JSON.dsh.bundle, { patch: './cordis.patch.yml' })
  assert.deepEqual(PACKAGE_JSON.dsh.client, EXPECTED_DSH_CLIENT)
})

test('package.json exports and files cover exactly the implemented runtime surface', () => {
  const exports = PACKAGE_JSON.exports
  assert.equal(exports['.'], './index.js')
  assert.equal(exports['./client'], './client.js')
  assert.equal(exports['./locale/*.json'], './locale/*.json')
  assert.equal(exports['./icon'], './icon.svg')
  assert.deepEqual(Object.keys(exports).sort(), ['.', './client', './icon', './locale/*.json'])

  assert.ok(Array.isArray(PACKAGE_JSON.files))
  assert.ok(PACKAGE_JSON.files.includes('lib/*.js'), 'files must cover the Host modules')
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(PACKAGE_JSON.files.includes(required), `files must include ${required}`)
  }
  for (const relPath of EXPECTED_FILES) {
    assert.ok(existsSync(path.join(PACKAGE_DIR, relPath)), `missing runtime file ${relPath}`)
    assert.ok(
      PACKAGE_JSON.files.some((pattern) => filesPatternMatches(pattern, relPath)),
      `runtime file ${relPath} is not covered by package.json files`,
    )
  }
  // Nothing shipped may be pulled in from development-only trees.
  for (const relPath of ['test/contract.test.js', 'docs/README.md', 'examples/profile-patch.yml', 'scripts/check.mjs']) {
    assert.equal(
      PACKAGE_JSON.files.some((pattern) => filesPatternMatches(pattern, relPath)),
      false,
      `files must not cover development file ${relPath}`,
    )
  }
})

test('package.json engines, scripts and dependency-free posture are honest', () => {
  assert.equal(PACKAGE_JSON.engines.node, '>=22.19.0')
  assert.equal(PACKAGE_JSON.engines.dsh, '>=0.2.2-rc.1')
  assert.equal(PACKAGE_JSON.scripts.test, 'node --test --test-force-exit "test/*.test.js"')
  assert.equal(PACKAGE_JSON.scripts.check, 'node scripts/check.mjs')
  assert.ok(Array.isArray(PACKAGE_JSON.keywords))
  assert.ok(PACKAGE_JSON.keywords.includes('dsh'))
  assert.equal(PACKAGE_JSON.dependencies, undefined)
  assert.equal(PACKAGE_JSON.devDependencies, undefined)
  assert.equal(PACKAGE_JSON.peerDependencies, undefined)
})

// ---------------------------------------------------------------------------
// bundle patch
// ---------------------------------------------------------------------------

test('cordis.patch.yml inserts exactly one confluence row without !!js', () => {
  const patch = readFileSync(PATCH_PATH, 'utf8')
  assert.match(patch, /^- insert:$/m)
  assert.equal((patch.match(/^\s*-\s*id:\s*confluence\s*$/gm) ?? []).length, 1)
  assert.equal((patch.match(/^\s*name:\s*['"]?dsh-confluence['"]?\s*$/gm) ?? []).length, 1)
  assert.match(patch, /^\s*config:$/m)
  assert.equal(patch.includes('!!js'), false, 'the bundle patch must not use !!js expressions')
})

test('cordis.patch.yml carries the complete v1 default configuration', () => {
  const patch = readFileSync(PATCH_PATH, 'utf8')
  for (const section of ['store', 'pulse', 'ledger', 'recall', 'privacy', 'ui', 'export', 'debug']) {
    assert.match(patch, new RegExp(`^        ${section}:$`, 'm'), `missing config section ${section}`)
  }
  assert.match(patch, /^        enabled: true$/m)
  const expectedSnippets = [
    "dir: ''",
    'retentionDays: 90',
    'maxEntriesPerWorkspace: 2000',
    'maxBodyBytes: 8192',
    'pollMs: 4000',
    'watch: true',
    'maxHeadlines: 3',
    'maxPeers: 2',
    'maxChars: 1400',
    'maxFilesPerSession: 8',
    'maxSessionsPerWorkspace: 200',
    'fileHintsInPulse: false',
    'maxSessions: 3',
    'maxHits: 5',
    'timeoutMs: 5000',
    'redact: true',
    'redactTitles: true',
    'privateSessions: []',
    'disabledWorkspaces: []',
    'redactPatterns: []',
    'enabled: false',
    "dir: '.confluence/export'",
    "logFile: ''",
  ]
  for (const snippet of expectedSnippets) {
    assert.ok(patch.includes(snippet), `patch is missing default config value: ${snippet}`)
  }
  assert.ok(patch.includes("'**/.env*'"), 'patch must keep the default denyPathPatterns entry')
  assert.ok(patch.includes("'**/*.pem'"), 'patch must keep the default denyPathPatterns entry')
})

// ---------------------------------------------------------------------------
// locale resources
// ---------------------------------------------------------------------------

test('locale resources parse and carry meaningful display metadata', () => {
  for (const locale of ['en', 'zh']) {
    const file = path.join(ROOT, 'locale', `${locale}.json`)
    assert.ok(existsSync(file), `missing locale ${locale}`)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof parsed.meta?.title, 'string')
    assert.ok(parsed.meta.title.trim().length >= 2, `${locale} meta.title is too short`)
    assert.equal(typeof parsed.meta?.description, 'string')
    assert.ok(parsed.meta.description.trim().length >= 20, `${locale} meta.description is too short`)
  }
  const en = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'zh.json'), 'utf8'))
  assert.equal(en.meta.title, 'Confluence')
  assert.equal(zh.meta.title, '汇流')
  assert.equal(en.meta.description, 'Shares workspace memory between sessions that run in the same project, fully offline.')
  assert.equal(zh.meta.description, '同一工作区内的会话共享记忆，完全离线运行。')
})

test('locale UI key sets are aligned and keep the scaffold plus the M3 panel strings', () => {
  const en = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'zh.json'), 'utf8'))
  const enKeys = deepKeys(en.ui)
  const zhKeys = deepKeys(zh.ui)
  assert.deepEqual(enKeys, zhKeys, 'en/zh UI key sets must be identical')
  assert.ok(enKeys.length >= 85, `expected the full M3 inventory (>=85 keys), found ${enKeys.length}`)
  const keys = new Set(enKeys)
  for (const key of SCAFFOLD_UI_KEYS) {
    assert.ok(keys.has(key), `scaffold UI string disappeared: ${key}`)
    assert.ok(typeof en.ui[key] === 'string' && en.ui[key].trim() !== '', `empty en string ${key}`)
    assert.ok(typeof zh.ui[key] === 'string' && zh.ui[key].trim() !== '', `empty zh string ${key}`)
  }
  for (const key of ['panel', 'board.title', 'questions.open', 'markRead', 'confirm.disable.action', 'state.loadError']) {
    assert.ok(keys.has(key), `missing required panel string ${key}`)
  }
})

// ---------------------------------------------------------------------------
// icon
// ---------------------------------------------------------------------------

test('icon.svg is an original, self-contained, script-free vector', () => {
  const buffer = readFileSync(ICON_PATH)
  assert.ok(buffer.length > 200, 'icon.svg is suspiciously small')
  assert.ok(buffer.length < 256 * 1024, 'icon.svg exceeds the 256 KiB limit')
  const svg = buffer.toString('utf8')
  assert.match(svg, /^<svg\b/)
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /viewBox="/)
  assert.doesNotMatch(svg, /<script/i)
  assert.doesNotMatch(svg, /<text/i, 'design requires text-free artwork')
  assert.doesNotMatch(svg, /<image\b/i)
  assert.doesNotMatch(svg, /\b(?:href|src)\s*=\s*["'](?:https?:)?\/\//i, 'no external references allowed')
  assert.doesNotMatch(svg, /xlink:href/i)
  assert.ok((svg.match(/<path\b/g) ?? []).length >= 3, 'expected multi-stream geometry')
})

// ---------------------------------------------------------------------------
// Host entry
// ---------------------------------------------------------------------------

test('index.js imports cleanly and has no import side effects', () => {
  const result = importQuietly(pathToFileURL(INDEX_PATH).href)
  assert.equal(result.error, undefined, `spawn failed: ${result.error?.message}`)
  assert.equal(result.status, 0, `import failed:\n${result.stderr}`)
  assert.equal(result.stdout.trim(), '', 'importing index.js must not write to stdout')
  assert.equal(result.stderr.trim(), '', 'importing index.js must not write to stderr')
})

test('index.js exports the implemented Host entry surface', async () => {
  const module = await import(pathToFileURL(INDEX_PATH).href)
  assert.equal(module.name, 'confluence')
  assert.equal(typeof module.apply, 'function')
  assert.equal(typeof module.applyWithDeps, 'function', 'applyWithDeps must be exported for hermetic tests')
  assert.equal(module.default, undefined, 'must use the apply(ctx, config) export form')
  assert.equal(typeof module.DEFAULTS, 'object')
  assert.equal(module.VERSION, '0.1.0')
  assert.equal(Object.isFrozen(module.DEFAULTS), true, 'DEFAULTS must stay frozen')
  assert.ok(Array.isArray(module.inject), 'inject must be an array')
  assert.ok(module.inject.includes('tools'), "inject must include 'tools'")
  assert.deepEqual(JSON.parse(JSON.stringify(module.DEFAULTS)), DEFAULTS)
})

test('apply() returns without throwing on a minimal fake ctx', async () => {
  const module = await import(pathToFileURL(INDEX_PATH).href)
  const dirs = [mkdtempSync(path.join(tmpdir(), 'confluence-contract-')), mkdtempSync(path.join(tmpdir(), 'confluence-contract-'))]
  const configs = [{ store: { dir: dirs[0] } }, { store: 'not-an-object', debug: { logFile: '' } }]
  try {
    for (let index = 0; index < configs.length; index += 1) {
      const warnings = []
      const ctx = {
        get: () => undefined,
        on: () => () => {},
        effect: () => undefined,
        logger: {
          debug() {},
          info() {},
          warn(...args) {
            warnings.push(args)
          },
          error(...args) {
            warnings.push(args)
          },
        },
      }
      const returned = module.apply(ctx, configs[index])
      assert.ok(returned instanceof Promise, 'apply() must return a promise-like bootstrap handle')
      await Promise.race([
        returned,
        new Promise((_, reject) => setTimeout(() => reject(new Error('apply bootstrap timed out')), 15000)),
      ])
    }
  } finally {
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup.
      }
    }
  }
})

test('production host code stays offline and the client half is a read-only same-origin module', () => {
  const networkImport = /from\s+['"]node:(?:http|https|net|tls|dgram|child_process)['"]|require\(\s*['"]node:(?:http|https|net|tls|dgram|child_process)['"]\s*\)/
  const harnessImport = /from\s+['"]@deepseek-ai\/|require\(\s*['"]@deepseek-ai\//
  const fetchCall = /\bfetch\s*\(/
  // `new URL(relative, 'http://127.0.0.1')` is a parser base, not an egress target.
  const parserBase = /['"]http:\/\/127\.0\.0\.1['"]/g
  for (const { relPath, source } of hostSources()) {
    assert.doesNotMatch(source, networkImport, `${relPath} must not import network/child-process modules`)
    assert.doesNotMatch(source, harnessImport, `${relPath} must not import @deepseek-ai packages`)
    assert.doesNotMatch(source, fetchCall, `${relPath} must not call fetch()`)
    const withoutParserBase = source.replace(parserBase, "''")
    assert.doesNotMatch(withoutParserBase, /https?:\/\//, `${relPath} must not contain network URL literals`)
  }

  const client = readFileSync(CLIENT_PATH, 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/, 'client.js must use the Dynamic ModuleLoader')
  assert.match(client, /id:\s*'dsh-confluence'/, "client.js module id must be 'dsh-confluence'")
  assert.doesNotMatch(client, /^\s*import\s/m, 'client.js is a plain browser module, not an ESM import graph')
  assert.doesNotMatch(client, harnessImport, 'client.js must not import @deepseek-ai packages')
  const fetchCalls = client.match(/\bfetch\s*\(/g) ?? []
  assert.equal(fetchCalls.length, 1, 'client.js must have exactly one fetch call (the relative panel GET)')
  assert.match(client, /fetch\(ROUTE_BASE/, 'the only fetch must target the relative panel route base')
  assert.doesNotMatch(client, /https?:\/\//, 'client.js must not contain absolute URLs')
  assert.doesNotMatch(client, /\binnerHTML\b|dangerouslySetInnerHTML/, 'panel must render untrusted text as React children')
  assert.doesNotMatch(client, /<iframe|createElement\(['"]iframe/, 'no iframe transport is allowed')
  assert.match(client, /inject:\s*\[\s*'slots'\s*,\s*'locale'\s*,\s*'layout'\s*\]/, 'client inject list changed')
  assert.match(client, /name:\s*'sidebar\.panellist'[\s\S]{0,120}id:\s*'confluence'[\s\S]{0,120}order:\s*30/)
  assert.match(client, /name:\s*'main'[\s\S]{0,120}key:\s*'confluence'/)
})

// ---------------------------------------------------------------------------
// repository documentation
// ---------------------------------------------------------------------------

test('README.md and README.zh-CN.md describe the implemented v0.1.0 state honestly', () => {
  const en = path.join(ROOT, 'README.md')
  const zh = path.join(ROOT, 'README.zh-CN.md')
  assert.ok(existsSync(en), 'missing README.md')
  assert.ok(existsSync(zh), 'missing README.zh-CN.md')
  const enText = readFileSync(en, 'utf8')
  const zhText = readFileSync(zh, 'utf8')
  for (const marker of [
    'Confluence / 汇流',
    'v0.1.0',
    'implemented',
    'Host',
    'panel',
    '256',
    'docs/install.md',
    'docs/publishing.md',
    'docs/plan/implementation-interfaces.md',
    'docs/plan/implementation-status.md',
    'node --test',
    'MIT',
    'https://github.com/XiaoleC05/Confluence',
  ]) {
    assert.ok(enText.includes(marker), `README.md is missing required content: ${marker}`)
  }
  for (const marker of ['汇流', 'v0.1.0', '256', 'docs/install.md', 'node --test', 'MIT']) {
    assert.ok(zhText.includes(marker), `README.zh-CN.md is missing required content: ${marker}`)
  }
  assert.match(enText.replace(/\s+/g, ' '), /not (been )?(installed|verified|executed)/i, 'README must keep the not-executed claims')
  assert.doesNotMatch(enText.replace(/\s+/g, ' '), /design-stage scaffold/i, 'README must no longer describe a design-stage scaffold as current state')
  for (const [file, text] of [['README.md', enText], ['README.zh-CN.md', zhText]]) {
    const lines = lineCount(path.join(ROOT, file))
    assert.ok(lines >= 200 && lines <= 430, `${file} must be 200–430 lines (found ${lines})`)
  }
})

test('docs/README.md exists, links resolve, and names every promised document', () => {
  assert.ok(existsSync(DOCS_README), 'missing docs/README.md')
  const text = readFileSync(DOCS_README, 'utf8')
  for (const target of markdownLinkTargets(text)) {
    const resolved = path.resolve(path.join(ROOT, 'docs'), target)
    assert.ok(
      existsSync(resolved) && statSync(resolved).isFile(),
      `docs/README.md link target does not exist: ${target}`,
    )
  }
  for (const required of REQUIRED_DOCS) {
    assert.ok(text.includes(required), `docs/README.md must mention ${required}`)
  }
})

test('documents promised by docs/README.md exist and are non-empty Markdown', () => {
  for (const required of REQUIRED_DOCS) {
    const file = path.join(ROOT, 'docs', required)
    assert.ok(existsSync(file), `docs/README.md promises a missing doc: ${required}`)
    assert.ok(statSync(file).size > 200, `doc ${required} is suspiciously empty`)
    assert.match(readFileSync(file, 'utf8'), /^#\s/m, `doc ${required} must start with a Markdown heading`)
  }
})

test('install and publishing docs keep the executed/not-executed honesty', () => {
  const install = path.join(ROOT, 'docs', 'install.md')
  const publishing = path.join(ROOT, 'docs', 'publishing.md')
  assert.ok(existsSync(install), 'missing docs/install.md')
  assert.ok(existsSync(publishing), 'missing docs/publishing.md')
  const installText = readFileSync(install, 'utf8')
  const publishingText = readFileSync(publishing, 'utf8')
  for (const marker of ['install_bundle', 'dsh plugin --profile', 'Not executed', 'scratch', 'rollback']) {
    assert.ok(installText.toLowerCase().includes(marker.toLowerCase()), `install.md is missing: ${marker}`)
  }
  for (const marker of ['npm pack', 'version', 'checksum', 'nothing was published', 'GitHub']) {
    assert.ok(publishingText.toLowerCase().includes(marker.toLowerCase()), `publishing.md is missing: ${marker}`)
  }
})

// ---------------------------------------------------------------------------
// shipped file set
// ---------------------------------------------------------------------------

test('the shipped runtime surface is exactly the implemented Host modules, client and resources', () => {
  const actualLib = readdirSync(LIB_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
  assert.deepEqual(actualLib, LIB_MODULES.slice().sort(), 'lib/ module set changed without a packaging update')
  assert.equal(LIB_MODULES.length, 15, 'the v0.1.0 Host has exactly 14 lib modules')
  assert.ok((PACKAGE_JSON.files ?? []).includes('lib/*.js'), 'files must ship lib/*.js')
  for (const relPath of EXPECTED_FILES) {
    assert.ok(existsSync(path.join(ROOT, relPath)), `missing shipped file ${relPath}`)
  }
  const indexSource = readFileSync(INDEX_PATH, 'utf8')
  assert.match(indexSource, /from '\.\/lib\//, 'index.js must import the Host modules')
})

// ---------------------------------------------------------------------------
// standalone checker
// ---------------------------------------------------------------------------

test('scripts/check.mjs runs standalone and passes', () => {
  const checker = path.join(ROOT, 'scripts', 'check.mjs')
  assert.ok(existsSync(checker), 'missing scripts/check.mjs')
  const result = spawnSync(process.execPath, ['scripts/check.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  })
  assert.equal(result.error, undefined, `checker spawn failed: ${result.error?.message}`)
  assert.equal(result.status, 0, `scripts/check.mjs failed:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`)
  assert.match(result.stdout, /passed/i)
})
