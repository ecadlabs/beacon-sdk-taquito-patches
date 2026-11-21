import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const moduleRequire = createRequire(path.join(process.cwd(), 'package.json'))
let directory: string

test.beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'beacon-wallet-browser-'))
  const archives = path.join(directory, 'tarballs')
  mkdirSync(archives)
  const npm = process.env.npm_execpath
  if (!npm) throw new Error('Run browser tests through npm')
  const dependencies: Record<string, string> = { '@taquito/michel-codec': '25.1.1' }
  for (const name of ['beacon-types', 'beacon-utils']) {
    const packed = JSON.parse(
      execFileSync(
        process.execPath,
        [
          npm,
          'pack',
          '--json',
          '--ignore-scripts',
          '--workspaces=false',
          '--pack-destination',
          archives
        ],
        { cwd: path.join(process.cwd(), 'packages', name), encoding: 'utf8' }
      )
    ) as Array<{ name: string; filename: string }>
    dependencies[packed[0].name] = `file:${path.join(archives, packed[0].filename)}`
  }
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ private: true, dependencies })
  )
  execFileSync(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: directory,
    timeout: 180000
  })
  writeFileSync(
    path.join(directory, 'entry.mjs'),
    "export * from '@ecadlabs/beacon-utils/wallet'\n"
  )
  writeFileSync(
    path.join(directory, 'webpack.config.cjs'),
    `module.exports = { mode: 'production', target: 'web', context: __dirname, entry: './entry.mjs', output: { path: __dirname, filename: 'wallet.js', library: { name: 'walletHelpers', type: 'var' } }, optimization: { minimize: false } }`
  )
  execFileSync(
    process.execPath,
    [
      moduleRequire.resolve('webpack-cli/bin/cli.js'),
      '--config',
      path.join(directory, 'webpack.config.cjs')
    ],
    { cwd: directory, timeout: 180000 }
  )
})

test.afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
})

declare const walletHelpers: typeof import('@ecadlabs/beacon-utils/wallet')

test('installed public wallet subpath runs in a browser without the default SDK bundle', async ({
  page
}) => {
  await page.addScriptTag({ path: path.join(directory, 'wallet.js') })
  const result = await page.evaluate(() => {
    const text = 'Tezos Signed Message: browser é 🌍'
    return {
      inspected: walletHelpers.inspectSignPayload(walletHelpers.packMessageText(text)),
      nested: walletHelpers.inspectSignPayload('0505090306'),
      operations: walletHelpers.sanitizePartialTezosOperations([
        { kind: 'delegation', source: 'spoof', gas_limit: '100', storage_limit: '1.5' }
      ])
    }
  })
  expect(result.inspected).toMatchObject({
    valid: true,
    kind: 'signed_message_text',
    decodedText: 'Tezos Signed Message: browser é 🌍'
  })
  expect(result.nested).toMatchObject({ valid: true, validation: 'canonical_micheline' })
  expect(result.operations).toEqual([{ kind: 'delegation', gas_limit: '100' }])
})
