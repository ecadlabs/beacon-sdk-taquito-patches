import { resolve } from 'node:path'
import ts from 'typescript'

it('type-checks subscriber payloads for account clearing and request correlation', () => {
  const configPath = resolve('tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  expect(config.error).toBeUndefined()
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd())
  const program = ts.createProgram({
    rootNames: [resolve('__tests__/type-fixtures/event-payloads.ts')],
    options: { ...parsed.options, noEmit: true }
  })
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
  const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getCanonicalFileName: (file) => file,
    getNewLine: () => '\n'
  })
  expect(formatted).toBe('')
}, 30_000)
