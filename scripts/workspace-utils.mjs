import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))

export const repoRoot = path.resolve(scriptsDir, '..')
export const rootPackagePath = path.join(repoRoot, 'package.json')
export const workspaceRoot = path.join(repoRoot, 'packages')

export const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'))

export const writeJson = (filePath, value) => {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export const getWorkspacePackages = () =>
  readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(workspaceRoot, entry.name))
    .filter((directory) => existsSync(path.join(directory, 'package.json')))
    .map((directory) => {
      const packageJsonPath = path.join(directory, 'package.json')
      const manifest = readJson(packageJsonPath)

      return {
        directory,
        packageJsonPath,
        manifest
      }
    })

const dependencySections = ['dependencies', 'optionalDependencies', 'peerDependencies']

export const getInternalDependencyNames = (manifest, workspaceNames) => {
  const internal = new Set()

  for (const section of dependencySections) {
    const dependencies = manifest[section] ?? {}
    for (const dependencyName of Object.keys(dependencies)) {
      if (workspaceNames.has(dependencyName)) {
        internal.add(dependencyName)
      }
    }
  }

  return [...internal]
}

export const topologicallySortWorkspaces = (packages) => {
  const workspaceNames = new Set(packages.map((pkg) => pkg.manifest.name))
  const incomingEdges = new Map()
  const outgoingEdges = new Map()
  const packageByName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]))

  for (const pkg of packages) {
    incomingEdges.set(pkg.manifest.name, 0)
    outgoingEdges.set(pkg.manifest.name, [])
  }

  for (const pkg of packages) {
    const dependencyNames = getInternalDependencyNames(pkg.manifest, workspaceNames)

    for (const dependencyName of dependencyNames) {
      outgoingEdges.get(dependencyName).push(pkg.manifest.name)
      incomingEdges.set(pkg.manifest.name, incomingEdges.get(pkg.manifest.name) + 1)
    }
  }

  const queue = packages
    .map((pkg) => pkg.manifest.name)
    .filter((name) => incomingEdges.get(name) === 0)
    .sort()

  const ordered = []

  while (queue.length > 0) {
    const name = queue.shift()
    ordered.push(packageByName.get(name))

    for (const dependentName of outgoingEdges.get(name)) {
      incomingEdges.set(dependentName, incomingEdges.get(dependentName) - 1)

      if (incomingEdges.get(dependentName) === 0) {
        queue.push(dependentName)
        queue.sort()
      }
    }
  }

  if (ordered.length !== packages.length) {
    throw new Error('Workspace dependency graph contains a cycle')
  }

  return ordered
}
