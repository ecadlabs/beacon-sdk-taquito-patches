import { resolve } from 'node:path'
import ts from 'typescript'

it.each(['event-payloads', 'message-observer'])(
  'type-checks public subscriber contract: %s',
  (fixture) => {
    const configPath = resolve('tsconfig.json')
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    expect(config.error).toBeUndefined()
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd())
    const program = ts.createProgram({
      rootNames: [resolve(`__tests__/type-fixtures/${fixture}.ts`)],
      options: { ...parsed.options, noEmit: true }
    })
    const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
    const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getCanonicalFileName: (file) => file,
      getNewLine: () => '\n'
    })
    expect(formatted).toBe('')
  },
  30_000
)
