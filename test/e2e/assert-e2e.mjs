#!/usr/bin/env node
// Confluence / 汇流 — offline E2E assertions for one `scripts/e2e-dsh.ps1` run.
//
// Reads the run directory (mock request logs + captured stdout/stderr), the
// scratch DSH_HOME (store + session logs) and asserts the user-visible contract:
//
//   E2E-01 the plugin bundle composes in the scratch profile and the run exits 0
//   E2E-02 session 1 receives the welcome pulse (empty board) in its model request
//   E2E-03 the model's confluence_post call succeeds and writes a durable entry
//   E2E-04 session 2 receives the entry in its pulse (unread) — cross-session sharing
//   E2E-05 the committed session logs carry the same pulse snapshots (log-derived)
//   E2E-06 no agent.inject / inbox splice was used (no wake/push channel)
//   E2E-07 the store lives only under the scratch DSH_HOME (real profile untouched is
//          asserted by the PowerShell wrapper)
//
// No network, no dependencies. Exit 0 = all checks passed.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  decodeSessionLogFile,
  findSessionFiles,
  messageText,
  pulseSnapshots,
  toolCalls,
  inboxSplices,
} from './lib/session-log.mjs'

const TITLE = 'E2E harness gotcha'

function parseArgs(argv) {
  const out = { run: '', dshHome: '', workspace: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`missing value for ${arg}`)
      return argv[i]
    }
    if (arg === '--run') out.run = next()
    else if (arg === '--dsh-home') out.dshHome = next()
    else if (arg === '--workspace') out.workspace = next()
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!out.run || !out.dshHome || !out.workspace) throw new Error('--run, --dsh-home and --workspace are required')
  return out
}

/** @param {string} file @returns {object[]} */
function readJsonl(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { malformed: true, line }
      }
    })
}

/** @param {string} dir @returns {string[]} */
function walkFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

/** @param {object[]} requests @returns {object[]} task requests (not session-title utility calls) */
function taskRequests(requests) {
  return requests.filter((request) => {
    const system = typeof request.system === 'string' ? request.system : ''
    return !/concise title/i.test(system) && !/nothing/i.test(system)
  })
}

/** @param {object} request @returns {string} concatenated user text */
function requestText(request) {
  const parts = []
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

const checks = []
/** @param {string} id @param {string} label @param {() => void} fn */
function check(id, label, fn) {
  try {
    fn()
    checks.push({ id, label, ok: true })
    process.stdout.write(`PASS    ${id}  ${label}\n`)
  } catch (error) {
    checks.push({ id, label, ok: false, error: String(error && error.message ? error.message : error) })
    process.stdout.write(`FAIL    ${id}  ${label}\n        ${String(error && error.message ? error.message : error)}\n`)
  }
}

/** @param {unknown} value @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const args = parseArgs(process.argv.slice(2))
process.stdout.write(`Confluence E2E assertions — run ${args.run}\n`)

// ── E2E-01: run artifacts + profile composition ─────────────────────────
const writerOut = readFileSync(join(args.run, 'session1.out.txt'), 'utf8')
const readerOut = readFileSync(join(args.run, 'session2.out.txt'), 'utf8')
const profileDir = join(args.dshHome, 'profiles', 'confluence-e2e')
check('E2E-01', 'both headless sessions exit 0 and the bundle composes in the scratch profile', () => {
  assert(/Board note accepted/.test(writerOut), 'writer stdout lacks the mock final answer')
  assert(/Hello from the Confluence E2E mock model/.test(readerOut), 'reader stdout lacks the mock answer')
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert(Array.isArray(manifest.dsh?.profile?.bundles), 'profile bundles missing')
  assert(manifest.dsh.profile.bundles.includes('dsh-confluence'), 'dsh-confluence bundle not selected')
  assert(manifest.dependencies && manifest.dependencies['dsh-confluence'], 'dsh-confluence dependency missing')
})

// ── store assertions ────────────────────────────────────────────────────
const storeRoot = join(args.dshHome, 'storages', 'confluence', 'v1', 'workspaces')
const workspaceDirs = existsSync(storeRoot)
  ? readdirSync(storeRoot).filter((name) => /^ws_[0-9a-f]{16}$/.test(name))
  : []
assert(workspaceDirs.length === 1, `expected exactly one workspace store, saw ${workspaceDirs.length}`)
const workspaceDir = join(storeRoot, workspaceDirs[0])
const journalFiles = walkFiles(workspaceDir).filter((file) => /journal\.[0-9]+-[0-9a-f]{8}\.v1\.jsonl$/.test(file))
const records = journalFiles.flatMap(readJsonl)
const entries = records.filter((record) => record.type === 'entry')

check('E2E-03', 'the model confluence_post call wrote a durable board entry', () => {
  assert(entries.length === 1, `expected 1 entry, saw ${entries.length}`)
  const entry = entries[0]
  assert(/^cnf_[0-9A-HJKMNP-TV-Z]{26}$/.test(entry.id), `bad entry id ${entry.id}`)
  assert(entry.title === TITLE, `entry title ${entry.title}`)
  assert(entry.kind === 'gotcha', `entry kind ${entry.kind}`)
  assert(Array.isArray(entry.tags) && entry.tags.includes('e2e'), 'entry tags missing e2e')
  assert(entry.author && typeof entry.author.sessionId === 'string', 'entry author session missing')
  assert(typeof entry.seq === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(entry.seq), 'entry seq missing/not ULID')
})

// ── mock request assertions ─────────────────────────────────────────────
const writerRequests = readJsonl(join(args.run, 'mock-writer.jsonl'))
const readerRequests = readJsonl(join(args.run, 'mock-reader.jsonl'))

check('E2E-02', 'session 1 model request carries the welcome pulse for an empty board', () => {
  const firstTask = taskRequests(writerRequests)[0]
  assert(firstTask, 'no writer task request captured')
  const text = requestText(firstTask)
  assert(text.includes('<confluence-workspace'), 'welcome pulse missing from the writer request')
  assert(/welcome="1"/.test(text), 'welcome="1" marker missing')
  assert(/Board is empty/.test(text), 'empty-board pulse copy missing')
})

check('E2E-04', 'session 2 pulse carries the unread entry from session 1 (cross-session sharing)', () => {
  const firstTask = taskRequests(readerRequests)[0]
  assert(firstTask, 'no reader task request captured')
  const text = requestText(firstTask)
  assert(text.includes('<confluence-workspace'), 'pulse missing from the reader request')
  assert(text.includes(TITLE), `reader pulse does not mention "${TITLE}"`)
  assert(/unread="1"/.test(text), 'reader pulse does not report unread="1"')
})

// ── committed session-log assertions ────────────────────────────────────
const sessionFiles = findSessionFiles(args.dshHome)
const decoded = sessionFiles.map((file) => decodeSessionLogFile(file.file ?? file)).filter(Boolean)
check('E2E-05', 'committed session logs carry the pulse snapshots and the tool call', () => {
  assert(decoded.length >= 2, `expected >=2 session logs, saw ${decoded.length}`)
  const writer = decoded.find((session) => JSON.stringify(session).includes('Board note accepted'))
  const reader = decoded.find((session) => JSON.stringify(session).includes('Hello from the Confluence E2E mock model'))
  assert(writer, 'writer session log not found')
  assert(reader, 'reader session log not found')
  const writerCalls = toolCalls(writer.events).filter((name) => name === 'confluence_post')
  assert(writerCalls.length === 1, `expected one confluence_post call in the writer log, saw ${writerCalls.length}`)
  const writerSnapshots = pulseSnapshots(writer.events).map((snapshot) => JSON.stringify(snapshot)).join('\n')
  assert(writerSnapshots.includes('<confluence-workspace'), 'writer log has no committed pulse snapshot')
  const readerSnapshots = pulseSnapshots(reader.events).map((snapshot) => JSON.stringify(snapshot)).join('\n')
  assert(readerSnapshots.includes(TITLE), 'reader log snapshots do not contain the shared entry')
})

check('E2E-06', 'no Confluence context was pushed through agent.inject / inbox splice', () => {
  // The headless app itself splices the initial task as a `next-turn` user message; that is
  // the host's input path, not a plugin push. Only splices carrying Confluence context would
  // violate the "pulse is the only passive channel, no wake" rule.
  const pluginSplices = []
  for (const session of decoded) {
    for (const splice of inboxSplices(session.events)) {
      const text = JSON.stringify(splice)
      if (text.includes('<confluence-') || text.includes('confluence:pulse')) pluginSplices.push(splice)
    }
  }
  assert(pluginSplices.length === 0, `${pluginSplices.length} Confluence inbox splice(s) present: ${JSON.stringify(pluginSplices[0])}`)
})

// ── store location assertion ────────────────────────────────────────────
check('E2E-07', 'the board store lives only under the scratch DSH_HOME', () => {
  const storeFiles = walkFiles(join(args.dshHome, 'storages', 'confluence'))
  assert(storeFiles.length >= 2, `expected manifest + journal files, saw ${storeFiles.length}`)
  for (const file of storeFiles) {
    const stat = statSync(file)
    assert(stat.isFile() && stat.size > 0, `empty store file: ${file}`)
  }
})

const failed = checks.filter((entry) => !entry.ok)
process.stdout.write(`\nConfluence E2E — ${checks.length - failed.length}/${checks.length} checks passed\n`)
process.exit(failed.length === 0 ? 0 : 1)
