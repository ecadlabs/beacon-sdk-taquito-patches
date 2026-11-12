#!/usr/bin/env node
// Full-source counts catch regressions from config/toolchain changes. Touched
// lines also catch replacement findings hidden by an unchanged file/rule count.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const cwd = process.cwd()
const baseRef = process.env.LINT_BASE_REF || 'origin/taquito-patches'
const baselinePath = resolve('scripts/lint-baseline.json')
const update = process.argv.length === 3 && process.argv[2] === '--update-baseline'

function fail(message) {
  console.error(message)
  process.exit(2)
}

if (process.argv.length > 2 && !update) fail('Usage: lint-new-findings.mjs [--update-baseline]')

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

function sourceFile(file) {
  return /^packages\/[^/]+\/src\/.*\.ts$/.test(file)
}

function files(args) {
  return git(args).split('\0').filter(Boolean)
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(file)
    return entry.isFile() && entry.name.endsWith('.ts') ? [relative(cwd, file)] : []
  })
}

try {
  // Generated source files may be gitignored, but npm run lint checks them too.
  const sources = readdirSync('packages', { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const directory = resolve('packages', entry.name, 'src')
      return existsSync(directory) ? sourceFiles(directory) : []
    }).sort()
  if (sources.length === 0) fail('No TypeScript source files found; refusing an empty lint check.')

  // Run even when no source lines changed, including pushes whose base is HEAD.
  const result = spawnSync('npx', ['--no-install', 'eslint', '-f', 'json', ...sources], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  })
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    fail(`ESLint failed (${result.error?.message || result.signal || `exit ${result.status}`}): ${result.stderr || ''}`)
  }
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    fail('ESLint produced missing or malformed JSON.')
  }
  if (!Array.isArray(report) || report.length === 0) fail('ESLint produced an empty or invalid report.')

  const expected = new Set(sources)
  const byFile = new Map()
  const counts = {}
  for (const entry of report) {
    if (!entry || typeof entry.filePath !== 'string' || !isAbsolute(entry.filePath) ||
        !Array.isArray(entry.messages) ||
        !['errorCount', 'warningCount', 'fatalErrorCount'].every(key => Number.isInteger(entry[key]) && entry[key] >= 0)) {
      fail('ESLint produced an invalid file report.')
    }
    const file = relative(cwd, entry.filePath)
    if (!expected.has(file) || byFile.has(file)) fail(`ESLint reported an unexpected or duplicate file: ${file}`)
    if (entry.fatalErrorCount > 0) fail(`ESLint reported a fatal diagnostic in ${file}.`)
    let errors = 0
    let warnings = 0
    for (const message of entry.messages) {
      if (!message || typeof message.message !== 'string' || ![1, 2].includes(message.severity) ||
          !(message.ruleId === null || typeof message.ruleId === 'string') ||
          (message.fatal !== undefined && typeof message.fatal !== 'boolean')) fail(`Invalid ESLint diagnostic in ${file}.`)
      // Parser/configuration errors must never be hidden by line filtering.
      if (message.fatal || message.ruleId === null) fail(`ESLint could not lint ${file}: ${message.message}`)
      if (!Number.isInteger(message.line) || message.line < 1 ||
          !Number.isInteger(message.column) || message.column < 1) fail(`Invalid ESLint diagnostic location in ${file}.`)
      if (message.severity === 2) errors++
      else warnings++
      counts[file] ??= Object.create(null)
      counts[file][message.ruleId] = (counts[file][message.ruleId] || 0) + 1
    }
    if (entry.errorCount !== errors || entry.warningCount !== warnings) fail(`Inconsistent ESLint counts in ${file}.`)
    byFile.set(file, entry.messages)
  }
  if (byFile.size !== expected.size) fail('ESLint omitted source files from its report.')
  const hasErrors = report.some(entry => entry.errorCount > 0)
  if (hasErrors !== (result.status === 1)) fail('ESLint exit status disagrees with its report.')

  if (update) {
    const sorted = Object.fromEntries(Object.keys(counts).sort().map(file => [file,
      Object.fromEntries(Object.entries(counts[file]).sort(([a], [b]) => a.localeCompare(b)))]))
    writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`)
    console.log('Updated scripts/lint-baseline.json. Review the count changes before committing.')
    process.exit(0)
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  if (!baseline || Array.isArray(baseline) || typeof baseline !== 'object') fail('Invalid lint baseline.')
  for (const [file, rules] of Object.entries(baseline)) {
    if (!sourceFile(file) || !rules || Array.isArray(rules) || typeof rules !== 'object' ||
        !Object.entries(rules).every(([rule, count]) => rule && Number.isInteger(count) && count >= 0)) fail('Invalid lint baseline entry.')
  }
  const findings = []
  for (const [file, rules] of Object.entries(counts)) {
    for (const [rule, count] of Object.entries(rules)) {
      const allowed = Object.hasOwn(baseline, file) && Object.hasOwn(baseline[file], rule) ? baseline[file][rule] : 0
      if (count > allowed) findings.push(`${file}: ${rule} increased from ${allowed} to ${count}`)
    }
  }

  const mergeBase = git(['merge-base', baseRef, 'HEAD']).trim()
  const changed = new Set([
    ...files(['diff', '-z', '--name-only', '--diff-filter=ACMR', mergeBase, 'HEAD']),
    ...files(['diff', '-z', '--name-only', '--diff-filter=ACMR', 'HEAD']),
    ...files(['ls-files', '-z', '--others', '--exclude-standard'])
  ])
  for (const file of changed) {
    if (!byFile.has(file)) continue
    const isNew = !git(['ls-tree', '-r', '--name-only', mergeBase, '--', file]).trim()
    const touched = new Set()
    const diff = git(['diff', '-U0', mergeBase, '--', file])
    for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(match[1])
      const count = match[2] === undefined ? 1 : Number(match[2])
      for (let line = start; line < start + count; line++) touched.add(line)
    }
    for (const message of byFile.get(file)) {
      if (isNew || touched.has(message.line)) findings.push(`${file}:${message.line}:${message.column} ${message.message} (${message.ruleId})`)
    }
  }
  if (findings.length) {
    console.error(findings.join('\n'))
    process.exit(1)
  }
  console.log(`No lint count increases or findings on touched lines vs ${baseRef} (${sources.length} source files).`)
} catch (error) {
  fail(`Lint gate failed: ${error.message}`)
}
