import { LocalStorage, Transport } from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  BeaconErrorType,
  ExtendedP2PPairingResponse,
  NetworkType,
  Origin,
  PermissionScope,
  Storage,
  StorageKey,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { BeaconEvent } from '../../src/events'

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  StorageValidator: class {
    async validate() {
      return true
    }
  },
  MultiTabChannel: class {
    async init() {}
    isLeader() {
      return true
    }
    async hasLeader() {
      return true
    }
    async getLeadership() {}
    postMessage() {}
    async close() {}
  }
}))

class Gate {
  readonly entered = new ExposedPromise<void>()
  readonly released = new ExposedPromise<void>()
  async wait(): Promise<void> {
    this.entered.resolve()
    await this.released.promise
  }
}

type StorageListener = Parameters<Storage['subscribeToStorageChanged']>[0]
type StorageChange = Parameters<StorageListener>[0]

class RestorationStorage extends LocalStorage {
  private changed?: StorageListener
  async subscribeToStorageChanged(callback: StorageListener): Promise<void> {
    this.changed = callback
  }
  async notify(event: StorageChange): Promise<void> {
    if (!this.changed) throw new Error('Storage listener is not registered')
    await this.changed(event)
  }
  async notifyEntry(key: StorageKey, newValue: string): Promise<void> {
    await this.notify({
      eventType: 'entryModified',
      key: this.getPrefixedKey(key),
      oldValue: null,
      newValue
    })
  }
}

const peer: ExtendedP2PPairingResponse = {
  id: 'restoration-peer',
  type: 'p2p-pairing-response',
  name: 'Restoration wallet',
  publicKey: '11'.repeat(32),
  senderId: 'restoration-sender',
  relayServer: 'relay.example',
  version: '3'
}
const account: AccountInfo = {
  accountIdentifier: 'restoration-account',
  senderId: peer.senderId,
  origin: { type: Origin.P2P, id: peer.id },
  address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
  network: { type: NetworkType.MAINNET },
  scopes: [PermissionScope.OPERATION_REQUEST],
  connectedAt: 1,
  walletType: 'implicit'
}

class RestorationTransport extends DappP2PTransport {
  readonly connected = vi.fn()
  readonly disconnected = vi.fn()
  connectGate?: Gate
  disconnectGate?: Gate
  peerReadGate?: Gate

  constructor(storage: Storage) {
    super(
      'Restoration transport',
      { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
      storage,
      {}
    )
  }
  async connect(): Promise<void> {
    if (this._isConnected !== TransportStatus.NOT_CONNECTED) return
    this.connected()
    this._isConnected = TransportStatus.CONNECTING
    await this.connectGate?.wait()
    if (this._isConnected === TransportStatus.CONNECTING) {
      this._isConnected = TransportStatus.CONNECTED
    }
  }
  async disconnect(): Promise<void> {
    this.disconnected()
    await this.disconnectGate?.wait()
    this._isConnected = TransportStatus.NOT_CONNECTED
  }
  async getPeers(): Promise<ExtendedP2PPairingResponse[]> {
    const gate = this.peerReadGate
    this.peerReadGate = undefined
    await gate?.wait()
    return [peer]
  }
  async removeAllPeers(): Promise<void> {}
  async doClientCleanup(): Promise<void> {}
}

function observe<T>(promise: Promise<T>) {
  const settled = vi.fn()
  const outcome = promise.then(
    (value) => {
      const result = { value }
      settled(result)
      return result
    },
    (error: unknown) => {
      const result = { error }
      settled(result)
      return result
    }
  )
  return { settled, outcome }
}

describe('DApp initialization through account restoration', () => {
  const gates: Gate[] = []
  const clients: DAppClient[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    Reflect.set(window, 'beaconCreatedClientInstance', false)
  })
  afterEach(async () => {
    for (const gate of gates) gate.released.resolve()
    await vi.advanceTimersByTimeAsync(0)
    for (const client of clients) await client.destroy()
    gates.length = 0
    clients.length = 0
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  function hold(): Gate {
    const gate = new Gate()
    gates.push(gate)
    return gate
  }

  async function create(stored = false, connectGate?: Gate, peerReadGate?: Gate) {
    const storage = new RestorationStorage('initialization-restoration')
    await storage.set(StorageKey.BEACON_SDK_SECRET_SEED, 'restoration-seed')
    if (stored) {
      await storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
      await storage.set(StorageKey.ACCOUNTS, [account])
    }
    const transports: RestorationTransport[] = []
    const changed = vi.fn()
    const selected = vi.fn()
    class RestorationClient extends DAppClient {
      async initInternalTransports(): Promise<void> {
        if (!this.p2pTransport) {
          const transport = new RestorationTransport(storage)
          transport.connectGate = transports.length === 0 ? connectGate : undefined
          transport.peerReadGate = transports.length === 0 ? peerReadGate : undefined
          transports.push(transport)
          this.p2pTransport = transport
          await this.addListener(transport)
        }
      }
      selectedTransport(): Promise<Transport> {
        return this.transport
      }
    }
    const client = new RestorationClient({
      name: 'Initialization restoration',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      eventHandlers: {
        [BeaconEvent.ACTIVE_ACCOUNT_SET]: { handler: changed },
        [BeaconEvent.ACTIVE_TRANSPORT_SET]: { handler: selected }
      }
    })
    clients.push(client)
    if (!stored) await client.getActiveAccount()
    return { client, storage, transports, changed, selected }
  }

  it('restores the constructor account before init and projects transport readiness', async () => {
    const gate = hold()
    const { client, transports, changed, selected } = await create(true, gate)
    await gate.entered.promise
    const active = observe(client.getActiveAccount())
    expect(active.settled).not.toHaveBeenCalled()
    expect(client.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
    expect(changed).not.toHaveBeenCalled()
    gate.released.resolve()
    await expect(active.outcome).resolves.toEqual({ value: account })
    await vi.advanceTimersByTimeAsync(0)
    expect(transports).toHaveLength(1)
    expect(transports[0].connected).toHaveBeenCalledTimes(1)
    expect(client.connectionStatus).toBe(TransportStatus.CONNECTED)
    expect(changed).toHaveBeenCalledExactlyOnceWith(account, undefined)
    expect(selected).toHaveBeenCalledTimes(1)
  })

  it('settles constructor account and init waiters on disconnect before restoration finishes', async () => {
    const gate = hold()
    const { client, storage, changed, selected } = await create(true, gate)
    await gate.entered.promise
    const active = observe(client.getActiveAccount())
    const first = observe(client.init())
    const second = observe(client.init())
    await client.disconnect({ notifyPeers: false })
    await expect(active.outcome).resolves.toEqual({ value: undefined })
    await expect(first.outcome).resolves.toMatchObject({
      error: { errorType: BeaconErrorType.ABORTED_ERROR }
    })
    await expect(second.outcome).resolves.toMatchObject({
      error: { errorType: BeaconErrorType.ABORTED_ERROR }
    })
    changed.mockClear()
    selected.mockClear()
    gate.released.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
    await expect(client.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
    expect(selected).not.toHaveBeenCalled()
  })

  it('joins constructor restoration when concurrent init callers arrive before connection completes', async () => {
    const gate = hold()
    const { client, transports, changed } = await create(true, gate)
    await gate.entered.promise
    const first = observe(client.init())
    const second = observe(client.init())
    await vi.advanceTimersByTimeAsync(0)
    expect(first.settled).not.toHaveBeenCalled()
    expect(second.settled).not.toHaveBeenCalled()
    gate.released.resolve()
    await expect(first.outcome).resolves.toEqual({ value: TransportType.P2P })
    await expect(second.outcome).resolves.toEqual({ value: TransportType.P2P })
    expect(transports[0].connected).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledExactlyOnceWith(account, undefined)
    expect(client.connectionStatus).toBe(TransportStatus.CONNECTED)
  })

  it('settles superseded public selection before its peer storage read finishes', async () => {
    const gate = hold()
    const { client, changed, selected, transports } = await create(false, undefined, gate)
    const selection = observe(client.setActiveAccount(account))
    await gate.entered.promise
    await client.disconnect({ notifyPeers: false })
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(selection.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    changed.mockClear()
    selected.mockClear()
    gate.released.resolve()
    await selection.outcome
    expect(changed).not.toHaveBeenCalled()
    expect(selected).not.toHaveBeenCalled()
    expect(transports[0].connected).not.toHaveBeenCalled()
    await expect(client.getActiveAccount()).resolves.toBeUndefined()
  })

  it('selects an account without init and allows a fresh selection after disconnect', async () => {
    const { client, storage, transports } = await create()
    await client.setActiveAccount(account)
    await expect(client.getActiveAccount()).resolves.toEqual(account)
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(account.accountIdentifier)
    expect(transports[0].connected).toHaveBeenCalledTimes(1)
    await client.disconnect({ notifyPeers: false })
    await client.setActiveAccount(account)
    expect(transports).toHaveLength(2)
    expect(transports[1].connected).toHaveBeenCalledTimes(1)
    await expect(client.selectedTransport()).resolves.toBe(transports[1])
    expect(client.connectionStatus).toBe(TransportStatus.CONNECTED)
  })

  it.each([StorageKey.ACTIVE_ACCOUNT, StorageKey.ACCOUNTS])(
    'restores from %s without init and leaves the stored selection intact',
    async (key) => {
      const gate = hold()
      const { client, storage, transports, changed } = await create(false, gate)
      await storage.set(StorageKey.ACCOUNTS, [account])
      await storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
      const notification = storage.notifyEntry(
        key,
        key === StorageKey.ACTIVE_ACCOUNT ? account.accountIdentifier : JSON.stringify([account])
      )
      await gate.entered.promise
      expect(changed).not.toHaveBeenCalledWith(account, undefined)
      gate.released.resolve()
      await notification
      await expect(client.getActiveAccount()).resolves.toEqual(account)
      await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(account.accountIdentifier)
      expect(transports[0].connected).toHaveBeenCalledTimes(1)
      expect(changed).toHaveBeenCalledWith(account, undefined)
    }
  )

  it.each([StorageKey.ACTIVE_ACCOUNT, StorageKey.ACCOUNTS])(
    'waits for disconnect before restoring from %s into a fresh transport',
    async (key) => {
      const { client, storage, transports, changed, selected } = await create()
      await client.setActiveAccount(account)
      const gate = hold()
      transports[0].disconnectGate = gate
      const disconnect = client.disconnect({ notifyPeers: false })
      await gate.entered.promise
      changed.mockClear()
      selected.mockClear()
      await storage.set(StorageKey.ACCOUNTS, [account])
      await storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
      const notification = storage.notifyEntry(
        key,
        key === StorageKey.ACTIVE_ACCOUNT ? account.accountIdentifier : JSON.stringify([account])
      )
      await vi.advanceTimersByTimeAsync(0)
      expect.soft(changed).not.toHaveBeenCalledWith(account, undefined)
      expect.soft(selected).not.toHaveBeenCalled()
      gate.released.resolve()
      await disconnect
      await notification
      expect(transports).toHaveLength(2)
      expect(transports[1].connected).toHaveBeenCalledTimes(1)
      await expect(client.selectedTransport()).resolves.toBe(transports[1])
      await expect(client.getActiveAccount()).resolves.toEqual(account)
      expect(client.connectionStatus).toBe(TransportStatus.CONNECTED)
    }
  )

  it('clears a pending storage restoration and ignores its late connection', async () => {
    const gate = hold()
    const { client, storage, changed, selected } = await create(false, gate)
    await storage.set(StorageKey.ACCOUNTS, [account])
    await storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
    const notification = storage.notifyEntry(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
    await gate.entered.promise
    localStorage.clear()
    await storage.notify({ eventType: 'storageCleared', key: null, oldValue: null, newValue: null })
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    selected.mockClear()
    gate.released.resolve()
    await notification
    await expect(client.getActiveAccount()).resolves.toBeUndefined()
    expect(client.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
    expect(changed).not.toHaveBeenCalled()
    expect(selected).not.toHaveBeenCalled()
  })

  it('refreshes SDK identity without cancelling an account selection on a seed notification', async () => {
    const gate = hold()
    const { client, storage, transports } = await create(false, gate)
    const before = await client.getOwnAppMetadata()
    const selection = observe(client.setActiveAccount(account))
    await gate.entered.promise
    await storage.set(StorageKey.BEACON_SDK_SECRET_SEED, 'next-restoration-seed')
    await storage.notifyEntry(StorageKey.BEACON_SDK_SECRET_SEED, 'next-restoration-seed')
    const after = await client.getOwnAppMetadata()
    expect(after.senderId).not.toBe(before.senderId)
    expect(selection.settled).not.toHaveBeenCalled()
    expect(transports[0].disconnected).not.toHaveBeenCalled()
    gate.released.resolve()
    await expect(selection.outcome).resolves.toEqual({ value: undefined })
    await expect(client.getActiveAccount()).resolves.toEqual(account)
    expect(transports[0].connected).toHaveBeenCalledTimes(1)
  })
})
