import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { getWorkspacePackages, readJson, repoRoot, rootPackagePath, writeJson } from './workspace-utils.mjs'

const rootPackage = readJson(rootPackagePath)
const targetVersion = process.argv[2] ?? rootPackage.version
const workspacePackages = getWorkspacePackages()
const workspaceNames = new Set(workspacePackages.map((pkg) => pkg.manifest.name))

rootPackage.version = targetVersion
writeJson(rootPackagePath, rootPackage)

for (const pkg of workspacePackages) {
  pkg.manifest.version = targetVersion

  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = pkg.manifest[section]

    if (!dependencies) {
      continue
    }

    for (const dependencyName of Object.keys(dependencies)) {
      if (workspaceNames.has(dependencyName)) {
        dependencies[dependencyName] = targetVersion
      }
    }
  }

  writeJson(pkg.packageJsonPath, pkg.manifest)
}

const constantsPath = path.join(repoRoot, 'packages', 'beacon-core', 'src', 'constants.ts')
const constantsFile = readFileSync(constantsPath, 'utf8')
const updatedConstants = constantsFile.replace(
  /export const SDK_VERSION: string = '([^']+)'/,
  `export const SDK_VERSION: string = '${targetVersion}'`
)

writeFileSync(constantsPath, updatedConstants)

console.log(`Synchronized workspace version to ${targetVersion}.`)
