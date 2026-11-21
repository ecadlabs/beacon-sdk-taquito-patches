import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  getWorkspacePackages,
  readJson,
  repoRoot,
  rootPackagePath,
  writeJson
} from './workspace-utils.mjs'

const packages = getWorkspacePackages().filter(({ manifest }) => !manifest.private)
const npmCli = process.env.npm_execpath
const expectedNpm = readJson(rootPackagePath).packageManager.replace(/^npm@/, '')
const env = { ...process.env }
delete env.NODE_PATH

function run(args, cwd, { capture = false, timeout = 180_000 } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `Child process failed (status ${result.status}, signal ${result.signal ?? 'none'}): ${args.join(' ')}`,
      { cause: result.error }
    )
  }
  return result.stdout
}

if (!npmCli || !existsSync(npmCli)) {
  throw new Error(
    'Run this check through npm run test:node-consumers using the pinned npm version.'
  )
}
const npmVersion = run([npmCli, '--version'], repoRoot, { capture: true }).trim()
if (npmVersion !== expectedNpm) {
  throw new Error(`Expected npm ${expectedNpm}, received ${npmVersion}. Use scripts/npm11.sh.`)
}
if (packages.length === 0) {
  throw new Error('No public workspace packages found.')
}

const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'beacon-node-consumer-'))
try {
  const archiveRoot = path.join(temporaryRoot, 'tarballs')
  const consumerRoot = path.join(temporaryRoot, 'consumer')
  mkdirSync(archiveRoot)
  mkdirSync(consumerRoot)

  const dependencies = {}
  for (const { directory, manifest } of packages) {
    const packed = JSON.parse(
      run(
        [
          npmCli,
          'pack',
          '--json',
          '--ignore-scripts',
          '--workspaces=false',
          '--pack-destination',
          archiveRoot
        ],
        directory,
        { capture: true }
      )
    )
    const archive = packed[0]
    if (
      packed.length !== 1 ||
      archive.name !== manifest.name ||
      archive.version !== manifest.version ||
      typeof archive.filename !== 'string' ||
      path.basename(archive.filename) !== archive.filename
    ) {
      throw new Error(`Unexpected npm pack output for ${manifest.name}.`)
    }
    dependencies[manifest.name] = `file:${path.join(archiveRoot, archive.filename)}`
  }

  writeJson(path.join(consumerRoot, 'package.json'), {
    name: 'beacon-node-consumer',
    version: '1.0.0',
    private: true,
    type: 'commonjs',
    dependencies,
    devDependencies: {
      '@types/node': readJson(rootPackagePath).devDependencies['@types/node']
    }
  })
  writeJson(
    path.join(consumerRoot, 'packages.json'),
    packages.map(({ manifest }) => ({ name: manifest.name, version: manifest.version }))
  )
  copyFileSync(
    path.join(repoRoot, 'test-fixtures', 'node-consumer', 'public-api.test.cjs'),
    path.join(consumerRoot, 'public-api.test.cjs')
  )

  console.log(
    `Testing ${packages.length} installed packages with Node ${process.version}, npm ${npmVersion}.`
  )
  run([npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], consumerRoot, {
    timeout: 300_000
  })
  run(['--test', 'public-api.test.cjs'], consumerRoot)
  run(
    [
      '-e',
      [
        "const assert = require('node:assert/strict')",
        "for (const name of ['@taquito/michel-codec', '@taquito/core']) {",
        "  assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' })",
        '}',
        "assert.throws(() => require('@ecadlabs/beacon-utils/wallet'), (error) =>",
        "  error.code === 'MODULE_NOT_FOUND' && error.message.includes('@taquito/michel-codec'))"
      ].join('\n')
    ],
    consumerRoot
  )

  const typecheck = (
    file,
    types = ['chrome'],
    emitDeclarations = false,
    exactOptionalPropertyTypes = false
  ) => {
    for (const [module, moduleResolution] of [
      ['NodeNext', 'NodeNext'],
      ['ESNext', 'Bundler']
    ]) {
      writeJson(path.join(consumerRoot, 'tsconfig.consumer.json'), {
        compilerOptions: {
          noEmit: !emitDeclarations,
          declaration: emitDeclarations,
          emitDeclarationOnly: emitDeclarations,
          outDir: 'declarations-' + moduleResolution,
          strict: true,
          exactOptionalPropertyTypes,
          // Existing pairing declarations do not support exact optionals. Check that mode at the consumer seam.
          skipLibCheck: exactOptionalPropertyTypes,
          target: 'ES2024',
          lib: ['ES2024', 'DOM'],
          types,
          module,
          moduleResolution
        },
        files: [file]
      })
      console.log('Typechecking ' + file + ' with ' + moduleResolution + ' resolution.')
      run(
        [
          path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
          '--project',
          'tsconfig.consumer.json',
          '--pretty',
          'false'
        ],
        consumerRoot
      )
      if (emitDeclarations) {
        const declarationDirectory = 'declarations-' + moduleResolution
        const emitted = readFileSync(
          path.join(consumerRoot, declarationDirectory, 'wallet-helpers-library.types.d.ts'),
          'utf8'
        )
        if (
          !emitted.includes('ValidatedWalletPartialTezosOperation') ||
          !emitted.includes('@ecadlabs/beacon-utils/wallet') ||
          emitted.includes('validatedWalletOperation')
        ) {
          throw new Error('Guard inference must emit a reference to the public validated type.')
        }
        writeFileSync(
          path.join(consumerRoot, 'emitted-wallet-consumer.ts'),
          [
            "import type { ValidatedWalletPartialTezosOperation } from '@ecadlabs/beacon-utils/wallet'",
            "import { acceptedOperations, acceptedOperation, acceptedOperationRequest, existingInputOperation } from './" +
              declarationDirectory +
              "/wallet-helpers-library.types.js'",
            'type Assert<Condition extends true> = Condition',
            'export type GuardedRequestReturn = ReturnType<typeof acceptedOperationRequest>',
            'export type InputOperationReturn = ReturnType<typeof existingInputOperation>',
            'export type FilterResult = Assert<ReturnType<typeof acceptedOperations> extends ValidatedWalletPartialTezosOperation[] ? true : false>',
            'export type FilterInput = Assert<ValidatedWalletPartialTezosOperation[] extends ReturnType<typeof acceptedOperations> ? true : false>',
            'export type GuardResult = Assert<ReturnType<typeof acceptedOperation> extends ValidatedWalletPartialTezosOperation | undefined ? true : false>',
            'export type GuardIsDefined = Assert<Exclude<ReturnType<typeof acceptedOperation>, undefined> extends never ? false : true>'
          ].join('\n')
        )
        writeJson(path.join(consumerRoot, 'tsconfig.emitted-consumer.json'), {
          compilerOptions: {
            noEmit: true,
            strict: true,
            skipLibCheck: false,
            target: 'ES2024',
            lib: ['ES2024', 'DOM'],
            types,
            module,
            moduleResolution
          },
          files: ['emitted-wallet-consumer.ts']
        })
        console.log(
          'Consuming emitted wallet declarations with ' + moduleResolution + ' resolution.'
        )
        run(
          [
            path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
            '--project',
            'tsconfig.emitted-consumer.json',
            '--pretty',
            'false'
          ],
          consumerRoot
        )
      }
    }
  }

  writeFileSync(
    path.join(consumerRoot, 'root-import.types.ts'),
    "import { getHexHash } from '@ecadlabs/beacon-utils'\nexport const hash: Promise<string> = getHexHash('')\n"
  )
  typecheck('root-import.types.ts', ['node', 'chrome'])
  for (const file of [
    'wallet-helpers.types.ts',
    'wallet-helpers-library.types.ts',
    'wallet-helpers.test.cjs'
  ]) {
    copyFileSync(
      path.join(repoRoot, 'test-fixtures', 'node-consumer', file),
      path.join(consumerRoot, file)
    )
  }
  writeFileSync(
    path.join(consumerRoot, 'exact-optional.types.ts'),
    [
      "import { TezosOperationType } from '@ecadlabs/beacon-types'",
      "import { isPartialTezosOperation } from '@ecadlabs/beacon-utils/wallet'",
      'export const delegateLength = (value: unknown): number | undefined => {',
      '  if (',
      '    isPartialTezosOperation(value) &&',
      '    value.kind === TezosOperationType.DELEGATION &&',
      "    'delegate' in value",
      '  ) {',
      '    return value.delegate.length',
      '  }',
      '  return undefined',
      '}',
      '',
      'export const argumentCount = (value: unknown): number | undefined => {',
      '  if (',
      '    isPartialTezosOperation(value) &&',
      '    value.kind === TezosOperationType.REGISTER_GLOBAL_CONSTANT &&',
      '    !Array.isArray(value.value) &&',
      "    'prim' in value.value &&",
      "    'args' in value.value",
      '  ) {',
      '    return value.value.args.length',
      '  }',
      '  return undefined',
      '}'
    ].join('\n')
  )
  for (const [index, version] of ['25.1.1', '25.2.0-beta3'].entries()) {
    console.log('Testing opt-in wallet helpers with @taquito/michel-codec ' + version + '.')
    run(
      [
        npmCli,
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '@taquito/michel-codec@' + version
      ],
      consumerRoot,
      { timeout: 300_000 }
    )
    if (index === 0) {
      typecheck('exact-optional.types.ts', ['chrome'], false, true)
      typecheck('wallet-helpers.types.ts')
      typecheck('wallet-helpers-library.types.ts', ['chrome'], true)
    }
    run(['--test', 'wallet-helpers.test.cjs'], consumerRoot)
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
