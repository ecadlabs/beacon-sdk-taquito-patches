import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { StorageManager } from '../../src/managers/StorageManager'
import { AccountManager } from '../../src/managers/AccountManager'
import { PeerManager } from '../../src/managers/PeerManager'
import { AppMetadataManager } from '../../src/managers/AppMetadataManager'
import { LocalStorage } from '../../src/storage/LocalStorage'
import { AccountInfo, NetworkType, Origin, StorageKey } from '@ecadlabs/beacon-types'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())
const first = { senderId: 'first', name: 'First' }
const second = { senderId: 'second', name: 'Second' }

describe('StorageManager', () => {
  it('supports insert, predicate lookup, overwrite control, removal and clear', async () => {
    const manager = new StorageManager(new LocalStorage(), StorageKey.APP_METADATA_LIST)
    expect(await manager.getAll()).toEqual([])
    expect(await manager.getOne(() => true)).toBeUndefined()
    await manager.addOne(first, (item) => item.senderId === first.senderId)
    await manager.addOne(second, (item) => item.senderId === second.senderId)
    const updated = { ...first, name: 'Updated' }
    await manager.addOne(updated, (item) => item.senderId === first.senderId, false)
    expect(await manager.getOne((item) => item.senderId === first.senderId)).toEqual(first)
    await manager.addOne(updated, (item) => item.senderId === first.senderId)
    expect(await manager.getAll()).toEqual([updated, second])
    await manager.remove((item) => item.senderId === first.senderId)
    expect(await manager.getAll()).toEqual([second])
    await manager.removeAll()
    expect(await manager.getAll()).toEqual([])
  })
  it.each(['add', 'remove'])('preserves concurrent addOne and %s writes', async (operation) => {
    const storage = new LocalStorage()
    const manager = new StorageManager(storage, StorageKey.APP_METADATA_LIST)
    await manager.addOne(first, () => false)
    const get = storage.get.bind(storage)
    vi.spyOn(storage, 'get').mockImplementation(async (key) => {
      const snapshot = await get(key)
      await new Promise((resolve) => setTimeout(resolve, 1))
      return snapshot
    })
    await Promise.all([
      manager.addOne(second, (item) => item.senderId === second.senderId),
      operation === 'add'
        ? manager.addOne({ senderId: 'third', name: 'Third' }, (item) => item.senderId === 'third')
        : manager.remove((item) => item.senderId === first.senderId)
    ])
    expect((await manager.getAll()).map((item) => item.senderId).sort()).toEqual(
      operation === 'add' ? ['first', 'second', 'third'] : ['second']
    )
  })
})

it('serializes removeAll between concurrent additions', async () => {
  const storage = new LocalStorage()
  const manager = new StorageManager(storage, StorageKey.APP_METADATA_LIST)
  const pending = new ExposedPromise<void>()
  const set = storage.set.bind(storage)
  const write = vi.spyOn(storage, 'set').mockImplementationOnce(async (key, value) => {
    await pending.promise
    return set(key, value)
  })
  const firstAdd = manager.addOne(first, () => false)
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
  const clearing = manager.removeAll()
  const secondAdd = manager.addOne(second, () => false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  pending.resolve()
  await Promise.all([firstAdd, clearing, secondAdd])
  expect(await manager.getAll()).toEqual([second])
})

describe('entity managers', () => {
  it('persists, upserts, looks up and removes app metadata', async () => {
    const manager = new AppMetadataManager(new LocalStorage())
    expect(await manager.getAppMetadataList()).toEqual([])
    await manager.addAppMetadata(first)
    await manager.addAppMetadata(second)
    await manager.addAppMetadata({ ...first, name: 'Updated' })
    expect(await manager.getAppMetadata('first')).toEqual({ ...first, name: 'Updated' })
    expect(await manager.getAppMetadataList()).toHaveLength(2)
    await manager.removeAppMetadata('missing')
    await manager.removeAppMetadata('first')
    expect(await manager.getAppMetadata('first')).toBeUndefined()
    await manager.removeAppMetadatas(['second'])
    expect(await manager.getAppMetadataList()).toEqual([])
    await manager.addAppMetadata(first)
    await manager.removeAllAppMetadata()
    expect(await manager.getAppMetadataList()).toEqual([])
  })
  it('persists, upserts and removes peers by public key', async () => {
    const manager = new PeerManager(new LocalStorage(), StorageKey.TRANSPORT_P2P_PEERS_WALLET)
    const peer = {
      id: 'one',
      name: 'Peer',
      senderId: 'sender',
      publicKey: 'key',
      relayServer: 'relay',
      version: '2',
      type: 'p2p-pairing-request'
    }
    expect(await manager.getPeers()).toEqual([])
    expect(await manager.hasPeer('key')).toBe(false)
    await manager.addPeer(peer)
    await manager.addPeer({ ...peer, name: 'Updated' })
    expect(await manager.getPeers()).toEqual([{ ...peer, name: 'Updated' }])
    expect(await manager.hasPeer('key')).toBe(true)
    expect(await manager.getPeer('key')).toEqual({ ...peer, name: 'Updated' })
    await manager.removePeer('key')
    expect(await manager.getPeer('key')).toBeUndefined()
    await manager.addPeer(peer)
    await manager.removePeers(['key'])
    expect(await manager.getPeers()).toEqual([])
    await manager.addPeer(peer)
    await manager.removeAllPeers()
    expect(await manager.getPeers()).toEqual([])
  })
  it('persists accounts, merges updates and removes selected accounts', async () => {
    const manager = new AccountManager(new LocalStorage())
    const account: AccountInfo = {
      accountIdentifier: 'one',
      senderId: 'sender',
      address: 'tz1',
      network: { type: NetworkType.MAINNET },
      scopes: [],
      origin: { type: Origin.P2P, id: 'peer' },
      connectedAt: 1,
      walletType: 'implicit'
    }
    expect(await manager.getAccounts()).toEqual([])
    await manager.addAccount(account)
    await manager.addAccount({ ...account, connectedAt: 2 })
    expect(await manager.getAccounts()).toEqual([{ ...account, connectedAt: 2 }])
    expect(await manager.updateAccount('missing', {})).toBeUndefined()
    expect(await manager.updateAccount('one', { connectedAt: 3 })).toEqual({
      ...account,
      connectedAt: 3
    })
    expect(await manager.getAccount('one')).toEqual({ ...account, connectedAt: 3 })
    await manager.removeAccount('one')
    expect(await manager.getAccount('one')).toBeUndefined()
    await manager.addAccount(account)
    await manager.removeAccounts(['one'])
    expect(await manager.getAccounts()).toEqual([])
    await manager.addAccount(account)
    await manager.removeAllAccounts()
    expect(await manager.getAccounts()).toEqual([])
  })
})

it('allows queued mutations after a failed write', async () => {
  const storage = new LocalStorage()
  const manager = new StorageManager(storage, StorageKey.APP_METADATA_LIST)
  const failure = new Error('write failed')
  vi.spyOn(storage, 'set').mockRejectedValueOnce(failure)
  const rejected = expect(manager.addOne(first, () => false)).rejects.toBe(failure)
  const next = manager.addOne(second, () => false)
  await rejected
  await next
  expect(await manager.getAll()).toEqual([second])
})
