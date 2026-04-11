import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const packagesRoot = path.join(repoRoot, 'packages')

const primaryPackages = new Set(['beacon-sdk', 'beacon-dapp', 'beacon-wallet'])
const addOnPackages = new Set([
  'beacon-blockchain-substrate',
  'beacon-blockchain-tezos',
  'beacon-blockchain-tezos-sapling'
])

const repoUrl = 'https://github.com/ecadlabs/beacon-sdk-taquito-patches'
const airgapUrl = 'https://github.com/airgap-it/beacon-sdk'
const octezConnectUrl = 'https://github.com/trilitech/octez.connect'

const packageDirs = [
  'beacon-blockchain-substrate',
  'beacon-blockchain-tezos',
  'beacon-blockchain-tezos-sapling',
  'beacon-core',
  'beacon-dapp',
  'beacon-sdk',
  'beacon-transport-matrix',
  'beacon-transport-postmessage',
  'beacon-transport-walletconnect',
  'beacon-types',
  'beacon-ui',
  'beacon-utils',
  'beacon-wallet'
]

const usageNote = (dirName) => {
  if (primaryPackages.has(dirName)) {
    return 'This is a primary package in the ECAD-maintained Beacon SDK line and may be installed directly.'
  }

  if (addOnPackages.has(dirName)) {
    return 'This is an add-on package in the ECAD-maintained Beacon SDK line. Most consumers get it transitively through higher-level Beacon packages.'
  }

  if (dirName === 'beacon-types') {
    return 'This is a shared types package in the ECAD-maintained Beacon SDK line. Install it directly only when you need the Beacon type surface itself.'
  }

  return 'This is a lower-level support package in the ECAD-maintained Beacon SDK line. Most consumers should install a higher-level package instead.'
}

const installBlock = (packageName, dirName) => {
  if (!primaryPackages.has(dirName)) {
    return ''
  }

  return `## Install

\`\`\`sh
npm install ${packageName}
\`\`\`
`
}

const recommendedEntryPoints = (dirName) => {
  if (primaryPackages.has(dirName)) {
    return ''
  }

  return `## Usually install instead

- \`@ecadlabs/beacon-sdk\` for the general Beacon SDK surface
- \`@ecadlabs/beacon-dapp\` for dApp integrations
- \`@ecadlabs/beacon-wallet\` for wallet integrations
- \`@taquito/beacon-wallet\` if you are consuming Beacon through Taquito
`
}

const template = ({ packageName, description, dirName }) => `# \`${packageName}\`

${description}

${usageNote(dirName)}

${installBlock(packageName, dirName)}## Package provenance

This package is published from the ECAD-maintained Beacon SDK repository:
[ecadlabs/beacon-sdk-taquito-patches](${repoUrl})

- Original Beacon lineage: [airgap-it/beacon-sdk](${airgapUrl})
- External maintenance line ECAD may selectively import from: [trilitech/octez.connect](${octezConnectUrl})

${recommendedEntryPoints(dirName)}## Notes

- ECAD publishes these packages under the neutral \`@ecadlabs/beacon-*\` scope
- Taquito consumes this package line directly where Beacon patches are needed
- Release notes, package policy, and the current package list live in the repository README
`

for (const dirName of packageDirs) {
  const packageDir = path.join(packagesRoot, dirName)
  const packageJson = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  const readmePath = path.join(packageDir, 'README.md')

  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    readmePath,
    template({
      packageName: packageJson.name,
      description: packageJson.description,
      dirName
    }),
    'utf8'
  )
}

console.log(`Synced package READMEs for ${packageDirs.length} packages.`)
