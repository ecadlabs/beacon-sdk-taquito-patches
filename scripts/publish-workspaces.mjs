import { spawnSync } from 'node:child_process'

import { getWorkspacePackages, topologicallySortWorkspaces } from './workspace-utils.mjs'

const extraArgs = process.argv.slice(2)
const packages = topologicallySortWorkspaces(getWorkspacePackages())

const getPrereleaseTag = (version) => {
  const prerelease = version.split('-')[1]

  if (!prerelease) {
    return undefined
  }

  return prerelease.split('.')[0]
}

const hasExplicitTagArg = extraArgs.some((arg, index) => {
  if (arg === '--tag') {
    return true
  }

  if (index > 0 && extraArgs[index - 1] === '--tag') {
    return true
  }

  return arg.startsWith('--tag=')
})

for (const pkg of packages) {
  if (pkg.manifest.private) {
    continue
  }

  const publishArgs = ['publish', '--access', 'public']
  const distTag = process.env.NPM_DIST_TAG ?? getPrereleaseTag(pkg.manifest.version)

  if (distTag && !hasExplicitTagArg) {
    publishArgs.push('--tag', distTag)
  }

  publishArgs.push(...extraArgs)
  const result = spawnSync('npm', publishArgs, {
    cwd: pkg.directory,
    stdio: 'inherit'
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
