import { spawnSync } from 'node:child_process'

import { getWorkspacePackages, topologicallySortWorkspaces } from './workspace-utils.mjs'

const [scriptName, ...flags] = process.argv.slice(2)

if (!scriptName) {
  throw new Error('Usage: node scripts/run-workspaces.mjs <script> [--topological]')
}

const topological = flags.includes('--topological')
const packages = topological ? topologicallySortWorkspaces(getWorkspacePackages()) : getWorkspacePackages()

for (const pkg of packages) {
  if (!pkg.manifest.scripts?.[scriptName]) {
    continue
  }

  const result = spawnSync('npm', ['run', scriptName], {
    cwd: pkg.directory,
    stdio: 'inherit'
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
