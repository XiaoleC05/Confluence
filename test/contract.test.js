// Confluence / 汇流 — dependency-free contract tests.
//
// These tests verify the *packaging contract* of the design-stage repository:
// they do not test unimplemented plugin behaviour (there is none yet). The
// standalone mirror of these checks is scripts/check.mjs.
//
// Run from the repository root:
//   node --test "test/*.test.js"
//
// Node builtins only. Nothing here touches the network or installs anything.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_DIR = ROOT
const PACKAGE_JSON = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const INDEX_PATH = path.join(ROOT, 'index.js')
const PATCH_PATH = path.join(ROOT, 'cordis.patch.yml')
const ICON_PATH = path.join(ROOT, 'icon.svg')
const DOCS_README = path.join(ROOT, 'docs', 'README.md')

/** Every documentation path this repository promises in docs/README.md. */
const REQUIRED_DOCS = [
  'research/dsh-internals.md',
  'research/prior-art.md',
  'research/external-patterns.md',
  'discussion/round-1.md',
  'discussion/round-2.md',
  'discussion/position-a.md',
  'discussion/position-b.md',
  'adr/0001-confluence-architecture.md',
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
  'publishing.md',
  'install.md',
  'planning/team-brief.md',
]

/** Runtime/display files that must be covered by package.json "files". */
const EXPECTED_FILES = [
  'index.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
]

const EXPECTED_UI_KEYS = [
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
  },
  ui: { enabled: true, pollMs: 5000 },
  export: { enabled: false, dir: '.confluence/export' },
  debug: { logFile: '' },
}

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

/** @returns {string[]} warnings captured by a fake logger-aware ctx */
function runApply(config, extraCtx = {}) {
  const calls = []
  const logger = {
    warn(...args) {
      calls.push(args.join(' '))
    },
    info() {},
    error() {},
    debug() {},
  }
  const ctx = new Proxy({ logger, ...extraCtx }, {
    get(target, property) {
      if (property === 'logger') return target.logger
      throw new Error(`design-stage apply() must not access ctx.${String(property)}`)
    },
  })
  // The plugin entry is loaded lazily so the import-side-effect test owns the
  // only place a fresh module graph is created.
  return { calls, ctx }
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

test('package.json is a private ESM design-stage bundle manifest', () => {
  assert.equal(PACKAGE_JSON.name, 'dsh-confluence')
  assert.equal(PACKAGE_JSON.version, '0.1.0')
  assert.equal(PACKAGE_JSON.private, true)
  assert.equal(PACKAGE_JSON.type, 'module')
  assert.equal(PACKAGE_JSON.main, './index.js')
  assert.equal(PACKAGE_JSON.license, 'MIT')
  assert.match(PACKAGE_JSON.description, /design-stage/i)
  assert.match(PACKAGE_JSON.author, /XiaoleC05/i)
  assert.match(PACKAGE_JSON.repository.url, /github\.com\/XiaoleC05\/Confluence\.git$/)
  assert.equal(PACKAGE_JSON.homepage, 'https://github.com/XiaoleC05/Confluence#readme')
  assert.match(PACKAGE_JSON.bugs.url, /github\.com\/XiaoleC05\/Confluence\/issues$/)
})

test('package.json exports and files cover exactly the design-stage runtime surface', () => {
  const exports = PACKAGE_JSON.exports
  assert.equal(exports['.'], './index.js')
  assert.equal(exports['./locale/*.json'], './locale/*.json')
  assert.equal(exports['./icon'], './icon.svg')
  assert.equal('./client' in exports, false, 'client half is M3; no ./client export yet')
  assert.equal(PACKAGE_JSON.dsh.client, undefined, 'dsh.client must not be declared yet')

  assert.deepEqual(PACKAGE_JSON.dsh.bundle, { patch: './cordis.patch.yml' })
  assert.ok(Array.isArray(PACKAGE_JSON.files))
  for (const required of ['index.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(PACKAGE_JSON.files.includes(required), `files must include ${required}`)
  }
  for (const relPath of EXPECTED_FILES) {
    assert.ok(
      PACKAGE_JSON.files.some((pattern) => filesPatternMatches(pattern, relPath)),
      `runtime file ${relPath} is not covered by package.json files`,
    )
  }
  for (const relPath of EXPECTED_FILES) {
    assert.ok(existsSync(path.join(PACKAGE_DIR, relPath)), `missing runtime file ${relPath}`)
  }
})

test('package.json engines, scripts and dependency-free posture are honest', () => {
  assert.equal(PACKAGE_JSON.engines.node, '>=22.19.0')
  assert.equal(PACKAGE_JSON.engines.dsh, '>=0.2.2-rc.1')
  assert.equal(PACKAGE_JSON.scripts.test, 'node --test "test/*.test.js"')
  assert.equal(PACKAGE_JSON.scripts.check, 'node scripts/check.mjs')
  assert.ok(Array.isArray(PACKAGE_JSON.keywords))
  assert.ok(PACKAGE_JSON.keywords.includes('dsh'))
  // Design stage: no runtime dependency may be needed to mount the scaffold.
  assert.equal(PACKAGE_JSON.dependencies, undefined)
  assert.equal(PACKAGE_JSON.devDependencies, undefined)
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
  assert.equal(patch.includes('!!js'), false, 'design-stage patch must not use !!js expressions')
})

test('cordis.patch.yml carries the complete ADR §10 default configuration', () => {
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
})

test('locale UI key sets are aligned and contain the planned panel strings', () => {
  const en = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'zh.json'), 'utf8'))
  assert.deepEqual(deepKeys(en.ui), deepKeys(zh.ui), 'en/zh UI key sets must be identical')
  const keys = new Set(deepKeys(en.ui))
  for (const key of EXPECTED_UI_KEYS) {
    assert.ok(keys.has(key), `missing future-UI string ${key}`)
    assert.ok(typeof en.ui[key] === 'string' && en.ui[key].trim() !== '', `empty en string ${key}`)
    assert.ok(typeof zh.ui[key] === 'string' && zh.ui[key].trim() !== '', `empty zh string ${key}`)
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
// host entry
// ---------------------------------------------------------------------------

test('index.js imports cleanly, exports the apply form, and has no import side effects', () => {
  const importUrl = pathToFileURL(INDEX_PATH).href
  const code = `await import(${JSON.stringify(importUrl)})`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  })
  assert.equal(result.error, undefined, `spawn failed: ${result.error?.message}`)
  assert.equal(result.status, 0, `import failed:\n${result.stderr}`)
  assert.equal(result.stdout.trim(), '', 'importing index.js must not write to stdout')
  assert.equal(result.stderr.trim(), '', 'importing index.js must not write to stderr')
})

test('index.js exports name/apply/defaults and does not use the service-class form', async () => {
  const module = await import(pathToFileURL(INDEX_PATH).href)
  assert.equal(module.name, 'confluence')
  assert.equal(typeof module.apply, 'function')
  assert.equal(module.default, undefined, 'must use the apply(ctx, config) export form')
  assert.equal(typeof module.resolveConfig, 'function')
  assert.equal(typeof module.DEFAULTS, 'object')
  assert.equal(Object.isFrozen(module.DEFAULTS), true, 'DEFAULTS must stay frozen')
  assert.deepEqual(JSON.parse(JSON.stringify(module.DEFAULTS)), DEFAULTS)
})

test('apply() logs exactly one design-stage warning and registers nothing', async () => {
  const module = await import(pathToFileURL(INDEX_PATH).href)
  for (const config of [undefined, null, 'garbage', [], {}, { enabled: false }]) {
    const { calls, ctx } = runApply(config)
    const returned = module.apply(ctx, config)
    assert.equal(returned, undefined, `apply() must return nothing (config=${JSON.stringify(config)})`)
    assert.equal(calls.length, 1, `apply() must log exactly one warning (config=${JSON.stringify(config)})`)
    assert.match(calls[0], /design-stage scaffold/i)
    assert.match(calls[0], /no tools or UI/i)
    assert.match(calls[0], /M1/)
  }
})

test('apply() degrades on malformed sections, warns once, and never throws', async () => {
  const module = await import(pathToFileURL(INDEX_PATH).href)
  const malformed = [
    { store: 'not-an-object', pulse: { maxHeadlines: 'many' } },
    { privacy: { denyPathPatterns: 'nope', privateSessions: [1, 'ok'] } },
    { recall: { timeoutMs: Number.NaN }, ui: { pollMs: -1 } },
    { enabled: 'yes' },
  ]
  for (const config of malformed) {
    const { calls, ctx } = runApply(config)
    const returned = module.apply(ctx, config)
    assert.equal(returned, undefined)
    assert.equal(calls.length, 1)
    assert.match(calls[0], /design-stage scaffold/i)
  }
  const { calls, ctx } = runApply({ store: 'not-an-object', enabled: 'yes' })
  module.apply(ctx, { store: 'not-an-object', enabled: 'yes' })
  assert.match(calls[0], /config warnings:/, 'malformed values must be reported in the single warning')
  assert.match(calls[0], /store ignored \(invalid section\)/)
  assert.match(calls[0], /enabled ignored \(invalid value\)/)
})

test('production host code stays offline: no network, no child process, no DSH imports', () => {
  const source = readFileSync(INDEX_PATH, 'utf8')
  assert.doesNotMatch(source, /from\s+['"]node:(?:http|https|net|tls|dgram|child_process)['"]/)
  assert.doesNotMatch(source, /require\(\s*['"]node:(?:http|https|net|tls|dgram|child_process)['"]\s*\)/)
  assert.doesNotMatch(source, /\bfetch\s*\(/)
  assert.doesNotMatch(source, /\bXMLHttpRequest\b/)
  assert.doesNotMatch(source, /from\s+['"]@deepseek-ai\//)
  assert.doesNotMatch(source, /require\(\s*['"]@deepseek-ai\//)
})

// ---------------------------------------------------------------------------
// repository documentation
// ---------------------------------------------------------------------------

test('README.md and README.zh-CN.md exist, are substantial, and stay honest', () => {
  const en = path.join(ROOT, 'README.md')
  const zh = path.join(ROOT, 'README.zh-CN.md')
  assert.ok(existsSync(en), 'missing README.md')
  assert.ok(existsSync(zh), 'missing README.zh-CN.md')
  const enText = readFileSync(en, 'utf8')
  const zhText = readFileSync(zh, 'utf8')
  for (const marker of ['Confluence / 汇流', 'Status', 'M1', 'docs/install.md', 'docs/publishing.md', 'node --test', 'MIT', 'https://github.com/XiaoleC05/Confluence']) {
    assert.ok(enText.includes(marker), `README.md is missing required content: ${marker}`)
  }
  for (const marker of ['汇流', 'M1', 'docs/install.md', 'node --test', 'MIT']) {
    assert.ok(zhText.includes(marker), `README.zh-CN.md is missing required content: ${marker}`)
  }
  assert.match(enText.replace(/\s+/g, ' '), /no user-visible effect/i, 'README must state the design-stage emptiness')
  assert.match(enText, /not been (installed|executed)|Not executed/i)
  for (const [file, text] of [['README.md', enText], ['README.zh-CN.md', zhText]]) {
    const lines = lineCount(path.join(ROOT, file))
    assert.ok(lines >= 200 && lines <= 350, `${file} must be 200–350 lines (found ${lines})`)
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
  for (const adr of ['adr/0002', 'adr/0003', 'adr/0004', 'adr/0005', 'adr/0006']) {
    assert.ok(text.includes(adr), `docs/README.md must mention planned decision record ${adr}`)
  }
})

test('documents promised by docs/README.md that already exist are non-empty Markdown', () => {
  for (const required of REQUIRED_DOCS) {
    const file = path.join(ROOT, 'docs', required)
    if (!existsSync(file)) continue // still in progress during round 3
    assert.ok(statSync(file).size > 200, `doc ${required} exists but is suspiciously empty`)
    assert.match(readFileSync(file, 'utf8'), /^#\s/m, `doc ${required} must start with a Markdown heading`)
  }
})

test('install and publishing docs exist and keep their honesty sections', () => {
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
// standalone checker
// ---------------------------------------------------------------------------

test('scripts/check.mjs runs standalone and passes', () => {
  const checker = path.join(ROOT, 'scripts', 'check.mjs')
  assert.ok(existsSync(checker), 'missing scripts/check.mjs')
  const result = spawnSync(process.execPath, ['scripts/check.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  })
  assert.equal(result.error, undefined, `checker spawn failed: ${result.error?.message}`)
  assert.equal(result.status, 0, `scripts/check.mjs failed:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`)
  assert.match(result.stdout, /passed/i)
})
