'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const { mkdir, mkdtemp, writeFile, rm } = require('node:fs/promises')

const { createStaticServer, resolveFilePath } = require('../helpers/static-server')

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

test('createStaticServer serves window.BEACON_WC_PROJECT_ID at /env.js from environment', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'beacon-static-env-'))
  const previousProjectId = process.env.BEACON_WC_PROJECT_ID
  process.env.BEACON_WC_PROJECT_ID = 'b893096be85915b2c5e8d83d086d880f'

  const staticServer = createStaticServer({ rootPath, port: 0 })

  try {
    await new Promise((resolve) => staticServer.start(resolve))
    const { port } = staticServer.server.address()
    const response = await fetch(`http://127.0.0.1:${port}/env.js`)

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/javascript; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(
      await response.text(),
      'window.BEACON_WC_PROJECT_ID = "b893096be85915b2c5e8d83d086d880f"\n'
    )
  } finally {
    if (previousProjectId === undefined) {
      delete process.env.BEACON_WC_PROJECT_ID
    } else {
      process.env.BEACON_WC_PROJECT_ID = previousProjectId
    }
    await new Promise((resolve) => staticServer.stop(resolve))
    await rm(rootPath, { recursive: true, force: true })
  }
})
