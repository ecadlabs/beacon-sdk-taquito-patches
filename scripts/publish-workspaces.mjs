import { spawnSync } from 'node:child_process'

import publishWorkspaceHelpers from './helpers/publish-workspaces.js'
import { getWorkspacePackages, topologicallySortWorkspaces } from './workspace-utils.mjs'

const { resolvePublishTag } = publishWorkspaceHelpers
const { resolvePublishCommand } = publishWorkspaceHelpers
const extraArgs = process.argv.slice(2)
const packages = topologicallySortWorkspaces(getWorkspacePackages())

for (const pkg of packages) {
  if (pkg.manifest.private) {
    continue
  }

  const publishArgs = ['publish', '--access', 'public']
  const distTag = resolvePublishTag({
    version: pkg.manifest.version,
    extraArgs,
    env: process.env
  })

  if (distTag) {
    publishArgs.push('--tag', distTag)
  }

  publishArgs.push(...extraArgs)
  const publishCommand = resolvePublishCommand({
    publishArgs,
    env: process.env,
    nodeExecPath: process.execPath
  })
  const result = spawnSync(publishCommand.command, publishCommand.args, {
    cwd: pkg.directory,
    stdio: 'inherit'
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
