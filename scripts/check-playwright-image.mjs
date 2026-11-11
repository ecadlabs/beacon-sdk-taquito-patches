import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { readJson, repoRoot } from './workspace-utils.mjs'

// The e2e jobs run in mcr.microsoft.com/playwright, which bundles browsers for
// exactly one Playwright release. If the lockfile moves without the image tag,
// Playwright can't find its browser and e2e dies at launch.
const lockfile = readJson(path.join(repoRoot, 'package-lock.json'))
const lockedVersion = lockfile.packages?.['node_modules/@playwright/test']?.version

if (!lockedVersion) {
  console.error('package-lock.json has no resolved @playwright/test')
  process.exit(1)
}

const workflowsDir = path.join(repoRoot, '.github', 'workflows')
const imagePattern = /mcr\.microsoft\.com\/playwright:v([^\s-]+)/g
const failures = []
let imageCount = 0

for (const file of readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name))) {
  const source = readFileSync(path.join(workflowsDir, file), 'utf8')

  for (const [, imageVersion] of source.matchAll(imagePattern)) {
    imageCount += 1
    if (imageVersion !== lockedVersion) {
      failures.push(`.github/workflows/${file} uses playwright:v${imageVersion}`)
    }
  }
}

if (imageCount === 0) {
  console.error('No mcr.microsoft.com/playwright image found in .github/workflows')
  process.exit(1)
}

if (failures.length > 0) {
  console.error(`Playwright image tags must match locked @playwright/test ${lockedVersion}:`)
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log(`Playwright images match @playwright/test ${lockedVersion}.`)
