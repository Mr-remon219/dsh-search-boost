#!/usr/bin/env node
// Pre-publish gate for dsh-search-boost (runs automatically via `npm publish`
// → prepublishOnly). Ensures the registry tarball always matches a clean,
// working, tested tree:
//   1. node --check every shipped source file (index.js + lib/*.js)
//   2. run the test suite (node --test test/*.test.mjs)
//   3. require a clean git working tree (unless DSH_SB_ALLOW_DIRTY=1)
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const libFiles = readdirSync(join(root, 'lib')).filter((f) => f.endsWith('.js'))
const testFiles = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.mjs'))
const files = ['index.js', ...libFiles.map((f) => join('lib', f))]

let failed = false
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
  if (r.status !== 0) failed = true
  return r
}

console.log('[verify-publish] syntax check ...')
for (const f of files) run(process.execPath, ['--check', f])

console.log('[verify-publish] tests ...')
run(process.execPath, ['--test', ...testFiles.map((f) => join('test', f))])

if (!process.env.DSH_SB_ALLOW_DIRTY) {
  console.log('[verify-publish] git working tree ...')
  const r = spawnSync('git', ['-c', 'safe.directory=*', 'status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (r.status === 0 && r.stdout.trim()) {
    console.error('[verify-publish] ERROR: working tree is dirty — commit or stash before publishing (registry must match the repo):')
    console.error(r.stdout.trim())
    failed = true
  } else if (r.status !== 0) {
    console.error('[verify-publish] ERROR: could not check git status')
    failed = true
  }
}

if (failed) {
  console.error('[verify-publish] FAILED — publish aborted')
  process.exit(1)
}
console.log('[verify-publish] OK — ready to publish')
