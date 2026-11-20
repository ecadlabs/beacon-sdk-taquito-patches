const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '../..')

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-typechecks-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, 'scripts'))
  fs.copyFileSync(
    path.join(root, 'scripts/typecheck.mjs'),
    path.join(directory, 'scripts/typecheck.mjs')
  )
  fs.copyFileSync(
    path.join(root, 'scripts/workspace-utils.mjs'),
    path.join(directory, 'scripts/workspace-utils.mjs')
  )
  fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'))
  fs.symlinkSync(
    path.join(root, 'node_modules'),
    path.join(directory, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const config = (name, files) =>
    fs.writeFileSync(
      path.join(directory, name),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          types: []
        },
        files
      })
    )
  const { getWorkspacePackages } = await import('../workspace-utils.mjs')
  for (const workspace of getWorkspacePackages()) {
    const name = path.basename(workspace.directory)
    const packageDir = path.join(directory, 'packages', name)
    fs.mkdirSync(path.join(packageDir, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: workspace.manifest.name })
    )
    fs.writeFileSync(path.join(packageDir, 'src/index.ts'), 'export const source = 1\n')
    config(`packages/${name}/tsconfig.json`, ['src/index.ts'])
    if (fs.existsSync(path.join(workspace.directory, 'tsconfig.tests.json'))) {
      fs.mkdirSync(path.join(packageDir, '__tests__'))
      fs.writeFileSync(
        path.join(packageDir, '__tests__/example.test.ts'),
        'export const example = 1\n'
      )
      config(`packages/${name}/tsconfig.tests.json`, ['__tests__/example.test.ts'])
    }
  }
  for (const name of ['tools', 'e2e', 'server', 'compat']) {
    fs.writeFileSync(path.join(directory, `${name}.ts`), 'export const example = 1\n')
    config(`tsconfig.${name}.json`, [`${name}.ts`])
  }
  return directory
}

const run = (directory, mode) =>
  spawnSync(process.execPath, [path.join(directory, 'scripts/typecheck.mjs'), mode], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 30000
  })

test('the coverage CLI accepts owned TypeScript files', async (t) => {
  const result = run(await fixture(t), 'coverage')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /belong to parsed typecheck targets/)
})

test('the coverage CLI rejects unowned authored TypeScript files', async (t) => {
  const directory = await fixture(t)
  fs.mkdirSync(path.join(directory, 'docs'))
  fs.writeFileSync(path.join(directory, 'docs/example.mts'), 'export const value = 1\n')
  const result = run(directory, 'coverage')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /docs[/\\]example\.mts/)
})

test('the coverage CLI rejects missing and empty targets', async (t) => {
  const directory = await fixture(t)
  const target = path.join(directory, 'packages/beacon-core/tsconfig.tests.json')
  fs.unlinkSync(target)
  assert.equal(run(directory, 'coverage').status, 2)
  fs.writeFileSync(target, JSON.stringify({ files: [] }))
  assert.equal(run(directory, 'coverage').status, 2)
})

for (const [mode, file] of [
  ['tests', 'packages/beacon-core/__tests__/example.test.ts'],
  ['tooling', 'tools.ts']
]) {
  test(`${mode} target fails on a real TypeScript error`, async (t) => {
    const directory = await fixture(t)
    fs.writeFileSync(path.join(directory, file), "export const invalid: number = 'wrong'\n")
    const result = run(directory, mode)
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /TS2322/)
  })
}

test('the coverage CLI rejects a missing production-only workspace target', async (t) => {
  const directory = await fixture(t)
  fs.unlinkSync(path.join(directory, 'packages/beacon-sdk/tsconfig.json'))

  const result = run(directory, 'coverage')

  assert.equal(result.status, 2)
  assert.match(
    result.stderr,
    /Missing typecheck target: packages[/\\]beacon-sdk[/\\]tsconfig\.json/
  )
})
