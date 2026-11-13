// Confluence / 汇流 — workspace identity resolution.
//
// Workspace key = canonical original project directory:
//   session.header.cwd (immutable) -> fs.realpath -> win32 lower-case fold
//   -> "ws_" + sha256(canonicalPath).slice(0,16)
//
// `ctx.workingDirectory.get(session)` is a fallback only when the header has no
// cwd (ADR 0001 §5, round-2 R1). A realpath failure means "no workspace" — there
// is deliberately no lexical fallback. The key is frozen for a session's
// lifetime. Contract: docs/plan/implementation-interfaces.md §3.

import path from 'node:path'
import { realpath as fsRealpath } from 'node:fs/promises'
import { sha256Hex } from './util.js'

const DEFAULT_FS = { realpath: fsRealpath }

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function nonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

/**
 * Canonicalize a directory path: fs.realpath then win32 lower-case fold.
 * Returns null when the path is unusable (bad input, missing directory, error).
 *
 * @param {unknown} rawPath
 * @param {{ fs?: {realpath?: Function}, platform?: string }} [deps]
 * @returns {Promise<string | null>}
 */
export async function canonicalizeDir(rawPath, deps = {}) {
  if (!nonEmptyString(rawPath)) return null
  const fsImpl = deps.fs && typeof deps.fs.realpath === 'function' ? deps.fs : DEFAULT_FS
  let resolved
  try {
    resolved = await fsImpl.realpath(rawPath)
  } catch {
    return null
  }
  if (!nonEmptyString(resolved)) return null
  const platform = typeof deps.platform === 'string' ? deps.platform : process.platform
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * @param {string} canonicalPath
 * @returns {string} workspace key
 */
export function workspaceKeyFor(canonicalPath) {
  if (!nonEmptyString(canonicalPath)) throw new TypeError('workspaceKeyFor requires a canonical path')
  return `ws_${sha256Hex(canonicalPath).slice(0, 16)}`
}

/**
 * @param {string} canonicalPath
 * @param {string} platform
 * @returns {string}
 */
function labelFor(canonicalPath, platform) {
  const basename = platform === 'win32' ? path.win32.basename(canonicalPath) : path.basename(canonicalPath)
  return basename !== '' ? basename : canonicalPath
}

/**
 * Resolve a session's workspace: header.cwd first (immutable original project),
 * effective working directory only as a fallback, realpath failure => null.
 *
 * @param {{ workingDirectory?: {get?: Function}, fs?: {realpath?: Function}, platform?: string }} deps
 * @param {{ id?: unknown, header?: {cwd?: unknown} }} session
 * @returns {Promise<{ key: string, canonicalPath: string, label: string } | null>}
 */
export async function resolveWorkspace(deps = {}, session) {
  const headerCwd = session && session.header ? session.header.cwd : undefined
  let rawDir = nonEmptyString(headerCwd) ? headerCwd : undefined

  if (rawDir === undefined) {
    const workingDirectory = deps && deps.workingDirectory
    if (workingDirectory && typeof workingDirectory.get === 'function') {
      try {
        const effective = workingDirectory.get(session)
        if (nonEmptyString(effective)) rawDir = effective
      } catch {
        rawDir = undefined
      }
    }
  }

  if (rawDir === undefined) return null
  const canonicalPath = await canonicalizeDir(rawDir, deps)
  if (canonicalPath === null) return null
  const platform = typeof deps.platform === 'string' ? deps.platform : process.platform
  return {
    key: workspaceKeyFor(canonicalPath),
    canonicalPath,
    label: labelFor(canonicalPath, platform),
  }
}

/**
 * Per-session cached resolver. The first successful resolution is frozen for
 * the session's lifetime (a later `cd` cannot move a session's workspace).
 *
 * @param {object} [deps] passed through to resolveWorkspace (workingDirectory, fs, platform)
 * @returns {{ resolve: (session: object) => Promise<{key: string, canonicalPath: string, label: string} | null> }}
 */
export function createWorkspaceResolver(deps = {}) {
  /** @type {Map<unknown, Promise<{key: string, canonicalPath: string, label: string} | null>>} */
  const cache = new Map()
  return {
    async resolve(session) {
      const id = session && (session.id !== undefined ? session.id : session.header && session.header.id)
      if (id !== undefined && id !== null && cache.has(id)) return cache.get(id)
      const pending = resolveWorkspace(deps, session).catch(() => null)
      if (id !== undefined && id !== null) cache.set(id, pending)
      return pending
    },
  }
}
