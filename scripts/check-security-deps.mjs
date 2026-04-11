import path from 'node:path'

import { readJson, repoRoot } from './workspace-utils.mjs'

const minimumVersions = {
  '@stablelib/ed25519': '2.1.0'
}

const compareSemver = (left, right) => {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10))
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10))

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0

    if (leftPart > rightPart) {
      return 1
    }

    if (leftPart < rightPart) {
      return -1
    }
  }

  return 0
}

const manifests = [
  readJson(path.join(repoRoot, 'packages', 'beacon-core', 'package.json')),
  readJson(path.join(repoRoot, 'packages', 'beacon-utils', 'package.json'))
]

const lockfile = readJson(path.join(repoRoot, 'package-lock.json'))
const failures = []

const beaconUtilsManifest = manifests.find((manifest) => manifest.name === '@ecadlabs/beacon-utils')
const beaconCoreManifest = manifests.find((manifest) => manifest.name === '@ecadlabs/beacon-core')

const declaredVersion = beaconUtilsManifest.dependencies?.['@stablelib/ed25519']

if (!declaredVersion) {
  failures.push('@ecadlabs/beacon-utils is missing required dependency @stablelib/ed25519')
} else {
  const normalizedVersion = declaredVersion.replace(/^[^\d]*/, '')

  if (compareSemver(normalizedVersion, minimumVersions['@stablelib/ed25519']) < 0) {
    failures.push(
      `@ecadlabs/beacon-utils declares @stablelib/ed25519@${declaredVersion}, expected at least ${minimumVersions['@stablelib/ed25519']}`
    )
  }
}

if (beaconCoreManifest.dependencies?.['@stablelib/ed25519']) {
  failures.push('@ecadlabs/beacon-core should consume ed25519 through @ecadlabs/beacon-utils, not declare it directly')
}

for (const [dependencyName, minimumVersion] of Object.entries(minimumVersions)) {
  const lockfileEntry = lockfile.packages?.[`node_modules/${dependencyName}`]

  if (!lockfileEntry?.version) {
    failures.push(`package-lock.json is missing resolved entry for ${dependencyName}`)
    continue
  }

  if (compareSemver(lockfileEntry.version, minimumVersion) < 0) {
    failures.push(
      `package-lock.json resolves ${dependencyName}@${lockfileEntry.version}, expected at least ${minimumVersion}`
    )
  }
}

if (failures.length > 0) {
  console.error('Security dependency check failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log('Security-sensitive dependency baselines are satisfied.')
