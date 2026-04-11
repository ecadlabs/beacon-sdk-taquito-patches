import fs from 'node:fs'
import path from 'node:path'

describe('@ecadlabs/beacon-dapp package manifest', () => {
  const manifestPath = path.join(__dirname, '..', 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }

  it('declares WalletConnect types used by its published TypeScript surface', () => {
    expect(manifest.dependencies?.['@walletconnect/types']).toEqual(expect.any(String))
  })
})
