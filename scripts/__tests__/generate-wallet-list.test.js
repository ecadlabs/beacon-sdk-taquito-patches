'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { cp, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const packages = ['beacon-blockchain-tezos', 'beacon-blockchain-tezos-sapling', 'beacon-ui']
const outputs = ['alert/wallet-lists.ts', 'alert/alert-templates.ts', 'toast/toast-templates.ts']

test('native generator awaits all nine outputs and preserves bytes across repeated runs', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'beacon-wallet-list-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))

  await cp(path.join(root, 'scripts'), path.join(fixture, 'scripts'), { recursive: true })
  await cp(path.join(root, 'assets'), path.join(fixture, 'assets'), { recursive: true })

  const expected = {}
  for (const packageName of packages) {
    for (const output of outputs) {
      const file = `packages/${packageName}/src/ui/${output}`
      const bytes = await readFile(path.join(root, file))
      expected[file] = createHash('sha256').update(bytes).digest('hex')
      await mkdir(path.dirname(path.join(fixture, file)), { recursive: true })
    }
  }
  assert.equal(Object.keys(expected).length, 9)
  await writeFile(path.join(fixture, 'expected.json'), JSON.stringify(expected))

  // Reuse frozen catalog entries in one process to expose shared-object mutation.
  const runner = `
    import assert from 'node:assert/strict'
    import { createHash } from 'node:crypto'
    import { readFile, rm } from 'node:fs/promises'
    import * as tezos from './scripts/blockchains/tezos.mjs'
    import * as sapling from './scripts/blockchains/tezos-sapling.mjs'

    for (const catalog of [tezos, sapling]) {
      for (const list of Object.values(catalog).filter(Array.isArray)) {
        list.forEach(Object.freeze)
        Object.freeze(list)
      }
    }

    const expected = JSON.parse(await readFile('expected.json', 'utf8'))
    for (let run = 0; run < 2; run++) {
      await import('./scripts/generate-wallet-list.mjs?run=' + run)
      for (const [file, checksum] of Object.entries(expected)) {
        const bytes = await readFile(file)
        assert.equal(createHash('sha256').update(bytes).digest('hex'), checksum, file)
        await rm(file)
      }
    }
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', runner], {
    cwd: fixture,
    encoding: 'utf8',
    stdio: 'pipe'
  })
})
