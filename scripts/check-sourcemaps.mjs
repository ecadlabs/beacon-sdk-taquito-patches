import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const packagesRoot = path.join(repoRoot, 'packages')

const walk = (dir) => {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      files.push(...walk(entryPath))
      continue
    }

    files.push(entryPath)
  }

  return files
}

const distMapFiles = walk(packagesRoot)
  .filter((filePath) => filePath.includes(`${path.sep}dist${path.sep}`))
  .filter((filePath) => filePath.endsWith('.js.map'))

const failures = []

for (const mapPath of distMapFiles) {
  const map = JSON.parse(readFileSync(mapPath, 'utf8'))
  const sources = Array.isArray(map.sources) ? map.sources : []
  const sourcesContent = Array.isArray(map.sourcesContent) ? map.sourcesContent : undefined

  if (sources.length === 0) {
    continue
  }

  if (!sourcesContent || sourcesContent.length !== sources.length) {
    failures.push(`${path.relative(repoRoot, mapPath)} is missing sourcesContent for one or more sources`)
    continue
  }

  if (sourcesContent.some((source) => typeof source !== 'string' || source.length === 0)) {
    failures.push(`${path.relative(repoRoot, mapPath)} has empty sourcesContent entries`)
  }
}

if (failures.length > 0) {
  console.error('Broken published sourcemaps detected:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log(`Validated ${distMapFiles.length} sourcemap files with embedded source content.`)
