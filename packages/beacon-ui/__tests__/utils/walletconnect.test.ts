import { hasWalletConnectSymKey } from '../../src/utils/walletconnect'

describe('hasWalletConnectSymKey', () => {
  it('accepts WalletConnect URIs with a symKey query parameter', () => {
    expect(hasWalletConnectSymKey('wc:topic@2?symKey=abc&relay-protocol=irn')).toBe(true)
  })

  it('rejects WalletConnect URIs without a symKey query parameter', () => {
    expect(hasWalletConnectSymKey('wc:topic@2?relay-protocol=irn')).toBe(false)
  })

  it('rejects non-WalletConnect payloads', () => {
    expect(hasWalletConnectSymKey('tezos://sync')).toBe(false)
  })
})
