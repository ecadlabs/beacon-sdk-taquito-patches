'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const generatorSource = path.resolve(__dirname, '../sync-package-readmes.mjs')
const authored =
  '## Session restoration\n\nKeep the authored documentation and trailing blank lines.\n\n'

const createFixture = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-readmes-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packages = fs
    .readdirSync(path.resolve(__dirname, '../../packages'))
    .filter((dir) => fs.existsSync(path.resolve(__dirname, '../../packages', dir, 'package.json')))
  for (const dir of packages) {
    const packageDir = path.join(root, 'packages', dir)
    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: `@fixture/${dir}`,
        description: 'Current package description.'
      })
    )
  }
  const documentationPath = path.join(root, 'scripts/readme-sections/beacon-dapp.md')
  fs.mkdirSync(path.dirname(documentationPath), { recursive: true })
  fs.writeFileSync(documentationPath, authored)
  const generator = path.join(root, 'scripts/sync-package-readmes.mjs')
  fs.copyFileSync(generatorSource, generator)
  return { root, packages, documentationPath, generator }
}

const readReadmes = (root, packages) =>
  packages.map((dir) => {
    const file = path.join(root, 'packages', dir, 'README.md')
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  })

test('README regeneration uses authored inputs and recreates deleted output without drift', (t) => {
  const { root, packages, generator } = createFixture(t)
  const dappReadme = path.join(root, 'packages/beacon-dapp/README.md')
  fs.writeFileSync(dappReadme, '# Stale generated title\n\nOutdated documentation.\n')
  const run = () => execFileSync(process.execPath, [generator], { cwd: root })

  run()

  const updated = fs.readFileSync(dappReadme, 'utf8')
  assert.ok(updated.startsWith('# `@fixture/beacon-dapp`\n\nCurrent package description.\n'))
  assert.ok(!updated.includes('Outdated documentation.'))
  assert.ok(updated.endsWith(authored))
  const coreReadme = fs.readFileSync(path.join(root, 'packages/beacon-core/README.md'), 'utf8')
  assert.ok(coreReadme.startsWith('# `@fixture/beacon-core`\n'))
  assert.ok(!coreReadme.includes(authored))

  const manifest = path.join(root, 'packages/beacon-dapp/package.json')
  fs.writeFileSync(
    manifest,
    JSON.stringify({ name: '@fixture/renamed-dapp', description: 'Updated description.' })
  )
  run()
  const metadataUpdated = fs.readFileSync(dappReadme, 'utf8')
  assert.ok(metadataUpdated.startsWith('# `@fixture/renamed-dapp`\n\nUpdated description.\n'))
  assert.ok(metadataUpdated.includes('npm install @fixture/renamed-dapp'))
  assert.ok(metadataUpdated.endsWith(authored))

  const before = readReadmes(root, packages)
  fs.unlinkSync(dappReadme)
  run()
  assert.deepEqual(readReadmes(root, packages), before)
  run()
  assert.deepEqual(readReadmes(root, packages), before)
})

test('missing required documentation fails before changing or creating any README', (t) => {
  const { root, packages, documentationPath, generator } = createFixture(t)
  fs.writeFileSync(
    path.join(root, 'packages/beacon-dapp/README.md'),
    '# Existing authored README\n'
  )
  const before = readReadmes(root, packages)
  fs.unlinkSync(documentationPath)

  const result = spawnSync(process.execPath, [generator], { cwd: root, encoding: 'utf8' })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ENOENT/)
  assert.ok(result.stderr.includes(documentationPath))
  assert.deepEqual(readReadmes(root, packages), before)
})

test('invalid late package metadata fails before changing or creating any README', (t) => {
  const { root, packages, generator } = createFixture(t)
  const existingReadme = path.join(root, 'packages/beacon-core/README.md')
  fs.writeFileSync(existingReadme, '# Existing README\n')
  const before = readReadmes(root, packages)
  const manifest = path.join(root, 'packages/beacon-wallet/package.json')
  fs.writeFileSync(manifest, '{ invalid JSON')

  const invalid = spawnSync(process.execPath, [generator], { cwd: root, encoding: 'utf8' })

  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /SyntaxError/)
  assert.deepEqual(readReadmes(root, packages), before)

  fs.unlinkSync(manifest)
  const missing = spawnSync(process.execPath, [generator], { cwd: root, encoding: 'utf8' })

  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /ENOENT/)
  assert.ok(missing.stderr.includes(manifest))
  assert.deepEqual(readReadmes(root, packages), before)
})

for (const [label, metadata, field] of [
  ['missing name', { description: 'Description.' }, 'name'],
  ['object description', { name: '@fixture/beacon-wallet', description: {} }, 'description'],
  ['whitespace description', { name: '@fixture/beacon-wallet', description: '  ' }, 'description'],
  ['null manifest', null, 'name']
]) {
  test(`late metadata with ${label} preserves every existing README`, (t) => {
    const { root, packages, generator } = createFixture(t)
    for (const dir of packages) {
      fs.writeFileSync(path.join(root, 'packages', dir, 'README.md'), `Existing ${dir} README\n`)
    }
    const before = readReadmes(root, packages)
    const manifest = path.join(root, 'packages/beacon-wallet/package.json')
    fs.writeFileSync(manifest, JSON.stringify(metadata))

    const result = spawnSync(process.execPath, [generator], { cwd: root, encoding: 'utf8' })

    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.includes(manifest), result.stderr)
    assert.match(result.stderr, new RegExp(`${field} must be a nonempty string`))
    assert.deepEqual(readReadmes(root, packages), before)
  })
}
