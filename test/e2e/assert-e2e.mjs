#!/usr/bin/env node
// Confluence / 高级记忆 — offline E2E assertions for one `scripts/e2e-dsh.ps1` run.
//
// v0.2.0 (ADR-0007): the memory boundary is the DSH profile, not the workspace.
// The harness therefore runs acceptance sessions in TWO different directories of
// the same scratch profile:
//   A (workspace-a) publishes a note with `confluence_post`
//   B (workspace-b) makes no tool calls — its passive pulse must carry A's note
//   C (workspace-b) reads the board with `confluence_board`
//   D (workspace-b) reads the full note with `confluence_read`
// (plus one throwaway warm-up session that absorbs the first-mount activation race)
// against the local Messages-API mock. This script asserts the user-visible
// contract from the run directory, the scratch DSH_HOME and the committed logs:
//
//   E2E-01 all acceptance sessions exit 0; the bundle composes in the scratch profile
//   E2E-02 the writer's welcome pulse is `<confluence-memory scope="global" …>` (empty board)
//   E2E-03 `confluence_post` wrote ONE durable entry into the global journal
//          (`…/workspaces/ws_0000000000000000/`), with provenance origin metadata
//   E2E-04 CROSS-DIRECTORY (headline): session A's cwd != session B's cwd, and B's
//          passive pulse carries A's note title and the merged legacy title
//   E2E-05 committed session logs carry the same new-tag pulse snapshots and the
//          expected tool calls; no snapshot uses `<confluence-workspace>`
//   E2E-06 no Confluence context is pushed through agent/inject / inbox splices
//   E2E-07 the store lives only under the scratch DSH_HOME and the global scope dir is
//          `ws_0000000000000000` with an `All sessions` manifest; every file is non-empty
//   E2E-08 readers in the OTHER directory read the board and the full note via
//          `confluence_board` + `confluence_read` (body visible), incl. the legacy note
//   E2E-09 a seeded legacy v1 per-workspace journal is merged read-only and is
//          byte-identical afterwards (no migration writes)
//   E2E-10 no tool call passes a workspace/scope key (universal memory has no scope arg)
//   E2E-11 pulse watermarks: digestSeq commits for readers, boardReadSeq advances after
//          `confluence_board`/`confluence_read`, and `confluence_post` alone leaves it null
//
// No network, no dependencies. Exit 0 = all checks passed.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  LEGACY_PULSE_TAG,
  MEMORY_PULSE_TAG,
  decodeSessionLogFile,
  findSessionFiles,
  inboxSplices,
  pulseHeader,
  pulseSnapshots,
  toolCallRecords,
  toolResults,
} from './lib/session-log.mjs'

const GLOBAL_SCOPE_KEY = 'ws_0000000000000000'
const GLOBAL_SCOPE_LABEL = 'All sessions'

// Artifacts produced by scripts/e2e-dsh.ps1.
const NOTE_TITLE = 'Cross-directory harness gotcha'
const NOTE_KIND = 'gotcha'
const NOTE_BODY_MARKER = 'Synthetic shared-memory gotcha'
const NOTE_TAGS = ['e2e', 'fixture']
const WRITER_FINAL = 'Board note accepted'
const READER_FINAL = 'Hello from the Confluence E2E mock model'
const BOARD_FINAL = 'Cross-directory board confirmed.'
const NOTE_FINAL = 'Cross-directory note read confirmed.'
const RECALL_FINAL = 'Cross-directory recall confirmed.'
const RECALL_QUERY = 'cross-directory E2E harness gotcha'
const WARMUP_FINAL = 'Warm-up session completed'
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/
const SEQ_RE = /^[0-9A-Z]{1,26}$/

function parseArgs(argv) {
  const out = { run: '', dshHome: '', workspaceA: '', workspaceB: '', legacySeed: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`missing value for ${arg}`)
      return argv[i]
    }
    if (arg === '--run') out.run = next()
    else if (arg === '--dsh-home') out.dshHome = next()
    else if (arg === '--workspace-a') out.workspaceA = next()
    else if (arg === '--workspace-b') out.workspaceB = next()
    else if (arg === '--legacy-seed') out.legacySeed = next()
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!out.run || !out.dshHome || !out.workspaceA || !out.workspaceB) {
    throw new Error('--run, --dsh-home, --workspace-a and --workspace-b are required')
  }
  if (out.legacySeed === '') out.legacySeed = join(out.run, 'legacy-seed.json')
  return out
}

/** @param {string} file @returns {string} */
function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** @param {string} file @returns {any} */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** @param {object[]} requests @returns {object[]} task requests (not session-title utility calls) */
function taskRequests(requests) {
  return requests.filter((request) => {
    const system = typeof request.system === 'string' ? request.system : ''
    return !/concise title/i.test(system) && !/nothing/i.test(system)
  })
}

/** @param {object} request @returns {string} concatenated user text (all text blocks) */
function requestText(request) {
  const parts = []
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** @param {unknown} block @returns {string} */
function toolResultBlockText(block) {
  if (!block || typeof block !== 'object') return ''
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) {
    return block.content
      .map((inner) => (inner && typeof inner.text === 'string' ? inner.text : ''))
      .join('\n')
  }
  return typeof block.text === 'string' ? block.text : ''
}

/** @param {object} request @returns {string[]} rendered tool-result texts carried by a request */
function requestToolResults(request) {
  const out = []
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block && block.type === 'tool_result') out.push(toolResultBlockText(block))
    }
  }
  return out
}

/** @param {string} file @returns {object[]} */
function readJsonl(file) {
  return readText(file)
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

/** @param {string} file @returns {string} */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Canonical directory comparison (scratch dirs are short-lived; fold case like the plugin does). */
function sameDir(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left === '' || right === '') return false
  const canonical = (value) => {
    let full = resolve(value)
    try {
      full = realpathSync(full)
    } catch {
      /* keep the lexical path; the run directory is ours */
    }
    return process.platform === 'win32' ? full.toLowerCase() : full
  }
  return canonical(left) === canonical(right)
}

/** @param {unknown} value @returns {boolean} */
function isUlid(value) {
  return typeof value === 'string' && ULID_RE.test(value)
}

/** @param {object[]} sessions @param {string} needle @returns {object | undefined} */
function sessionWith(sessions, needle) {
  return sessions.find((session) => JSON.stringify(session.events).includes(needle))
}

/** Sessions whose committed log shows a successful call of `name` (not just an attempted call). */
function sessionWithSuccessfulTool(sessions, name) {
  return sessions.find((session) => {
    const calls = toolCallRecords(session.events).filter((call) => call.name === name)
    if (calls.length === 0) return false
    const ids = new Set(calls.map((call) => call.callId))
    return toolResults(session.events).some((result) => ids.has(result.callId) && !result.isError)
  })
}

const checks = []
/** @param {string} id @param {string} label @param {() => void} fn */
function check(id, label, fn) {
  try {
    fn()
    checks.push({ id, label, ok: true })
    process.stdout.write(`PASS    ${id}  ${label}\n`)
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    checks.push({ id, label, ok: false, error: message })
    process.stdout.write(`FAIL    ${id}  ${label}\n        ${message}\n`)
  }
}

/** @param {unknown} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const args = parseArgs(process.argv.slice(2))
process.stdout.write(`Confluence cross-directory E2E assertions — run ${args.run}\n`)
process.stdout.write(`  scratch dsh home: ${args.dshHome}\n  workspace A:      ${args.workspaceA}\n  workspace B:      ${args.workspaceB}\n`)

// ── load artifacts (safe reads: a missing artifact must surface as a named FAIL) ──
const outA = readText(join(args.run, 'session-a.out.txt'))
const outB = readText(join(args.run, 'session-b.out.txt'))
const outC = readText(join(args.run, 'session-c.out.txt'))
const outD = readText(join(args.run, 'session-d.out.txt'))
const outE = readText(join(args.run, 'session-e.out.txt'))
const outWarmup = readText(join(args.run, 'session-warmup.out.txt'))
const mockA = readJsonl(join(args.run, 'mock-a.jsonl'))
const mockB = readJsonl(join(args.run, 'mock-b.jsonl'))
const mockC = readJsonl(join(args.run, 'mock-c.jsonl'))
const mockD = readJsonl(join(args.run, 'mock-d.jsonl'))
const mockE = readJsonl(join(args.run, 'mock-e.jsonl'))

const storeRoot = join(args.dshHome, 'storages', 'confluence', 'v1', 'workspaces')
const storeDirs = existsSync(storeRoot) ? readdirSync(storeRoot).filter((name) => /^ws_[0-9a-f]{16}$/.test(name)) : []
const globalDir = join(storeRoot, GLOBAL_SCOPE_KEY)
const globalJournalFiles = walkFiles(globalDir).filter((file) => /journal\.[0-9]+-[0-9a-f]{8}\.v1\.jsonl$/.test(file))
const globalRecords = globalJournalFiles.flatMap(readJsonl)
const globalEntries = globalRecords.filter((record) => record.type === 'entry')
const globalSessions = globalRecords.filter((record) => record.type === 'session')

const decoded = []
for (const found of findSessionFiles(args.dshHome)) {
  try {
    decoded.push({ ...decodeSessionLogFile(found.file), file: found.file, sessionId: found.sessionId, encodedCwd: found.encodedCwd })
  } catch {
    /* a session log that cannot decode is reported by the checks that need it */
  }
}
const writerSession = sessionWithSuccessfulTool(decoded, 'confluence_post')
const readerSession = sessionWith(decoded, READER_FINAL)
const boardReaderSession = sessionWith(decoded, BOARD_FINAL)
const noteReaderSession = sessionWith(decoded, NOTE_FINAL)
const recallSession = sessionWith(decoded, RECALL_FINAL)
const warmupSession = sessionWith(decoded, WARMUP_FINAL)

let legacySeed = null
try {
  legacySeed = readJson(args.legacySeed)
} catch {
  legacySeed = null
}
const legacyTitle = legacySeed && legacySeed.entry ? legacySeed.entry.title : 'Legacy alpha decision'

// ── E2E-01: run artifacts + profile composition ─────────────────────────
const profileDir = join(args.dshHome, 'profiles', 'confluence-e2e')
check('E2E-01', 'every acceptance session exits 0 and the bundle composes in the scratch profile', () => {
  assert(/Board note accepted/.test(outA), 'writer session stdout lacks the mock final answer')
  assert(/Hello from the Confluence E2E mock model/.test(outB), 'pulse reader session stdout lacks the mock answer')
  assert(/Cross-directory board confirmed/.test(outC), 'board reader session stdout lacks the mock answer')
  assert(/Cross-directory note read confirmed/.test(outD), 'note reader session stdout lacks the mock answer')
  assert(/Cross-directory recall confirmed/.test(outE), 'recall session stdout lacks the mock answer')
  assert(/Warm-up session completed/.test(outWarmup), 'warm-up session stdout lacks its final answer')
  const manifest = readJson(join(profileDir, 'package.json'))
  assert(Array.isArray(manifest.dsh?.profile?.bundles), 'profile bundles missing')
  assert(manifest.dsh.profile.bundles.includes('dsh-confluence'), 'dsh-confluence bundle not selected')
  assert(manifest.dependencies && manifest.dependencies['dsh-confluence'], 'dsh-confluence dependency missing')
})

// ── E2E-02: writer welcome pulse uses the global tag/template ──────────
check('E2E-02', 'session A carries a <confluence-memory scope="global"> welcome pulse for the empty board', () => {
  const firstTask = taskRequests(mockA)[0]
  assert(firstTask, 'no writer task request captured')
  const text = requestText(firstTask)
  assert(!text.includes(`<${LEGACY_PULSE_TAG}`), `writer pulse still uses the legacy <${LEGACY_PULSE_TAG}> tag`)
  const header = pulseHeader(text)
  assert(header, 'writer request carries no pulse block')
  assert(header.tag === MEMORY_PULSE_TAG, `writer pulse tag is <${header.tag}>, expected <${MEMORY_PULSE_TAG}>`)
  assert(header.attributes.scope === 'global', 'writer pulse header lacks scope="global"')
  assert(header.attributes.welcome === '1', 'welcome="1" marker missing')
  assert(header.attributes.unread === '0', `writer welcome pulse reports unread="${header.attributes.unread}", expected 0 (empty board)`)
  assert(/\buntrusted\b/i.test(text), 'pulse warning line missing from the writer request')
  if (legacySeed) assert(!text.includes(legacyTitle), 'writer pulse already sees the legacy note; the fixture was seeded too early')
})

// ── E2E-03: the post wrote one durable global entry ───────────────────
check('E2E-03', 'confluence_post wrote ONE durable entry into the global journal with provenance', () => {
  assert(existsSync(globalDir), `global scope directory missing: ${globalDir}`)
  assert(globalJournalFiles.length >= 1, 'global journal file missing')
  assert(globalEntries.length === 1, `expected 1 entry in the global journal, saw ${globalEntries.length}`)
  const entry = globalEntries[0]
  assert(/^cnf_[0-9A-HJKMNP-TV-Z]{26}$/.test(entry.id), `bad entry id ${entry.id}`)
  assert(entry.ws === GLOBAL_SCOPE_KEY, `entry ws is "${entry.ws}", expected the global scope key`)
  assert(entry.title === NOTE_TITLE, `entry title is "${entry.title}"`)
  assert(entry.kind === NOTE_KIND, `entry kind is "${entry.kind}"`)
  assert(Array.isArray(entry.tags) && NOTE_TAGS.every((tag) => entry.tags.includes(tag)), 'entry tags missing e2e/fixture')
  assert(entry.author && typeof entry.author.sessionId === 'string', 'entry author session missing')
  assert(isUlid(entry.seq), 'entry seq missing/not a ULID')
  assert(typeof entry.body === 'string' && entry.body.includes(NOTE_BODY_MARKER), 'entry body marker missing')
  // Provenance is best-effort (ADR-0007 §2.1) but must never leak a path when present.
  if (entry.origin !== undefined) {
    assert(entry.origin && typeof entry.origin === 'object', 'entry origin is not an object')
    assert(!/[\\/]/.test(String(entry.origin.workspaceLabel ?? '')), `entry origin label leaks a path: ${entry.origin.workspaceLabel}`)
    if (entry.origin.workspaceLabel !== undefined) {
      assert(/^workspace-a$/i.test(entry.origin.workspaceLabel), `entry origin label is "${entry.origin.workspaceLabel}", expected "workspace-a"`)
    }
    if (entry.origin.workspaceKey !== undefined) {
      assert(/^ws_[0-9a-f]{16}$/.test(entry.origin.workspaceKey), `entry origin key is malformed: ${entry.origin.workspaceKey}`)
    }
  }
  // Ledger rows are global too: no session row may be written to a real workspace shard.
  assert(globalSessions.length >= 4, `expected global ledger rows for every session, saw ${globalSessions.length}`)
  for (const row of globalSessions) {
    assert(row.ws === GLOBAL_SCOPE_KEY, `session row ${row.id} carries ws "${row.ws}", expected the global scope key`)
  }
})

// ── E2E-04: HEADLINE — cross-directory passive pulse ───────────────────
check('E2E-04', "CROSS-DIRECTORY: session A cwd != session B cwd and B's pulse carries A's note", () => {
  assert(writerSession, 'writer session log (successful confluence_post) not found')
  assert(readerSession, 'pulse reader session log not found')
  assert(writerSession.header?.cwd, 'writer session header has no cwd')
  assert(readerSession.header?.cwd, 'reader session header has no cwd')
  assert(sameDir(writerSession.header.cwd, args.workspaceA), `writer session ran in "${writerSession.header.cwd}", expected workspace A`)
  assert(sameDir(readerSession.header.cwd, args.workspaceB), `reader session ran in "${readerSession.header.cwd}", expected workspace B`)
  assert(!sameDir(writerSession.header.cwd, readerSession.header.cwd), 'both sessions ran in the same directory; cross-directory claim is NOT proven')
  assert(writerSession.encodedCwd !== readerSession.encodedCwd, 'both sessions landed in one persisted-cwd bucket; directories did not differ')
  const firstTask = taskRequests(mockB)[0]
  assert(firstTask, 'no reader task request captured')
  const text = requestText(firstTask)
  assert(!text.includes(`<${LEGACY_PULSE_TAG}`), `reader pulse still uses the legacy <${LEGACY_PULSE_TAG}> tag`)
  const header = pulseHeader(text)
  assert(header, 'reader request carries no pulse block')
  assert(header.tag === MEMORY_PULSE_TAG, `reader pulse tag is <${header.tag}>, expected <${MEMORY_PULSE_TAG}>`)
  assert(header.attributes.scope === 'global', 'reader pulse header lacks scope="global"')
  assert(header.attributes.welcome === '1', 'reader pulse is not the welcome digest')
  assert(text.includes(NOTE_TITLE), `reader pulse does not mention session A's note "${NOTE_TITLE}"`)
  assert(text.includes(legacyTitle), `reader pulse does not mention the merged legacy note "${legacyTitle}"`)
  const unread = Number(header.attributes.unread ?? '0')
  assert(Number.isFinite(unread) && unread >= 2, `reader pulse reports unread="${header.attributes.unread}", expected >= 2 (note + legacy note)`)
})

// ── E2E-05: committed session logs ────────────────────────────────
check('E2E-05', 'committed session logs carry the new-tag pulse snapshots and the expected tool calls', () => {
  assert(decoded.length >= 5, `expected >=5 session logs, saw ${decoded.length}`)
  assert(writerSession && readerSession && boardReaderSession && noteReaderSession && recallSession, 'one of the acceptance session logs is missing')
  const writerCalls = toolCallRecords(writerSession.events).map((call) => call.name)
  assert(writerCalls.length === 1 && writerCalls[0] === 'confluence_post', `writer tool calls: [${writerCalls.join(',')}]`)
  const readerSnapshots = pulseSnapshots(readerSession.events)
  assert(readerSnapshots.length >= 1, 'reader log has no committed pulse snapshot')
  assert(readerSnapshots.every((snapshot) => snapshot.tag === MEMORY_PULSE_TAG), `reader pulse snapshots carry tags [${readerSnapshots.map((snapshot) => snapshot.tag).join(',')}]`)
  const readerPulse = readerSnapshots.map((snapshot) => snapshot.pulseText).join('\n')
  assert(readerPulse.includes(NOTE_TITLE), 'reader log snapshots do not contain the shared note')
  assert(readerPulse.includes(legacyTitle), 'reader log snapshots do not contain the merged legacy note')
  assert(readerPulse.includes('scope="global"'), 'reader log pulse snapshot lacks scope="global"')
  const boardReaderCalls = toolCallRecords(boardReaderSession.events).map((call) => call.name)
  assert(JSON.stringify(boardReaderCalls) === JSON.stringify(['confluence_board']), `board reader tool calls: [${boardReaderCalls.join(',')}]`)
  const noteReaderCalls = toolCallRecords(noteReaderSession.events).map((call) => call.name)
  assert(JSON.stringify(noteReaderCalls) === JSON.stringify(['confluence_read']), `note reader tool calls: [${noteReaderCalls.join(',')}]`)
  const recallCalls = toolCallRecords(recallSession.events).map((call) => call.name)
  assert(JSON.stringify(recallCalls) === JSON.stringify(['confluence_recall']), `recall session tool calls: [${recallCalls.join(',')}]`)
  for (const session of decoded) {
    for (const snapshot of pulseSnapshots(session.events)) {
      assert(snapshot.tag === MEMORY_PULSE_TAG, `a pulse snapshot in ${session.sessionId} still carries <${snapshot.tag}>`)
    }
  }
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

// ── E2E-07: store location, global scope dir, manifest ────────────
check('E2E-07', 'the store is only under the scratch DSH_HOME and the global scope dir is ws_0000000000000000', () => {
  const storeBase = join(args.dshHome, 'storages', 'confluence')
  assert(existsSync(storeBase), `Confluence store missing under the scratch DSH_HOME: ${storeBase}`)
  assert(resolve(storeBase).toLowerCase().startsWith(resolve(args.dshHome).toLowerCase()), 'store escaped the scratch DSH_HOME')
  assert(existsSync(globalDir), `global scope directory missing: ${globalDir}`)
  const expected = [GLOBAL_SCOPE_KEY, ...(legacySeed ? [legacySeed.wsKey] : [])].sort()
  assert(JSON.stringify([...storeDirs].sort()) === JSON.stringify(expected), `workspace dirs are [${[...storeDirs].sort().join(', ')}], expected [${expected.join(', ')}]`)
  const manifest = readJson(join(globalDir, 'MANIFEST.v1.json'))
  assert(manifest.format === 'confluence.store/v1' && manifest.formatVersion === 1, 'global manifest format is not confluence.store/v1')
  assert(manifest.ws === GLOBAL_SCOPE_KEY, `global manifest ws is "${manifest.ws}"`)
  assert(manifest.workspace && manifest.workspace.canonicalPath === '', 'global manifest must carry an empty canonicalPath')
  assert(/^all sessions$/i.test(String(manifest.workspace.label ?? '')), `global manifest label is "${manifest.workspace.label}", expected "${GLOBAL_SCOPE_LABEL}"`)
  const storeFiles = walkFiles(storeBase)
  assert(storeFiles.length >= 2, `expected manifest + journal files, saw ${storeFiles.length}`)
  for (const file of storeFiles) {
    const stat = statSync(file)
    assert(stat.isFile() && stat.size > 0, `empty store file: ${file}`)
  }
})

// ── E2E-08: board + full note read from the OTHER directory ─────────
check('E2E-08', 'workspace-B sessions read the board and the full note via confluence_board + confluence_read', () => {
  assert(boardReaderSession, 'board reader session log not found')
  assert(noteReaderSession, 'note reader session log not found')
  assert(sameDir(boardReaderSession.header?.cwd, args.workspaceB), `board reader ran in "${boardReaderSession.header?.cwd}", expected workspace B`)
  assert(sameDir(noteReaderSession.header?.cwd, args.workspaceB), `note reader ran in "${noteReaderSession.header?.cwd}", expected workspace B`)
  assert(!sameDir(boardReaderSession.header?.cwd, writerSession?.header?.cwd), 'board reader did not run in a different directory than the writer')
  const noteEntry = globalEntries[0]
  // Board read (session C).
  const boardResults = toolResults(boardReaderSession.events)
  assert(boardResults.length === 1, `expected one committed board result, saw ${boardResults.length}`)
  const boardResult = boardResults[0]
  assert(!boardResult.isError, 'confluence_board returned an error')
  assert(boardResult.text.includes('<confluence-board'), 'board result is not rendered as a <confluence-board> block')
  assert(boardResult.text.includes(NOTE_TITLE), `board result does not list "${NOTE_TITLE}"`)
  assert(boardResult.text.includes(legacyTitle), `board result does not list the merged legacy note "${legacyTitle}"`)
  assert(/through=[0-9A-HJKMNP-TV-Z]{1,26}/.test(boardResult.text), 'board result lacks the through= watermark marker')
  assert(!boardResult.text.includes(args.run), 'board result leaked an absolute scratch path into model-visible text')
  // Full note read (session D).
  const noteResults = toolResults(noteReaderSession.events)
  assert(noteResults.length === 1, `expected one committed note-read result, saw ${noteResults.length}`)
  const readResult = noteResults[0]
  assert(!readResult.isError, 'confluence_read returned an error')
  assert(readResult.text.includes('Body:'), 'note read result has no Body: line')
  assert(readResult.text.includes(NOTE_BODY_MARKER), 'note read result does not carry the writer body')
  assert(readResult.text.includes(noteEntry.id), 'note read result does not carry the writer note id')
  assert(!readResult.text.includes(args.run), 'note read result leaked an absolute scratch path into model-visible text')
  const readCall = toolCallRecords(noteReaderSession.events).find((call) => call.name === 'confluence_read')
  assert(readCall && readCall.input && readCall.input.ref === noteEntry.id, 'confluence_read was not called with the writer note id')
  // Wire-level cross-checks: the mock saw both rendered results in follow-up requests.
  const boardWire = mockC.find((request) => requestToolResults(request).some((text) => text.includes('<confluence-board')))
  assert(boardWire, 'mock never saw a board tool result in the board reader requests')
  const boardWireText = requestToolResults(boardWire).find((text) => text.includes('<confluence-board'))
  assert(boardWireText.includes(NOTE_TITLE), 'wire-level board result does not list the cross-directory note')
  assert(boardWireText.includes(legacyTitle), 'wire-level board result does not list the merged legacy note')
  const noteWire = mockD.find((request) => requestToolResults(request).some((text) => text.includes('Body:') && text.includes(NOTE_BODY_MARKER)))
  assert(noteWire, 'mock never saw a successful note-read body in the note reader requests')
})

// ── E2E-09: legacy merge is read-only ────────────────────────────
check('E2E-09', 'the seeded legacy workspace journal is merged and byte-identical afterwards', () => {
  assert(legacySeed, `legacy seed metadata missing: ${args.legacySeed}`)
  assert(Array.isArray(legacySeed.files) && legacySeed.files.length >= 2, 'legacy seed has no file list')
  const legacyDir = join(storeRoot, legacySeed.wsKey)
  assert(existsSync(legacyDir), `legacy workspace dir missing: ${legacyDir}`)
  for (const seeded of legacySeed.files) {
    const file = join(args.run, seeded.path)
    assert(existsSync(file), `seeded legacy file disappeared: ${seeded.path}`)
    assert(sha256(file) === seeded.sha256, `legacy file was modified (hash mismatch): ${seeded.path}`)
  }
  const legacyFiles = walkFiles(legacyDir)
  assert(legacyFiles.length === legacySeed.files.length, `legacy dir gained files (${legacyFiles.length} > ${legacySeed.files.length}); legacy must stay read-only`)
  const legacyRecords = legacyFiles.filter((file) => /journal\.[0-9]+-[0-9a-f]{8}\.v1\.jsonl$/.test(file)).flatMap(readJsonl)
  const legacyEntry = legacyRecords.find((record) => record.type === 'entry')
  assert(legacyEntry, 'seeded legacy journal has no entry record')
  assert(legacyEntry.ws === legacySeed.wsKey, 'legacy entry ws was rewritten')
  assert(legacyEntry.title === legacyTitle, 'legacy entry title was rewritten')
  assert(!globalRecords.some((record) => record.ws === legacySeed.wsKey), 'a legacy record was migrated into the global journal')
})

// ── E2E-10: no workspace/scope key is passed to any tool ──────────
check('E2E-10', 'no Confluence tool call passes a workspace/scope key (universal memory)', () => {
  const forbiddenKey = /^(ws|wsKey|workspace|workspaceId|workspaceKey|workspaceLabel|scope|scopeKey)$/i
  let toolCallCount = 0
  for (const session of decoded) {
    for (const call of toolCallRecords(session.events)) {
      if (!call.name.startsWith('confluence_')) continue
      toolCallCount += 1
      assert(call.parseError === undefined, `${call.name} call arguments are not JSON: ${call.parseError}`)
      const input = call.input ?? {}
      const offenders = Object.keys(input).filter((key) => forbiddenKey.test(key))
      assert(offenders.length === 0, `${call.name} passes forbidden scope argument(s): ${offenders.join(', ')}`)
      assert(!/\bws_[0-9a-f]{16}\b/.test(call.argumentsText), `${call.name} arguments embed a workspace key: ${call.argumentsText.slice(0, 120)}`)
    }
  }
  assert(toolCallCount >= 4, `expected at least 4 Confluence tool calls across the run, saw ${toolCallCount}`)
})

// ── E2E-11: pulse watermarks (digestSeq / boardReadSeq) ───────────
function watermarkOf(session) {
  if (!session) return null
  const file = join(args.dshHome, 'storages', 'session_projcache', 'sessions', `${session.sessionId}.json`)
  if (!existsSync(file)) return null
  const state = readJson(file)
  const row = state?.record?.rows?.confluence_watermark
  return row && row.val && typeof row.val === 'object' ? row.val : null
}

/** Newest committed `through=` marker in a session's successful tool results. */
function newestThrough(session) {
  const markers = toolResults(session.events)
    .filter((result) => !result.isError)
    .map((result) => /through=([0-9A-HJKMNP-TV-Z]{26})/.exec(result.text)?.[1])
    .filter((value) => typeof value === 'string')
  return markers.length === 0 ? null : markers.sort().at(-1)
}

check('E2E-11', 'pulse watermarks commit the digest and advance boardReadSeq after board/read', () => {
  const writerMark = watermarkOf(writerSession)
  const readerMark = watermarkOf(readerSession)
  const boardReaderMark = watermarkOf(boardReaderSession)
  const noteReaderMark = watermarkOf(noteReaderSession)
  const recallMark = watermarkOf(recallSession)
  assert(writerMark, 'writer watermark projection state missing (session_projcache)')
  assert(readerMark, 'reader watermark projection state missing (session_projcache)')
  assert(boardReaderMark, 'board reader watermark projection state missing (session_projcache)')
  assert(noteReaderMark, 'note reader watermark projection state missing (session_projcache)')
  assert(recallMark, 'recall session watermark projection state missing (session_projcache)')
  const noteEntry = globalEntries[0]
  assert(SEQ_RE.test(String(writerMark.digestSeq ?? '')), `writer digestSeq is "${writerMark.digestSeq}"`)
  assert(writerMark.boardReadSeq === null, `writer only posted but boardReadSeq is "${writerMark.boardReadSeq}"`)
  assert(isUlid(readerMark.digestSeq), `reader digestSeq is "${readerMark.digestSeq}"`)
  assert(readerMark.boardReadSeq === null, `reader took no board tool but boardReadSeq is "${readerMark.boardReadSeq}"`)
  assert(isUlid(boardReaderMark.digestSeq), `board reader digestSeq is "${boardReaderMark.digestSeq}"`)
  assert(isUlid(noteReaderMark.digestSeq), `note reader digestSeq is "${noteReaderMark.digestSeq}"`)
  // delta §10.3: boardReadSeq advances after confluence_board / confluence_read.
  assert(isUlid(boardReaderMark.boardReadSeq), `board reader boardReadSeq is "${boardReaderMark.boardReadSeq}" after confluence_board`)
  assert(boardReaderMark.boardReadSeq >= noteEntry.seq, 'board reader boardReadSeq did not reach the writer note seq')
  assert(isUlid(noteReaderMark.boardReadSeq), `note reader boardReadSeq is "${noteReaderMark.boardReadSeq}" after confluence_read`)
  assert(noteReaderMark.boardReadSeq >= noteEntry.seq, 'note reader boardReadSeq did not reach the writer note seq')
  const boardThrough = newestThrough(boardReaderSession)
  assert(boardThrough !== null, 'board reader committed no through= marker in its tool results')
  assert(boardReaderMark.boardReadSeq === boardThrough, `boardReadSeq "${boardReaderMark.boardReadSeq}" != newest through marker "${boardThrough}"`)
  const noteThrough = newestThrough(noteReaderSession)
  assert(noteThrough !== null, 'note reader committed no through= marker in its tool results')
  assert(noteReaderMark.boardReadSeq === noteThrough, `read boardReadSeq "${noteReaderMark.boardReadSeq}" != newest through marker "${noteThrough}"`)
  assert(isUlid(recallMark.digestSeq), `recall session digestSeq is "${recallMark.digestSeq}"`)
  assert(recallMark.boardReadSeq === null, `recall does not read the board but boardReadSeq is "${recallMark.boardReadSeq}"`)
})

// ── E2E-12: cross-directory recall ────────────────────────────────
check('E2E-12', 'confluence_recall from workspace B finds a literal phrase spoken in a workspace-A session', () => {
  assert(recallSession, 'recall session log not found')
  assert(sameDir(recallSession.header?.cwd, args.workspaceB), `recall session ran in "${recallSession.header?.cwd}", expected workspace B`)
  assert(!sameDir(recallSession.header?.cwd, writerSession?.header?.cwd), 'recall session did not run in a different directory than the writer')
  const results = toolResults(recallSession.events)
  assert(results.length === 1, `expected one committed recall result, saw ${results.length}`)
  const result = results[0]
  assert(!result.isError, 'confluence_recall returned an error')
  assert(result.text.includes('<confluence-session') === false, 'recall rendered a session read, not a hit list')
  const ref = /session:(?:session-)?([0-9a-f-]{36}):(\d+)/.exec(result.text)
  assert(ref, 'recall result carries no session:<id>:<seq> hit ref')
  const recalledId = `session-${ref[1]}`
  assert(recalledId !== recallSession.sessionId, 'recall returned the caller itself')
  const recalled = decoded.find((session) => session.sessionId === recalledId)
  assert(recalled, `recalled session ${recalledId} is not persisted in the scratch profile`)
  assert(sameDir(recalled.header?.cwd, args.workspaceA), `recalled session ran in "${recalled.header?.cwd}", expected workspace A`)
  assert(/cross-directory E2E harness gotcha/i.test(result.text), 'recall excerpt does not contain the queried phrase')
  const call = toolCallRecords(recallSession.events).find((entry) => entry.name === 'confluence_recall')
  assert(call && call.input && call.input.query === RECALL_QUERY, 'confluence_recall was not called with the expected query')
  const wire = mockE.find((request) =>
    requestToolResults(request).some((text) => /session:(?:session-)?[0-9a-f-]{36}:\d+/.test(text)),
  )
  assert(wire, 'mock never saw a recall hit ref in the recall session requests')
})

const failed = checks.filter((entry) => !entry.ok)
process.stdout.write(`\nConfluence cross-directory E2E — ${checks.length - failed.length}/${checks.length} checks passed\n`)
process.exit(failed.length === 0 ? 0 : 1)
