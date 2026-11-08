import {
  CommunicationClient,
  getAccountIdentifier,
  LocalStorage,
  PeerManager,
  Serializer,
  Transport
} from '@ecadlabs/beacon-core'
import {
  BeaconErrorType,
  BeaconMessage,
  BeaconMessageType,
  AccountInfo,
  ConnectionContext,
  ExtendedPostMessagePairingResponse,
  NetworkType,
  Origin,
  PeerInfoType,
  PermissionScope,
  PermissionResponse,
  StorageKeyReturnType,
  StorageKey,
  TransportType
} from '@ecadlabs/beacon-types'
import { ExposedPromise, getAddressFromPublicKey } from '@ecadlabs/beacon-utils'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { BeaconEvent } from '../../src/events'

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  ...(await vi.importActual<
    typeof import('../../../beacon-core/src/transports/clients/ClientEvents')
  >('../../../beacon-core/src/transports/clients/ClientEvents')),
  MultiTabChannel: class {
    async init() {}
    isLeader() {
      return true
    }
    hasLeader() {
      return Promise.resolve(true)
    }
    getLeadership() {
      return Promise.resolve()
    }
    postMessage() {}
    close() {
      return Promise.resolve()
    }
  }
}))

vi.mock('@ecadlabs/beacon-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-ui')>()),
  isMobileOS: () => false,
  isDesktop: () => true
}))

class ControlledClient extends CommunicationClient {
  readonly sent = new ExposedPromise<string>()
  async sendMessage(message: string): Promise<void> {
    this.sent.resolve(message)
  }
  async unsubscribeFromEncryptedMessages(): Promise<void> {}
  async unsubscribeFromEncryptedMessage(): Promise<void> {}
}

class ControlledTransport extends Transport<
  PeerInfoType,
  StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP,
  ControlledClient
> {
  readonly type = TransportType.POST_MESSAGE
  readonly sent: Promise<string>

  constructor(storage: LocalStorage) {
    const client = new ControlledClient()
    super(
      'Permission response test',
      client,
      new PeerManager(storage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
    )
    this.sent = client.sent.promise
  }

  async listen(): Promise<void> {}

  async receive(message: BeaconMessage): Promise<void> {
    await this.notifyListeners(await new Serializer().serialize(message), connectionInfo)
  }
}

const connectionInfo: ConnectionContext = { origin: Origin.EXTENSION, id: 'extension-id' }
const peer: ExtendedPostMessagePairingResponse = {
  type: 'postmessage-pairing-response',
  id: 'wallet-peer',
  senderId: 'wallet-sender',
  publicKey: '11'.repeat(32),
  name: 'Permission wallet',
  extensionId: connectionInfo.id,
  version: '3'
}
const publicKey = 'edpkv3Nf62TZxR1XwzKRteLTh1SmXLmr8cGEwHRSNoiUV3oiBrDbFX'
const metadata = { senderId: peer.senderId, name: peer.name }

class StorageWait {
  readonly entered = new ExposedPromise<void>()
  readonly released = new ExposedPromise<void>()
  finish: 'resolve' | 'reject' = 'resolve'

  constructor(
    readonly operation: 'get' | 'set',
    readonly key: StorageKey
  ) {}

  async wait(): Promise<void> {
    this.entered.resolve()
    await this.released.promise
    if (this.finish === 'reject') {
      throw new Error('Account preparation did not complete')
    }
  }
}

class ControlledStorage extends LocalStorage {
  readonly waits: StorageWait[] = []
  readonly accountWrites: unknown[] = []

  hold(operation: 'get' | 'set', key: StorageKey): StorageWait {
    const wait = new StorageWait(operation, key)
    this.waits.push(wait)
    return wait
  }

  private async waitFor(operation: 'get' | 'set', key: StorageKey): Promise<void> {
    const index = this.waits.findIndex((wait) => wait.operation === operation && wait.key === key)
    if (index >= 0) {
      const [wait] = this.waits.splice(index, 1)
      await wait.wait()
    }
  }

  async get<K extends StorageKey>(key: K): Promise<StorageKeyReturnType[K]> {
    await this.waitFor('get', key)
    return super.get(key)
  }

  async set<K extends StorageKey>(key: K, value: StorageKeyReturnType[K]): Promise<void> {
    await this.waitFor('set', key)
    if (key === StorageKey.ACCOUNTS) {
      this.accountWrites.push(structuredClone(value))
    }
    await super.set(key, value)
  }
}

describe('Permission response lifetime', () => {
  let dapp: DAppClient
  let transport: ControlledTransport
  let storage: ControlledStorage
  let waits: StorageWait[]
  const failed = vi.fn()
  const succeeded = vi.fn()
  const changed = vi.fn()

  beforeEach(async () => {
    vi.useFakeTimers()
    waits = []
    localStorage.clear()
    Object.defineProperty(window, 'beaconCreatedClientInstance', {
      value: false,
      writable: true,
      configurable: true
    })
    storage = new ControlledStorage('permission-response-lifetime')
    transport = new ControlledTransport(storage)
    dapp = new DAppClient({
      name: 'Permission response lifetime',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      requestTimeoutMs: 0,
      network: { type: NetworkType.MAINNET }
    })
    await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, changed)
    await dapp.subscribeToEvent(BeaconEvent.PERMISSION_REQUEST_ERROR, failed)
    await dapp.subscribeToEvent(BeaconEvent.PERMISSION_REQUEST_SUCCESS, succeeded)
    await dapp.getActiveAccount()
    await transport.addPeer(peer)
    await transport.connect()
    await dapp.init(transport)
    // Avoid starting additional adapters in this storage and wrapper fixture.
    vi.spyOn(dapp, 'initInternalTransports').mockResolvedValue(undefined)
    dapp['resolveActivePeer'](peer)
    await vi.advanceTimersByTimeAsync(0)
    vi.clearAllMocks()
  })

  afterEach(async () => {
    for (const wait of waits) {
      wait.released.resolve()
    }
    await vi.advanceTimersByTimeAsync(0)
    await dapp.destroy()
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  function hold(operation: 'get' | 'set', key: StorageKey): StorageWait {
    const wait = storage.hold(operation, key)
    waits.push(wait)
    return wait
  }

  function observe<T>(promise: Promise<T>) {
    const settled = vi.fn()
    const outcome = promise.then(
      (value) => {
        settled({ value })
        return { value }
      },
      (error: unknown) => {
        settled({ error })
        return { error }
      }
    )
    return { outcome, settled }
  }

  async function request() {
    const pending = observe(dapp.requestPermissions())
    await vi.advanceTimersByTimeAsync(0)
    const encoded = await transport.sent
    const sent: unknown = await new Serializer().deserialize(encoded)
    if (!sent || typeof sent !== 'object' || !('id' in sent) || typeof sent.id !== 'string') {
      throw new Error('Missing request ID')
    }
    expect(pending.settled).not.toHaveBeenCalled()
    return { ...pending, id: sent.id }
  }

  function response(id: string): PermissionResponse {
    return {
      id,
      version: '2',
      senderId: peer.senderId,
      type: BeaconMessageType.PermissionResponse,
      walletType: 'implicit',
      publicKey,
      appMetadata: metadata,
      network: { type: NetworkType.MAINNET },
      scopes: [PermissionScope.SIGN]
    }
  }

  function aborted(id: string) {
    return {
      id,
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.ABORTED_ERROR,
      senderId: '',
      version: '2'
    }
  }

  async function deliver(id: string, wait: StorageWait): Promise<void> {
    await transport.receive(response(id))
    await vi.advanceTimersByTimeAsync(0)
    expect(wait.entered.isResolved()).toBe(true)
  }

  function expectAborted(pending: Awaited<ReturnType<typeof request>>) {
    expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: aborted(pending.id) })
    expect
      .soft(failed)
      .toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ errorResponse: aborted(pending.id) }),
        expect.any(Array)
      )
    expect.soft(succeeded).not.toHaveBeenCalled()
  }

  const boundaries = [
    { name: 'account preparation', operation: 'get', key: StorageKey.LAST_SELECTED_WALLET },
    { name: 'account persistence', operation: 'set', key: StorageKey.ACCOUNTS },
    { name: 'active account persistence', operation: 'set', key: StorageKey.ACTIVE_ACCOUNT }
  ] satisfies { name: string; operation: 'get' | 'set'; key: StorageKey }[]

  it.each(boundaries)(
    'aborts during $name before pending storage completes',
    async ({ operation, key }) => {
      const pending = await request()
      const wait = hold(operation, key)
      await deliver(pending.id, wait)
      const disconnect = dapp.disconnect({ notifyPeers: false })
      await vi.advanceTimersByTimeAsync(0)
      expectAborted(pending)
      changed.mockClear()

      wait.released.resolve()
      await disconnect
      await vi.advanceTimersByTimeAsync(0)
      expectAborted(pending)
      expect.soft(changed.mock.calls.filter(([account]) => account !== undefined)).toEqual([])
      expect(await dapp.getActiveAccount()).toBeUndefined()
      expect(await dapp.getAccounts()).toEqual([])
      expect(await storage.get(StorageKey.ACTIVE_ACCOUNT)).toBeUndefined()
    }
  )

  it.each(boundaries)(
    'keeps the abort when $name rejects after disconnect',
    async ({ operation, key }) => {
      const pending = await request()
      const wait = hold(operation, key)
      wait.finish = 'reject'
      await deliver(pending.id, wait)
      const disconnect = dapp.disconnect({ notifyPeers: false })
      await vi.advanceTimersByTimeAsync(0)
      expectAborted(pending)
      changed.mockClear()

      wait.released.resolve()
      await disconnect
      await vi.advanceTimersByTimeAsync(0)
      expectAborted(pending)
      expect.soft(changed.mock.calls.filter(([account]) => account !== undefined)).toEqual([])
      expect(await dapp.getActiveAccount()).toBeUndefined()
      expect(await dapp.getAccounts()).toEqual([])
    }
  )

  it('aborts before account handling starts and does not adopt a later transition', async () => {
    const pending = await request()
    const wait = new StorageWait('get', StorageKey.LAST_SELECTED_WALLET)
    waits.push(wait)
    const original = dapp['onNewAccount'].bind(dapp)
    const boundary = { onNewAccount: dapp['onNewAccount'] }
    vi.spyOn(boundary, 'onNewAccount').mockImplementationOnce(async (...args) => {
      await wait.wait()
      return original(...args)
    })
    dapp['onNewAccount'] = boundary.onNewAccount
    await transport.receive(response(pending.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(wait.entered.isResolved()).toBe(true)
    await dapp.disconnect({ notifyPeers: false })
    await vi.advanceTimersByTimeAsync(0)
    expectAborted(pending)
    changed.mockClear()

    wait.released.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expectAborted(pending)
    expect.soft(changed.mock.calls.filter(([account]) => account !== undefined)).toEqual([])
    expect.soft(await dapp.getActiveAccount()).toBeUndefined()
    expect.soft(await dapp.getAccounts()).toEqual([])
  })

  it('aborts during destroy without waiting for an account write to finish', async () => {
    const pending = await request()
    const wait = hold('set', StorageKey.ACCOUNTS)
    await deliver(pending.id, wait)
    const destroyed = vi.fn()
    const destruction = dapp.destroy().then(destroyed)
    await vi.advanceTimersByTimeAsync(0)
    expectAborted(pending)
    expect(destroyed).not.toHaveBeenCalled()
    changed.mockClear()

    wait.released.resolve()
    await destruction
    await vi.advanceTimersByTimeAsync(0)
    expectAborted(pending)
    expect(changed).not.toHaveBeenCalled()
    expect(await storage.get(StorageKey.ACCOUNTS)).toEqual([])
  })

  it('keeps an unrelated account selection when earlier preparation resumes', async () => {
    const pending = await request()
    const wait = hold('get', StorageKey.LAST_SELECTED_WALLET)
    await deliver(pending.id, wait)
    const selected: AccountInfo = {
      accountIdentifier: 'selected-account',
      senderId: peer.senderId,
      origin: { type: connectionInfo.origin, id: connectionInfo.id },
      address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
      publicKey,
      network: { type: NetworkType.MAINNET },
      scopes: [PermissionScope.SIGN],
      connectedAt: 1,
      walletType: 'implicit'
    }
    await storage.set(StorageKey.ACCOUNTS, [selected])
    await dapp.setActiveAccount(selected)
    await vi.advanceTimersByTimeAsync(0)
    expectAborted(pending)
    changed.mockClear()

    wait.released.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expectAborted(pending)
    expect(await dapp.getActiveAccount()).toEqual(selected)
    expect(await dapp.getAccounts()).toEqual([selected])
    expect(changed).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)(
    'does not publish success when wallet details %s after disconnect',
    async (finish) => {
      const pending = await request()
      const wait = new StorageWait('get', StorageKey.LAST_SELECTED_WALLET)
      wait.finish = finish
      waits.push(wait)
      const original = dapp['getWalletInfo'].bind(dapp)
      const boundary = { getWalletInfo: dapp['getWalletInfo'] }
      vi.spyOn(boundary, 'getWalletInfo').mockImplementationOnce(async (...args) => {
        await wait.wait()
        return original(...args)
      })
      dapp['getWalletInfo'] = boundary.getWalletInfo
      await transport.receive(response(pending.id))
      await vi.advanceTimersByTimeAsync(0)
      expect(wait.entered.isResolved()).toBe(true)
      expect(await dapp.getActiveAccount()).toBeDefined()
      dapp['getWalletInfo'] = original
      await dapp.disconnect({ notifyPeers: false })
      await vi.advanceTimersByTimeAsync(0)
      expectAborted(pending)
      changed.mockClear()

      wait.released.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expectAborted(pending)
      expect(changed).not.toHaveBeenCalled()
      expect(await dapp.getActiveAccount()).toBeUndefined()
      expect(await storage.get(StorageKey.ACTIVE_ACCOUNT)).toBeUndefined()
    }
  )

  it('settles both coalesced callers once while account persistence remains pending', async () => {
    const send = vi.spyOn(transport, 'send')
    const pending = await request()
    const second = observe(dapp.requestPermissions())
    const wait = hold('set', StorageKey.ACCOUNTS)
    await deliver(pending.id, wait)
    const disconnect = dapp.disconnect({ notifyPeers: false })
    await vi.advanceTimersByTimeAsync(0)
    expectAborted(pending)
    expect.soft(second.settled).toHaveBeenCalledExactlyOnceWith({ error: aborted(pending.id) })
    expect(send).toHaveBeenCalledTimes(1)

    wait.released.resolve()
    await disconnect
    await vi.advanceTimersByTimeAsync(0)
    expectAborted(pending)
    expect.soft(second.settled).toHaveBeenCalledExactlyOnceWith({ error: aborted(pending.id) })
  })

  it('orders the prior account rollback before peer removal while the caller is aborted', async () => {
    const address = await getAddressFromPublicKey(publicKey)
    const previous: AccountInfo = {
      accountIdentifier: await getAccountIdentifier(address, { type: NetworkType.MAINNET }),
      senderId: peer.senderId,
      origin: { type: connectionInfo.origin, id: connectionInfo.id },
      address,
      publicKey,
      network: { type: NetworkType.MAINNET },
      scopes: [PermissionScope.OPERATION_REQUEST],
      connectedAt: 1,
      walletType: 'implicit'
    }
    await storage.set(StorageKey.ACCOUNTS, [previous])
    storage.accountWrites.length = 0
    const pending = await request()
    const write = hold('set', StorageKey.ACCOUNTS)
    await deliver(pending.id, write)
    const disconnected = vi.fn()
    const disconnect = dapp.disconnect({ notifyPeers: false }).then(disconnected)
    await vi.advanceTimersByTimeAsync(0)
    expectAborted(pending)
    const rollback = hold('set', StorageKey.ACCOUNTS)
    write.released.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(rollback.entered.isResolved()).toBe(true)
    expect(disconnected).not.toHaveBeenCalled()
    expect(storage.accountWrites).toEqual([
      [expect.objectContaining({ scopes: [PermissionScope.SIGN] })]
    ])

    rollback.released.resolve()
    await disconnect
    await vi.advanceTimersByTimeAsync(0)
    expectAborted(pending)
    expect(storage.accountWrites).toEqual([
      [expect.objectContaining({ scopes: [PermissionScope.SIGN] })],
      [previous],
      []
    ])
    expect(await dapp.getAccounts()).toEqual([])
    expect(await dapp.getActiveAccount()).toBeUndefined()
  })

  it('completes after its own account selection and shares one success with coalesced callers', async () => {
    const send = vi.spyOn(transport, 'send')
    const pending = await request()
    const second = observe(dapp.requestPermissions())
    await transport.receive(response(pending.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(pending.settled).toHaveBeenCalledTimes(1)
    expect(second.settled).toHaveBeenCalledTimes(1)
    const account = await dapp.getActiveAccount()
    expect(account).toEqual(expect.objectContaining({ scopes: [PermissionScope.SIGN] }))
    expect(await dapp.getAccounts()).toEqual([account])
    expect(await storage.get(StorageKey.ACTIVE_ACCOUNT)).toBe(account?.accountIdentifier)
    expect(await pending.outcome).toEqual({
      value: expect.objectContaining({ accountInfo: account })
    })
    expect(await second.outcome).toEqual(await pending.outcome)
    expect(succeeded).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps the V2 result when a success observer disconnects', async () => {
    let disconnect: Promise<void> | undefined
    await dapp.subscribeToEvent(BeaconEvent.PERMISSION_REQUEST_SUCCESS, () => {
      disconnect = dapp.disconnect({ notifyPeers: false })
    })
    const pending = await request()
    await transport.receive(response(pending.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(disconnect).toBeDefined()
    await disconnect
    await vi.advanceTimersByTimeAsync(0)
    const expected = {
      value: expect.objectContaining({ id: pending.id, type: BeaconMessageType.PermissionResponse })
    }
    expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith(expected)
    await expect.soft(pending.outcome).resolves.toEqual(expected)
    expect(succeeded).toHaveBeenCalledTimes(1)
    expect.soft(failed).not.toHaveBeenCalled()
    expect(await dapp.getActiveAccount()).toBeUndefined()
  })
})
