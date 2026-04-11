import { readFileSync } from 'node:fs'
import path from 'node:path'

import { getWorkspacePackages, readJson, repoRoot, rootPackagePath } from './workspace-utils.mjs'

const rootPackage = readJson(rootPackagePath)
const expectedVersion = rootPackage.version
const workspacePackages = getWorkspacePackages()
const workspaceNames = new Set(workspacePackages.map((pkg) => pkg.manifest.name))
const versionErrors = []

for (const pkg of workspacePackages) {
  if (pkg.manifest.version !== expectedVersion) {
    versionErrors.push(
      `${path.relative(process.cwd(), pkg.packageJsonPath)} has version ${pkg.manifest.version}, expected ${expectedVersion}`
    )
  }

  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = pkg.manifest[section] ?? {}

    for (const [dependencyName, dependencyVersion] of Object.entries(dependencies)) {
      if (workspaceNames.has(dependencyName) && dependencyVersion !== expectedVersion) {
        versionErrors.push(
          `${pkg.manifest.name} ${section}.${dependencyName} is ${dependencyVersion}, expected ${expectedVersion}`
        )
      }
    }
  }
}

const constantsPath = path.join(repoRoot, 'packages', 'beacon-core', 'src', 'constants.ts')
const constantsFile = readFileSync(constantsPath, 'utf8')
const sdkVersionMatch = constantsFile.match(/SDK_VERSION: string = '([^']+)'/)

if (!sdkVersionMatch) {
  versionErrors.push('Could not find SDK_VERSION in packages/beacon-core/src/constants.ts')
} else if (sdkVersionMatch[1] !== expectedVersion) {
  versionErrors.push(
    `packages/beacon-core/src/constants.ts has SDK_VERSION ${sdkVersionMatch[1]}, expected ${expectedVersion}`
  )
}

if (versionErrors.length > 0) {
  console.error('Workspace version check failed:')
  for (const error of versionErrors) {
    console.error(`- ${error}`)
  }
  process.exit(1)
}

console.log(`Workspace versions are consistent at ${expectedVersion}.`)
