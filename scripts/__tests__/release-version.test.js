'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const test = require('node:test')
const { version } = require('../../package.json')

function checkVersion(refType, refName) {
  return spawnSync(process.execPath, [path.resolve(__dirname, '../check-workspace-version.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_TYPE: refType, GITHUB_REF_NAME: refName }
  })
}

test('release verification accepts the exact version tag', () => {
  const run = checkVersion('tag', 'v' + version)
  assert.equal(run.status, 0, run.stderr)
})

test('release verification rejects a mismatched tag and identifies both versions', () => {
  const tag = 'v0.0.0'
  const run = checkVersion('tag', tag)
  assert.equal(run.status, 1)
  assert.ok(run.stderr.includes(tag))
  assert.ok(run.stderr.includes(version))
})

test('ordinary branch builds can use a name unrelated to the package version', () => {
  const run = checkVersion('branch', 'taquito-patches')
  assert.equal(run.status, 0, run.stderr)
})
