#!/usr/bin/env node
// Confluence / 汇流 — standalone contract check (design-stage repository).
//
// Mirrors the packaging checks in test/contract.test.js so that CI or a human
// can run one command without the test runner:
//   node scripts/check.mjs
//
// Node builtins only; no network, no installs, no profile changes. Exit code 0
// means every check passed. This script intentionally does NOT run the bundle
// and does not test unimplemented plugin behaviour.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INDEX_PATH = path.join(ROOT, 'index.js')
const PATCH_PATH = path.join(ROOT, 'cordis.patch.yml')
const ICON_PATH = path.join(ROOT, 'icon.svg')
const DOCS_README = path.join(ROOT, 'docs', 'README.md')

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

const EXPECTED_FILES = ['index.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json']

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
    redactPatterns: [],
  },
  ui: { enabled: true, pollMs: 5000 },
  export: { enabled: false, dir: '.confluence/export' },
  debug: { logFile: '' },
}

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
// shared helpers
// ---------------------------------------------------------------------------

function filesPatternMatches(pattern, relPath) {
  if (pattern === relPath) return true
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp('^' + escaped + '$').test(relPath)
}

function deepKeys(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  const out = []
  for (const key of Object.keys(value)) out.push(...deepKeys(value[key], prefix === '' ? key : `${prefix}.${key}`))
  return out.sort()
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

function lineCount(file) {
  const text = readFileSync(file, 'utf8')
  if (text === '') return 0
  const lines = text.split(/\r?\n/)
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

check('manifest: identity, engine range and metadata', () => {
  assertEquals(packageJson.name, 'dsh-confluence', 'name')
  assertEquals(packageJson.version, '0.1.0', 'version')
  assertEquals(packageJson.private, true, 'private')
  assertEquals(packageJson.type, 'module', 'type')
  assertEquals(packageJson.main, './index.js', 'main')
  assertEquals(packageJson.license, 'MIT', 'license')
  assertEquals(packageJson.engines.node, '>=22.19.0', 'engines.node')
  assertEquals(packageJson.engines.dsh, '>=0.2.2-rc.1', 'engines.dsh')
  assertEquals(packageJson.scripts.test, 'node --test "test/*.test.js"', 'scripts.test')
  assertEquals(packageJson.scripts.check, 'node scripts/check.mjs', 'scripts.check')
  assert(/design-stage/i.test(packageJson.description), 'description must state the design stage')
  assert(/XiaoleC05/.test(packageJson.author), 'author')
  assert(/github\.com\/XiaoleC05\/Confluence\.git$/.test(packageJson.repository.url), 'repository.url')
  assertEquals(packageJson.homepage, 'https://github.com/XiaoleC05/Confluence#readme', 'homepage')
  assert(/github\.com\/XiaoleC05\/Confluence\/issues$/.test(packageJson.bugs.url), 'bugs.url')
  assert(Array.isArray(packageJson.keywords) && packageJson.keywords.includes('dsh'), 'keywords')
})

check('manifest: exports/files describe only the design-stage surface', () => {
  assertEquals(packageJson.exports['.'], './index.js', 'exports[.]')
  assertEquals(packageJson.exports['./locale/*.json'], './locale/*.json', 'exports[locale]')
  assertEquals(packageJson.exports['./icon'], './icon.svg', 'exports[icon]')
  assert(!('./client' in packageJson.exports), 'client export must not exist before M3')
  assertEquals(packageJson.dsh.client, undefined, 'dsh.client must not be declared before M3')
  assertEquals(packageJson.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch')
  for (const required of ['index.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert(packageJson.files.includes(required), `files must include ${required}`)
  }
  for (const relPath of EXPECTED_FILES) {
    assert(existsSync(path.join(ROOT, relPath)), `missing runtime file ${relPath}`)
    assert(
      packageJson.files.some((pattern) => filesPatternMatches(pattern, relPath)),
      `runtime file ${relPath} is not covered by files`,
    )
  }
  assertEquals(packageJson.dependencies, undefined, 'dependency-free design stage')
  assertEquals(packageJson.devDependencies, undefined, 'dependency-free design stage')
})

check('patch: exactly one confluence row, full ADR §10 defaults, no !!js', () => {
  const patch = readFileSync(PATCH_PATH, 'utf8')
  assert(/^- insert:$/m.test(patch), 'patch must contain an insert block')
  assertEquals((patch.match(/^\s*-\s*id:\s*confluence\s*$/gm) ?? []).length, 1, 'confluence row count')
  assertEquals((patch.match(/^\s*name:\s*['"]?dsh-confluence['"]?\s*$/gm) ?? []).length, 1, 'row name count')
  assert(!patch.includes('!!js'), 'design-stage patch must not use !!js expressions')
  for (const section of ['store', 'pulse', 'ledger', 'recall', 'privacy', 'ui', 'export', 'debug']) {
    assert(new RegExp(`^        ${section}:$`, 'm').test(patch), `missing config section ${section}`)
  }
  assert(/^        enabled: true$/m.test(patch), 'top-level enabled default')
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
    "'**/.env*'",
    "'**/*.pem'",
  ]
  for (const snippet of expectedSnippets) assert(patch.includes(snippet), `patch missing: ${snippet}`)
})

check('locale: metadata and aligned future-UI key sets', () => {
  const en = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'zh.json'), 'utf8'))
  assertEquals(en.meta.title, 'Confluence', 'en meta.title')
  assertEquals(zh.meta.title, '汇流', 'zh meta.title')
  assert(en.meta.description.trim().length >= 20, 'en meta.description too short')
  assert(zh.meta.description.trim().length >= 20, 'zh meta.description too short')
  const enKeys = deepKeys(en.ui)
  const zhKeys = deepKeys(zh.ui)
  assertEquals(JSON.stringify(enKeys), JSON.stringify(zhKeys), 'en/zh UI key alignment')
  const keys = new Set(enKeys)
  for (const key of EXPECTED_UI_KEYS) {
    assert(keys.has(key), `missing future-UI string ${key}`)
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
  assert(!/xlink:href/i.test(svg), 'icon must not use xlink references')
  assert((svg.match(/<path\b/g) ?? []).length >= 3, 'icon must contain multi-stream geometry')
})

check('host entry: import is side-effect free and exports name/apply/defaults', () => {
  const importUrl = pathToFileURL(INDEX_PATH).href
  const code = `await import(${JSON.stringify(importUrl)})`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  })
  assert(!result.error, `import spawn failed: ${result.error?.message ?? ''}`)
  assertEquals(result.status, 0, 'import exit status')
  assertEquals(result.stdout.trim(), '', 'import stdout')
  assertEquals(result.stderr.trim(), '', 'import stderr')
})

check('host entry: apply() logs one warning, registers nothing, tolerates bad config', async () => {
  const module = await import(pathToFileURL(INDEX_PATH).href)
  assertEquals(module.name, 'confluence', 'exported name')
  assertEquals(typeof module.apply, 'function', 'apply export')
  assertEquals(module.default, undefined, 'must not use the service-class export form')
  assert(Object.isFrozen(module.DEFAULTS), 'DEFAULTS must be frozen')
  assert(
    Array.isArray(module.DEFAULTS.privacy.redactPatterns) && module.DEFAULTS.privacy.redactPatterns.length === 0,
    'privacy.redactPatterns must default to [] (V3 sync)',
  )
  assertEquals(JSON.stringify(module.DEFAULTS), JSON.stringify(DEFAULTS), 'DEFAULTS match ADR §10')

  const malformed = [undefined, null, 'garbage', [], {}, { enabled: false }, { store: 'not-an-object' }]
  for (const config of malformed) {
    const calls = []
    const logger = { warn(...args) { calls.push(args.join(' ')) }, info() {}, error() {}, debug() {} }
    const ctx = new Proxy(
      { logger },
      {
        get(target, property) {
          if (property === 'logger') return target.logger
          throw new Error(`design-stage apply() must not access ctx.${String(property)}`)
        },
      },
    )
    const returned = module.apply(ctx, config)
    assertEquals(returned, undefined, `apply return (config=${JSON.stringify(config)})`)
    assertEquals(calls.length, 1, `warning count (config=${JSON.stringify(config)})`)
    assert(/design-stage scaffold/i.test(calls[0]), 'warning must state the design stage')
    assert(/M1/.test(calls[0]), 'warning must point at M1')
  }
})

check('host code: offline posture (no network, no child process, no DSH imports)', () => {
  const source = readFileSync(INDEX_PATH, 'utf8')
  assert(!/from\s+['"]node:(?:http|https|net|tls|dgram|child_process)['"]/.test(source), 'network/child-process import')
  assert(!/require\(\s*['"]node:(?:http|https|net|tls|dgram|child_process)['"]\s*\)/.test(source), 'require network/child-process')
  assert(!/\bfetch\s*\(/.test(source), 'fetch()')
  assert(!/\bXMLHttpRequest\b/.test(source), 'XMLHttpRequest')
  assert(!/from\s+['"]@deepseek-ai\//.test(source), 'static @deepseek-ai import')
  assert(!/require\(\s*['"]@deepseek-ai\//.test(source), 'static @deepseek-ai require')
})

check('README: honest design-stage documentation in English and Chinese', () => {
  const enPath = path.join(ROOT, 'README.md')
  const zhPath = path.join(ROOT, 'README.zh-CN.md')
  assert(existsSync(enPath), 'missing README.md')
  assert(existsSync(zhPath), 'missing README.zh-CN.md')
  const en = readFileSync(enPath, 'utf8')
  const zh = readFileSync(zhPath, 'utf8')
  for (const marker of [
    'Confluence / 汇流',
    'Status',
    'M1',
    'docs/install.md',
    'docs/publishing.md',
    'node --test',
    'MIT',
    'https://github.com/XiaoleC05/Confluence',
  ]) {
    assert(en.includes(marker), `README.md missing: ${marker}`)
  }
  for (const marker of ['汇流', 'M1', 'docs/install.md', 'node --test', 'MIT']) {
    assert(zh.includes(marker), `README.zh-CN.md missing: ${marker}`)
  }
  assert(/no user-visible effect/i.test(en.replace(/\s+/g, ' ')), 'README must state the design-stage emptiness')
  const enLines = lineCount(enPath)
  const zhLines = lineCount(zhPath)
  assert(enLines >= 200 && enLines <= 350, `README.md must be 200–350 lines (found ${enLines})`)
  assert(zhLines >= 200 && zhLines <= 350, `README.zh-CN.md must be 200–350 lines (found ${zhLines})`)
})

check('docs index: links resolve and every promised document is named', () => {
  assert(existsSync(DOCS_README), 'missing docs/README.md')
  const text = readFileSync(DOCS_README, 'utf8')
  for (const target of markdownLinkTargets(text)) {
    const resolved = path.resolve(path.join(ROOT, 'docs'), target)
    assert(existsSync(resolved) && statSync(resolved).isFile(), `broken docs/README.md link: ${target}`)
  }
  for (const required of REQUIRED_DOCS) assert(text.includes(required), `docs/README.md must mention ${required}`)
  for (const adr of ['adr/0002', 'adr/0003', 'adr/0004', 'adr/0005', 'adr/0006']) {
    assert(text.includes(adr), `docs/README.md must mention planned decision record ${adr}`)
  }
})

check('docs: install and publishing guides keep the verification honesty', () => {
  const install = readFileSync(path.join(ROOT, 'docs', 'install.md'), 'utf8')
  const publishing = readFileSync(path.join(ROOT, 'docs', 'publishing.md'), 'utf8')
  for (const marker of ['install_bundle', 'dsh plugin --profile', 'not executed', 'scratch', 'rollback']) {
    assert(install.toLowerCase().includes(marker), `install.md missing: ${marker}`)
  }
  for (const marker of ['npm pack', 'version', 'checksum', 'nothing was published', 'github']) {
    assert(publishing.toLowerCase().includes(marker), `publishing.md missing: ${marker}`)
  }
})

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

const passed = results.filter((result) => result.ok).length
const failed = results.length - passed
console.log('')
console.log(`Confluence contract check — ${results.length} checks, ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('Repository root: ' + ROOT)
  process.exitCode = 1
} else {
  console.log('All packaging contract checks passed (design stage; no plugin behaviour is tested).')
}
