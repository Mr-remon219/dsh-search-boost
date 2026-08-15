#!/usr/bin/env node
// Regression runner for the audit fixes. Delegates to node:test.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(process.execPath, ['--test', 'test/audit-fixes.test.mjs'], {
  cwd: root,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
