import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

it('accepts legacy enableMetrics flags in both public option types', () => {
  const root = path.resolve(__dirname, '../../..')
  const temporary = mkdtempSync(path.join(tmpdir(), 'beacon-option-types-'))
  try {
    const config = path.join(temporary, 'tsconfig.json')
    writeFileSync(
      config,
      JSON.stringify({
        extends: path.join(root, 'tsconfig.json'),
        compilerOptions: { noEmit: true, types: ['node', 'chrome'] },
        files: [path.join(root, 'test-fixtures/client-options/legacy-metrics.ts')],
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
