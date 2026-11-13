#!/usr/bin/env node
// Confluence / 汇流 — offline export CLI (`confluence.memories/v1`).
//
//   node scripts/export-memories.mjs --dsh-home <dir> --workspace <path> [--out <dir>] [--json] [--dry-run]
//
// Reads one workspace's merged journal from a scratch or real DSH_HOME (read-only), writes the
// deterministic, redacted `memories.v1.jsonl` + `manifest.json` pair outside the store, and prints
// a short summary. This is the only supported way a later `solo-bench` phase learns about
// Confluence memory: the export is a snapshot, never a live channel (ADR 0006).
//
// The CLI is deliberately explicit about --dsh-home: it never falls back to the real ~/.dsh, so a
// verification run can only touch the store it names. Export is workspace-relative only; --out is
// resolved under the canonical workspace directory and rejects rooted/`..` values.
//
// Exit codes: 0 success; 1 runtime failure (missing store/workspace, unsafe path, IO); 2 usage error.
// No network, no dependency, no child process. Hermetic tests call the exported run().

import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JournalStore } from '../lib/store.js'
import { createRedactor } from '../lib/redact.js'
import { resolveConfig } from '../lib/config.js'
import { canonicalizeDir, workspaceKeyFor } from '../lib/workspace.js'
import { exportWorkspace, EXPORT_SCHEMA, EXPORT_FORMAT_VERSION, MEMORIES_FILE, EXPORT_MANIFEST_FILE } from '../lib/export.js'

export const USAGE = `Usage: node scripts/export-memories.mjs --dsh-home <dir> --workspace <path> [options]

Export one Confluence workspace's shared memory as the offline confluence.memories/v1 pair
(memories.v1.jsonl + manifest.json). The store is only read; the export is written under the
workspace (default .confluence/export) and never read back.

Required:
  --dsh-home <dir>      DSH_HOME that contains storages/confluence/v1 (scratch homes are fine;
                        the real ~/.dsh is never assumed)
  --workspace <path>    workspace directory (canonicalized; must have a store manifest)

Options:
  --out <dir>           workspace-relative export directory (default: config export.dir
                        ".confluence/export"); rooted or ".." values are rejected
  --json                print one JSON summary object to stdout instead of the human summary
  --dry-run             compute and validate, print the summary, write nothing
  -h, --help            show this help

Examples:
  node scripts/export-memories.mjs --dsh-home .tmp/e2e/run-20261113-183207/dsh-home \\\n    --workspace .tmp/e2e/run-20261113-183207/workspace --json
  node scripts/export-memories.mjs --dsh-home "$env:DSH_HOME" --workspace D:\\work\\repo --dry-run
`

/** @param {string} message */
class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
    this.code = 'USAGE'
  }
}

/**
 * Parse argv (without the node/script entries).
 * @param {readonly string[]} argv
 * @returns {{dshHome: string, workspace: string, out: string, json: boolean, dryRun: boolean, help: boolean}}
 */
export function parseArgs(argv) {
  const parsed = { dshHome: '', workspace: '', out: '', json: false, dryRun: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    /** @returns {string} */
    const next = () => {
      if (index + 1 >= argv.length) throw new UsageError(`${arg} requires a value`)
      index += 1
      return argv[index]
    }
    if (arg === '--dsh-home') parsed.dshHome = next()
    else if (arg === '--workspace') parsed.workspace = next()
    else if (arg === '--out') parsed.out = next()
    else if (arg === '--json') parsed.json = true
    else if (arg === '--dry-run') parsed.dryRun = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else throw new UsageError(`unknown argument: ${arg}`)
  }
  if (parsed.help) return parsed
  if (parsed.dshHome === '') throw new UsageError('--dsh-home is required (the store is never guessed)')
  if (parsed.workspace === '') throw new UsageError('--workspace is required')
  return parsed
}

/**
 * Validate a workspace-relative export directory ("narrow inside the workspace", ADR-0001 §17 E3).
 * @param {string} value
 * @returns {string}
 */
export function validateWorkspaceRelativeDir(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError('--out must be a non-empty workspace-relative directory')
  }
  const raw = value.trim()
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    throw new UsageError(`--out must be workspace-relative, not rooted: ${raw}`)
  }
  if (raw.split(/[\\/]+/).includes('..')) {
    throw new UsageError(`--out must not contain "..": ${raw}`)
  }
  const normalized = raw.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
  if (normalized === '') throw new UsageError('--out resolves to the workspace root; name a subdirectory')
  return normalized
}

/**
 * Run the CLI. Exported for hermetic tests (no child process needed): inject stdout/stderr
 * collectors and a clock; everything else is the real code path.
 *
 * @param {{
 *   argv: readonly string[],
 *   io?: {stdout?: (text: string) => void, stderr?: (text: string) => void},
 *   now?: () => number,
 *   env?: Record<string, string | undefined>,
 *   createStore?: (options: object) => object,
 * }} options
 * @returns {Promise<number>} process exit code
 */
export async function run({ argv, io = {}, now = () => Date.now(), createStore } = {}) {
  const stdout = typeof io.stdout === 'function' ? io.stdout : (text) => process.stdout.write(text)
  const stderr = typeof io.stderr === 'function' ? io.stderr : (text) => process.stderr.write(text)
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    stderr(`${error.message}\n\n${USAGE}`)
    return 2
  }
  if (args.help) {
    stdout(USAGE)
    return 0
  }

  let store = null
  try {
    const logger = { debug() {}, info() {}, warn() {}, error() {} }
    if (!existsSync(args.dshHome)) {
      const error = new Error(`DSH_HOME directory not found: ${args.dshHome}`)
      error.code = 'STORE_UNAVAILABLE'
      throw error
    }
    const dshHome = path.resolve(args.dshHome)
    const storeRootCandidate = path.join(dshHome, 'storages', 'confluence', 'v1')
    if (!existsSync(storeRootCandidate)) {
      const error = new Error(`no Confluence store under ${dshHome} (expected storages/confluence/v1)`)
      error.code = 'STORE_UNAVAILABLE'
      throw error
    }

    const canonicalWorkspace = await canonicalizeDir(args.workspace)
    if (canonicalWorkspace === null) {
      const error = new Error(`workspace directory not found or unusable: ${args.workspace}`)
      error.code = 'BAD_ARGUMENT'
      throw error
    }
    const workspaceKey = workspaceKeyFor(canonicalWorkspace)

    const config = resolveConfig({}).config
    const relativeDir = args.out !== '' ? validateWorkspaceRelativeDir(args.out) : validateWorkspaceRelativeDir(config.export.dir)
    const outDir = path.resolve(canonicalWorkspace, relativeDir)
    const relativeFromWorkspace = path.relative(canonicalWorkspace, outDir)
    if (relativeFromWorkspace === '' || relativeFromWorkspace.startsWith('..') || path.isAbsolute(relativeFromWorkspace)) {
      const error = new Error(`export directory escapes the workspace: ${outDir}`)
      error.code = 'BAD_ARGUMENT'
      throw error
    }

    const makeStore = typeof createStore === 'function'
      ? createStore
      : (options) => new JournalStore(options)
    store = makeStore({ config, logger, deps: { env: { DSH_HOME: dshHome } } })
    const redactor = createRedactor(config, { logger })

    const result = await exportWorkspace({
      store,
      config,
      redactor,
      workspaceKey,
      outDir,
      logger,
      now,
      dryRun: args.dryRun,
    })

    const summary = {
      ok: true,
      schema: EXPORT_SCHEMA,
      formatVersion: EXPORT_FORMAT_VERSION,
      workspaceKey,
      workspacePath: canonicalWorkspace,
      storeRoot: typeof store.rootDir === 'string' ? store.rootDir : storeRootCandidate,
      outDir: result.outDir,
      dryRun: result.dryRun,
      files: result.files,
      recordCount: result.recordCount,
      firstSeq: result.firstSeq,
      lastSeq: result.lastSeq,
      tombstoneStubs: result.tombstoneStubs,
      skippedReplies: result.skippedReplies,
      skippedRetention: result.skippedRetention,
      truncated: result.truncated,
    }
    if (args.json) {
      stdout(JSON.stringify(summary, null, 2) + '\n')
    } else {
      const lines = [
        'Confluence export — confluence.memories/v1',
        `  workspace:  ${workspaceKey}  (${canonicalWorkspace})`,
        `  store:      ${summary.storeRoot}`,
        `  output:     ${result.outDir}${result.dryRun ? '  [dry-run: not written]' : ''}`,
        `  records:    ${result.recordCount} live, ${result.tombstoneStubs} tombstone stub(s), ` +
          `${result.skippedReplies} reply line(s) skipped, ${result.skippedRetention} hidden by retention`,
        `  seq range:  ${result.firstSeq ?? '-'} .. ${result.lastSeq ?? '-'}`,
        `  truncated:  ${result.truncated}`,
      ]
      for (const file of result.files) {
        lines.push(`  file:       ${file.name}  ${file.bytes} bytes  sha256:${file.sha256}`)
      }
      if (!result.dryRun) {
        lines.push(`  manifest:   ${path.join(result.outDir, EXPORT_MANIFEST_FILE)}`)
        lines.push(`  jsonl:      ${path.join(result.outDir, MEMORIES_FILE)}`)
      }
      stdout(lines.join('\n') + '\n')
    }
    return 0
  } catch (error) {
    if (error && (error.name === 'UsageError' || error.code === 'USAGE')) {
      stderr(`${error.message}\n\n${USAGE}`)
      return 2
    }
    const code = error && typeof error.code === 'string' ? error.code : 'EXPORT_FAILED'
    stderr(`export-memories: ${code}: ${error?.message ?? String(error)}\n`)
    return 1
  } finally {
    if (store && typeof store.close === 'function') {
      try {
        await store.close()
      } catch {
        // best effort cleanup; the export result is already decided
      }
    }
  }
}

/** True when this file is the process entry point (Windows paths included). */
function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) {
  run({ argv: process.argv.slice(2) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`export-memories: EXPORT_FAILED: ${error?.stack ?? String(error)}\n`)
      process.exitCode = 1
    })
}
