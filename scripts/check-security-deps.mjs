import path from 'node:path'

import { readJson, repoRoot } from './workspace-utils.mjs'

const minimumVersions = {
  '@stablelib/ed25519': '2.1.0',
  'unstorage': '1.17.5',
  'h3': '1.15.9',
  'defu': '6.1.7',
  'picomatch': '2.3.2'
}

const pinnedVersions = {
  '@walletconnect/sign-client': '2.18.0',
  '@walletconnect/types': '2.18.0',
  '@walletconnect/utils': '2.18.0'
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

const rootManifest = readJson(path.join(repoRoot, 'package.json'))
const manifests = [
  readJson(path.join(repoRoot, 'packages', 'beacon-core', 'package.json')),
  readJson(path.join(repoRoot, 'packages', 'beacon-dapp', 'package.json')),
  readJson(path.join(repoRoot, 'packages', 'beacon-utils', 'package.json')),
  readJson(path.join(repoRoot, 'packages', 'beacon-transport-walletconnect', 'package.json'))
]

const lockfile = readJson(path.join(repoRoot, 'package-lock.json'))
const failures = []

const getResolvedEntries = (dependencyName) =>
  Object.entries(lockfile.packages ?? {})
    .filter(([packagePath]) => packagePath.endsWith(`node_modules/${dependencyName}`))
    .map(([packagePath, entry]) => ({ packagePath, version: entry?.version }))

const beaconUtilsManifest = manifests.find((manifest) => manifest.name === '@ecadlabs/beacon-utils')
const beaconCoreManifest = manifests.find((manifest) => manifest.name === '@ecadlabs/beacon-core')
const beaconDappManifest = manifests.find((manifest) => manifest.name === '@ecadlabs/beacon-dapp')
const walletConnectTransportManifest = manifests.find(
  (manifest) => manifest.name === '@ecadlabs/beacon-transport-walletconnect'
)

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

if (walletConnectTransportManifest.dependencies?.elliptic) {
  failures.push('@ecadlabs/beacon-transport-walletconnect must not declare elliptic')
}

if (beaconDappManifest.dependencies?.['@walletconnect/types'] !== pinnedVersions['@walletconnect/types']) {
  failures.push(
    `@ecadlabs/beacon-dapp declares @walletconnect/types@${beaconDappManifest.dependencies?.['@walletconnect/types'] ?? 'missing'}, expected exact ${pinnedVersions['@walletconnect/types']}`
  )
}

for (const [dependencyName, pinnedVersion] of Object.entries(pinnedVersions)) {
  if (rootManifest.dependencies?.[dependencyName] !== pinnedVersion) {
    failures.push(
      `root package.json declares ${dependencyName}@${rootManifest.dependencies?.[dependencyName] ?? 'missing'}, expected exact ${pinnedVersion}`
    )
  }

  if (rootManifest.overrides?.[dependencyName] !== pinnedVersion) {
    failures.push(
      `root package.json overrides ${dependencyName}@${rootManifest.overrides?.[dependencyName] ?? 'missing'}, expected exact ${pinnedVersion}`
    )
  }

  if (walletConnectTransportManifest.dependencies?.[dependencyName] !== pinnedVersion) {
    failures.push(
      `@ecadlabs/beacon-transport-walletconnect declares ${dependencyName}@${walletConnectTransportManifest.dependencies?.[dependencyName] ?? 'missing'}, expected exact ${pinnedVersion}`
    )
  }

  const resolvedEntries = getResolvedEntries(dependencyName)

  if (resolvedEntries.length === 0) {
    failures.push(`package-lock.json is missing resolved entry for ${dependencyName}`)
    continue
  }

  for (const entry of resolvedEntries) {
    if (entry.version !== pinnedVersion) {
      failures.push(
        `package-lock.json resolves ${dependencyName}@${entry.version ?? 'missing'} at ${entry.packagePath}, expected exact ${pinnedVersion}`
      )
    }
  }
}

for (const [dependencyName, minimumVersion] of Object.entries(minimumVersions)) {
  const resolvedEntries = getResolvedEntries(dependencyName)

  if (resolvedEntries.length === 0) {
    failures.push(`package-lock.json is missing resolved entry for ${dependencyName}`)
    continue
  }

  for (const entry of resolvedEntries) {
    if (!entry.version || compareSemver(entry.version, minimumVersion) < 0) {
      failures.push(
        `package-lock.json resolves ${dependencyName}@${entry.version ?? 'missing'} at ${entry.packagePath}, expected at least ${minimumVersion}`
      )
    }
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
