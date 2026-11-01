import fs from 'node:fs'
import path from 'node:path'

describe('@ecadlabs/beacon-dapp package manifest', () => {
  const manifestPath = path.join(__dirname, '..', 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }

  it('pins WalletConnect types to 2.18.0 for Kukai iOS compatibility', () => {
    expect(manifest.dependencies?.['@walletconnect/types']).toBe('2.18.0')
  })
})
