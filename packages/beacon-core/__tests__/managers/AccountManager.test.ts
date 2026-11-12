import {
  AccountInfo,
  BeaconMessageType,
  NetworkType,
  Origin,
  PermissionScope,
  StorageKey
} from '@ecadlabs/beacon-types'
import { AccountManager } from '../../src/managers/AccountManager'
import { LocalStorage } from '../../src/storage/LocalStorage'

const account: AccountInfo = {
  accountIdentifier: 'tezos-account',
  senderId: 'wallet',
  origin: { type: Origin.EXTENSION, id: 'extension' },
  address: 'tz1-test',
  network: { type: NetworkType.MAINNET },
  scopes: [PermissionScope.SIGN],
  connectedAt: 1,
  walletType: 'implicit'
}
const chainAccount = {
  accountIdentifier: 'chain-account',
  senderId: 'wallet',
  origin: { type: Origin.EXTENSION, id: 'extension' },
  address: 'tz1-test',
  scopes: ['sign', 'chain-owned-scope'],
  connectedAt: 1,
  chainData: { accounts: [{ opaqueKey: 'chain-value' }] }
}

describe('stored account variants', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('restores legacy Tezos and chain-owned records without inventing V3 network fields or rewriting storage', async () => {
    const storage = new LocalStorage('account-variants')
    const { walletType: _legacyMissingWalletType, ...legacy } = account
    const original = JSON.stringify([legacy, chainAccount])
    localStorage.setItem(storage.getPrefixedKey(StorageKey.ACCOUNTS), original)
    const manager = new AccountManager(storage)
    await expect(manager.getAccounts()).resolves.toEqual([account, chainAccount])
    await expect(manager.getAccount(chainAccount.accountIdentifier)).resolves.toEqual(chainAccount)
    expect(localStorage.getItem(storage.getPrefixedKey(StorageKey.ACCOUNTS))).toBe(original)
  })

  it('restores legacy Tezos accounts with retired testnet network types without throwing', async () => {
    const storage = new LocalStorage('retired-testnet-accounts')
    const legacyOxford = { ...account, accountIdentifier: 'oxford-1', network: { type: 'oxfordnet' } }
    const legacyTezlink = {
      ...account,
      accountIdentifier: 'tezlink-1',
      network: { type: 'tezlink_shadownet' }
    }
    const original = JSON.stringify([legacyOxford, legacyTezlink])
    localStorage.setItem(storage.getPrefixedKey(StorageKey.ACCOUNTS), original)
    const manager = new AccountManager(storage)
    await expect(manager.getAccounts()).resolves.toEqual([legacyOxford, legacyTezlink])
    expect(localStorage.getItem(storage.getPrefixedKey(StorageKey.ACCOUNTS))).toBe(original)
  })

  it('reports malformed records instead of silently dropping them or rewriting storage', async () => {
    const storage = new LocalStorage('invalid-account')
    const original = JSON.stringify([account, null])
    localStorage.setItem(storage.getPrefixedKey(StorageKey.ACCOUNTS), original)
    await expect(new AccountManager(storage).getAccounts()).rejects.toThrow(
      'Invalid stored account'
    )
    expect(localStorage.getItem(storage.getPrefixedKey(StorageKey.ACCOUNTS))).toBe(original)
  })

  it('rejects sparse scopes and sparse account collections returned by custom storage', async () => {
    const storage = new LocalStorage('sparse-account')
    const sparseScopes: string[] = ['sign']
    delete sparseScopes[0]
    const sparseAccounts = [chainAccount]
    delete sparseAccounts[0]
    const get = vi.spyOn(storage, 'get')
    get.mockResolvedValue([{ ...chainAccount, scopes: sparseScopes }])
    await expect(new AccountManager(storage).getAccounts()).rejects.toThrow(
      'Invalid stored account'
    )
    get.mockResolvedValue(sparseAccounts)
    await expect(new AccountManager(storage).getAccounts()).rejects.toThrow(
      'Invalid stored account'
    )
  })

  it('validates a merged update without converting a chain account into a partial Tezos account', async () => {
    const storage = new LocalStorage('account-update')
    const manager = new AccountManager(storage)
    await manager.addAccount(chainAccount)
    await expect(
      manager.updateAccount(chainAccount.accountIdentifier, { publicKey: 'updated-key' })
    ).resolves.toEqual({ ...chainAccount, publicKey: 'updated-key' })
    const original = localStorage.getItem(storage.getPrefixedKey(StorageKey.ACCOUNTS))
    await expect(
      manager.updateAccount(chainAccount.accountIdentifier, { walletType: 'implicit' })
    ).rejects.toThrow('Invalid stored account')
    expect(localStorage.getItem(storage.getPrefixedKey(StorageKey.ACCOUNTS))).toBe(original)
  })

  it('does not use matching chain-owned scopes as Tezos signing permission', async () => {
    const storage = new LocalStorage('chain-permission')
    localStorage.setItem(
      storage.getPrefixedKey(StorageKey.ACCOUNTS),
      JSON.stringify([chainAccount])
    )
    const manager = new AccountManager(storage)
    await expect(
      manager.hasPermission({
        id: 'request',
        version: '2',
        senderId: 'dapp',
        type: BeaconMessageType.SignPayloadRequest,
        payload: '05',
        sourceAddress: 'tz1-test'
      })
    ).resolves.toBe(false)
    await manager.addAccount(account)
    await expect(
      manager.hasPermission({
        id: 'request',
        version: '2',
        senderId: 'dapp',
        type: BeaconMessageType.SignPayloadRequest,
        payload: '05',
        sourceAddress: 'tz1-test'
      })
    ).resolves.toBe(true)
  })
})
