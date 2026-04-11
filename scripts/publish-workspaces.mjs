import { spawnSync } from 'node:child_process'

import { getWorkspacePackages, topologicallySortWorkspaces } from './workspace-utils.mjs'

const extraArgs = process.argv.slice(2)
const packages = topologicallySortWorkspaces(getWorkspacePackages())

for (const pkg of packages) {
  if (pkg.manifest.private) {
    continue
  }

  const publishArgs = ['publish', '--access', 'public', ...extraArgs]
  const result = spawnSync('npm', publishArgs, {
    cwd: pkg.directory,
    stdio: 'inherit'
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
