const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const gate = resolve(__dirname, '../lint-new-findings.mjs')
const file = 'packages/sample/src/example.ts'

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'lint-gate-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  mkdirSync(join(cwd, 'packages/sample/src'), { recursive: true })
  mkdirSync(join(cwd, 'scripts'))
  mkdirSync(join(cwd, 'bin'))
  writeFileSync(join(cwd, file), 'export const first = 1\nexport const second = 2\n')
  writeFileSync(join(cwd, 'scripts/lint-baseline.json'), JSON.stringify({ [file]: { debt: 1 } }))
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base')
  git('branch', 'base')
  writeFileSync(join(cwd, file), 'export const first = 1\nexport const second = 3\n')
  writeFileSync(join(cwd, 'bin/npx'), `#!/usr/bin/env node
if (process.env.FAKE_SIGNAL) process.kill(process.pid, 'SIGTERM')
else { process.stdout.write(process.env.FAKE_REPORT); process.exit(Number(process.env.FAKE_EXIT)) }
`, { mode: 0o755 })
  const run = (messages, { status = messages.some(m => m.severity === 2) ? 1 : 0, raw, transform = report => report, args = [], env = {} } = {}) => {
    const report = [{ filePath: join(cwd, file), messages, errorCount: messages.filter(m => m.severity === 2).length, warningCount: messages.filter(m => m.severity === 1).length, fatalErrorCount: messages.filter(m => m.fatal).length }]
    return spawnSync(process.execPath, [gate, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PATH: `${join(cwd, 'bin')}:${process.env.PATH}`, LINT_BASE_REF: 'base', FAKE_REPORT: raw ?? JSON.stringify(transform(report)), FAKE_EXIT: String(status), ...env } })
  }
  return { run, cwd, git }
}

const debt = { ruleId: 'debt', severity: 2, message: 'Existing debt', line: 1, column: 1 }

test('fatal diagnostics on untouched lines fail the gate', t => {
  const { run } = fixture(t)
  const result = run([{ ...debt, ruleId: null, fatal: true }], { status: 2 })
  assert.equal(result.status, 2, result.stdout + result.stderr)
})

test('process and report failures cannot pass with findings outside touched lines', async t => {
  const cases = [
    ['operational exit', { status: 2 }],
    ['signal', { env: { FAKE_SIGNAL: '1' } }],
    ['empty output', { raw: '' }],
    ['malformed JSON', { raw: '{' }],
    ['empty report', { raw: '[]' }],
    ['non-array report', { raw: '{}' }],
    ['missing messages', { transform: ([entry]) => [{ ...entry, messages: undefined }] }],
    ['invalid diagnostic', { transform: ([entry]) => [{ ...entry, messages: [null] }] }],
    ['duplicate report', { transform: ([entry]) => [entry, entry] }],
    ['inconsistent counts', { transform: ([entry]) => [{ ...entry, errorCount: 0 }] }],
    ['invalid location', { transform: ([entry]) => [{ ...entry, messages: [{ ...debt, line: 0 }] }] }],
    ['exit/report mismatch', { status: 0 }]
  ]
  for (const [name, options] of cases) await t.test(name, t => {
    const { run } = fixture(t)
    const result = run([debt], options)
    assert.equal(result.status, 2, result.stdout + result.stderr)
  })
  await t.test('fatal with ordinary lint exit', t => {
    const { run } = fixture(t)
    const result = run([{ ...debt, fatal: true }])
    assert.equal(result.status, 2, result.stdout + result.stderr)
  })
})

test('ESLint launch failure fails after successful Git discovery', t => {
  const { run, cwd } = fixture(t)
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(cwd, 'bin/git'))
  rmSync(join(cwd, 'bin/npx'))
  const result = run([debt], { env: { PATH: join(cwd, 'bin') } })
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.match(result.stderr, /ESLint failed.*ENOENT/)
})

test('existing debt and reductions pass, but touched findings and full-source increases fail', async t => {
  for (const [name, messages, expected] of [
    ['existing debt', [debt], 0],
    ['debt reduction', [], 0],
    ['same-count finding on touched line', [{ ...debt, line: 2 }], 1],
    ['new rule on untouched line', [{ ...debt, ruleId: 'new-rule' }], 1],
    ['increased count on untouched line', [debt, debt], 1],
    ['warning on touched line', [{ ...debt, line: 2, severity: 1 }], 1]
  ]) await t.test(name, t => {
    const { run } = fixture(t)
    const result = run(messages)
    assert.equal(result.status, expected, result.stdout + result.stderr)
  })
})

test('config-only changes and pushes with base at HEAD still enforce full-source counts', async t => {
  for (const base of ['base', 'HEAD']) await t.test(base, t => {
    const { run, cwd, git } = fixture(t)
    git('checkout', '--', file)
    writeFileSync(join(cwd, 'eslint.config.mjs'), 'export default []\n')
    const result = run([debt, debt], { env: { LINT_BASE_REF: base } })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stderr, /increased from 1 to 2/)
  })
})

test('new source files own every line even when a baseline allowance exists', t => {
  const { run, git } = fixture(t)
  git('rm', '--cached', file)
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'remove source')
  const result = run([debt], { env: { LINT_BASE_REF: 'HEAD' } })
  assert.equal(result.status, 1, result.stdout + result.stderr)
})

test('reports cannot omit a source file', t => {
  const { run, cwd } = fixture(t)
  writeFileSync(join(cwd, 'packages/sample/src/other.ts'), 'export const other = 1\n')
  const result = run([debt])
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.match(result.stderr, /omitted source files/)
})

test('generated ignored TypeScript sources cannot add findings outside the baseline', t => {
  const { run, cwd } = fixture(t)
  const generated = 'packages/sample/src/generated/wallet-list.ts'
  mkdirSync(join(cwd, 'packages/sample/src/generated'))
  mkdirSync(join(cwd, 'packages/no-source'))
  writeFileSync(join(cwd, '.gitignore'), 'packages/sample/src/generated/\n')
  writeFileSync(join(cwd, generated), 'export const wallet = 1\n')
  // Model ESLint returning only the source files it was asked to lint.
  writeFileSync(join(cwd, 'bin/npx'), `#!/usr/bin/env node
const { relative } = require('node:path')
const report = JSON.parse(process.env.FAKE_REPORT).filter(entry => process.argv.includes(relative(process.cwd(), entry.filePath)))
process.stdout.write(JSON.stringify(report))
process.exit(1)
`, { mode: 0o755 })
  const result = run([debt], {
    transform: ([entry]) => [entry, { ...entry, filePath: join(cwd, generated), messages: [{ ...debt, ruleId: 'new-rule' }] }]
  })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /generated\/wallet-list\.ts: new-rule increased from 0 to 1/)
})

test('baseline update records reductions explicitly', t => {
  const { run, cwd } = fixture(t)
  const { readFileSync } = require('node:fs')
  const result = run([], { args: ['--update-baseline'] })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'scripts/lint-baseline.json'), 'utf8')), {})
})
