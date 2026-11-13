// WP1 unit tests — lib/workspace.js
// Covers implementation-interfaces.md §3 and UT-WS-01..06: canonical key from
// header.cwd first, effective-directory fallback, realpath failure => null
// (no lexical fallback), freeze per session, key shape and basename labels.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canonicalizeDir,
  createWorkspaceResolver,
  resolveWorkspace,
  workspaceKeyFor,
} from '../lib/workspace.js'
import { sha256Hex } from '../lib/util.js'

const WIN32 = { platform: 'win32' }

/** @param {Record<string, string>} mapping @param {{errorFor?: string[], calls?: string[]}} [options] */
function fakeFs(mapping, options = {}) {
  const calls = options.calls ?? []
  const errorFor = options.errorFor ?? []
  return {
    calls,
    async realpath(rawPath) {
      calls.push(rawPath)
      if (errorFor.includes(rawPath)) {
        const error = new Error(`ENOENT: no such file or directory, realpath '${rawPath}'`)
        error.code = 'ENOENT'
        throw error
      }
      if (!(rawPath in mapping)) {
        const error = new Error(`ENOENT: ${rawPath}`)
        error.code = 'ENOENT'
        throw error
      }
      return mapping[rawPath]
    },
  }
}

test('UT-WS-01 canonicalization: realpath + win32 lowercase fold; spellings converge', async () => {
  const fs = fakeFs({
    'C:\\Repo\\Sub\\..': 'C:\\Repo',
    'c:/repo/': 'C:\\Repo',
    'C:\\Repo': 'C:\\Repo',
  })
  const a = await canonicalizeDir('C:\\Repo\\Sub\\..', { fs, ...WIN32 })
  const b = await canonicalizeDir('c:/repo/', { fs, ...WIN32 })
  const c = await canonicalizeDir('C:\\Repo', { fs, ...WIN32 })
  assert.equal(a, 'c:\\repo')
  assert.equal(b, 'c:\\repo')
  assert.equal(c, 'c:\\repo')
  assert.equal(workspaceKeyFor(a), workspaceKeyFor(b))
  assert.equal(workspaceKeyFor(a), workspaceKeyFor(c))
})

test('UT-WS-02 key shape: "ws_" + sha256(canonicalPath).slice(0,16)', async () => {
  const canonical = 'd:\\05_code\\solo-bench'
  const key = workspaceKeyFor(canonical)
  assert.match(key, /^ws_[0-9a-f]{16}$/)
  assert.equal(key, `ws_${sha256Hex(canonical).slice(0, 16)}`)
  assert.equal(key.length, 19)
})

test('UT-WS-03 freeze: a session that changes directory keeps its first workspace key', async () => {
  const fs = fakeFs({ 'C:\\A': 'C:\\A', 'C:\\B': 'C:\\B' })
  let effective = 'C:\\A'
  const workingDirectory = { get: () => effective }
  const resolver = createWorkspaceResolver({ fs, workingDirectory, ...WIN32 })
  const session = { id: 'session-freeze', header: { cwd: 'C:\\A' } }
  const first = await resolver.resolve(session)
  assert.equal(first.canonicalPath, 'c:\\a')
  // A `cd` elsewhere must not move a session that already has a workspace.
  effective = 'C:\\B'
  const second = await resolver.resolve({ id: 'session-freeze', header: { cwd: 'C:\\B' } })
  assert.equal(second.key, first.key)
  assert.equal(second.canonicalPath, 'c:\\a')
  assert.equal(fs.calls.length, 1, 'resolution happens once per session id')
})

test('UT-WS-04 fallback: header.cwd absent => effective directory from workingDirectory', async () => {
  const fs = fakeFs({ 'C:\\Proj': 'C:\\Proj' })
  const workingDirectory = { get: () => 'C:\\Proj' }
  const resolved = await resolveWorkspace({ fs, workingDirectory, ...WIN32 }, { id: 's1', header: {} })
  assert.equal(resolved.canonicalPath, 'c:\\proj')
  assert.equal(resolved.key, workspaceKeyFor('c:\\proj'))
  assert.deepEqual(fs.calls, ['C:\\Proj'], 'the effective directory is what gets realpath-ed')
})

test('UT-WS-05 unresolvable: realpath failure => null, no lexical fallback, no throw', async () => {
  const fs = fakeFs({}, { errorFor: ['C:\\Gone'] })
  const resolved = await resolveWorkspace({ fs, ...WIN32 }, { id: 's1', header: { cwd: 'C:\\Gone' } })
  assert.equal(resolved, null)
  const noDir = await resolveWorkspace({ fs: fakeFs({}, { calls: [] }), ...WIN32 }, { id: 's2', header: {} })
  assert.equal(noDir, null, 'no cwd and no working directory => no workspace')

  const throwing = {
    async realpath() {
      throw new Error('EACCES')
    },
  }
  assert.equal(await canonicalizeDir('C:\\Any', { fs: throwing, ...WIN32 }), null)
  assert.equal(await canonicalizeDir('', { fs: throwing, ...WIN32 }), null)
  assert.equal(await canonicalizeDir(undefined, { fs: throwing, ...WIN32 }), null)
})

test('UT-WS-06 distinct directories sharing a basename differ; symlink target converges', async () => {
  const fs = fakeFs({
    'C:\\a\\proj': 'C:\\a\\proj',
    'D:\\b\\proj': 'D:\\b\\proj',
    'C:\\link\\proj': 'C:\\real\\proj',
    'C:\\other-link': 'C:\\real\\proj',
  })
  const one = await resolveWorkspace({ fs, ...WIN32 }, { id: 's1', header: { cwd: 'C:\\a\\proj' } })
  const two = await resolveWorkspace({ fs, ...WIN32 }, { id: 's2', header: { cwd: 'D:\\b\\proj' } })
  assert.notEqual(one.key, two.key)
  assert.equal(one.label, 'proj')
  assert.equal(two.label, 'proj')

  const symlink = await resolveWorkspace({ fs, ...WIN32 }, { id: 's3', header: { cwd: 'C:\\link\\proj' } })
  const junction = await resolveWorkspace({ fs, ...WIN32 }, { id: 's4', header: { cwd: 'C:\\other-link' } })
  assert.equal(symlink.key, junction.key, 'symlinks/junctions to one target share a workspace')
  assert.equal(symlink.canonicalPath, 'c:\\real\\proj')
})

test('UT-WS-07 label: basename of the canonical path (workspace metadata label)', async () => {
  const fs = fakeFs({ 'D:\\05_Code\\solo-bench': 'D:\\05_Code\\solo-bench', 'C:\\': 'C:\\' })
  const resolved = await resolveWorkspace({ fs, ...WIN32 }, { id: 's1', header: { cwd: 'D:\\05_Code\\solo-bench' } })
  assert.equal(resolved.label, 'solo-bench')
  const root = await resolveWorkspace({ fs, ...WIN32 }, { id: 's2', header: { cwd: 'C:\\' } })
  assert.equal(root.label, 'c:\\', 'a drive root falls back to the canonical path')
})
