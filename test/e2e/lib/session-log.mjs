#!/usr/bin/env node
// Confluence / 汇流 — offline E2E session-log reader.
//
// DSH persists one logical session as a v4 JSONL file whose records are written
// in **concatenated zstd frames** (one frame per append batch), inside
// `<DSH_HOME>/sessions/<encoded-cwd>/<session-id>/session.v4.jsonl.zstd`.
// Node's one-shot zstd decoder stops after the first frame, so this module
// walks the zstd frame headers, decompresses each frame independently, and
// returns the session header plus every committed event.
//
// No dependency, no network, read-only. Used by `scripts/m0-smoke.mjs` and
// `test/e2e/assert-e2e.mjs`; the E2E assertions are the only reason the harness
// needs to read a session log at all.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Walk concatenated zstd frames and return their decompressed payloads.
 * Implements only the frame-skipping subset of RFC 8878 needed to find frame
 * boundaries: frame header descriptor, optional window/dictionary/content-size
 * fields, then block headers until the last-block flag.
 *
 * @param {Buffer} raw file bytes
 * @returns {Buffer[]} one decompressed buffer per frame
 */
export function decodeZstdFrames(raw) {
  const frames = []
  let offset = 0
  while (offset + 4 <= raw.length) {
    if (!raw.subarray(offset, offset + 4).equals(ZSTD_MAGIC)) {
      throw new Error(`zstd: no frame magic at offset ${offset} (of ${raw.length})`)
    }
    const fd = raw[offset + 4]
    const fcsFlag = fd >> 6
    const singleSegment = (fd & 0x20) !== 0
    const hasChecksum = (fd & 0x04) !== 0
    const dictFlag = fd & 0x03
    let cursor = offset + 5
    if (!singleSegment) cursor += 1 // Window_Descriptor
    cursor += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4
    const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    cursor += fcsSize
    if (cursor > raw.length) throw new Error(`zstd: truncated frame header at offset ${offset}`)
    // Blocks.
    let lastBlock = false
    while (!lastBlock) {
      if (cursor + 3 > raw.length) throw new Error(`zstd: truncated block header at offset ${cursor}`)
      const header = raw[cursor] | (raw[cursor + 1] << 8) | (raw[cursor + 2] << 16)
      const blockType = (header >> 1) & 0x03
      const blockSize = header >>> 3
      lastBlock = (header & 0x01) !== 0
      cursor += 3
      if (blockType === 0 || blockType === 2) cursor += blockSize
      else if (blockType === 1) cursor += 1
      else throw new Error(`zstd: reserved block type at offset ${cursor - 3}`)
    }
    if (hasChecksum) cursor += 4
    if (cursor > raw.length) throw new Error(`zstd: frame at offset ${offset} exceeds file`)
    const frame = raw.subarray(offset, cursor)
    try {
      frames.push(zstdDecompressSync(frame))
    } catch (error) {
      // Fall back to "decompress from this frame to the end": some zstd builds
      // tolerate trailing data, and the payload is still correct when they do.
      try {
        frames.push(zstdDecompressSync(raw.subarray(offset, cursor)))
      } catch {
        throw new Error(`zstd: frame at offset ${offset} did not decompress: ${error && error.message}`)
      }
    }
    offset = cursor
  }
  if (offset !== raw.length) throw new Error(`zstd: ${raw.length - offset} trailing bytes after last frame`)
  return frames
}

/**
 * Decode one session log into `{ header, events }`.
 * @param {string} file
 */
export function decodeSessionLogFile(file) {
  const events = []
  for (const frame of decodeZstdFrames(readFileSync(file))) {
    for (const line of frame.toString('utf8').split('\n')) {
      if (line.trim() === '') continue
      events.push(JSON.parse(line))
    }
  }
  const header = events.find((event) => event.type === 'session' && event.version === 4)
  return {
    header,
    events: events.filter((event) => event !== header),
    eventCount: events.length,
    rawBytes: statSync(file).size,
  }
}

/**
 * Find every persisted session under a `DSH_HOME`.
 * @param {string} dshHome
 * @returns {{file:string,dir:string,sessionId:string,encodedCwd:string}[]}
 */
export function findSessionFiles(dshHome) {
  const root = join(dshHome, 'sessions')
  const found = []
  let buckets = []
  try {
    buckets = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return found
  }
  for (const bucket of buckets) {
    const bucketDir = join(root, bucket.name)
    let sessionDirs = []
    try {
      sessionDirs = readdirSync(bucketDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const sessionDir of sessionDirs) {
      const dir = join(bucketDir, sessionDir.name)
      const file = join(dir, 'session.v4.jsonl.zstd')
      try {
        if (statSync(file).isFile()) found.push({ file, dir, sessionId: sessionDir.name, encodedCwd: bucket.name })
      } catch {
        /* not a persisted session directory */
      }
    }
  }
  return found.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

/** Runtime-context snapshot messages (the loop commits one per changed joined text). */
export function runtimeContextMessages(events) {
  return events.filter(
    (event) => event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'runtime-context',
  )
}

/** Section text from a runtime-context snapshot by section name. */
export function sectionText(snapshotMessage, sectionName) {
  const sections = (snapshotMessage?.data?.source?.sections ?? []).filter((section) => section && typeof section === 'object')
  const match = sections.find((section) => section.name === sectionName)
  if (match === undefined) return undefined
  return typeof match.text === 'string' ? match.text : ''
}

/** Pulse snapshots: runtime-context messages whose sections include `confluence:pulse`. */
export function pulseSnapshots(events) {
  return runtimeContextMessages(events)
    .map((message) => ({ message, pulseText: sectionText(message, 'confluence:pulse') }))
    .filter((entry) => entry.pulseText !== undefined)
}

/** Full text of a message event (joins text blocks; ignores non-text blocks). */
export function messageText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** All `agent/inbox/spliced` events. Runtime-context must not arrive this way. */
export function inboxSplices(events) {
  return events.filter((event) => event.type === 'agent/inbox/spliced')
}

/** Model-facing tool names recorded in the most recent `request/header`. */
export function toolNames(events) {
  let names = []
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const tools = event?.data?.header?.tools
    if (Array.isArray(tools)) names = tools.map((tool) => tool && tool.name).filter((name) => typeof name === 'string')
  }
  return names
}

/** Assistant `tool/call` names committed in the session. */
export function toolCalls(events) {
  const calls = []
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const name = event?.data?.name ?? event?.data?.call?.name
    if (typeof name === 'string') calls.push(name)
  }
  return calls
}

/** The final answer text from a `--json` headless run (NDJSON on stdout). */
export function finalHeadlessAnswer(stdoutText) {
  let final = null
  for (const line of String(stdoutText).split(/\r?\n/)) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed && parsed.type === 'final') final = parsed
  }
  return final
}

// CLI convenience: `node test/e2e/lib/session-log.mjs <session file>` dumps a
// compact event summary for debugging a failed run.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('session-log.mjs')) {
  const file = process.argv[2]
  if (!file) {
    process.stderr.write('usage: node test/e2e/lib/session-log.mjs <session.v4.jsonl.zstd>\n')
    process.exit(2)
  }
  const { header, events } = decodeSessionLogFile(file)
  process.stdout.write(`${JSON.stringify({ header, eventCount: events.length }, null, 2)}\n`)
  for (const event of events) {
    process.stdout.write(`${String(event.seq ?? '-').padStart(3)} ${event.type}\n`)
  }
}
