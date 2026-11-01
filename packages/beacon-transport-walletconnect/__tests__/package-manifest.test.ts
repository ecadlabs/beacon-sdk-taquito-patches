import fs from 'node:fs'
import path from 'node:path'

describe('@ecadlabs/beacon-transport-walletconnect package manifest', () => {
  const manifestPath = path.join(__dirname, '..', 'package.json')
  const rootManifestPath = path.join(__dirname, '..', '..', '..', 'package.json')
  const dependabotPath = path.join(__dirname, '..', '..', '..', '.github', 'dependabot.yml')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
    overrides?: Record<string, string>
  }
  const dependabotConfig = fs.readFileSync(dependabotPath, 'utf8')

  it('pins the WalletConnect packages to 2.18.0 for Kukai iOS compatibility', () => {
    expect(manifest.dependencies).toMatchObject({
      '@walletconnect/sign-client': '2.18.0',
      '@walletconnect/types': '2.18.0',
      '@walletconnect/utils': '2.18.0'
    })
    expect(rootManifest.dependencies).toMatchObject({
      '@walletconnect/sign-client': '2.18.0',
      '@walletconnect/types': '2.18.0',
      '@walletconnect/utils': '2.18.0'
    })
    expect(rootManifest.overrides).toMatchObject({
      '@walletconnect/sign-client': '2.18.0',
      '@walletconnect/types': '2.18.0',
      '@walletconnect/utils': '2.18.0'
    })
  })

  it('ignores @walletconnect/* and TypeScript >= 6.0.0 in dependabot configuration', () => {
    expect(dependabotConfig).toContain('dependency-name: "@walletconnect/*"')
    expect(dependabotConfig).toContain('dependency-name: "typescript"')
    expect(dependabotConfig).toContain('">= 6.0.0"')
  })

  it('does not carry an unused elliptic dependency', () => {
    expect(manifest.dependencies?.elliptic).toBeUndefined()
  })
})
