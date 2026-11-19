'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { test } = require('node:test')
const path = require('node:path')
const fs = require('node:fs')

const root = path.resolve(__dirname, '../..')

test('shipped source and maintained guides are free of retired Beacon documentation hosts', () => {
  const paths = execFileSync('git', ['ls-files', '-z', 'packages/*/src/**', 'docs/**', '*.md'], {
    cwd: root,
    encoding: 'utf8'
  })
    .split('\0')
    .filter(Boolean)
  const stale = paths.filter((name) =>
    /\b(?:docs|typedocs)\.walletbeacon\.io\b/i.test(fs.readFileSync(path.join(root, name), 'utf8'))
  )
  assert.deepEqual(stale, [])
})
