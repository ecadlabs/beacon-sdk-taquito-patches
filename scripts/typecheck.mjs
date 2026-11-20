import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { getWorkspacePackages } from './workspace-utils.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const testPackages = [
  'beacon-core',
  'beacon-dapp',
  'beacon-transport-matrix',
  'beacon-transport-postmessage',
  'beacon-transport-walletconnect',
  'beacon-ui',
  'beacon-types',
  'beacon-utils',
  'beacon-wallet'
]
const production = getWorkspacePackages()
  .map(({ directory }) => relative(root, resolve(directory, 'tsconfig.json')))
  .sort()
const groups = {
  production,
  tests: testPackages.map((name) => `packages/${name}/tsconfig.tests.json`),
  tooling: [
    'tsconfig.tools.json',
    'tsconfig.e2e.json',
    'tsconfig.server.json',
    'tsconfig.compat.json'
  ]
}
const requested = process.argv[2] || 'all'
if (process.argv.length > 3 || !['all', 'coverage', ...Object.keys(groups)].includes(requested)) {
  console.error('Usage: typecheck.mjs [production|tests|tooling|coverage]')
  process.exit(2)
}

function parseConfig(config) {
  const file = resolve(root, config)
  if (!existsSync(file)) throw new Error(`Missing typecheck target: ${config}`)
  const parsed = ts.getParsedCommandLineOfConfigFile(
    file,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      }
    }
  )
  if (parsed.errors.length)
    throw new Error(
      parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n')
    )
  if (!parsed.fileNames.length) throw new Error(`Empty typecheck target: ${config}`)
  for (const source of parsed.fileNames) {
    if (!existsSync(source)) throw new Error(`Missing target source: ${source}`)
  }
  return parsed
}

function checkCoverage() {
  const roots = new Set(
    Object.values(groups)
      .flat()
      .flatMap((config) => parseConfig(config).fileNames.map((file) => resolve(file)))
  )
  const ignored = new Set([
    'node_modules',
    'dist',
    '.git',
    'coverage',
    'webpack_builds',
    'test-results',
    'playwright-report'
  ])
  function scan(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = resolve(directory, entry.name)
      if (entry.isDirectory()) return ignored.has(entry.name) ? [] : scan(file)
      return entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name) ? [file] : []
    })
  }
  const expected = scan(root).filter(
    (file) => !/^packages\/[^/]+\/src\//.test(relative(root, file).split('\\').join('/'))
  )
  if (!expected.length)
    throw new Error('No test/tooling TypeScript files found; refusing an empty coverage check.')
  const unowned = expected.filter((file) => !roots.has(file))
  if (unowned.length)
    throw new Error(
      `TypeScript files without a typecheck target:\n${unowned.map((file) => relative(root, file)).join('\n')}`
    )
  console.log(
    `All ${expected.length} test/tooling TypeScript files belong to parsed typecheck targets.`
  )
}

try {
  checkCoverage()
  if (requested !== 'coverage') {
    const configs = requested === 'all' ? Object.values(groups).flat() : groups[requested]
    for (const config of configs) {
      console.log(`Typechecking ${config}`)
      const result = spawnSync(
        process.execPath,
        [
          require.resolve('typescript/bin/tsc'),
          '--noEmit',
          '--pretty',
          'false',
          '--project',
          config
        ],
        { cwd: root, stdio: 'inherit' }
      )
      if (result.error || result.signal || result.status !== 0) {
        if (result.error || result.signal) console.error(result.error?.message || result.signal)
        process.exit(result.status || 2)
      }
    }
  }
} catch (error) {
  console.error(`Typecheck failed: ${error.message}`)
  process.exit(2)
}
