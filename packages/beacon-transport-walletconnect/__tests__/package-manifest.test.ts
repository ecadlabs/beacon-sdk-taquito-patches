import fs from 'node:fs'
import path from 'node:path'

describe('@ecadlabs/beacon-transport-walletconnect package manifest', () => {
  const manifestPath = path.join(__dirname, '..', 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }

  it('declares the WalletConnect packages it imports at runtime', () => {
    expect(manifest.dependencies).toMatchObject({
      '@walletconnect/sign-client': expect.any(String),
      '@walletconnect/types': expect.any(String),
      '@walletconnect/utils': expect.any(String)
    })
  })

  it('does not carry an unused elliptic dependency', () => {
    expect(manifest.dependencies?.elliptic).toBeUndefined()
  })
})
