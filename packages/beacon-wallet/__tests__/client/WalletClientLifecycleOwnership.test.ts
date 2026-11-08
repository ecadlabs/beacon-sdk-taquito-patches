import { setImmediate } from 'node:timers/promises'
import { LocalStorage, Serializer, Transport } from '@ecadlabs/beacon-core'
import { P2PCommunicationClient } from '@ecadlabs/beacon-transport-matrix'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import {
  BeaconMessageType,
  BeaconRequestMessage,
  NetworkType,
  Origin,
  StorageKey,
  StorageKeyReturnType,
  TransportStatus
} from '@ecadlabs/beacon-types'
import { WalletClient } from '../../src/client/WalletClient'
import { WalletP2PTransport } from '../../src/transports/WalletP2PTransport'

const metadata = { senderId: 'dapp', name: 'Dapp' }
const context = { origin: Origin.P2P, id: 'peer' }
const permission = (id: string): BeaconRequestMessage => ({
  id,
  senderId: metadata.senderId,
  version: '2',
  type: BeaconMessageType.PermissionRequest,
  appMetadata: metadata,
  network: { type: NetworkType.MAINNET },
  scopes: []
})
const operation: BeaconRequestMessage = {
  id: 'held-operation',
  senderId: metadata.senderId,
  version: '2',
  type: BeaconMessageType.OperationRequest,
  network: { type: NetworkType.MAINNET },
  operationDetails: [],
  sourceAddress: 'tz1'
}
const gate = () => ({ entered: new ExposedPromise<void>(), release: new ExposedPromise<void>() })

class MetadataStorage extends LocalStorage {
  public metadataRead: ReturnType<typeof gate> | undefined

  public override async get<K extends StorageKey>(key: K): Promise<StorageKeyReturnType[K]> {
    const value = await super.get(key)
    const pending = key === StorageKey.APP_METADATA_LIST ? this.metadataRead : undefined
    if (pending) {
      this.metadataRead = undefined
      pending.entered.resolve()
      await pending.release.promise
    }
    return value
  }
}

class TestWallet extends WalletClient {
  public attach(transport: WalletP2PTransport): Promise<void> {
    return this.setTransport(transport)
  }
}

class DeliveryTransport extends WalletP2PTransport {
  public replay: BeaconRequestMessage | undefined

  public override async connect(): Promise<void> {
    this._isConnected = TransportStatus.CONNECTING
    if (this.replay) await this.deliver(this.replay)
    await Transport.prototype.connect.call(this)
  }

  public override async disconnect(): Promise<void> {
    await Transport.prototype.disconnect.call(this)
  }

  public override async send(): Promise<void> {}

  public async deliver(message: BeaconRequestMessage): Promise<void> {
    await this.notifyListeners(await new Serializer().serialize(message), context)
  }
}

describe('Wallet listener lifetime', () => {
  const wallets: TestWallet[] = []

  beforeEach(() => localStorage.clear())
  afterEach(async () => {
    await Promise.allSettled(wallets.splice(0).map((wallet) => wallet.destroy()))
    vi.restoreAllMocks()
    localStorage.clear()
  })

  const create = async () => {
    const storage = new MetadataStorage('wallet-lifetime')
    const wallet = new TestWallet({ name: 'Wallet', storage })
    wallets.push(wallet)
    await wallet.beaconId
    const keys = await getKeypairFromSeed('wallet-lifetime-transport')
    const transport = new DeliveryTransport('Wallet', keys, storage, {})
    await wallet.attach(transport)
    return { wallet, storage, transport, keys }
  }

  it('does not deliver metadata work completed after destroy and preserves another transport observer', async () => {
    const { wallet, storage, transport } = await create()
    await storage.set(StorageKey.APP_METADATA_LIST, [metadata])
    const received = vi.fn()
    const other = vi.fn()
    await transport.addListener(other)
    await wallet.connect(received)
    const pending = gate()
    storage.metadataRead = pending
    const delivering = transport.deliver(operation)
    await pending.entered.promise
    try {
      await wallet.destroy()
      pending.release.resolve()
      await delivering
      other.mockClear()
      const next = permission('after-destroy')
      await transport.deliver(next)
      expect(received).not.toHaveBeenCalled()
      expect(other).toHaveBeenCalledExactlyOnceWith(await new Serializer().serialize(next), context)
    } finally {
      pending.release.resolve()
      await delivering
    }
  })

  it('retires its listener after connection retries are exhausted without removing another observer', async () => {
    const { wallet, transport } = await create()
    vi.spyOn(transport, 'connect').mockRejectedValue(new Error('Transport unavailable'))
    const received = vi.fn()
    const other = vi.fn()
    await transport.addListener(other)
    // Exhausted retries retain the existing resolved connect() return contract.
    await expect(wallet.connect(received)).resolves.toBeUndefined()
    const message = permission('after-failed-connect')
    await transport.deliver(message)
    expect(received).not.toHaveBeenCalled()
    expect(other).toHaveBeenCalledExactlyOnceWith(
      await new Serializer().serialize(message),
      context
    )
  })

  it('routes later requests once to the callback supplied by repeated setup', async () => {
    const { wallet, transport } = await create()
    const first = vi.fn()
    const current = vi.fn()
    await wallet.connect(first)
    await wallet.connect(current)
    const message = permission('current-callback')
    await transport.deliver(message)
    expect(first).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledExactlyOnceWith(message, context)
  })

  it('keeps one-shot readiness across reconnect without awaiting the replay application callback', async () => {
    const { wallet, transport } = await create()
    const readiness = wallet.isConnected
    const application = gate()
    transport.replay = permission('initial-replay')
    let metadataAtDelivery: ReturnType<WalletClient['getAppMetadata']> | undefined
    const received = vi.fn(async () => {
      metadataAtDelivery = wallet.getAppMetadata(metadata.senderId)
      application.entered.resolve()
      await application.release.promise
    })
    let connected = false
    const connecting = wallet.connect(received).then(() => {
      connected = true
    })
    await application.entered.promise
    try {
      await setImmediate()
      const connectedBeforeApplication = connected
      application.release.resolve()
      await connecting
      expect(connectedBeforeApplication).toBe(true)
      await expect(metadataAtDelivery).resolves.toEqual(metadata)
      await expect(readiness).resolves.toBe(true)
      expect(wallet.isConnected).toBe(readiness)
      transport.replay = undefined
      await transport.disconnect()
      await expect(wallet.isConnected).resolves.toBe(true)
      const reconnected = vi.fn()
      await wallet.connect(reconnected)
      const message = permission('after-reconnect')
      await transport.deliver(message)
      expect(wallet.isConnected).toBe(readiness)
      expect(reconnected).toHaveBeenCalledExactlyOnceWith(message, context)
      expect(received).toHaveBeenCalledTimes(1)
    } finally {
      application.release.resolve()
      await connecting
    }
  })

  it('keeps public readiness pending while concurrent setup joins a connecting P2P transport', async () => {
    const { wallet, storage, keys } = await create()
    const transport = new WalletP2PTransport('Wallet', keys, storage, {})
    await wallet.attach(transport)
    const startup = gate()
    vi.spyOn(P2PCommunicationClient.prototype, 'start').mockImplementation(async () => {
      startup.entered.resolve()
      await startup.release.promise
    })
    vi.spyOn(P2PCommunicationClient.prototype, 'stop').mockResolvedValue(undefined)
    let ready = false
    const readiness = wallet.isConnected.then(() => {
      ready = true
    })
    const first = wallet.connect(vi.fn())
    const second = wallet.connect(vi.fn())
    await startup.entered.promise
    try {
      await setImmediate()
      const readyBeforeStartup = ready
      startup.release.resolve()
      await Promise.all([first, second, readiness])
      expect(readyBeforeStartup).toBe(false)
      expect(ready).toBe(true)
      expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    } finally {
      startup.release.resolve()
      await Promise.allSettled([first, second])
    }
  })
})
