import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

it('keeps explicit undefined origins safe for exact-optional consumers', () => {
  const root = path.resolve(__dirname, '../../..')
  const temporary = mkdtempSync(path.join(tmpdir(), 'beacon-error-origin-types-'))
  try {
    const config = path.join(temporary, 'tsconfig.json')
    writeFileSync(
      config,
      JSON.stringify({
        extends: path.join(root, 'tsconfig.json'),
        compilerOptions: {
          rootDir: root,
          noEmit: true,
          declaration: false,
          exactOptionalPropertyTypes: true,
          // Existing pairing declarations do not support this flag. Check the caller contract.
          skipLibCheck: true,
          types: ['node', 'chrome']
        },
        files: [path.join(root, 'test-fixtures/client-options/error-origin.types.ts')],
        include: []
      })
    )
    const result = spawnSync(
      process.execPath,
      [require.resolve('typescript/bin/tsc'), '--project', config, '--pretty', 'false'],
      { cwd: root, encoding: 'utf8', timeout: 30000 }
    )
    expect(result.error).toBeUndefined()
    expect({
      status: result.status,
      signal: result.signal,
      diagnostics: result.stdout + result.stderr
    }).toEqual({ status: 0, signal: null, diagnostics: '' })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}, 45000)
