'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const { mkdir, mkdtemp, writeFile, rm } = require('node:fs/promises')

const { resolveFilePath } = require('../helpers/static-server')

test('resolveFilePath maps the root request to index.html', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'beacon-static-root-'))

  try {
    await writeFile(path.join(rootPath, 'index.html'), '<h1>Beacon</h1>')

    assert.equal(await resolveFilePath(rootPath, '/'), path.join(rootPath, 'index.html'))
  } finally {
    await rm(rootPath, { recursive: true, force: true })
  }
})

test('resolveFilePath rejects path traversal requests', async () => {
  const parentPath = await mkdtemp(path.join(os.tmpdir(), 'beacon-static-parent-'))
  const rootPath = path.join(parentPath, 'public')

  try {
    await mkdir(rootPath)
    await writeFile(path.join(parentPath, 'secret.txt'), 'private')
    await writeFile(path.join(rootPath, 'index.html'), '<h1>Beacon</h1>')

    assert.equal(await resolveFilePath(rootPath, '/%2e%2e/secret.txt'), null)
  } finally {
    await rm(parentPath, { recursive: true, force: true })
  }
})
