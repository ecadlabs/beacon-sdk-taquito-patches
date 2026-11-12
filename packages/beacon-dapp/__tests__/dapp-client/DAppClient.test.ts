import type { Mock } from 'vitest'
import { openToast, setDesktopList } from '@ecadlabs/beacon-ui'
// __tests__/DAppClient.test.ts
import { DAppClient } from '../../src/dapp-client/DAppClient'
import {
  AccountInfo,
  Blockchain,
  BeaconMessage,
  BeaconMessageWrapper,
  BeaconBaseMessage,
  ConnectionContext,
  ErrorResponse,
  ExtendedP2PPairingResponse,
  PeerInfoType,
  WalletInfo,
  BeaconMessageType,
  BeaconErrorType,
  NetworkType,
  Origin,
  PermissionScope,
  StorageKey,
  StorageKeyReturnType,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { LocalStorage, Logger } from '@ecadlabs/beacon-core'
import { WalletConnectTransport } from '@ecadlabs/beacon-transport-walletconnect'
import { BeaconEvent } from '../../src/events'
import { DappPostMessageTransport } from '../../src/transports/DappPostMessageTransport'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'
import { PostMessageTransport } from '@ecadlabs/beacon-transport-postmessage'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { getDAppClientInstance } from '../../src/utils/get-instance'

type RequestResponse = Awaited<NonNullable<ReturnType<DAppClient['createRequest']>>['promise']>
type RequestRoute = NonNullable<Parameters<DAppClient['createRequest']>[1]>

// The default deadline for permission requests when requestTimeoutMs is not configured.
const DEFAULT_PERMISSION_DEADLINE_MS = 60_000

function admitRequest<Failure>(
  owner: DAppClient,
  id: string,
  pending: {
    promise: Promise<unknown>
    resolve(value: RequestResponse): void
    reject(error?: Failure): void
  },
  route: RequestRoute = 'Direct',
  armDeadline = true,
  // Only permission requests keep a deadline when requestTimeoutMs is not configured.
  requestType: BeaconMessageType = BeaconMessageType.PermissionRequest
) {
  const request = owner['createRequest'](id, route)
  if (!request) throw new Error('Request already registered')
  // Observe fixture teardown even when the test ends without a response.
  void pending.promise.catch(() => undefined)
  void request.promise.then(pending.resolve, pending.reject)
  if (armDeadline) owner['armRequestDeadline'](request.key, requestType)
  return request
}

function closeRequest(owner: DAppClient, id: string) {
  const request = owner['requestTracker'].get(id)
  if (request) owner['requestTracker'].abort(request.key, owner['createAbortedError'](id))
}

const mockLoggerWarn = vi.fn()
const mockLoggerError = vi.fn()
let mockBroadcastMessage: ((message: unknown) => Promise<void>) | undefined
let storageChangedCallback:
  | ((event: {
      eventType: 'storageCleared' | 'entryModified'
      key: string | null
      oldValue: string | null
      newValue: string | null
    }) => Promise<void>)
  | undefined

//
// 1) Mock out all the heavy @ecadlabs/beacon-core and @ecadlabs/beacon-ui dependencies,
//    so we can instantiate DAppClient without spinning up real transports, storage, etc.
//

vi.mock('@ecadlabs/beacon-ui', () => ({
  setColorMode: vi.fn(),
  getColorMode: vi.fn().mockReturnValue('light'),
  setDesktopList: vi.fn(),
  setExtensionList: vi.fn(),
  setWebList: vi.fn(),
  setiOSList: vi.fn(),
  getiOSList: vi.fn().mockReturnValue([]),
  getDesktopList: vi.fn().mockReturnValue([]),
  getExtensionList: vi.fn().mockReturnValue([]),
  getWebList: vi.fn().mockReturnValue([]),
  isBrowser: vi.fn().mockReturnValue(true),
  isDesktop: vi.fn().mockReturnValue(false),
  isMobileOS: vi.fn().mockReturnValue(false),
  isIOS: vi.fn().mockReturnValue(false),
  closeToast: vi.fn(),
  openToast: vi.fn()
}))

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecadlabs/beacon-core')>()
  return {
    ...actual,
    // A minimal in-memory LocalStorage stub. The constructor is fixture-only;
    // the real LocalStorage constructor takes an optional key prefix.
    LocalStorage: class {
      private store = new Map<string, any>()
      constructor(initialValues?: Record<string, any>) {
        Object.entries(initialValues ?? {}).forEach(([key, value]) => this.store.set(key, value))
      }
      async get(key: string) {
        return this.store.get(key)
      }
      async set(key: string, value: any) {
        this.store.set(key, value)
      }
      async delete(key: string) {
        this.store.delete(key)
      }
      subscribeToStorageChanged(cb: typeof storageChangedCallback) {
        storageChangedCallback = cb
        return Promise.resolve()
      }
      getPrefixedKey(key: string) {
        return key
      }
    },
    // StorageValidator always “valid”
    StorageValidator: class {
      private mockStorage: any
      constructor(mockStorage: any) {
        this.mockStorage = mockStorage
      }
      validate() {
        return Promise.resolve(this.mockStorage.validateResults?.shift() ?? true)
      }
    },
    // Serializer just serializes to an empty string
    Serializer: class {
      serialize(_r: any) {
        return Promise.resolve('')
      }
    },
    // ExposedPromise with resolve/reject hooks
    ExposedPromise: class<T, E> {
      public promise: Promise<T>
      private _resolve!: (v: T) => void
      private _reject!: (e: E) => void
      constructor() {
        this.promise = new Promise<T>((res, rej) => {
          this._resolve = res
          this._reject = rej
        })
      }
      static resolve<U>(val: U) {
        const ex = new (this as any)()
        ex._resolve(val)
        return ex
      }
      resolve(v: T) {
        this._resolve(v)
      }
      reject(e: E) {
        this._reject(e)
      }
      isSettled() {
        return true
      }
    },
    generateGUID: vi.fn().mockResolvedValue('guid'),
    getSenderId: vi
      .fn()
      .mockImplementation(async (pk: string) =>
        pk === 'wallet-public-key' ? 'wallet-sender-id' : 'senderId'
      ),
    Logger: class {
      constructor(_name: string) {}
      error(...args: unknown[]) {
        mockLoggerError(...args)
      }
      log() {}
      warn(...args: unknown[]) {
        mockLoggerWarn(...args)
      }
      time() {}
    },
    ClientEvents: {
      CLOSE_ALERT: 'CLOSE_ALERT',
      RESET_STATE: 'RESET_STATE',
      WC_ACK_NOTIFICATION: 'WC_ACK_NOTIFICATION',
      ON_RELAYER_ERROR: 'ON_RELAYER_ERROR'
    },
    MultiTabChannel: class {
      constructor(_a: string, callback: (message: unknown) => Promise<void>, _c: unknown) {
        mockBroadcastMessage = callback
      }
      isLeader() {
        return true
      }
      hasLeader() {
        return Promise.resolve(true)
      }
      getLeadership() {
        return Promise.resolve()
      }
      close() {
        return Promise.resolve()
      }
      postMessage(_msg: any) {}
    }
  }
})

vi.mock('@walletconnect/sign-client', () => ({ default: {} }))
vi.mock('@walletconnect/types', () => ({}))
vi.mock('@walletconnect/utils', () => ({ getSdkError: vi.fn() }))

describe('DAppClient: basic unit tests', () => {
  let client: DAppClient

  beforeEach(() => {
    ;(window as any).beaconCreatedClientInstance = false
    mockLoggerWarn.mockClear()
    mockLoggerError.mockClear()
    storageChangedCallback = undefined
    mockBroadcastMessage = undefined
    client = new DAppClient({
      name: 'TestApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET
    })
    client.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
  })

  it('returns event cleanup that stops notifications without removing other subscribers', async () => {
    const listener = vi.fn()
    const other = vi.fn()
    const unsubscribe = await client.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, listener)
    await client.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, other)
    await client['events'].emit(BeaconEvent.CHANNEL_CLOSED, undefined)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toBeTypeOf('function')

    unsubscribe()
    unsubscribe()
    await client['events'].emit(BeaconEvent.CHANNEL_CLOSED, undefined)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(other).toHaveBeenCalledTimes(2)
  })

  const seedPeerStorage = async () => {
    await (client as any).storage.set(StorageKey.TRANSPORT_P2P_PEERS_DAPP, [])
    await (client as any).storage.set(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP, [])
    await (client as any).storage.set(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP, [])
  }

  const createStoredAccount = (): AccountInfo => ({
    accountIdentifier: '2Hhz5SFLypkQAgwvMCX7',
    senderId: 'wallet-sender-id',
    origin: {
      type: Origin.P2P,
      id: 'wallet-public-key'
    },
    address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
    network: {
      type: NetworkType.MAINNET
    },
    scopes: [PermissionScope.OPERATION_REQUEST],
    connectedAt: 1,
    walletType: 'implicit'
  })

  const createV480P2PPeer = () => ({
    type: 'p2p-pairing-request',
    id: 'wallet-public-key',
    senderId: 'wallet-sender-id',
    name: 'v4.8.0 Wallet',
    publicKey: 'wallet-public-key',
    version: '4',
    relayServer: 'matrix.example.com'
  })

  const createV480Permission = () => ({
    accountIdentifier: '2Hhz5SFLypkQAgwvMCX7',
    senderId: 'wallet-sender-id',
    address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
    network: {
      type: NetworkType.MAINNET
    },
    scopes: [PermissionScope.OPERATION_REQUEST],
    appMetadata: {
      senderId: 'dapp-sender-id',
      name: 'TestApp'
    },
    website: 'https://example.com',
    connectedAt: 1
  })

  it('settles an admitted request from its matching response', async () => {
    const pending = new ExposedPromise<RequestResponse, ErrorResponse>()
    const request = admitRequest(client, 'myId', pending)
    expect(client['requestTracker'].isCurrent(request.key)).toBe(true)
    const error: ErrorResponse = {
      id: 'myId',
      version: '2',
      senderId: 'wallet-sender-id',
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.NOT_GRANTED_ERROR
    }
    const receive = client['handleResponse'] as (
      message: BeaconMessage,
      context: ConnectionContext
    ) => Promise<void>
    await receive(error, { origin: Origin.P2P, id: 'wallet-public-key' })
    await expect(pending.promise).rejects.toEqual({ ...error, errorOrigin: 'wallet' })
    expect(client['requestTracker'].isCurrent(request.key)).toBe(false)
  })

  it('addBlockchain / removeBlockchain manage internal map', async () => {
    // define a minimal fake chain
    const fakeChain = {
      identifier: 'chain-1',
      getWalletLists: vi.fn().mockResolvedValue({
        desktopList: [],
        extensionList: [],
        webList: [],
        iOSList: []
      }),
      handleResponse: vi.fn()
    }
    client.addBlockchain(fakeChain as any)
    expect((client as any).blockchains.has('chain-1')).toBe(true)

    client.removeBlockchain('chain-1')
    expect((client as any).blockchains.has('chain-1')).toBe(false)
  })

  it.each(['remove', 'replace', 'register again', 'another chain'] as const)(
    'publishes wallet lists only for current registrations after %s',
    async (action) => {
      type WalletLists = Awaited<ReturnType<Blockchain['getWalletLists']>>
      const delayed = new ExposedPromise<WalletLists>()
      const lists: WalletLists = { desktopList: [], extensionList: [], webList: [], iOSList: [] }
      const chain: Blockchain = {
        identifier: 'delayed-chain',
        async validateRequest() {},
        async handleResponse() {},
        async getAccountInfosFromPermissionResponse() {
          return []
        },
        getWalletLists: vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValue(lists)
      }
      vi.mocked(setDesktopList).mockClear()
      client.addBlockchain(chain)
      if (action === 'remove') client.removeBlockchain(chain.identifier)
      else client.addBlockchain(
        action === 'another chain' ? { ...chain, identifier: 'other-chain' } :
        action === 'replace' ? { ...chain } : chain
      )
      await Promise.resolve()
      if (action !== 'remove') expect(setDesktopList).toHaveBeenCalledOnce()
      vi.mocked(setDesktopList).mockClear()
      delayed.resolve(lists)
      await delayed.promise
      await Promise.resolve()
      if (action === 'another chain') expect(setDesktopList).toHaveBeenCalledWith(lists.desktopList)
      else expect(setDesktopList).not.toHaveBeenCalled()
    }
  )

  it('reports wallet list loading failures for the registered blockchain', async () => {
    const failure = new Error('wallet list unavailable')
    const warn = vi.spyOn(Logger.prototype, 'warn')
    client.addBlockchain({
      identifier: 'failed-chain',
      async validateRequest() {},
      async handleResponse() {},
      async getAccountInfosFromPermissionResponse() {
        return []
      },
      async getWalletLists() {
        throw failure
      }
    })
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('addBlockchain wallet lists', 'failed-chain', failure)
    )
  })

  it('handles raw v3 disconnect messages without a nested message wrapper', async () => {
    const publicKey = '11'.repeat(32)
    const senderId = await (await import('@ecadlabs/beacon-core')).getSenderId(publicKey)
    ;(client as any)._activePeer = ExposedPromise.resolve({
      type: 'p2p-pairing-response',
      publicKey,
      senderId
    })
    const channelClosedHandler = vi.fn()
    const removeAccountsForPeerIds = vi
      .spyOn(client as any, 'removeAccountsForPeerIds')
      .mockResolvedValue(undefined)

    ;(client as any).p2pTransport = {
      getPeers: vi.fn().mockResolvedValue([]),
      removePeer: vi.fn()
    }

    client.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, channelClosedHandler)

    await expect(
      (client as any).handleResponse(
        {
          id: 'disconnect-id',
          version: '3',
          senderId,
          type: BeaconMessageType.Disconnect
        },
        {
          origin: Origin.P2P,
          id: publicKey
        }
      )
    ).resolves.toBeUndefined()

    expect(removeAccountsForPeerIds).toHaveBeenCalledWith([senderId])
    expect(channelClosedHandler).toHaveBeenCalled()

    removeAccountsForPeerIds.mockRestore()
  })

  it('ignores disconnects that do not match the active wallet identity', async () => {
    const publicKey = '11'.repeat(32)
    const senderId = await (await import('@ecadlabs/beacon-core')).getSenderId(publicKey)
    ;(client as any)._activePeer = ExposedPromise.resolve({
      type: 'p2p-pairing-response',
      publicKey,
      senderId
    })
    const removeAccounts = vi
      .spyOn(client as any, 'removeAccountsForPeerIds')
      .mockResolvedValue(undefined)
    const closed = vi.fn()
    client.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, closed)
    for (const [claimedSender, connectionId] of [
      ['mismatched-sender', publicKey],
      [senderId, '22'.repeat(32)]
    ]) {
      await (client as any).handleResponse(
        {
          id: 'mismatched-disconnect',
          version: '3',
          senderId: claimedSender,
          type: BeaconMessageType.Disconnect
        },
        { origin: Origin.P2P, id: connectionId }
      )
    }
    expect(removeAccounts).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
    removeAccounts.mockRestore()
  })

  it('emits one acknowledge event for duplicate acknowledge messages on an open request', async () => {
    const acknowledgeHandler = vi.fn()
    const getWalletInfo = vi.spyOn(client as any, 'getWalletInfo').mockResolvedValue({})

    admitRequest(
      client,
      'request-id',
      new ExposedPromise<RequestResponse, ErrorResponse>(),
      'Direct',
      false
    )

    client.subscribeToEvent(BeaconEvent.ACKNOWLEDGE_RECEIVED, acknowledgeHandler)

    const acknowledge = {
      id: 'request-id',
      version: '2',
      senderId: 'wallet-sender-id',
      type: BeaconMessageType.Acknowledge
    }
    const connectionInfo = {
      origin: Origin.P2P,
      id: 'wallet-public-key'
    }

    await (client as any).handleResponse(acknowledge, connectionInfo)
    await (client as any).handleResponse(acknowledge, connectionInfo)

    expect(acknowledgeHandler).toHaveBeenCalledTimes(1)

    getWalletInfo.mockRestore()
  })

  it('emits one acknowledge event for duplicate v3 wrapped acknowledge messages', async () => {
    await seedPeerStorage()

    const acknowledgeHandler = vi.fn()
    const getWalletInfo = vi.spyOn(client as any, 'getWalletInfo').mockResolvedValue({})

    admitRequest(
      client,
      'wrapper-request-id',
      new ExposedPromise<RequestResponse, ErrorResponse>(),
      'Direct',
      false
    )

    client.subscribeToEvent(BeaconEvent.ACKNOWLEDGE_RECEIVED, acknowledgeHandler)

    const acknowledge = {
      id: 'wrapper-request-id',
      version: '3',
      senderId: 'wallet-sender-id',
      message: {
        id: 'inner-acknowledge-id',
        version: '3',
        senderId: 'wallet-sender-id',
        type: BeaconMessageType.Acknowledge
      }
    }
    const connectionInfo = {
      origin: Origin.P2P,
      id: 'wallet-public-key'
    }

    await (client as any).handleResponse(acknowledge, connectionInfo)
    await (client as any).handleResponse(acknowledge, connectionInfo)

    expect(acknowledgeHandler).toHaveBeenCalledTimes(1)

    getWalletInfo.mockRestore()
  })

  it('coalesces concurrent permission requests onto one in-flight request', async () => {
    const permissionResponse = {
      id: 'permission-response-id',
      version: '2',
      senderId: 'wallet-sender-id',
      type: BeaconMessageType.PermissionResponse,
      publicKey: 'edpk',
      network: {
        type: NetworkType.MAINNET
      },
      scopes: []
    }
    const deferredRequest = new ExposedPromise<
      {
        message: typeof permissionResponse
        connectionInfo: {
          origin: Origin.P2P
          id: string
        }
      },
      Error
    >()
    const output = {
      ...permissionResponse,
      walletKey: 'wallet-key',
      address: 'tz1-address',
      accountInfo: {
        address: 'tz1-address',
        walletKey: 'wallet-key'
      }
    }
    const makeRequest = vi
      .spyOn(client as any, 'makeRequest')
      .mockReturnValue(deferredRequest.promise)
    vi.spyOn(client as any, 'checkMakeRequest').mockResolvedValue(true)
    vi.spyOn(client as any, 'getOwnAppMetadata').mockResolvedValue({
      senderId: 'dapp-sender-id',
      name: 'TestApp'
    })
    vi.spyOn(client as any, 'onNewAccount').mockResolvedValue(output.accountInfo)
    vi.spyOn(client as any, 'notifySuccess').mockResolvedValue(undefined)
    vi.spyOn(client as any, 'getWalletInfo').mockResolvedValue({})
    vi.spyOn((client as any).accountManager, 'addAccount').mockResolvedValue(undefined)

    const firstRequest = client.requestPermissions()
    const secondRequest = client.requestPermissions()

    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
    }

    expect(makeRequest).toHaveBeenCalledTimes(1)

    deferredRequest.resolve({
      message: permissionResponse,
      connectionInfo: {
        origin: Origin.P2P,
        id: 'wallet-public-key'
      }
    })

    await expect(firstRequest).resolves.toEqual(output)
    await expect(secondRequest).resolves.toEqual(output)
  })

  it('rejects concurrent permission requests with different scopes', async () => {
    vi.spyOn(client as any, 'getOwnAppMetadata').mockReturnValue(new Promise(() => {}))

    const firstRequest = client.requestPermissions({
      scopes: [PermissionScope.SIGN]
    })
    const secondRequest = client.requestPermissions({
      scopes: [PermissionScope.OPERATION_REQUEST]
    })

    await expect(secondRequest).rejects.toThrow(
      'Cannot start a permission request with different scopes while another permission request is pending'
    )
    firstRequest.catch(() => undefined)
  })

  it('validates concurrent permission request input before coalescing', async () => {
    vi.spyOn(client as any, 'getOwnAppMetadata').mockReturnValue(new Promise(() => {}))

    const firstRequest = client.requestPermissions()
    const invalidRequest = client.requestPermissions({
      network: {
        type: NetworkType.MAINNET
      }
    } as any)

    await expect(invalidRequest).rejects.toThrow(
      '[BEACON] the "network" property is no longer accepted in input. Please provide it when instantiating DAppClient.'
    )
    firstRequest.catch(() => undefined)
  })

  it('clears the in-flight permission request after rejection', async () => {
    const permissionResponse = {
      id: 'permission-response-id',
      version: '2',
      senderId: 'wallet-sender-id',
      type: BeaconMessageType.PermissionResponse,
      publicKey: 'edpk',
      network: {
        type: NetworkType.MAINNET
      },
      scopes: []
    }
    const rejectedRequest = new ExposedPromise<unknown, Error>()
    const successfulRequest = new ExposedPromise<
      {
        message: typeof permissionResponse
        connectionInfo: {
          origin: Origin.P2P
          id: string
        }
      },
      Error
    >()
    const output = {
      ...permissionResponse,
      walletKey: 'wallet-key',
      address: 'tz1-address',
      accountInfo: {
        address: 'tz1-address',
        walletKey: 'wallet-key'
      }
    }
    const makeRequest = vi
      .spyOn(client as any, 'makeRequest')
      .mockReturnValueOnce(rejectedRequest.promise)
      .mockReturnValueOnce(successfulRequest.promise)
    vi.spyOn(client as any, 'checkMakeRequest').mockResolvedValue(true)
    vi.spyOn(client as any, 'getOwnAppMetadata').mockResolvedValue({
      senderId: 'dapp-sender-id',
      name: 'TestApp'
    })
    vi.spyOn(client as any, 'runRequestErrorSideEffects').mockResolvedValue(undefined)
    vi.spyOn(client as any, 'onNewAccount').mockResolvedValue(output.accountInfo)
    vi.spyOn(client as any, 'notifySuccess').mockResolvedValue(undefined)
    vi.spyOn(client as any, 'getWalletInfo').mockResolvedValue({})
    vi.spyOn((client as any).accountManager, 'addAccount').mockResolvedValue(undefined)

    const firstRequest = client.requestPermissions()

    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
    }

    rejectedRequest.reject(new Error('rejected'))
    await expect(firstRequest).rejects.toThrow('rejected')

    const retryRequest = client.requestPermissions()

    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
    }

    expect(makeRequest).toHaveBeenCalledTimes(2)

    successfulRequest.resolve({
      message: permissionResponse,
      connectionInfo: {
        origin: Origin.P2P,
        id: 'wallet-public-key'
      }
    })

    await expect(retryRequest).resolves.toEqual(output)
  })

  it('does not return a destroyed singleton dApp client', async () => {
    const config = {
      name: 'TestApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET
    }
    const firstClient = getDAppClientInstance(config, true)
    const staleAccount = {
      accountIdentifier: 'stale-account-id',
      senderId: 'wallet-sender-id',
      origin: {
        type: Origin.P2P,
        id: 'wallet-public-key'
      },
      address: 'tz1-stale-address',
      network: {
        type: NetworkType.MAINNET
      },
      scopes: [PermissionScope.SIGN],
      connectedAt: Date.now(),
      walletType: 'implicit'
    } as const

    ;(firstClient as any)._activeAccount = ExposedPromise.resolve(staleAccount)
    await expect(firstClient.getActiveAccount()).resolves.toEqual(staleAccount)

    const destroyPromise = firstClient.destroy()

    const secondClient = getDAppClientInstance({
      ...config,
      storage: new LocalStorage()
    })

    expect(secondClient).not.toBe(firstClient)
    await expect(firstClient.getActiveAccount()).rejects.toThrow(
      'DAppClient has been destroyed and cannot be used again.'
    )
    await expect(firstClient.requestPermissions()).rejects.toThrow(
      'DAppClient has been destroyed and cannot be used again.'
    )
    await expect(secondClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(destroyPromise).resolves.toBeUndefined()
  })

  it('destroys all internal transports, not only the selected transport', async () => {
    const createTransport = (type: TransportType) => ({
      type,
      disconnect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    })
    const postMessageTransport = createTransport(TransportType.POST_MESSAGE)
    const p2pTransport = createTransport(TransportType.P2P)
    const walletConnectTransport = {
      ...createTransport(TransportType.WALLETCONNECT),
      doClientCleanup: vi.fn().mockResolvedValue(undefined)
    }
    const closeMultiTabChannel = vi.fn().mockResolvedValue(undefined)
    let rejectInit!: (reason: unknown) => void
    const initPromise = new Promise<TransportType>((_resolve, reject) => {
      rejectInit = reject
    })
    const initRejection = expect(initPromise).rejects.toMatchObject({
      errorType: BeaconErrorType.ABORTED_ERROR
    })

    ;(client as any).postMessageTransport = postMessageTransport
    ;(client as any).p2pTransport = p2pTransport
    ;(client as any).walletConnectTransport = walletConnectTransport
    ;(client as any).multiTabChannel = {
      close: closeMultiTabChannel
    }

    await (client as any).addListener(postMessageTransport)
    await (client as any).addListener(p2pTransport)
    await (client as any).addListener(walletConnectTransport)
    await (client as any).setTransport(p2pTransport)
    ;(client as any)._initPromise = initPromise
    ;(client as any)._initReject = rejectInit
    ;(client as any)._requestPermissionsPromise = initPromise
    ;(client as any)._requestPermissionsKey = 'sign'
    const removeAllPeers = vi.spyOn(client, 'removeAllPeers')

    await client.destroy()
    await initRejection

    expect(removeAllPeers).not.toHaveBeenCalled()
    expect(postMessageTransport.removeListener).toHaveBeenCalledTimes(1)
    expect(p2pTransport.removeListener).toHaveBeenCalledTimes(1)
    expect(walletConnectTransport.removeListener).toHaveBeenCalledTimes(1)
    expect(postMessageTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(p2pTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(walletConnectTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(postMessageTransport.send).not.toHaveBeenCalled()
    expect(p2pTransport.send).not.toHaveBeenCalled()
    expect(walletConnectTransport.send).not.toHaveBeenCalled()
    expect(walletConnectTransport.doClientCleanup).toHaveBeenCalledTimes(1)
    expect(closeMultiTabChannel).toHaveBeenCalledTimes(1)
    expect((client as any).postMessageTransport).toBeUndefined()
    expect((client as any).p2pTransport).toBeUndefined()
    expect((client as any).walletConnectTransport).toBeUndefined()
    expect((client as any)._initPromise).toBeUndefined()
    expect((client as any)._initReject).toBeUndefined()
    expect((client as any)._requestPermissionsPromise).toBeUndefined()
    expect((client as any)._requestPermissionsKey).toBeUndefined()
  })

  it('does not create a WalletConnect pairing request before the WC payload is awaited', async () => {
    const pairInitHandler = vi.fn()
    const createBaseTransport = (type: TransportType) => ({
      type,
      connectionStatus: TransportStatus.CONNECTED,
      connect: vi.fn().mockResolvedValue(undefined),
      listenForNewPeer: vi.fn().mockResolvedValue(undefined),
      stopListeningForNewPeers: vi.fn().mockResolvedValue(undefined),
      getPairingRequestInfo: vi.fn().mockResolvedValue({}),
      getPeers: vi.fn().mockResolvedValue([]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    })
    const postMessageTransport = createBaseTransport(TransportType.POST_MESSAGE)
    const p2pTransport = createBaseTransport(TransportType.P2P)
    const walletConnectTransport = {
      ...createBaseTransport(TransportType.WALLETCONNECT),
      getPairingRequestInfo: vi.fn().mockResolvedValue({ uri: 'wc:test-topic@2?symKey=test' })
    }
    const initInternalTransports = vi
      .spyOn(client as any, 'initInternalTransports')
      .mockImplementation(async function (this: any) {
        this.postMessageTransport = postMessageTransport
        this.p2pTransport = p2pTransport
        this.walletConnectTransport = walletConnectTransport
      })

    client.subscribeToEvent(BeaconEvent.PAIR_INIT, pairInitHandler)
    const initPromise = (client as any).init().catch(() => undefined)

    try {
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(pairInitHandler).toHaveBeenCalledTimes(1)
      expect(walletConnectTransport.getPairingRequestInfo).not.toHaveBeenCalled()

      const pairInitPayload = pairInitHandler.mock.calls[0][0]
      await expect(pairInitPayload.walletConnectPeerInfo).resolves.toBe(
        'wc:test-topic@2?symKey=test'
      )
      expect(walletConnectTransport.getPairingRequestInfo).toHaveBeenCalledTimes(1)
    } finally {
      ;(client as any)._initReject?.({ type: BeaconMessageType.Error })
      await initPromise
      initInternalTransports.mockRestore()
    }
  })

  it('clears the in-memory active account even when storage and transport state are already gone', async () => {
    const staleAccount = createStoredAccount()

    ;(client as any)._activeAccount = ExposedPromise.resolve(staleAccount)
    await (client as any).storage.delete(StorageKey.ACTIVE_ACCOUNT)

    const clearResult = await Promise.race([
      client.clearActiveAccount().then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 0))
    ])

    expect(clearResult).toBe('resolved')
    await expect(client.getActiveAccount()).resolves.toBeUndefined()
    await expect((client as any).storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
  })

  it('emits channel close events before transport has resolved', async () => {
    const channelClosedHandler = vi.fn()

    client.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, channelClosedHandler)

    const result = await Promise.race([
      (client as any).channelClosedHandler(TransportType.P2P).then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 0))
    ])

    expect(result).toBe('resolved')
    expect(channelClosedHandler).toHaveBeenCalledTimes(1)
  })

  it('does not notify wallet peers when cleaning up after a transport channel close', async () => {
    const staleAccount = createStoredAccount()
    const peer = createV480P2PPeer()
    const channelClosedHandler = vi.fn()
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([peer]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }

    client.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, channelClosedHandler)
    ;(client as any)._activeAccount = ExposedPromise.resolve(staleAccount)
    await (client as any).storage.set(StorageKey.ACCOUNTS, [staleAccount])
    await (client as any).setTransport(transport)

    await (client as any).channelClosedHandler(TransportType.P2P)

    expect(channelClosedHandler).toHaveBeenCalledTimes(1)
    expect(transport.removeAllPeers).toHaveBeenCalledTimes(1)
    expect(transport.send).not.toHaveBeenCalled()
    await expect(client.getActiveAccount()).resolves.toBeUndefined()
  })

  it('disconnect clears pending in-memory requests for non-WalletConnect transports', async () => {
    const staleAccount = createStoredAccount()
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }
    const pendingRequest = new ExposedPromise<unknown, any>()
    const pendingRejection = pendingRequest.promise.catch((error) => error)

    ;(client as any)._activeAccount = ExposedPromise.resolve(staleAccount)
    await (client as any).storage.set(StorageKey.ACCOUNTS, [])
    await (client as any).setTransport(transport)
    admitRequest(client, 'pending-after-disconnect', pendingRequest, 'Direct', false)

    await client.disconnect()

    expect(client['requestTracker'].size).toBe(0)
    await expect(pendingRejection).resolves.toMatchObject({
      id: 'pending-after-disconnect',
      errorType: BeaconErrorType.ABORTED_ERROR
    })
    await expect(client.getActiveAccount()).resolves.toBeUndefined()
    expect(transport.disconnect).toHaveBeenCalledTimes(1)
  })

  it('does not emit or rewrite storage when clearing an already-empty active account', async () => {
    await expect(client.getActiveAccount()).resolves.toBeUndefined()

    const testClient = client as unknown as {
      storage: { delete: (key: StorageKey) => Promise<void> }
      events: { emit: (event: BeaconEvent, payload?: unknown) => Promise<void> }
    }
    const storageDelete = vi.spyOn(testClient.storage, 'delete')
    const emit = vi.spyOn(testClient.events, 'emit')

    await client.clearActiveAccount()

    expect(storageDelete).not.toHaveBeenCalledWith(StorageKey.ACTIVE_ACCOUNT)
    expect(emit).not.toHaveBeenCalledWith(BeaconEvent.ACTIVE_ACCOUNT_SET, undefined)
  })

  it('does not emit or rewrite storage for duplicate active-account deletion events', async () => {
    await expect(client.getActiveAccount()).resolves.toBeUndefined()
    expect(storageChangedCallback).toBeDefined()

    const testClient = client as unknown as {
      storage: {
        delete: (key: StorageKey) => Promise<void>
        getPrefixedKey: (key: StorageKey) => string
      }
      events: { emit: (event: BeaconEvent, payload?: unknown) => Promise<void> }
    }
    const storageDelete = vi.spyOn(testClient.storage, 'delete')
    const emit = vi.spyOn(testClient.events, 'emit')

    await storageChangedCallback?.({
      eventType: 'entryModified',
      key: testClient.storage.getPrefixedKey(StorageKey.ACTIVE_ACCOUNT),
      oldValue: 'active-account-id',
      newValue: null
    })
    await storageChangedCallback?.({
      eventType: 'entryModified',
      key: testClient.storage.getPrefixedKey(StorageKey.ACTIVE_ACCOUNT),
      oldValue: null,
      newValue: null
    })

    expect(storageDelete).not.toHaveBeenCalledWith(StorageKey.ACTIVE_ACCOUNT)
    expect(emit).not.toHaveBeenCalledWith(BeaconEvent.ACTIVE_ACCOUNT_SET, undefined)
  })

  it('recovers the active account when accounts storage catches up to an existing pointer', async () => {
    const account = createStoredAccount()
    const testClient = client as unknown as {
      storage: {
        set: (key: StorageKey, value: unknown) => Promise<void>
        getPrefixedKey: (key: StorageKey) => string
      }
      setActiveAccount: (account?: unknown) => Promise<void>
    }

    await testClient.storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
    await testClient.storage.set(StorageKey.ACCOUNTS, [account])
    const initialize = vi.spyOn(client, 'initInternalTransports').mockResolvedValue(undefined)

    await storageChangedCallback?.({
      eventType: 'entryModified',
      key: testClient.storage.getPrefixedKey(StorageKey.ACCOUNTS),
      oldValue: '[]',
      newValue: JSON.stringify([account])
    })

    await expect(client.getActiveAccount()).resolves.toEqual(account)
    initialize.mockRestore()
  })

  it('does not re-set the active account when accounts storage changes but memory already matches', async () => {
    const account = createStoredAccount()
    const testClient = client as unknown as {
      _activeAccount: ExposedPromise<unknown>
      storage: {
        set: (key: StorageKey, value: unknown) => Promise<void>
        getPrefixedKey: (key: StorageKey) => string
      }
      setActiveAccount: (account?: unknown) => Promise<void>
    }

    testClient._activeAccount = ExposedPromise.resolve(account)
    await testClient.storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
    await testClient.storage.set(StorageKey.ACCOUNTS, [account])
    const setActiveAccount = vi.spyOn(testClient, 'setActiveAccount').mockResolvedValue(undefined)

    await storageChangedCallback?.({
      eventType: 'entryModified',
      key: testClient.storage.getPrefixedKey(StorageKey.ACCOUNTS),
      oldValue: '[]',
      newValue: JSON.stringify([account])
    })

    expect(setActiveAccount).not.toHaveBeenCalled()
    setActiveAccount.mockRestore()
  })

  it('disconnect rejects pending init and clears permission request state', async () => {
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }
    let rejectInit!: (reason: unknown) => void
    const initPromise = new Promise<TransportType>((_resolve, reject) => {
      rejectInit = reject
    })
    const initRejection = expect(initPromise).rejects.toMatchObject({
      errorType: BeaconErrorType.ABORTED_ERROR
    })

    await (client as any).storage.set(StorageKey.ACCOUNTS, [])
    await (client as any).setTransport(transport)
    ;(client as any)._initPromise = initPromise
    ;(client as any)._initReject = rejectInit
    ;(client as any)._requestPermissionsPromise = initPromise
    ;(client as any)._requestPermissionsKey = 'sign'

    await client.disconnect()
    await initRejection

    expect((client as any)._initPromise).toBeUndefined()
    expect((client as any)._initReject).toBeUndefined()
    expect((client as any)._requestPermissionsPromise).toBeUndefined()
    expect((client as any)._requestPermissionsKey).toBeUndefined()
  })

  it('disconnect tears down initialized transports while pairing is still pending', async () => {
    const createTransport = (type: TransportType) => ({
      type,
      connectionStatus: TransportStatus.CONNECTING,
      getPeers: vi.fn().mockResolvedValue([]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    })
    const postMessageTransport = createTransport(TransportType.POST_MESSAGE)
    const p2pTransport = createTransport(TransportType.P2P)
    const walletConnectTransport = {
      ...createTransport(TransportType.WALLETCONNECT),
      doClientCleanup: vi.fn().mockResolvedValue(undefined)
    }

    ;(client as any).postMessageTransport = postMessageTransport
    ;(client as any).p2pTransport = p2pTransport
    ;(client as any).walletConnectTransport = walletConnectTransport

    await expect(client.disconnect()).resolves.toBeUndefined()

    expect(postMessageTransport.removeAllPeers).toHaveBeenCalledTimes(1)
    expect(p2pTransport.removeAllPeers).toHaveBeenCalledTimes(1)
    expect(walletConnectTransport.removeAllPeers).toHaveBeenCalledTimes(1)
    expect(postMessageTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(p2pTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(walletConnectTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(walletConnectTransport.doClientCleanup).toHaveBeenCalledTimes(1)
    expect((client as any).postMessageTransport).toBeUndefined()
    expect((client as any).p2pTransport).toBeUndefined()
    expect((client as any).walletConnectTransport).toBeUndefined()
  })

  it('disconnect uses one in-flight logout for concurrent calls', async () => {
    const peer = createV480P2PPeer()
    let resolvePeers!: (peers: unknown[]) => void
    const getPeersPromise = new Promise<unknown[]>((resolve) => {
      resolvePeers = resolve
    })
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockReturnValue(getPeersPromise),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }

    ;(client as any).removeAccountsForPeers = vi.fn().mockResolvedValue(undefined)
    await (client as any).setTransport(transport)

    const firstDisconnect = client.disconnect()
    const secondDisconnect = client.disconnect()
    resolvePeers([peer])

    await expect(Promise.all([firstDisconnect, secondDisconnect])).resolves.toEqual([
      undefined,
      undefined
    ])

    expect(transport.getPeers).toHaveBeenCalledTimes(1)
    expect(transport.removeAllPeers).toHaveBeenCalledTimes(1)
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(transport.disconnect).toHaveBeenCalledTimes(1)
  })

  it('disconnect clears the in-flight promise when internal cleanup throws synchronously', async () => {
    const disconnectInternal = vi
      .spyOn(client as any, 'disconnectInternal')
      .mockImplementationOnce(() => {
        throw new Error('sync disconnect failure')
      })
      .mockResolvedValueOnce(undefined)

    await expect(client.disconnect()).rejects.toThrow('sync disconnect failure')
    await expect(client.disconnect()).resolves.toBeUndefined()

    expect(disconnectInternal).toHaveBeenCalledTimes(2)
  })

  it('disconnect sends peer notifications when a concurrent caller upgrades notifyPeers', async () => {
    const peer = createV480P2PPeer()
    let resolvePeers!: (peers: unknown[]) => void
    const getPeersPromise = new Promise<unknown[]>((resolve) => {
      resolvePeers = resolve
    })
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockReturnValue(getPeersPromise),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }

    ;(client as any).removeAccountsForPeers = vi.fn().mockResolvedValue(undefined)
    await (client as any).setTransport(transport)

    const firstDisconnect = client.disconnect({ notifyPeers: false })
    const secondDisconnect = client.disconnect({ notifyPeers: true })
    resolvePeers([peer])

    await expect(Promise.all([firstDisconnect, secondDisconnect])).resolves.toEqual([
      undefined,
      undefined
    ])

    expect(transport.getPeers).toHaveBeenCalledTimes(1)
    expect(transport.removeAllPeers).toHaveBeenCalledTimes(1)
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(transport.send).toHaveBeenCalledWith(expect.any(String), peer)
    expect(transport.disconnect).toHaveBeenCalledTimes(1)
  })

  it('disconnect tears down all resolved transports, not only the active transport', async () => {
    const postMessagePeer = {
      type: 'postmessage-pairing-response',
      id: 'postmessage-wallet',
      senderId: 'postmessage-sender',
      name: 'PostMessage Wallet',
      publicKey: 'postmessage-wallet',
      version: '4',
      extensionId: 'extension-id'
    }
    const p2pPeer = createV480P2PPeer()
    const walletConnectPeer = {
      type: 'walletconnect-pairing-response',
      id: 'wc-wallet',
      senderId: 'wc-wallet',
      name: 'WalletConnect Wallet',
      publicKey: 'wc-wallet',
      version: 'first'
    }
    const createTransport = (type: TransportType) => ({
      type,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    })
    const postMessageTransport = createTransport(TransportType.POST_MESSAGE)
    const p2pTransport = createTransport(TransportType.P2P)
    const walletConnectTransport = {
      ...createTransport(TransportType.WALLETCONNECT),
      doClientCleanup: vi.fn().mockResolvedValue(undefined)
    }
    postMessageTransport.getPeers.mockResolvedValue([postMessagePeer])
    p2pTransport.getPeers.mockResolvedValue([p2pPeer])
    walletConnectTransport.getPeers.mockResolvedValue([walletConnectPeer])
    ;(client as any).postMessageTransport = postMessageTransport
    ;(client as any).p2pTransport = p2pTransport
    ;(client as any).walletConnectTransport = walletConnectTransport
    await (client as any).storage.set(StorageKey.ACCOUNTS, [])
    await (client as any).setTransport(p2pTransport)

    await client.disconnect()

    expect(p2pTransport.getPeers).toHaveBeenCalledTimes(1)
    expect(postMessageTransport.getPeers).toHaveBeenCalledTimes(1)
    expect(walletConnectTransport.getPeers).toHaveBeenCalledTimes(1)
    expect(postMessageTransport.send).toHaveBeenCalledWith(expect.any(String), postMessagePeer)
    expect(p2pTransport.send).toHaveBeenCalledWith(expect.any(String), p2pPeer)
    expect(walletConnectTransport.send).toHaveBeenCalledWith(expect.any(String), walletConnectPeer)
    expect(postMessageTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(p2pTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(walletConnectTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(walletConnectTransport.doClientCleanup).toHaveBeenCalledTimes(1)
    expect((client as any).postMessageTransport).toBeUndefined()
    expect((client as any).p2pTransport).toBeUndefined()
    expect((client as any).walletConnectTransport).toBeUndefined()
  })

  it('disconnect tears down resolved transports with no peers without sending notifications', async () => {
    const createTransport = (type: TransportType) => ({
      type,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    })
    const postMessageTransport = createTransport(TransportType.POST_MESSAGE)
    const p2pTransport = createTransport(TransportType.P2P)
    const walletConnectTransport = {
      ...createTransport(TransportType.WALLETCONNECT),
      doClientCleanup: vi.fn().mockResolvedValue(undefined)
    }

    ;(client as any).postMessageTransport = postMessageTransport
    ;(client as any).p2pTransport = p2pTransport
    ;(client as any).walletConnectTransport = walletConnectTransport
    await (client as any).storage.set(StorageKey.ACCOUNTS, [])
    await (client as any).setTransport(p2pTransport)

    await expect(client.disconnect()).resolves.toBeUndefined()

    expect(postMessageTransport.removeAllPeers).toHaveBeenCalledTimes(1)
    expect(p2pTransport.removeAllPeers).toHaveBeenCalledTimes(1)
    expect(walletConnectTransport.removeAllPeers).toHaveBeenCalledTimes(1)
    expect(postMessageTransport.send).not.toHaveBeenCalled()
    expect(p2pTransport.send).not.toHaveBeenCalled()
    expect(walletConnectTransport.send).not.toHaveBeenCalled()
    expect(postMessageTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(p2pTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(walletConnectTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(walletConnectTransport.doClientCleanup).toHaveBeenCalledTimes(1)
  })

  it('disconnect logs transport cleanup failures and still resolves', async () => {
    const postMessageTransport = {
      type: TransportType.POST_MESSAGE,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockRejectedValue(new Error('postmessage cleanup failed')),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }
    const p2pTransport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }

    ;(client as any).postMessageTransport = postMessageTransport
    ;(client as any).p2pTransport = p2pTransport
    await (client as any).storage.set(StorageKey.ACCOUNTS, [])
    await (client as any).setTransport(p2pTransport)

    await expect(client.disconnect()).resolves.toBeUndefined()

    expect(postMessageTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(p2pTransport.disconnect).toHaveBeenCalledTimes(1)
    expect(mockLoggerWarn).toHaveBeenCalledWith('disconnectResolvedTransports', expect.any(Error))
  })

  it('disconnect sends disconnect messages to stored peers before tearing down transport state', async () => {
    const peer = createV480P2PPeer()
    let resolveSend!: () => void
    const sendPromise = new Promise<void>((resolve) => {
      resolveSend = resolve
    })
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([peer]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockReturnValue(sendPromise),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }

    ;(client as any).removeAccountsForPeers = vi.fn().mockResolvedValue(undefined)
    await (client as any).setTransport(transport)

    const disconnect = client.disconnect().then(() => 'resolved')
    await Promise.resolve()
    await Promise.resolve()

    await expect(Promise.race([disconnect, Promise.resolve('pending')])).resolves.toBe('pending')
    expect(transport.disconnect).not.toHaveBeenCalled()

    resolveSend()

    await expect(disconnect).resolves.toBe('resolved')

    expect(transport.getPeers).toHaveBeenCalledTimes(1)
    expect(transport.removeAllPeers).toHaveBeenCalledTimes(1)
    expect((client as any).removeAccountsForPeers).toHaveBeenCalledWith([peer])
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(transport.send).toHaveBeenCalledWith(expect.any(String), peer)
    expect(transport.disconnect).toHaveBeenCalledTimes(1)
    expect(transport.send.mock.invocationCallOrder[0]).toBeLessThan(
      transport.disconnect.mock.invocationCallOrder[0]
    )
  })

  it('disconnect clears selected transport and active peer so the client can reconnect', async () => {
    const peer = createV480P2PPeer()
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([peer]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }

    await (client as any).storage.set(StorageKey.ACCOUNTS, [])
    await (client as any).setTransport(transport)
    ;(client as any)._activePeer = ExposedPromise.resolve(peer)
    expect((client as any)._transport.isResolved()).toBe(true)

    await client.disconnect()

    expect((client as any)._transport.isResolved()).toBe(false)
    await expect((client as any)._activePeer.promise).resolves.toBeUndefined()
  })

  it('deduplicates peer disconnect notifications across duplicate transport instances', async () => {
    const peer = createV480P2PPeer()
    const createTransport = () => ({
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([peer]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    })
    const firstTransport = createTransport()
    const secondTransport = createTransport()

    ;(client as any).removeAccountsForPeers = vi.fn().mockResolvedValue(undefined)
    ;(client as any).p2pTransport = firstTransport
    await (client as any).setTransport(secondTransport)

    await client.disconnect()

    expect(firstTransport.getPeers).toHaveBeenCalledTimes(1)
    expect(secondTransport.getPeers).toHaveBeenCalledTimes(1)
    expect(firstTransport.send).toHaveBeenCalledTimes(1)
    expect(secondTransport.send).not.toHaveBeenCalled()
  })

  it('disconnect is idempotent when there are no peers and storage has already been cleared', async () => {
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }

    await (client as any).storage.delete(StorageKey.ACTIVE_ACCOUNT)
    await (client as any).storage.set(StorageKey.ACCOUNTS, [])
    await (client as any).setTransport(transport)

    await expect(client.disconnect()).resolves.toBeUndefined()

    expect(transport.getPeers).toHaveBeenCalledTimes(1)
    expect(transport.removeAllPeers).toHaveBeenCalledTimes(1)
    expect(transport.send).not.toHaveBeenCalled()
    expect(transport.disconnect).toHaveBeenCalledTimes(1)
    await expect(client.getActiveAccount()).resolves.toBeUndefined()
  })

  it('disconnect is idempotent after a previous disconnect completed', async () => {
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockImplementation(() => {
        transport.connectionStatus = TransportStatus.NOT_CONNECTED

        return Promise.resolve()
      }),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }

    await (client as any).storage.delete(StorageKey.ACTIVE_ACCOUNT)
    await (client as any).storage.set(StorageKey.ACCOUNTS, [])
    await (client as any).setTransport(transport)

    await expect(client.disconnect()).resolves.toBeUndefined()
    await expect(client.disconnect()).resolves.toBeUndefined()

    expect(transport.getPeers).toHaveBeenCalledTimes(1)
    expect(transport.removeAllPeers).toHaveBeenCalledTimes(1)
    expect(transport.disconnect).toHaveBeenCalledTimes(1)
    await expect(client.getActiveAccount()).resolves.toBeUndefined()
  })

  it('disconnect completes local cleanup when peer notification fails', async () => {
    const staleAccount = createStoredAccount()
    const peer = createV480P2PPeer()
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([peer]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockRejectedValue(new Error('peer offline')),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }
    const pendingRequest = new ExposedPromise<unknown, any>()
    const pendingRejection = pendingRequest.promise.catch((error) => error)

    ;(client as any)._activeAccount = ExposedPromise.resolve(staleAccount)
    await (client as any).storage.set(StorageKey.ACCOUNTS, [])
    await (client as any).setTransport(transport)
    admitRequest(client, 'pending-after-disconnect', pendingRequest, 'Direct', false)

    await expect(client.disconnect()).resolves.toBeUndefined()

    expect(transport.send).toHaveBeenCalledWith(expect.any(String), peer)
    expect(transport.disconnect).toHaveBeenCalledTimes(1)
    expect(client['requestTracker'].size).toBe(0)
    await expect(pendingRejection).resolves.toMatchObject({
      id: 'pending-after-disconnect',
      errorType: BeaconErrorType.ABORTED_ERROR
    })
    await expect(client.getActiveAccount()).resolves.toBeUndefined()
  })

  it('disconnect is a no-op after transport has already been cleared', async () => {
    const staleAccount = createStoredAccount()
    const pendingRequest = new ExposedPromise<unknown, any>()
    const pendingRejection = pendingRequest.promise.catch((error) => error)

    ;(client as any)._activeAccount = ExposedPromise.resolve(staleAccount)
    admitRequest(client, 'pending-after-disconnect', pendingRequest, 'Direct', false)
    await (client as any).storage.delete(StorageKey.ACTIVE_ACCOUNT)

    await expect(client.disconnect()).resolves.toBeUndefined()

    expect(client['requestTracker'].size).toBe(0)
    await expect(pendingRejection).resolves.toMatchObject({
      id: 'pending-after-disconnect',
      errorType: BeaconErrorType.ABORTED_ERROR
    })
    await expect(client.getActiveAccount()).resolves.toBeUndefined()
  })

  it('disconnect is a no-op when transport is already disconnected', async () => {
    const staleAccount = createStoredAccount()
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.NOT_CONNECTED,
      getPeers: vi.fn().mockResolvedValue([]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }

    ;(client as any)._activeAccount = ExposedPromise.resolve(staleAccount)
    await (client as any).storage.delete(StorageKey.ACTIVE_ACCOUNT)
    await (client as any).setTransport(transport)

    await expect(client.disconnect()).resolves.toBeUndefined()

    expect(transport.getPeers).not.toHaveBeenCalled()
    expect(transport.removeAllPeers).not.toHaveBeenCalled()
    expect(transport.send).not.toHaveBeenCalled()
    expect(transport.disconnect).not.toHaveBeenCalled()
    await expect(client.getActiveAccount()).resolves.toBeUndefined()
  })

  it('disconnect closes WalletConnect transport after attempting to notify a stored WalletConnect peer', async () => {
    const peer = {
      type: 'walletconnect-pairing-response',
      id: 'wallet-public-key',
      senderId: 'wallet-public-key',
      name: 'WalletConnect Wallet',
      publicKey: 'wallet-public-key',
      version: 'first'
    }
    const transport = {
      type: TransportType.WALLETCONNECT,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([peer]),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      doClientCleanup: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }
    Object.setPrototypeOf(transport, WalletConnectTransport.prototype)

    await (client as any).storage.delete(StorageKey.ACTIVE_ACCOUNT)
    await (client as any).storage.set(StorageKey.ACCOUNTS, [])
    await (client as any).setTransport(transport)

    await expect(client.disconnect()).resolves.toBeUndefined()

    expect(transport.getPeers).toHaveBeenCalledTimes(1)
    expect(transport.removeAllPeers).toHaveBeenCalledTimes(1)
    expect(transport.send).toHaveBeenCalledWith(expect.any(String), peer)
    expect(transport.disconnect).toHaveBeenCalledTimes(1)
    expect(transport.doClientCleanup).toHaveBeenCalledTimes(1)
  })

  it('cleans up v3 wrapped responses by the outer request id', async () => {
    await seedPeerStorage()

    const request = new ExposedPromise<RequestResponse, ErrorResponse>()
    admitRequest(client, 'wrapper-request-id', request, 'Direct', false)

    await (client as any).handleResponse(
      {
        id: 'wrapper-request-id',
        version: '3',
        senderId: 'wallet-sender-id',
        message: {
          id: 'inner-response-id',
          version: '3',
          senderId: 'wallet-sender-id',
          type: BeaconMessageType.SignPayloadResponse,
          signature: 'edsigt...'
        }
      },
      {
        origin: Origin.P2P,
        id: 'wallet-public-key'
      }
    )

    expect(client['requestTracker'].get('wrapper-request-id') !== undefined).toBe(false)
  })

  it('rejects open requests when the wallet peer never answers', async () => {
    vi.useFakeTimers()
    ;(window as any).beaconCreatedClientInstance = false
    const timeoutClient = new DAppClient({
      name: 'TimeoutApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      requestTimeoutMs: 10
    })
    timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    const channelClosedHandler = vi.fn()
    timeoutClient.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, channelClosedHandler)

    const operationRequest = new ExposedPromise<unknown, unknown>()
    const rejection = vi.fn()
    void operationRequest.promise.catch(rejection)

    try {
      admitRequest(timeoutClient, 'ghost-request-id', operationRequest)

      await vi.advanceTimersByTimeAsync(10)

      expect(rejection).toHaveBeenCalledWith(
        expect.objectContaining({
          type: BeaconMessageType.Error,
          errorType: BeaconErrorType.PEER_UNREACHABLE,
          id: 'ghost-request-id'
        })
      )
      expect(timeoutClient['requestTracker'].get('ghost-request-id') !== undefined).toBe(false)
      expect(channelClosedHandler).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears delegated open requests when another tab receives the wallet response', async () => {
    vi.useFakeTimers()
    ;(window as any).beaconCreatedClientInstance = false
    const timeoutClient = new DAppClient({
      name: 'TimeoutApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      requestTimeoutMs: 10
    })
    timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    const channelClosedHandler = vi.fn()
    timeoutClient.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, channelClosedHandler)
    const postMessage = vi.spyOn((timeoutClient as any).multiTabChannel, 'postMessage')

    try {
      admitRequest(
        timeoutClient,
        'delegated-request-id',
        new ExposedPromise<unknown, unknown>(),
        'LeaderProxy'
      )

      expect(
        timeoutClient['requestTracker'].get('delegated-request-id')?.route === 'LeaderProxy'
      ).toBe(true)

      await (timeoutClient as any).handleResponse(
        {
          id: 'delegated-request-id',
          version: '2',
          senderId: 'wallet-sender-id',
          type: BeaconMessageType.SignPayloadResponse,
          signature: 'edsigt...'
        },
        {
          origin: Origin.P2P,
          id: 'wallet-public-key'
        }
      )

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'delegated-request-id',
          type: 'RESPONSE'
        })
      )
      expect(timeoutClient['requestTracker'].get('delegated-request-id') !== undefined).toBe(false)
      expect(
        timeoutClient['requestTracker'].get('delegated-request-id')?.route === 'LeaderProxy'
      ).toBe(false)

      await vi.advanceTimersByTimeAsync(10)

      expect(channelClosedHandler).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps delegated acknowledged requests open without timing them out', async () => {
    vi.useFakeTimers()
    ;(window as any).beaconCreatedClientInstance = false
    const timeoutClient = new DAppClient({
      name: 'TimeoutApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      requestTimeoutMs: 10
    })
    timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    const channelClosedHandler = vi.fn()
    timeoutClient.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, channelClosedHandler)
    const postMessage = vi.spyOn((timeoutClient as any).multiTabChannel, 'postMessage')

    const operationRequest = new ExposedPromise<unknown, unknown>()
    const rejection = vi.fn()
    void operationRequest.promise.catch(rejection)

    try {
      admitRequest(
        timeoutClient,
        'delegated-acknowledged-request-id',
        operationRequest,
        'LeaderProxy'
      )

      await (timeoutClient as any).handleResponse(
        {
          id: 'delegated-acknowledged-request-id',
          version: '2',
          senderId: 'wallet-sender-id',
          type: BeaconMessageType.Acknowledge
        },
        {
          origin: Origin.P2P,
          id: 'wallet-public-key'
        }
      )

      await vi.advanceTimersByTimeAsync(10)

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'delegated-acknowledged-request-id',
          type: 'RESPONSE'
        })
      )
      expect(rejection).not.toHaveBeenCalled()
      expect(channelClosedHandler).not.toHaveBeenCalled()
      expect(
        timeoutClient['requestTracker'].get('delegated-acknowledged-request-id') !== undefined
      ).toBe(true)
      expect(
        timeoutClient['requestTracker'].get('delegated-acknowledged-request-id')?.route ===
          'LeaderProxy'
      ).toBe(true)
    } finally {
      closeRequest(timeoutClient, 'delegated-acknowledged-request-id')
      vi.useRealTimers()
    }
  })

  it('forwards delegated send failures back to the requesting tab', async () => {
    ;(window as any).beaconCreatedClientInstance = false
    const timeoutClient = new DAppClient({
      name: 'TimeoutApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      requestTimeoutMs: 0
    })
    timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})

    const postMessage = vi.spyOn((timeoutClient as any).multiTabChannel, 'postMessage')
    vi.spyOn((timeoutClient as any).multiTabChannel, 'isLeader').mockReturnValue(true)
    ;(timeoutClient as any)._transport = ExposedPromise.resolve({
      waitForResolution: vi.fn().mockResolvedValue(undefined)
    })

    const sendFailure: ErrorResponse = {
      id: 'delegated-send-failure-id',
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.UNKNOWN_ERROR,
      senderId: '',
      version: '2'
    }
    vi.spyOn(timeoutClient as any, 'makeRequest').mockRejectedValue(sendFailure)

    await (timeoutClient as any).prepareRequest({
      id: 'delegated-send-failure-id',
      type: BeaconMessageType.OperationRequest,
      data: {
        type: BeaconMessageType.OperationRequest,
        network: {
          type: NetworkType.MAINNET
        },
        operationDetails: [],
        sourceAddress: 'tz1-address'
      }
    })
    await Promise.resolve()

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'delegated-send-failure-id',
        type: 'RESPONSE',
        data: expect.objectContaining({
          message: expect.objectContaining({
            id: 'delegated-send-failure-id',
            type: BeaconMessageType.Error,
            errorType: BeaconErrorType.UNKNOWN_ERROR
          })
        })
      })
    )
    expect(
      timeoutClient['requestTracker'].get('delegated-send-failure-id')?.route === 'LeaderProxy'
    ).toBe(false)
  })

  it('clears open requests when transport send rejects asynchronously', async () => {
    ;(window as any).beaconCreatedClientInstance = false
    const timeoutClient = new DAppClient({
      name: 'TimeoutApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      requestTimeoutMs: 0
    })
    timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})

    const sendError = new Error('send failed')
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      send: vi.fn().mockRejectedValue(sendError)
    }
    const peer = {
      type: 'p2p-pairing-response',
      senderId: 'wallet-sender-id',
      publicKey: 'wallet-public-key',
      name: 'Wallet',
      relayServer: 'matrix.example.com'
    }
    ;(timeoutClient as any)._beaconId = ExposedPromise.resolve('beacon-id')
    ;(timeoutClient as any)._activePeer = ExposedPromise.resolve(peer)
    ;(timeoutClient as any)._transport = ExposedPromise.resolve(transport)

    vi.spyOn(timeoutClient as any, 'init').mockResolvedValue(TransportType.P2P)
    vi.spyOn(timeoutClient as any, 'transport', 'get').mockReturnValue(Promise.resolve(transport))
    vi.spyOn(timeoutClient as any, 'checkPermissions').mockResolvedValue(true)
    vi.spyOn(timeoutClient as any, 'addRequestAndCheckIfRateLimited').mockResolvedValue(false)
    vi.spyOn(timeoutClient as any, 'getActiveAccount').mockResolvedValue(undefined)
    vi.spyOn(timeoutClient as any, 'getPeer').mockResolvedValue(peer)
    vi.spyOn(timeoutClient as any, 'getWalletInfo').mockResolvedValue({})

    await expect(
      (timeoutClient as any).makeRequest({
        type: BeaconMessageType.OperationRequest,
        network: {
          type: NetworkType.MAINNET
        },
        operationDetails: [],
        sourceAddress: 'tz1-address'
      })
    ).rejects.toBe(sendError)

    expect(timeoutClient['requestTracker'].get('guid') !== undefined).toBe(false)
  })

  it('restores an upstream v4.8.0-style P2P persisted session without deactivating it', async () => {
    const activeAccountHandler = vi.fn()
    const invalidAccountHandler = vi.fn()
    const storedAccount = createStoredAccount()
    const p2pPeer = createV480P2PPeer()
    const storage = new LocalStorage({
      [StorageKey.ACTIVE_ACCOUNT]: storedAccount.accountIdentifier,
      [StorageKey.ACCOUNTS]: [storedAccount],
      [StorageKey.PERMISSION_LIST]: [createV480Permission()],
      [StorageKey.TRANSPORT_P2P_PEERS_DAPP]: [p2pPeer]
    })
    const initInternalTransports = vi
      .spyOn(DAppClient.prototype as any, 'initInternalTransports')
      .mockImplementation(async function (this: any) {
        this.p2pTransport = {
          connectionStatus: TransportStatus.CONNECTED,
          getPeers: vi.fn().mockResolvedValue([p2pPeer])
        }
      })

    try {
      ;(window as any).beaconCreatedClientInstance = false
      const storedStateClient = new DAppClient({
        name: 'UpstreamV480StoredStateApp',
        storage,
        preferredNetwork: NetworkType.MAINNET,
        disableDefaultEvents: true,
        eventHandlers: {
          [BeaconEvent.ACTIVE_ACCOUNT_SET]: {
            handler: activeAccountHandler
          },
          [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: {
            handler: invalidAccountHandler
          }
        }
      })

      await (storedStateClient as any).storageValidated

      await expect(storedStateClient.getActiveAccount()).resolves.toEqual(storedAccount)
      await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(
        storedAccount.accountIdentifier
      )
      await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toEqual([storedAccount])
      expect(activeAccountHandler).toHaveBeenCalledWith(storedAccount, undefined)
      expect(invalidAccountHandler).not.toHaveBeenCalled()
    } finally {
      initInternalTransports.mockRestore()
    }
  })

  it('recreates the SDK secret seed through transport init after storage was cleared', async () => {
    await (client as any).storage.delete(StorageKey.BEACON_SDK_SECRET_SEED)
    ;(client as any).postMessageTransport = {
      type: TransportType.POST_MESSAGE
    }

    try {
      await expect((client as any).initInternalTransports()).resolves.toBeUndefined()

      const restoredSeed = await (client as any).storage.get(StorageKey.BEACON_SDK_SECRET_SEED)

      expect(restoredSeed).toEqual(expect.any(String))
      expect(restoredSeed).not.toHaveLength(0)
      await expect(client.beaconId).resolves.toEqual(expect.any(String))
      expect((client as any).postMessageTransport).toBeDefined()
    } finally {
      ;(client as any).postMessageTransport = undefined
    }
  })

  it('reuses one SDK secret recovery when transport init races after storage was cleared', async () => {
    await (client as any).storage.delete(StorageKey.BEACON_SDK_SECRET_SEED)
    const initSDK = vi.spyOn(client as any, 'initSDK')

    const [firstSeed, secondSeed] = await Promise.all([
      (client as any).getOrCreateSDKSecretSeed(),
      (client as any).getOrCreateSDKSecretSeed()
    ])

    expect(firstSeed).toBe(secondSeed)
    expect(initSDK).toHaveBeenCalledTimes(1)
    await expect((client as any).storage.get(StorageKey.BEACON_SDK_SECRET_SEED)).resolves.toBe(
      firstSeed
    )

    initSDK.mockRestore()
  })

  it('recreates the SDK secret seed when storage contains invalid seed sentinels', async () => {
    await (client as any).storage.set(StorageKey.BEACON_SDK_SECRET_SEED, 'undefined')

    const restoredSeed = await (client as any).getOrCreateSDKSecretSeed()

    expect(restoredSeed).toEqual(expect.any(String))
    expect(restoredSeed).not.toBe('undefined')
  })

  it('emits account deactivated and clears the active pointer when the stored active account is missing', async () => {
    const invalidAccountHandler = vi.fn()
    const legacyInvalidAccountHandler = vi.fn()
    const activeAccountHandler = vi.fn()
    const storedAccount = createStoredAccount()
    const storage = new LocalStorage({
      [StorageKey.ACTIVE_ACCOUNT]: 'missing-account-id',
      [StorageKey.ACCOUNTS]: [storedAccount]
    })

    ;(window as any).beaconCreatedClientInstance = false
    const storedStateClient = new DAppClient({
      name: 'StoredStateApp',
      storage,
      preferredNetwork: NetworkType.MAINNET,
      disableDefaultEvents: true,
      eventHandlers: {
        [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: {
          handler: invalidAccountHandler
        },
        [BeaconEvent.ACTIVE_ACCOUNT_SET]: {
          handler: activeAccountHandler
        }
      }
    })
    await storedStateClient.subscribeToEvent(
      BeaconEvent.INVALID_ACCOUNT_DEACTIVATED,
      legacyInvalidAccountHandler
    )

    await (storedStateClient as any).storageValidated

    await expect(storedStateClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toEqual([storedAccount])
    expect(activeAccountHandler).not.toHaveBeenCalled()
    expect(invalidAccountHandler).toHaveBeenCalledWith(
      { reason: 'missing_active_account' },
      undefined
    )
    expect(legacyInvalidAccountHandler).toHaveBeenCalled()
  })

  it('keeps non-active accounts after repairing a missing active account', async () => {
    const invalidAccountHandler = vi.fn()
    const storedAccount = createStoredAccount()
    const secondaryAccount = {
      ...createStoredAccount(),
      accountIdentifier: 'secondary-account-id',
      senderId: 'secondary-wallet-sender-id',
      address: 'tz1secondaryAddress'
    }
    const storage = new LocalStorage({
      [StorageKey.ACTIVE_ACCOUNT]: 'missing-account-id',
      [StorageKey.ACCOUNTS]: [storedAccount, secondaryAccount]
    })

    ;(window as any).beaconCreatedClientInstance = false
    const storedStateClient = new DAppClient({
      name: 'StoredAccountsSurviveRepairApp',
      storage,
      preferredNetwork: NetworkType.MAINNET,
      disableDefaultEvents: true,
      eventHandlers: {
        [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: {
          handler: invalidAccountHandler
        }
      }
    })

    await (storedStateClient as any).storageValidated

    await expect(storedStateClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storedStateClient.getAccounts()).resolves.toEqual([
      storedAccount,
      secondaryAccount
    ])
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    expect(invalidAccountHandler).toHaveBeenCalledWith(
      { reason: 'missing_active_account' },
      undefined
    )
  })

  it('treats a literal undefined active-account sentinel as silent state repair', async () => {
    const invalidAccountHandler = vi.fn()
    const activeAccountHandler = vi.fn()
    const storage = new LocalStorage({
      [StorageKey.ACTIVE_ACCOUNT]: 'undefined',
      [StorageKey.BEACON_SDK_SECRET_SEED]: 'seed',
      [StorageKey.LAST_SELECTED_WALLET]: { key: 'kukai', name: 'Kukai' }
    })

    ;(window as any).beaconCreatedClientInstance = false
    const storedStateClient = new DAppClient({
      name: 'UndefinedSentinelStoredStateApp',
      storage,
      preferredNetwork: NetworkType.MAINNET,
      disableDefaultEvents: true,
      eventHandlers: {
        [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: {
          handler: invalidAccountHandler
        },
        [BeaconEvent.ACTIVE_ACCOUNT_SET]: {
          handler: activeAccountHandler
        }
      }
    })

    await (storedStateClient as any).storageValidated

    await expect(storedStateClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.BEACON_SDK_SECRET_SEED)).resolves.toBe('seed')
    await expect(storage.get(StorageKey.LAST_SELECTED_WALLET)).resolves.toEqual({
      key: 'kukai',
      name: 'Kukai'
    })
    expect(activeAccountHandler).not.toHaveBeenCalled()
    expect(invalidAccountHandler).toHaveBeenCalledWith(
      { reason: 'missing_active_account' },
      undefined
    )
  })

  it('repairs a normalized undefined active-account sentinel when accounts remain in real storage', async () => {
    localStorage.clear()
    const invalidAccountHandler = vi.fn()
    const activeAccountHandler = vi.fn()
    const storedAccount = createStoredAccount()
    const { LocalStorage: RealLocalStorage } = (await vi.importActual<
      typeof import('@ecadlabs/beacon-core')
    >('@ecadlabs/beacon-core')) as typeof import('@ecadlabs/beacon-core')
    const storage = new RealLocalStorage()

    await storage.set(StorageKey.ACTIVE_ACCOUNT, 'undefined')
    await storage.set(StorageKey.ACCOUNTS, [storedAccount])
    ;(window as any).beaconCreatedClientInstance = false
    const storedStateClient = new DAppClient({
      name: 'RealStorageUndefinedSentinelApp',
      storage,
      preferredNetwork: NetworkType.MAINNET,
      disableDefaultEvents: true,
      eventHandlers: {
        [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: {
          handler: invalidAccountHandler
        },
        [BeaconEvent.ACTIVE_ACCOUNT_SET]: {
          handler: activeAccountHandler
        }
      }
    })

    await (storedStateClient as any).storageValidated

    await expect(storedStateClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toEqual([storedAccount])
    expect(activeAccountHandler).not.toHaveBeenCalled()
    expect(invalidAccountHandler).toHaveBeenCalledWith(
      { reason: 'missing_active_account' },
      undefined
    )
    localStorage.clear()
  })

  it('continues a permission request after repairing a missing active account', async () => {
    const invalidAccountHandler = vi.fn()
    const storage = new LocalStorage({
      [StorageKey.ACTIVE_ACCOUNT]: 'undefined',
      [StorageKey.BEACON_SDK_SECRET_SEED]: 'seed',
      [StorageKey.LAST_SELECTED_WALLET]: { key: 'kukai', name: 'Kukai' }
    })
    const permissionResponse = {
      id: 'permission-response-id',
      version: '2',
      senderId: 'wallet-sender-id',
      type: BeaconMessageType.PermissionResponse,
      publicKey: 'edpk',
      network: {
        type: NetworkType.MAINNET
      },
      scopes: []
    }
    const permissionResult = {
      message: permissionResponse,
      connectionInfo: {
        origin: Origin.P2P,
        id: 'wallet-public-key'
      }
    }
    const accountInfo = {
      address: 'tz1-address',
      walletKey: 'wallet-key'
    }

    ;(window as any).beaconCreatedClientInstance = false
    const storedStateClient = new DAppClient({
      name: 'RepairThenConnectApp',
      storage,
      preferredNetwork: NetworkType.MAINNET,
      disableDefaultEvents: true,
      eventHandlers: {
        [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: {
          handler: invalidAccountHandler
        }
      }
    })
    const hideUI = vi.spyOn(storedStateClient as any, 'hideUI')
    const makeRequest = vi
      .spyOn(storedStateClient as any, 'makeRequest')
      .mockResolvedValue(permissionResult)
    vi.spyOn(storedStateClient as any, 'checkMakeRequest').mockResolvedValue(true)
    vi.spyOn(storedStateClient as any, 'getOwnAppMetadata').mockResolvedValue({
      senderId: 'dapp-sender-id',
      name: 'RepairThenConnectApp'
    })
    vi.spyOn(storedStateClient as any, 'onNewAccount').mockResolvedValue(accountInfo)
    vi.spyOn(storedStateClient as any, 'notifySuccess').mockResolvedValue(undefined)
    vi.spyOn(storedStateClient as any, 'getWalletInfo').mockResolvedValue({})
    vi.spyOn((storedStateClient as any).accountManager, 'addAccount').mockResolvedValue(undefined)

    const restored: unknown = Reflect.get(storedStateClient, 'activeAccountLoaded')
    if (!(restored instanceof Promise)) {
      throw new Error('Missing startup completion promise')
    }
    await restored
    await expect(storedStateClient.requestPermissions()).resolves.toEqual({
      ...permissionResponse,
      walletKey: accountInfo.walletKey,
      address: accountInfo.address,
      accountInfo
    })

    expect(invalidAccountHandler).toHaveBeenCalledWith(
      { reason: 'missing_active_account' },
      undefined
    )
    expect(makeRequest).toHaveBeenCalledTimes(1)
    expect(hideUI).not.toHaveBeenCalled()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
  })

  it('deletes active-account storage when the active account is cleared', async () => {
    const { startupClient, storage, release, startup, account } = await delayedStartup()
    release.resolve()
    await startup
    await expect(startupClient.getActiveAccount()).resolves.toEqual(account)

    await startupClient.clearActiveAccount()

    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
  })

  it('emits account deactivated and clears state when stored accounts are malformed', async () => {
    const invalidAccountHandler = vi.fn()
    const storage = new LocalStorage({
      [StorageKey.ACTIVE_ACCOUNT]: 'stored-account-id',
      [StorageKey.ACCOUNTS]: {
        accountIdentifier: 'stored-account-id'
      }
    })

    ;(window as any).beaconCreatedClientInstance = false
    const storedStateClient = new DAppClient({
      name: 'MalformedStoredStateApp',
      storage,
      preferredNetwork: NetworkType.MAINNET,
      disableDefaultEvents: true,
      eventHandlers: {
        [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: {
          handler: invalidAccountHandler
        }
      }
    })

    await (storedStateClient as any).storageValidated

    await expect(storedStateClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toBeUndefined()
    expect(invalidAccountHandler).toHaveBeenCalledWith(
      { reason: 'invalid_active_account_storage' },
      undefined
    )
  })

  it('clears invalid storage without account deactivated event when validation fails with no active account', async () => {
    const invalidAccountHandler = vi.fn()
    const storedAccount = createStoredAccount()
    const storage = new LocalStorage({
      [StorageKey.ACCOUNTS]: [storedAccount]
    })
    ;(storage as any).validateResults = [false, false]
    ;(window as any).beaconCreatedClientInstance = false
    const storedStateClient = new DAppClient({
      name: 'InvalidValidatedStateApp',
      storage,
      preferredNetwork: NetworkType.MAINNET,
      disableDefaultEvents: true,
      eventHandlers: {
        [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: {
          handler: invalidAccountHandler
        }
      }
    })

    await (storedStateClient as any).storageValidated

    await expect(storedStateClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toBeUndefined()
    expect(invalidAccountHandler).not.toHaveBeenCalled()
  })

  it('emits account deactivated once when active-account restore and validation both fail', async () => {
    const invalidAccountHandler = vi.fn()
    const storage = new LocalStorage({
      [StorageKey.ACTIVE_ACCOUNT]: 'missing-account-id',
      [StorageKey.ACCOUNTS]: [createStoredAccount()]
    })
    ;(storage as any).validateResults = [false, false]
    ;(window as any).beaconCreatedClientInstance = false
    const storedStateClient = new DAppClient({
      name: 'DoubleInvalidStoredStateApp',
      storage,
      preferredNetwork: NetworkType.MAINNET,
      disableDefaultEvents: true,
      eventHandlers: {
        [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: {
          handler: invalidAccountHandler
        }
      }
    })

    await (storedStateClient as any).storageValidated

    await expect(storedStateClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toBeUndefined()
    expect(invalidAccountHandler).toHaveBeenCalledTimes(1)
    expect(invalidAccountHandler).toHaveBeenCalledWith(
      { reason: 'missing_active_account' },
      undefined
    )
  })

  it('emits account deactivated with storage validation reason when restored storage stays invalid', async () => {
    const invalidAccountHandler = vi.fn()
    const storedAccount = createStoredAccount()
    const storage = new LocalStorage({
      [StorageKey.ACTIVE_ACCOUNT]: storedAccount.accountIdentifier,
      [StorageKey.ACCOUNTS]: [storedAccount]
    })
    const firstValidation = new ExposedPromise<boolean>()
    ;(storage as any).validateResults = [firstValidation.promise, false]
    const p2pPeer = createV480P2PPeer()
    const disconnectP2P = vi.fn().mockResolvedValue(undefined)
    const initInternalTransports = vi
      .spyOn(DAppClient.prototype as any, 'initInternalTransports')
      .mockImplementation(async function (this: any) {
        this.p2pTransport = {
          connectionStatus: TransportStatus.CONNECTED,
          getPeers: vi.fn().mockResolvedValue([p2pPeer]),
          disconnect: disconnectP2P
        }
      })
    const getWalletInfo = vi
      .spyOn(DAppClient.prototype as any, 'getWalletInfo')
      .mockResolvedValue({ name: 'Wallet', type: 'web' })

    try {
      ;(window as any).beaconCreatedClientInstance = false
      const storedStateClient = new DAppClient({
        name: 'StorageValidationFailedApp',
        storage,
        preferredNetwork: NetworkType.MAINNET,
        disableDefaultEvents: true,
        eventHandlers: {
          [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: {
            handler: invalidAccountHandler
          }
        }
      })

      await expect(storedStateClient.getActiveAccount()).resolves.toEqual(storedAccount)
      firstValidation.resolve(false)
      await (storedStateClient as any).storageValidated

      await expect(storedStateClient.getActiveAccount()).resolves.toBeUndefined()
      await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
      await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toBeUndefined()
      expect(disconnectP2P).toHaveBeenCalledTimes(1)
      expect(invalidAccountHandler).toHaveBeenCalledWith(
        { reason: 'storage_validation_failed' },
        undefined
      )
    } finally {
      initInternalTransports.mockRestore()
      getWalletInfo.mockRestore()
    }
  })

  it('keeps legacy no-payload account deactivated event emission compatible', async () => {
    ;(window as any).beaconCreatedClientInstance = false
    const storedStateClient = new DAppClient({
      name: 'LegacyAccountDeactivatedEventApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      disableDefaultEvents: true
    })
    const invalidAccountHandler = vi.fn()
    await storedStateClient.subscribeToEvent(
      BeaconEvent.INVALID_ACCOUNT_DEACTIVATED,
      invalidAccountHandler
    )

    await expect(
      (storedStateClient as any).events.emit(BeaconEvent.INVALID_ACCOUNT_DEACTIVATED)
    ).resolves.toBeUndefined()
    expect(invalidAccountHandler).toHaveBeenCalledWith(undefined, undefined)
  })

  it('clears v3 open requests when transport send rejects asynchronously', async () => {
    ;(window as any).beaconCreatedClientInstance = false
    const timeoutClient = new DAppClient({
      name: 'TimeoutApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      requestTimeoutMs: 0
    })
    timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})

    const sendError = new Error('send failed')
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      send: vi.fn().mockRejectedValue(sendError)
    }
    const peer = {
      type: 'p2p-pairing-response',
      senderId: 'wallet-sender-id',
      publicKey: 'wallet-public-key',
      name: 'Wallet',
      relayServer: 'matrix.example.com'
    }
    ;(timeoutClient as any)._beaconId = ExposedPromise.resolve('beacon-id')
    ;(timeoutClient as any)._activePeer = ExposedPromise.resolve(peer)
    ;(timeoutClient as any)._transport = ExposedPromise.resolve(transport)

    vi.spyOn(timeoutClient as any, 'init').mockResolvedValue(TransportType.P2P)
    vi.spyOn(timeoutClient as any, 'transport', 'get').mockReturnValue(Promise.resolve(transport))
    vi.spyOn(timeoutClient as any, 'addRequestAndCheckIfRateLimited').mockResolvedValue(false)
    vi.spyOn(timeoutClient as any, 'getActiveAccount').mockResolvedValue(undefined)
    vi.spyOn(timeoutClient as any, 'getPeer').mockResolvedValue(peer)
    vi.spyOn(timeoutClient as any, 'getWalletInfo').mockResolvedValue({})

    await expect(
      (timeoutClient as any).makeRequestV3({
        type: BeaconMessageType.SignPayloadRequest,
        signingType: 'raw',
        payload: 'payload',
        sourceAddress: 'tz1-address'
      })
    ).rejects.toBe(sendError)

    expect(timeoutClient['requestTracker'].get('guid') !== undefined).toBe(false)
  })

  it('clears delegated request markers when the delegated request times out', async () => {
    vi.useFakeTimers()
    ;(window as any).beaconCreatedClientInstance = false
    const timeoutClient = new DAppClient({
      name: 'TimeoutApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      requestTimeoutMs: 10
    })
    timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})

    const operationRequest = new ExposedPromise<unknown, unknown>()
    void operationRequest.promise.catch(() => undefined)

    try {
      admitRequest(timeoutClient, 'delegated-request-id', operationRequest, 'LeaderProxy')

      await vi.advanceTimersByTimeAsync(10)

      expect(
        timeoutClient['requestTracker'].get('delegated-request-id')?.route === 'LeaderProxy'
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['valid', 'unknown', 'closed'])(
    'handles a %s ACK without clearing unrelated request timeouts',
    async (ackKind) => {
      vi.useFakeTimers()
      ;(window as any).beaconCreatedClientInstance = false
      const timeoutClient = new DAppClient({
        name: 'TimeoutApp',
        storage: new LocalStorage(),
        preferredNetwork: NetworkType.MAINNET,
        requestTimeoutMs: 10
      })
      timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
      const channelClosedHandler = vi.fn()
      timeoutClient.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, channelClosedHandler)
      vi.spyOn(timeoutClient as any, 'getWalletInfo').mockResolvedValue({})

      const operationRequest = new ExposedPromise<unknown, unknown>()
      const rejection = vi.fn()
      void operationRequest.promise.catch(rejection)

      try {
        admitRequest(timeoutClient, 'acknowledged-request-id', operationRequest)

        if (ackKind === 'closed') {
          admitRequest(timeoutClient, 'closed-request-id', new ExposedPromise())
          closeRequest(timeoutClient, 'closed-request-id')
        }

        await timeoutClient['handleResponse'](
          {
            id: ackKind === 'valid' ? 'acknowledged-request-id' : `${ackKind}-request-id`,
            version: '2',
            senderId: 'wallet-sender-id',
            type: BeaconMessageType.Acknowledge
          },
          {
            origin: Origin.WALLETCONNECT,
            id: 'wallet-public-key'
          }
        )

        await vi.advanceTimersByTimeAsync(10)

        if (ackKind === 'valid') {
          expect(rejection).not.toHaveBeenCalled()
          expect(channelClosedHandler).not.toHaveBeenCalled()
          expect(timeoutClient['requestTracker'].get('acknowledged-request-id') !== undefined).toBe(
            true
          )
        } else {
          expect(rejection).toHaveBeenCalledWith(
            expect.objectContaining({
              id: 'acknowledged-request-id',
              errorType: BeaconErrorType.PEER_UNREACHABLE
            })
          )
          expect(channelClosedHandler).toHaveBeenCalledTimes(1)
          expect(timeoutClient['requestTracker'].get('acknowledged-request-id') !== undefined).toBe(
            false
          )
        }
      } finally {
        closeRequest(timeoutClient, 'acknowledged-request-id')
        vi.useRealTimers()
      }
    }
  )

  it('applies the deadline to a real request whose ID is session_update', async () => {
    vi.useFakeTimers()
    ;(window as any).beaconCreatedClientInstance = false
    const timeoutClient = new DAppClient({
      name: 'TimeoutApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      requestTimeoutMs: 10
    })
    timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    const channelClosedHandler = vi.fn()
    timeoutClient.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, channelClosedHandler)

    const sessionUpdate = new ExposedPromise<RequestResponse, ErrorResponse>()
    const rejection = vi.fn()
    void sessionUpdate.promise.catch(rejection)

    try {
      admitRequest(timeoutClient, 'session_update', sessionUpdate)

      await vi.advanceTimersByTimeAsync(10)

      expect(rejection).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'session_update',
          errorType: BeaconErrorType.PEER_UNREACHABLE
        })
      )
      expect(channelClosedHandler).toHaveBeenCalledTimes(1)
      expect(timeoutClient['requestTracker'].get('session_update') !== undefined).toBe(false)
    } finally {
      closeRequest(timeoutClient, 'session_update')
      vi.useRealTimers()
    }
  })

  describe('notification routing', () => {
    let getWalletInfo: DAppClient['getWalletInfo']
    let receive: (
      message: BeaconMessage | BeaconMessageWrapper<{ type: unknown }>,
      connectionInfo: ConnectionContext
    ) => Promise<void>
    const connectionInfo: ConnectionContext = { origin: Origin.P2P, id: 'wallet-public-key' }
    const activePeer: ExtendedP2PPairingResponse = {
      type: 'p2p-pairing-response',
      id: 'active-peer',
      publicKey: 'wallet-public-key',
      senderId: 'wallet-sender-id',
      name: 'Wallet',
      version: '3',
      relayServer: 'matrix.example.com'
    }

    beforeEach(async () => {
      vi.useFakeTimers()
      getWalletInfo = client['getWalletInfo']
      // Client declares request input; DAppClient installs a V2/V3 response handler.
      receive = client['handleResponse'] as typeof receive
      await client['storageValidated']
      await seedPeerStorage()
      client['_activePeer'] = ExposedPromise.resolve<PeerInfoType | undefined>(activePeer)
      client['_activeAccount'] = ExposedPromise.resolve<AccountInfo | undefined>(
        createStoredAccount()
      )
      await client['storage'].set(StorageKey.ACCOUNTS, [createStoredAccount()])
    })

    afterEach(() => {
      client['abortOpenRequests']()
      client['getWalletInfo'] = getWalletInfo
      vi.restoreAllMocks()
      vi.clearAllTimers()
      vi.useRealTimers()
    })

    function register(id = 'live-request', route: RequestRoute = 'Direct') {
      const pending = new ExposedPromise<
        {
          message: BeaconMessage | BeaconMessageWrapper<BeaconBaseMessage>
          connectionInfo: ConnectionContext
        },
        ErrorResponse
      >()
      const resolved = vi.fn()
      const rejected = vi.fn()
      void pending.promise.then(resolved, rejected)
      admitRequest(client, id, pending, route)
      return { pending, resolved, rejected }
    }

    function envelope(message: BeaconMessage, version: string) {
      return version === '3'
        ? { id: message.id, senderId: message.senderId, version, message }
        : message
    }

    it('aborts a real request whose ID is session_update', async () => {
      const request = register('session_update')

      client['abortOpenRequests']()
      await vi.advanceTimersByTimeAsync(0)

      expect(request.rejected).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'session_update', errorType: BeaconErrorType.ABORTED_ERROR })
      )
      expect(request.resolved).not.toHaveBeenCalled()
      expect(client['requestTracker'].size).toBe(0)
    })

    it.each([BeaconMessageType.ChangeAccountRequest, BeaconMessageType.Disconnect] as const)(
      'keeps a delegated request pending after a mismatched %s with the same ID',
      async (type) => {
        const request = register('live-request', 'LeaderProxy')
        const forwarded = vi.spyOn(client['multiTabChannel'], 'postMessage')

        await receive(
          envelope(
            {
              id: 'live-request',
              version: '2',
              senderId: activePeer.senderId,
              type,
              address: createStoredAccount().address,
              walletType: 'implicit',
              network: { type: NetworkType.MAINNET },
              scopes: [PermissionScope.SIGN]
            },
            '3'
          ),
          { ...connectionInfo, id: 'other-public-key' }
        )

        expect(forwarded).not.toHaveBeenCalled()
        expect(request.resolved).not.toHaveBeenCalled()
        expect(request.rejected).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_DEADLINE_MS)
        expect(request.rejected).toHaveBeenCalledWith(
          expect.objectContaining({ errorType: BeaconErrorType.PEER_UNREACHABLE })
        )
      }
    )

    it.each([BeaconMessageType.ChangeAccountRequest, BeaconMessageType.Disconnect] as const)(
      'handles a retained peer %s without settling the active peer request with the same ID',
      async (type) => {
        const retainedPeer: ExtendedP2PPairingResponse = {
          ...activePeer,
          id: 'retained-peer',
          publicKey: 'retained-public-key',
          senderId: 'senderId'
        }
        const retainedAccount: AccountInfo = {
          ...createStoredAccount(),
          accountIdentifier: 'retained-account',
          senderId: retainedPeer.senderId,
          origin: { type: Origin.P2P, id: retainedPeer.publicKey }
        }
        await client['storage'].set(StorageKey.ACCOUNTS, [createStoredAccount(), retainedAccount])
        const transport = new DappP2PTransport(
          'Notification test',
          { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
          client['storage'],
          {}
        )
        vi.spyOn(transport, 'getPeers').mockResolvedValue([activePeer, retainedPeer])
        const removed = vi.spyOn(transport, 'removePeer').mockResolvedValue(undefined)
        client['p2pTransport'] = transport
        const request = register()
        const closed = vi.fn()
        await client.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, closed)

        await receive(
          {
            id: 'live-request',
            version: '2',
            senderId: retainedPeer.senderId,
            type,
            address: 'tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU',
            walletType: 'implicit',
            network: { type: NetworkType.MAINNET },
            scopes: [PermissionScope.SIGN]
          },
          { origin: Origin.P2P, id: retainedPeer.publicKey }
        )

        if (type === BeaconMessageType.Disconnect) {
          expect(removed).toHaveBeenCalledWith(retainedPeer)
          expect(closed).toHaveBeenCalledTimes(1)
          await expect(client['storage'].get(StorageKey.ACCOUNTS)).resolves.toEqual([
            createStoredAccount()
          ])
        } else {
          expect(removed).not.toHaveBeenCalled()
          expect(closed).not.toHaveBeenCalled()
          await expect(client['storage'].get(StorageKey.ACCOUNTS)).resolves.toEqual([
            createStoredAccount(),
            retainedAccount
          ])
        }
        await expect(client.getActiveAccount()).resolves.toEqual(createStoredAccount())
        expect(request.resolved).not.toHaveBeenCalled()
        expect(request.rejected).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_DEADLINE_MS)
        expect(request.rejected).toHaveBeenCalledWith(
          expect.objectContaining({ errorType: BeaconErrorType.PEER_UNREACHABLE })
        )
      }
    )

    it.each([
      ['2', BeaconMessageType.ChangeAccountRequest],
      ['3', BeaconMessageType.ChangeAccountRequest],
      ['2', BeaconMessageType.Disconnect],
      ['3', BeaconMessageType.Disconnect]
    ] as const)(
      'keeps a live request pending after a V%s %s from a mismatched connection',
      async (version, type) => {
        const request = register()
        const selected = vi.spyOn(client, 'setActiveAccount')
        const closed = vi.fn()
        await client.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, closed)
        const message: BeaconMessage = {
          id: 'live-request',
          version: '2',
          senderId: activePeer.senderId,
          type,
          address: createStoredAccount().address,
          walletType: 'implicit' as const,
          network: { type: NetworkType.MAINNET },
          scopes: [PermissionScope.SIGN]
        }

        await receive(envelope(message, version), {
          ...connectionInfo,
          id: 'other-public-key'
        })

        expect(request.resolved).not.toHaveBeenCalled()
        expect(request.rejected).not.toHaveBeenCalled()
        expect(selected).not.toHaveBeenCalled()
        expect(closed).not.toHaveBeenCalled()
        await expect(client['storage'].get(StorageKey.ACCOUNTS)).resolves.toEqual([
          createStoredAccount()
        ])
        await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_DEADLINE_MS)
        expect(request.rejected).toHaveBeenCalledWith(
          expect.objectContaining({ errorType: BeaconErrorType.PEER_UNREACHABLE })
        )
      }
    )

    it.each(['2', '3'])(
      'applies a V%s account change without settling a request with the same ID',
      async (version) => {
        const request = register()
        const selected = vi.spyOn(client, 'setActiveAccount').mockResolvedValue(undefined)
        const message: BeaconMessage = {
          id: 'live-request',
          version: '2',
          senderId: activePeer.senderId,
          type: BeaconMessageType.ChangeAccountRequest,
          address: 'tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU',
          walletType: 'implicit',
          network: { type: NetworkType.MAINNET },
          scopes: [PermissionScope.SIGN]
        }

        await receive(envelope(message, version), connectionInfo)

        expect(selected).toHaveBeenCalledWith(expect.objectContaining({ address: message.address }))
        await expect(client['storage'].get(StorageKey.ACCOUNTS)).resolves.toEqual(
          expect.arrayContaining([expect.objectContaining({ address: message.address })])
        )
        expect(request.resolved).not.toHaveBeenCalled()
        expect(request.rejected).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_DEADLINE_MS)
        expect(request.rejected).toHaveBeenCalledWith(
          expect.objectContaining({ errorType: BeaconErrorType.PEER_UNREACHABLE })
        )
      }
    )

    it.each([BeaconMessageType.Acknowledge, BeaconMessageType.BlockchainResponse] as const)(
      'keeps the deadline armed while a V3 %s awaits wallet information',
      async (type) => {
        const request = register()
        await client['storage'].set(StorageKey.TRANSPORT_P2P_PEERS_DAPP, [activePeer])
        const entered = new ExposedPromise<void>()
        const wallet = new ExposedPromise<WalletInfo>()
        client['getWalletInfo'] = () => {
          entered.resolve()
          return wallet.promise
        }
        const acknowledged = vi.fn()
        await client.subscribeToEvent(BeaconEvent.ACKNOWLEDGE_RECEIVED, acknowledged)
        const message =
          type === BeaconMessageType.Acknowledge
            ? { type }
            : {
                type,
                blockchainIdentifier: 'tezos',
                blockchainData: { transactionHash: 'op-hash' }
              }
        const delivery = receive(
          {
            id: 'live-request',
            version: '3',
            senderId: activePeer.senderId,
            message
          },
          connectionInfo
        )
        await entered.promise

        await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_DEADLINE_MS)
        expect(request.rejected).toHaveBeenCalledWith(
          expect.objectContaining({ errorType: BeaconErrorType.PEER_UNREACHABLE })
        )
        wallet.resolve({ name: 'Wallet' })
        await delivery

        expect(request.resolved).not.toHaveBeenCalled()
        expect(request.rejected).toHaveBeenCalledTimes(1)
        expect(acknowledged).not.toHaveBeenCalled()
      }
    )

    it.each([BeaconMessageType.Acknowledge, BeaconMessageType.BlockchainResponse] as const)(
      'does not attach an earlier V3 %s to a request registered during wallet lookup',
      async (type) => {
        await client['storage'].set(StorageKey.TRANSPORT_P2P_PEERS_DAPP, [activePeer])
        const entered = new ExposedPromise<void>()
        const wallet = new ExposedPromise<WalletInfo>()
        client['getWalletInfo'] = () => {
          entered.resolve()
          return wallet.promise
        }
        const acknowledged = vi.fn()
        await client.subscribeToEvent(BeaconEvent.ACKNOWLEDGE_RECEIVED, acknowledged)
        const message =
          type === BeaconMessageType.Acknowledge
            ? { type }
            : {
                type,
                blockchainIdentifier: 'tezos',
                blockchainData: { transactionHash: 'op-hash' }
              }
        const delivery = receive(
          {
            id: 'live-request',
            version: '3',
            senderId: activePeer.senderId,
            message
          },
          connectionInfo
        )
        await entered.promise
        const request = register()
        wallet.resolve({ name: 'Wallet' })
        await delivery

        expect(request.resolved).not.toHaveBeenCalled()
        expect(acknowledged).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_DEADLINE_MS)
        expect(request.rejected).toHaveBeenCalledWith(
          expect.objectContaining({ errorType: BeaconErrorType.PEER_UNREACHABLE })
        )
      }
    )
  })

  it('processes buffered Disconnect delivered during transport.connect() when restoring active account on startup', async () => {
    const publicKey = '11'.repeat(32)
    const senderId = await (await import('@ecadlabs/beacon-core')).getSenderId(publicKey)
    const storedAccount = {
      ...createStoredAccount(),
      senderId,
      origin: {
        type: Origin.P2P,
        id: publicKey
      }
    }
    const p2pPeer = {
      ...createV480P2PPeer(),
      id: publicKey,
      publicKey,
      senderId
    }
    const storage = new LocalStorage({
      [StorageKey.ACTIVE_ACCOUNT]: storedAccount.accountIdentifier,
      [StorageKey.ACCOUNTS]: [storedAccount],
      [StorageKey.TRANSPORT_P2P_PEERS_DAPP]: [p2pPeer]
    })

    let storedStateClient!: DAppClient
    const p2pTransport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.NOT_CONNECTED,
      getPeers: vi.fn().mockResolvedValue([p2pPeer]),
      removePeer: vi.fn().mockResolvedValue(undefined),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockImplementation(async () => {
        p2pTransport.connectionStatus = TransportStatus.CONNECTED
        await (storedStateClient as any).handleResponse(
          {
            id: 'buffered-disconnect-id',
            version: '3',
            senderId,
            type: BeaconMessageType.Disconnect
          },
          {
            origin: Origin.P2P,
            id: publicKey
          }
        )
      })
    }

    const initInternalTransports = vi
      .spyOn(DAppClient.prototype as any, 'initInternalTransports')
      .mockImplementation(async function (this: any) {
        this.p2pTransport = p2pTransport
      })

    try {
      ;(window as any).beaconCreatedClientInstance = false
      storedStateClient = new DAppClient({
        name: 'BufferedDisconnectOnReloadApp',
        storage,
        preferredNetwork: NetworkType.MAINNET,
        disableDefaultEvents: true
      })

      await (storedStateClient as any).storageValidated

      expect(p2pTransport.connect).toHaveBeenCalledTimes(1)
      expect(p2pTransport.removePeer).toHaveBeenCalledWith(p2pPeer)
      await expect(storedStateClient.getActiveAccount()).resolves.toBeUndefined()
      await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
      await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toEqual([])
    } finally {
      initInternalTransports.mockRestore()
    }
  })

  it('removes an inactive saved peer and its accounts on a matching Disconnect without deactivating the active peer', async () => {
    const { getSenderId: mockGetSenderId } = (await import('@ecadlabs/beacon-core'))
    const pubKeyA = 'aa'.repeat(32)
    const pubKeyB = 'bb'.repeat(32)
    const senderIdA = 'sender-wallet-a'
    const senderIdB = 'sender-wallet-b'
    ;(mockGetSenderId as Mock).mockImplementation(async (pk: string) => {
      if (pk === pubKeyA) return senderIdA
      if (pk === pubKeyB) return senderIdB
      return 'senderId'
    })

    const peerA = {
      ...createV480P2PPeer(),
      id: pubKeyA,
      publicKey: pubKeyA,
      senderId: senderIdA,
      name: 'Wallet A'
    }
    const peerB = {
      ...createV480P2PPeer(),
      id: pubKeyB,
      publicKey: pubKeyB,
      senderId: senderIdB,
      name: 'Wallet B'
    }
    const accountA = {
      ...createStoredAccount(),
      accountIdentifier: 'account-a-id',
      senderId: senderIdA,
      address: 'tz1AccountAAddress111111111111111111',
      origin: {
        type: Origin.P2P,
        id: pubKeyA
      }
    }
    const accountB = {
      ...createStoredAccount(),
      accountIdentifier: 'account-b-id',
      senderId: senderIdB,
      address: 'tz1AccountBAddress222222222222222222',
      origin: {
        type: Origin.P2P,
        id: pubKeyB
      }
    }

    await (client as any).storage.set(StorageKey.ACCOUNTS, [accountA, accountB])
    await (client as any).storage.set(StorageKey.ACTIVE_ACCOUNT, accountB.accountIdentifier)
    ;(client as any)._activeAccount = ExposedPromise.resolve(accountB)
    ;(client as any)._activePeer = ExposedPromise.resolve(peerB)
    ;(client as any).p2pTransport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([peerA, peerB]),
      removePeer: vi.fn().mockResolvedValue(undefined)
    }

    try {
      await (client as any).handleResponse(
        {
          id: 'inactive-wallet-a-disconnect',
          version: '3',
          senderId: senderIdA,
          type: BeaconMessageType.Disconnect
        },
        {
          origin: Origin.P2P,
          id: pubKeyA
        }
      )

      expect((client as any).p2pTransport.removePeer).toHaveBeenCalledWith(peerA)
      await expect(client.getActiveAccount()).resolves.toEqual(accountB)
      await expect((client as any).storage.get(StorageKey.ACCOUNTS)).resolves.toEqual([accountB])
    } finally {
      ;(mockGetSenderId as Mock).mockImplementation(async (pk: string) =>
        pk === 'wallet-public-key' ? 'wallet-sender-id' : 'senderId'
      )
    }
  })

  it('ignores ChangeAccountRequest with Origin.WALLETCONNECT when another peer or session is active', async () => {
    const activeAccount = createStoredAccount()
    const activePeer = createV480P2PPeer()
    await (client as any).storage.set(StorageKey.ACCOUNTS, [activeAccount])
    await (client as any).storage.set(StorageKey.ACTIVE_ACCOUNT, activeAccount.accountIdentifier)
    ;(client as any)._activeAccount = ExposedPromise.resolve(activeAccount)
    ;(client as any)._activePeer = ExposedPromise.resolve(activePeer)
    ;(client as any).postMessageTransport = {
      type: TransportType.POST_MESSAGE,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([])
    }
    ;(client as any).p2pTransport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([activePeer])
    }
    ;(client as any).walletConnectTransport = {
      type: TransportType.WALLETCONNECT,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: vi.fn().mockResolvedValue([]),
      forceUpdate: vi.fn()
    }

    const setActiveAccountSpy = vi.spyOn(client, 'setActiveAccount')

    await (client as any).handleResponse(
      {
        id: 'wc-inactive-change-account',
        version: '3',
        senderId: 'inactive-wc-topic',
        type: BeaconMessageType.ChangeAccountRequest,
        address: 'tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU',
        publicKey: 'cc'.repeat(32),
        walletType: 'implicit',
        network: {
          type: NetworkType.MAINNET
        },
        scopes: [PermissionScope.SIGN]
      },
      {
        origin: Origin.WALLETCONNECT,
        id: 'cc'.repeat(32)
      }
    )

    expect(setActiveAccountSpy).not.toHaveBeenCalled()
    await expect(client.getActiveAccount()).resolves.toEqual(activeAccount)
    setActiveAccountSpy.mockRestore()
  })

  it('rejects an implicit account in onNewAccount when address does not match publicKey', async () => {
    const publicKey = '11'.repeat(32)
    await (client as any).storage.set(StorageKey.ACCOUNTS, [])
    const setActiveAccountSpy = vi
      .spyOn(client, 'setActiveAccount')
      .mockResolvedValue(undefined)

    try {
      await expect(
        (client as any).onNewAccount(
          {
            address: 'tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU',
            publicKey,
            walletType: 'implicit',
            network: {
              type: NetworkType.MAINNET
            },
            scopes: [PermissionScope.SIGN]
          },
          {
            origin: Origin.P2P,
            id: publicKey
          },
          'senderId'
        )
      ).rejects.toThrow(/address/i)
      expect(setActiveAccountSpy).not.toHaveBeenCalled()
    } finally {
      setActiveAccountSpy.mockRestore()
    }
  })

  it('processes buffered ChangeAccountRequest delivered during transport.connect() when restoring active account on startup', async () => {
    const publicKey = '11'.repeat(32)
    const newPublicKey = '22'.repeat(32)
    const senderId = await (await import('@ecadlabs/beacon-core')).getSenderId(publicKey)
    const storedAccount = {
      ...createStoredAccount(),
      senderId,
      origin: {
        type: Origin.P2P,
        id: publicKey
      }
    }
    const p2pPeer = {
      ...createV480P2PPeer(),
      id: publicKey,
      publicKey,
      senderId
    }
    const storage = new LocalStorage({
      [StorageKey.ACTIVE_ACCOUNT]: storedAccount.accountIdentifier,
      [StorageKey.ACCOUNTS]: [storedAccount],
      [StorageKey.TRANSPORT_P2P_PEERS_DAPP]: [p2pPeer]
    })

    let storedStateClient!: DAppClient
    const p2pTransport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.NOT_CONNECTED,
      getPeers: vi.fn().mockResolvedValue([p2pPeer]),
      removePeer: vi.fn().mockResolvedValue(undefined),
      removeAllPeers: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined),
      removeListener: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockImplementation(async () => {
        p2pTransport.connectionStatus = TransportStatus.CONNECTED
        await (storedStateClient as any).handleResponse(
          {
            id: 'buffered-change-account-id',
            version: '3',
            senderId,
            type: BeaconMessageType.ChangeAccountRequest,
            publicKey: newPublicKey,
            walletType: 'implicit',
            network: {
              type: NetworkType.MAINNET
            },
            scopes: [PermissionScope.SIGN]
          },
          {
            origin: Origin.P2P,
            id: publicKey
          }
        )
      })
    }

    const initInternalTransports = vi
      .spyOn(DAppClient.prototype as any, 'initInternalTransports')
      .mockImplementation(async function (this: any) {
        this.p2pTransport = p2pTransport
      })

    try {
      ;(window as any).beaconCreatedClientInstance = false
      storedStateClient = new DAppClient({
        name: 'BufferedChangeAccountOnReloadApp',
        storage,
        preferredNetwork: NetworkType.MAINNET,
        disableDefaultEvents: true
      })

      await (storedStateClient as any).storageValidated

      expect(p2pTransport.connect).toHaveBeenCalledTimes(1)
      const activeAccount = await storedStateClient.getActiveAccount()
      expect(activeAccount?.publicKey).not.toBe(storedAccount.publicKey)
      expect(activeAccount?.accountIdentifier).not.toBe(storedAccount.accountIdentifier)
    } finally {
      initInternalTransports.mockRestore()
    }
  })

  it('removes an inactive saved WalletConnect account on Disconnect when another transport is active and WC session was already cleared', async () => {
    const wcTopicA = 'wc-session-topic-a'
    const wcPubKeyA = 'aa'.repeat(32)
    const p2pPubKeyB = 'bb'.repeat(32)
    const senderIdB = 'sender-wallet-b'

    const wcPeerA = {
      id: wcTopicA,
      type: 'walletconnect-pairing-response' as const,
      name: 'WC Wallet A',
      publicKey: wcPubKeyA,
      version: '2',
      senderId: wcTopicA
    }
    const p2pPeerB = {
      ...createV480P2PPeer(),
      id: p2pPubKeyB,
      publicKey: p2pPubKeyB,
      senderId: senderIdB,
      name: 'P2P Wallet B'
    }
    const accountA = {
      ...createStoredAccount(),
      accountIdentifier: 'wc-account-a-id',
      senderId: wcTopicA,
      address: 'tz1WcAccountAAddress1111111111111111',
      origin: {
        type: Origin.WALLETCONNECT,
        id: wcPubKeyA
      }
    }
    const accountB = {
      ...createStoredAccount(),
      accountIdentifier: 'p2p-account-b-id',
      senderId: senderIdB,
      address: 'tz1P2pAccountBAddress222222222222222',
      origin: {
        type: Origin.P2P,
        id: p2pPubKeyB
      }
    }

    await (client as any).storage.set(StorageKey.ACCOUNTS, [accountA, accountB])
    await (client as any).storage.set(StorageKey.ACTIVE_ACCOUNT, accountB.accountIdentifier)
    await (client as any).storage.set(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP, [wcPeerA])
    ;(client as any)._activeAccount = ExposedPromise.resolve(accountB)
    ;(client as any)._activePeer = ExposedPromise.resolve(p2pPeerB)
    ;(client as any).walletConnectTransport = {
      type: TransportType.WALLETCONNECT,
      connectionStatus: TransportStatus.CONNECTED,
      // Simulates currentSession() already cleared before Disconnect handler queries getPeers()
      getPeers: vi.fn().mockResolvedValue([]),
      removePeer: vi.fn().mockResolvedValue(undefined)
    }

    await (client as any).handleResponse(
      {
        id: 'inactive-wc-disconnect',
        version: '2',
        senderId: wcTopicA,
        type: BeaconMessageType.Disconnect
      },
      {
        origin: Origin.WALLETCONNECT,
        id: wcPubKeyA
      }
    )

    await expect(client.getActiveAccount()).resolves.toEqual(accountB)
    await expect((client as any).storage.get(StorageKey.ACCOUNTS)).resolves.toEqual([accountB])
  })

  it.each(['peer', 'one', 'all'])('clears an account selected while %s removal waits for an earlier account write', async (kind) => {
    await client.getActiveAccount()
    const account = createStoredAccount()
    const storage: LocalStorage = Reflect.get(client, 'storage')
    await storage.set(StorageKey.ACCOUNTS, [account])
    const pending = new ExposedPromise<void>()
    const queued = Reflect.get(client, 'mutateAccounts').call(client, () => pending.promise)
    const removed = kind === 'peer'
      ? Reflect.get(client, 'removeAccountsForPeerIds').call(client, [account.senderId])
      : kind === 'one' ? client.removeAccount(account.accountIdentifier) : client.removeAllAccounts()
    vi.spyOn(client, 'initInternalTransports').mockResolvedValue(undefined)
    vi.spyOn(Reflect.get(client, 'accountManager'), 'getAccount').mockResolvedValue(account)
    await client.setActiveAccount(account)
    pending.resolve()
    await Promise.all([queued, removed])
    expect((await client.getAccounts()) ?? []).toEqual([])
    expect(await storage.get(StorageKey.ACTIVE_ACCOUNT)).toBeUndefined()
    expect(await client.getActiveAccount()).toBeUndefined()
  })

  it.each(['lookup', 'write'])('does not restore durable accounts after removal during %s', async (stage) => {
    const storage: LocalStorage = Reflect.get(client, 'storage')
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    await client.getActiveAccount()
    const get = storage.get.bind(storage)
    const set = storage.set.bind(storage)
    vi.spyOn(storage, 'get').mockImplementation(async (key) => {
      if (stage === 'lookup' && key === StorageKey.LAST_SELECTED_WALLET) { entered.resolve(); await release.promise }
      const result = await get(key)
      return key === StorageKey.ACCOUNTS ? result ?? [] : result
    })
    if (stage === 'write') {
      vi.spyOn(storage, 'set').mockImplementation(async (key, value) => {
        if (key === StorageKey.ACCOUNTS && Array.isArray(value) && value.length > 0) {
          entered.resolve(); await release.promise
        }
        return set(key, value)
      })
    }
    const change = Reflect.get(client, 'onNewAccount').call(client, {
      id: 'permission', version: '2', senderId: 'wallet-sender-id',
      type: BeaconMessageType.PermissionResponse,
      address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
      network: { type: NetworkType.MAINNET }, scopes: [PermissionScope.SIGN]
    }, { origin: Origin.P2P, id: 'wallet-public-key' })
    await entered.promise
    const removed = client.removeAllAccounts()
    // Let cleanup reach storage while the earlier operation remains held.
    for (let i = 0; i < 30; i++) await Promise.resolve()
    release.resolve()
    await Promise.all([change, removed])
    expect(await storage.get(StorageKey.ACCOUNTS)).toEqual([])
    expect(await storage.get(StorageKey.ACTIVE_ACCOUNT)).toBeUndefined()
    expect(await client.getActiveAccount()).toBeUndefined()
  })

  it('does not overwrite active account when a peer switch occurs while ChangeAccountRequest is awaiting storage in onNewAccount', async () => {
    const { getSenderId: mockGetSenderId } = (await import('@ecadlabs/beacon-core'))
    const pubKeyA = 'aa'.repeat(32)
    const pubKeyB = 'bb'.repeat(32)
    const senderIdA = 'sender-wallet-a'
    const senderIdB = 'sender-wallet-b'
    ;(mockGetSenderId as Mock).mockImplementation(async (pk: string) => {
      if (pk === pubKeyA) return senderIdA
      if (pk === pubKeyB) return senderIdB
      return 'senderId'
    })

    const peerA = {
      ...createV480P2PPeer(),
      id: pubKeyA,
      publicKey: pubKeyA,
      senderId: senderIdA,
      name: 'Wallet A'
    }
    const peerB = {
      ...createV480P2PPeer(),
      id: pubKeyB,
      publicKey: pubKeyB,
      senderId: senderIdB,
      name: 'Wallet B'
    }
    const accountA = {
      ...createStoredAccount(),
      accountIdentifier: 'account-a-id',
      senderId: senderIdA,
      origin: {
        type: Origin.P2P,
        id: pubKeyA
      }
    }
    const accountB = {
      ...createStoredAccount(),
      accountIdentifier: 'account-b-id',
      senderId: senderIdB,
      origin: {
        type: Origin.P2P,
        id: pubKeyB
      }
    }

    await (client as any).storage.set(StorageKey.ACCOUNTS, [accountA, accountB])
    await (client as any).storage.set(StorageKey.ACTIVE_ACCOUNT, accountA.accountIdentifier)
    ;(client as any)._activeAccount = ExposedPromise.resolve(accountA)
    ;(client as any)._activePeer = ExposedPromise.resolve(peerA)

    let releaseAddAccount!: () => void
    const entered = new ExposedPromise<void>()
    const originalAddAccount = (client as any).accountManager.addAccount.bind(
      (client as any).accountManager
    )
    const addAccountSpy = vi
      .spyOn((client as any).accountManager, 'addAccount')
      .mockImplementationOnce(async (account: any) => {
        await new Promise<void>((resolve) => {
          releaseAddAccount = resolve
          entered.resolve()
        })
        return originalAddAccount(account)
      })
    const initTransportsSpy = vi
      .spyOn(client as any, 'initInternalTransports')
      .mockResolvedValue(undefined)

    try {
      const changePromise = (client as any).handleResponse(
        {
          id: 'overlapping-change-account',
          version: '3',
          senderId: senderIdA,
          type: BeaconMessageType.ChangeAccountRequest,
          publicKey: pubKeyA,
          walletType: 'implicit',
          network: {
            type: NetworkType.MAINNET
          },
          scopes: [PermissionScope.SIGN]
        },
        {
          origin: Origin.P2P,
          id: pubKeyA
        }
      )

      await entered.promise

      // User switches to Wallet B while Wallet A's ChangeAccountRequest is paused in addAccount
      ;(client as any)._activePeer = ExposedPromise.resolve(peerB)
      ;(client as any)._activeAccount = ExposedPromise.resolve(accountB)
      await (client as any).storage.set(StorageKey.ACTIVE_ACCOUNT, accountB.accountIdentifier)

      releaseAddAccount()
      await changePromise

      await expect(client.getActiveAccount()).resolves.toEqual(accountB)
      expect(await client.getAccounts()).toEqual([accountA, accountB])
      expect(await Reflect.get(client, 'storage').get(StorageKey.ACTIVE_ACCOUNT)).toBe(accountB.accountIdentifier)
    } finally {
      addAccountSpy.mockRestore()
      initTransportsSpy.mockRestore()
      ;(mockGetSenderId as Mock).mockImplementation(async (pk: string) =>
        pk === 'wallet-public-key' ? 'wallet-sender-id' : 'senderId'
      )
    }
  })

  it('does not let an earlier ChangeAccountRequest from the same peer overwrite a newer one when addAccount completes out of order', async () => {
    const wcPubKey = 'cc'.repeat(32)
    const wcTopic = 'wc-active-topic'
    const wcPeer = {
      id: wcPubKey,
      type: 'walletconnect-pairing-response' as const,
      name: 'WC Wallet',
      publicKey: wcPubKey,
      version: 'first',
      senderId: wcTopic,
      extensionId: 'WC Wallet'
    }
    const initialAccount = {
      ...createStoredAccount(),
      accountIdentifier: 'wc-initial-id',
      senderId: wcTopic,
      address: 'tz1InitialWcAddress11111111111111111',
      origin: {
        type: Origin.WALLETCONNECT,
        id: wcPubKey
      }
    }

    await (client as any).storage.set(StorageKey.ACCOUNTS, [initialAccount])
    await (client as any).storage.set(StorageKey.ACTIVE_ACCOUNT, initialAccount.accountIdentifier)
    ;(client as any)._activeAccount = ExposedPromise.resolve(initialAccount)
    ;(client as any)._activePeer = ExposedPromise.resolve(wcPeer)

    let releaseFirstAdd!: () => void
    const entered = new ExposedPromise<void>()
    const originalAddAccount = (client as any).accountManager.addAccount.bind(
      (client as any).accountManager
    )
    const addAccountSpy = vi
      .spyOn((client as any).accountManager, 'addAccount')
      .mockImplementationOnce(async (account: any) => {
        await new Promise<void>((resolve) => {
          releaseFirstAdd = resolve
          entered.resolve()
        })
        return originalAddAccount(account)
      })
    const initTransportsSpy = vi
      .spyOn(client as any, 'initInternalTransports')
      .mockResolvedValue(undefined)
    const getPeerSpy = vi.spyOn(client as any, 'getPeer').mockResolvedValue(wcPeer)

    try {
      const firstChange = (client as any).handleResponse(
        {
          id: 'wc-change-1',
          version: '2',
          senderId: wcTopic,
          type: BeaconMessageType.ChangeAccountRequest,
          address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
          walletType: 'implicit',
          network: {
            type: NetworkType.MAINNET
          },
          scopes: [PermissionScope.SIGN]
        },
        {
          origin: Origin.WALLETCONNECT,
          id: wcPubKey
        }
      )

      await entered.promise

      const secondChange = (client as any).handleResponse(
        {
          id: 'wc-change-2',
          version: '2',
          senderId: wcTopic,
          type: BeaconMessageType.ChangeAccountRequest,
          address: 'tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6',
          walletType: 'implicit',
          network: {
            type: NetworkType.MAINNET
          },
          scopes: [PermissionScope.SIGN]
        },
        {
          origin: Origin.WALLETCONNECT,
          id: wcPubKey
        }
      )

      // Release the older write before awaiting its serialized successor.
      releaseFirstAdd()
      await Promise.all([firstChange, secondChange])

      await expect(client.getActiveAccount()).resolves.toEqual(
        expect.objectContaining({
          address: 'tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6'
        })
      )
    } finally {
      addAccountSpy.mockRestore()
      initTransportsSpy.mockRestore()
      getPeerSpy.mockRestore()
    }
  })

  it('does not overwrite active account if user switches account during setActiveAccount pre-commit awaits', async () => {
    const { getSenderId: mockGetSenderId } = (await import('@ecadlabs/beacon-core'))
    const pubKeyA = 'aa'.repeat(32)
    const pubKeyB = 'bb'.repeat(32)
    const senderIdA = 'sender-wallet-a'
    const senderIdB = 'sender-wallet-b'
    ;(mockGetSenderId as Mock).mockImplementation(async (pk: string) => {
      if (pk === pubKeyA) return senderIdA
      if (pk === pubKeyB) return senderIdB
      return 'senderId'
    })

    const peerA = {
      ...createV480P2PPeer(),
      id: pubKeyA,
      publicKey: pubKeyA,
      senderId: senderIdA,
      name: 'Wallet A'
    }
    const peerB = {
      ...createV480P2PPeer(),
      id: pubKeyB,
      publicKey: pubKeyB,
      senderId: senderIdB,
      name: 'Wallet B'
    }
    const accountA = {
      ...createStoredAccount(),
      accountIdentifier: 'account-a-id',
      senderId: senderIdA,
      origin: {
        type: Origin.P2P,
        id: pubKeyA
      }
    }
    const accountB = {
      ...createStoredAccount(),
      accountIdentifier: 'account-b-id',
      senderId: senderIdB,
      address: 'tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6',
      origin: {
        type: Origin.P2P,
        id: pubKeyB
      }
    }

    await (client as any).storage.set(StorageKey.ACCOUNTS, [accountA, accountB])
    await (client as any).storage.set(StorageKey.ACTIVE_ACCOUNT, accountA.accountIdentifier)
    ;(client as any)._activeAccount = ExposedPromise.resolve(accountA)
    ;(client as any)._activePeer = ExposedPromise.resolve(peerA)

    let releaseInvalidStateCheck!: () => void
    const entered = new ExposedPromise<void>()
    const invalidStateSpy = vi
      .spyOn(client as any, 'resetDisconnectedWalletConnectSelection')
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseInvalidStateCheck = resolve
          entered.resolve()
        })
        return false
      })
    const initTransportsSpy = vi
      .spyOn(client as any, 'initInternalTransports')
      .mockResolvedValue(undefined)

    try {
      const changePromise = (client as any).handleResponse(
        {
          id: 'change-during-invalid-state-await',
          version: '3',
          senderId: senderIdA,
          type: BeaconMessageType.ChangeAccountRequest,
          address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
          walletType: 'implicit',
          network: {
            type: NetworkType.MAINNET
          },
          scopes: [PermissionScope.SIGN]
        },
        {
          origin: Origin.P2P,
          id: pubKeyA
        }
      )

      await entered.promise

      // User explicitly selects accountB while ChangeAccountRequest is inside setActiveAccount before _activeAccount mutation
      await client.setActiveAccount(accountB)
      ;(client as any)._activePeer = ExposedPromise.resolve(peerB)

      releaseInvalidStateCheck()
      await changePromise

      await expect(client.getActiveAccount()).resolves.toEqual(accountB)
    } finally {
      invalidStateSpy.mockRestore()
      initTransportsSpy.mockRestore()
      ;(mockGetSenderId as Mock).mockImplementation(async (pk: string) =>
        pk === 'wallet-public-key' ? 'wallet-sender-id' : 'senderId'
      )
    }
  })

  it('does not re-activate an account when ChangeAccountRequest arrives while disconnect is in flight', async () => {
    const { getSenderId: mockGetSenderId } = (await import('@ecadlabs/beacon-core'))
    const pubKeyA = 'aa'.repeat(32)
    const senderIdA = 'sender-wallet-a'
    ;(mockGetSenderId as Mock).mockImplementation(async (pk: string) =>
      pk === pubKeyA ? senderIdA : 'senderId'
    )

    const peerA = {
      ...createV480P2PPeer(),
      id: pubKeyA,
      publicKey: pubKeyA,
      senderId: senderIdA,
      name: 'Wallet A'
    }
    const accountA = {
      ...createStoredAccount(),
      accountIdentifier: 'account-a-id',
      senderId: senderIdA,
      origin: {
        type: Origin.P2P,
        id: pubKeyA
      }
    }

    await (client as any).storage.set(StorageKey.ACCOUNTS, [accountA])
    await (client as any).storage.set(StorageKey.ACTIVE_ACCOUNT, accountA.accountIdentifier)
    ;(client as any)._activeAccount = ExposedPromise.resolve(accountA)
    ;(client as any)._activePeer = ExposedPromise.resolve(peerA)

    let releaseDisconnect!: () => void
    const disconnectSpy = vi
      .spyOn(client as any, 'removeAllPeersFromTransports')
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseDisconnect = resolve
        })
      })
    const initTransportsSpy = vi
      .spyOn(client as any, 'initInternalTransports')
      .mockResolvedValue(undefined)

    try {
      const disconnectPromise = client.disconnect()
      for (let i = 0; i < 15 && !releaseDisconnect; i++) {
        await Promise.resolve()
      }
      expect(releaseDisconnect).toBeDefined()

      // ChangeAccountRequest arrives while disconnect() is already in flight and _activePeer has not been cleared yet
      const changePromise = (client as any).handleResponse(
        {
          id: 'change-during-in-flight-disconnect',
          version: '3',
          senderId: senderIdA,
          type: BeaconMessageType.ChangeAccountRequest,
          address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
          walletType: 'implicit',
          network: {
            type: NetworkType.MAINNET
          },
          scopes: [PermissionScope.SIGN]
        },
        {
          origin: Origin.P2P,
          id: pubKeyA
        }
      )

      releaseDisconnect()
      await Promise.all([disconnectPromise, changePromise])

      await expect(client.getActiveAccount()).resolves.toBeUndefined()
    } finally {
      disconnectSpy.mockRestore()
      initTransportsSpy.mockRestore()
      ;(mockGetSenderId as Mock).mockImplementation(async (pk: string) =>
        pk === 'wallet-public-key' ? 'wallet-sender-id' : 'senderId'
      )
    }
  })

  it('does not overwrite a newer active peer when setActivePeer awaits initInternalTransports', async () => {
    const peerA = {
      ...createV480P2PPeer(),
      id: 'peer-a',
      publicKey: 'aa'.repeat(32),
      senderId: 'sender-a',
      name: 'Wallet A'
    }
    const peerB = {
      ...createV480P2PPeer(),
      id: 'peer-b',
      publicKey: 'bb'.repeat(32),
      senderId: 'sender-b',
      name: 'Wallet B'
    }

    let releaseInit!: () => void
    const initTransportsSpy = vi
      .spyOn(client as any, 'initInternalTransports')
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseInit = resolve
        })
      })
      .mockResolvedValue(undefined)
    const setTransportSpy = vi.spyOn(client as any, 'setTransport').mockResolvedValue(undefined)

    try {
      const firstSetPeer = (client as any).setActivePeer(peerA)
      for (let i = 0; i < 10 && !releaseInit; i++) {
        await Promise.resolve()
      }
      expect(releaseInit).toBeDefined()

      // Superseding account transition and active peer selection happens before initInternalTransports resolves
      ;(client as any).beginAccountTransition()
      await (client as any).setActivePeer(peerB)

      releaseInit()
      await firstSetPeer

      const resolvedPeer = await (client as any)._activePeer.promise
      expect(resolvedPeer).toEqual(peerB)
    } finally {
      initTransportsSpy.mockRestore()
      setTransportSpy.mockRestore()
    }
  })

  const delayedStartup = async () => {
    const account = createStoredAccount()
    const storage = new LocalStorage()
    await storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
    await storage.set(StorageKey.ACCOUNTS, [account])
    await storage.set(StorageKey.PERMISSION_LIST, [createV480Permission()])
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    const transport = new DappP2PTransport(
      'Delayed startup',
      { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
      storage,
      {}
    )
    vi.spyOn(transport, 'connect').mockImplementation(async () => {
      entered.resolve()
      await release.promise
    })
    vi.spyOn(transport, 'getPeers').mockResolvedValue([
      { ...createV480P2PPeer(), type: 'p2p-pairing-response' }
    ])
    vi.spyOn(transport, 'removeAllPeers').mockResolvedValue(undefined)
    vi.spyOn(transport, 'disconnect').mockResolvedValue(undefined)
    vi.spyOn(transport, 'removePeer').mockResolvedValue(undefined)
    let incoming: Parameters<DappP2PTransport['addListener']>[0] | undefined
    vi.spyOn(transport, 'addListener').mockImplementation(async (listener) => {
      incoming = listener
    })
    const selected = vi.fn()
    class StartupClient extends DAppClient {
      public async initInternalTransports(): Promise<void> {
        this.p2pTransport = transport
        await this.addListener(transport)
      }
      public hasSelectedTransport(): boolean {
        return this._transport.isResolved()
      }
      public selectedTransport() {
        return this.transport
      }
    }
    Reflect.set(window, 'beaconCreatedClientInstance', false)
    const startupClient = new StartupClient({
      name: 'Delayed startup',
      storage,
      disableDefaultEvents: true,
      eventHandlers: { [BeaconEvent.ACTIVE_ACCOUNT_SET]: { handler: selected } }
    })
    await entered.promise
    const startup: unknown = Reflect.get(startupClient, 'activeAccountLoaded')
    if (!(startup instanceof Promise)) {
      throw new Error('Missing startup completion promise')
    }
    const receiveDisconnect = async (): Promise<void> => {
      if (!incoming) {
        throw new Error('Expected the public transport message subscription')
      }
      const { Serializer } =
        await vi.importActual<typeof import('@ecadlabs/beacon-core')>('@ecadlabs/beacon-core')
      await incoming(
        await new Serializer().serialize({
          id: 'peer-disconnect',
          version: '2',
          senderId: account.senderId,
          type: BeaconMessageType.Disconnect
        }),
        { origin: Origin.P2P, id: account.origin.id }
      )
    }
    return {
      startupClient,
      storage,
      account,
      selected,
      release,
      startup,
      transport,
      receiveDisconnect
    }
  }

  const holdNextConnection = (transport: DappP2PTransport) => {
    const entered = new ExposedPromise<void>()
    const prepared = new ExposedPromise<void>()
    vi.spyOn(transport, 'connect').mockImplementationOnce(async () => {
      entered.resolve()
      await prepared.promise
    })
    return { entered, prepared }
  }

  it.each(['account', 'peer'])(
    'cancels a pending local selection removed through its %s without blocking a later choice',
    async (removal) => {
      const { startupClient, storage, account, selected, release, transport, receiveDisconnect } =
        await delayedStartup()
      await startupClient.clearActiveAccount()
      release.resolve()
      selected.mockClear()
      const { entered, prepared } = holdNextConnection(transport)
      const selection = startupClient.setActiveAccount(account)
      await entered.promise
      try {
        if (removal === 'account') {
          await startupClient.removeAccount(account.accountIdentifier)
        } else {
          await receiveDisconnect()
        }
        prepared.resolve()
        await selection
        await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
        await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
        await expect(startupClient.getAccounts()).resolves.toEqual([])
        expect(selected).not.toHaveBeenCalledWith(account, undefined)

        await startupClient.setActiveAccount(account)
        await expect(startupClient.getActiveAccount()).resolves.toEqual(account)
        await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(
          account.accountIdentifier
        )
      } finally {
        prepared.resolve()
        await selection
      }
    }
  )

  it.each(['account', 'peer'])(
    'preserves a pending replacement when its previous active %s is removed',
    async (removal) => {
      const { startupClient, storage, account, release, transport, receiveDisconnect } =
        await delayedStartup()
      release.resolve()
      await startupClient.setActiveAccount(account)
      const newer = { ...account, accountIdentifier: 'replacement', senderId: 'replacement-peer' }
      await storage.set(StorageKey.ACCOUNTS, [account, newer])
      const { entered, prepared } = holdNextConnection(transport)
      const selection = startupClient.setActiveAccount(newer)
      await entered.promise
      try {
        if (removal === 'account') {
          await startupClient.removeAccount(account.accountIdentifier)
        } else {
          await receiveDisconnect()
        }
        await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
        await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
        prepared.resolve()
        await selection
        await expect(startupClient.getActiveAccount()).resolves.toEqual(newer)
        await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(newer.accountIdentifier)
      } finally {
        prepared.resolve()
        await selection
      }
    }
  )

  it.each(['account', 'peer'])(
    'does not clear a replacement committed while the previous %s removal is delayed',
    async (removal) => {
      const { startupClient, storage, account, release, transport, receiveDisconnect } =
        await delayedStartup()
      release.resolve()
      await startupClient.setActiveAccount(account)
      const newer = { ...account, accountIdentifier: 'replacement', senderId: 'replacement-peer' }
      await storage.set(StorageKey.ACCOUNTS, [account, newer])
      const { entered, prepared } = holdNextConnection(transport)
      const deleting = new ExposedPromise<void>()
      const deleted = new ExposedPromise<void>()
      const set = storage.set.bind(storage)
      vi.spyOn(storage, 'set').mockImplementation(async (key, value) => {
        if (key === StorageKey.ACCOUNTS) {
          deleting.resolve()
          await deleted.promise
        }
        await set(key, value)
      })
      const selection = startupClient.setActiveAccount(newer)
      await entered.promise
      const removing =
        removal === 'account'
          ? startupClient.removeAccount(account.accountIdentifier)
          : receiveDisconnect()
      await deleting.promise
      try {
        prepared.resolve()
        await selection
        deleted.resolve()
        await removing
        await expect(startupClient.getActiveAccount()).resolves.toEqual(newer)
        await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(newer.accountIdentifier)
        await expect(startupClient.getAccounts()).resolves.toEqual([newer])
      } finally {
        prepared.resolve()
        deleted.resolve()
        await Promise.all([selection, removing])
      }
    }
  )

  it.each(['account', 'peer'])(
    'retains a different committed account when its pending replacement %s is removed',
    async (removal) => {
      const { startupClient, storage, account, release, transport, receiveDisconnect } =
        await delayedStartup()
      release.resolve()
      const retained = { ...account, accountIdentifier: 'retained', senderId: 'retained-peer' }
      await startupClient.setActiveAccount(retained)
      const { entered, prepared } = holdNextConnection(transport)
      const selection = startupClient.setActiveAccount(account)
      await entered.promise
      try {
        if (removal === 'account') {
          await startupClient.removeAccount(account.accountIdentifier)
        } else {
          await receiveDisconnect()
        }
        prepared.resolve()
        await selection
        await expect(startupClient.getActiveAccount()).resolves.toEqual(retained)
        await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(
          retained.accountIdentifier
        )
      } finally {
        prepared.resolve()
        await selection
      }
    }
  )

  it.each(['account', 'peer'])(
    'preserves a replacement committed during its previous %s pointer lookup',
    async (removal) => {
      const { startupClient, storage, account, release, transport, receiveDisconnect } =
        await delayedStartup()
      release.resolve()
      await startupClient.setActiveAccount(account)
      const newer = { ...account, accountIdentifier: 'replacement', senderId: 'replacement-peer' }
      await storage.set(StorageKey.ACCOUNTS, [account, newer])
      const { entered, prepared } = holdNextConnection(transport)
      const lookupEntered = new ExposedPromise<void>()
      const lookupFinished = new ExposedPromise<void>()
      const get = storage.get.bind(storage)
      let holdPointer = true
      vi.spyOn(storage, 'get').mockImplementation(async (key) => {
        const value = await get(key)
        if (key === StorageKey.ACTIVE_ACCOUNT && holdPointer) {
          holdPointer = false
          lookupEntered.resolve()
          await lookupFinished.promise
        }
        return value
      })
      const selection = startupClient.setActiveAccount(newer)
      await entered.promise
      const removing =
        removal === 'account'
          ? startupClient.removeAccount(account.accountIdentifier)
          : receiveDisconnect()
      await lookupEntered.promise
      try {
        prepared.resolve()
        await selection
        lookupFinished.resolve()
        await removing
        await expect(startupClient.getActiveAccount()).resolves.toEqual(newer)
        await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(newer.accountIdentifier)
        await expect(startupClient.getAccounts()).resolves.toEqual([newer])
      } finally {
        prepared.resolve()
        lookupFinished.resolve()
        await Promise.all([selection, removing])
      }
    }
  )

  it('keeps a pending local selection when an unrelated account is removed', async () => {
    const { startupClient, storage, account, release, transport } = await delayedStartup()
    await startupClient.clearActiveAccount()
    release.resolve()
    const unrelated = { ...account, accountIdentifier: 'unrelated', senderId: 'unrelated-peer' }
    await storage.set(StorageKey.ACCOUNTS, [account, unrelated])
    const { entered, prepared } = holdNextConnection(transport)
    const selection = startupClient.setActiveAccount(account)
    await entered.promise
    try {
      await startupClient.removeAccount(unrelated.accountIdentifier)
      prepared.resolve()
      await selection
      await expect(startupClient.getActiveAccount()).resolves.toEqual(account)
      await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(account.accountIdentifier)
      await expect(startupClient.getAccounts()).resolves.toEqual([account])
    } finally {
      prepared.resolve()
      await selection
    }
  })

  it.each(['account', 'peer'])(
    'keeps a newer account selection when an older %s removal completes',
    async (removal) => {
      const { startupClient, storage, account, release, receiveDisconnect } = await delayedStartup()
      release.resolve()
      await startupClient.getActiveAccount()
      const newer = { ...account, accountIdentifier: 'newer', senderId: 'newer-peer' }
      await storage.set(StorageKey.ACCOUNTS, [account, newer])
      const entered = new ExposedPromise<void>()
      const removed = new ExposedPromise<void>()
      const set = storage.set.bind(storage)
      vi.spyOn(storage, 'set').mockImplementation(async (key, value) => {
        if (key === StorageKey.ACCOUNTS) {
          entered.resolve()
          await removed.promise
        }
        await set(key, value)
      })
      const removing =
        removal === 'account'
          ? startupClient.removeAccount(account.accountIdentifier)
          : receiveDisconnect()
      await entered.promise
      try {
        await startupClient.setActiveAccount(newer)
        removed.resolve()
        await removing
        await expect(startupClient.getActiveAccount()).resolves.toEqual(newer)
        await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(newer.accountIdentifier)
        await expect(startupClient.getAccounts()).resolves.toEqual([newer])
      } finally {
        removed.resolve()
        await removing
      }
    }
  )

  it('clears a stored selection when its peer disconnects during pending startup', async () => {
    const { startupClient, storage, release, receiveDisconnect } = await delayedStartup()
    const read = startupClient.getActiveAccount()
    try {
      await receiveDisconnect()
      await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
      await expect(startupClient.getAccounts()).resolves.toEqual([])
      await expect(read).resolves.toBeUndefined()
    } finally {
      release.resolve()
    }
  })

  it('settles an existing account read when account-list recovery repairs pending startup', async () => {
    const { startupClient, storage, release } = await delayedStartup()
    const settled = vi.fn()
    const read = startupClient.getActiveAccount().then(settled)
    try {
      await storage.set(StorageKey.ACCOUNTS, [])
      if (!storageChangedCallback) {
        throw new Error('Expected the storage change subscription')
      }
      await storageChangedCallback({
        eventType: 'entryModified',
        key: StorageKey.ACCOUNTS,
        oldValue: '[{}]',
        newValue: '[]'
      })
      expect(settled).toHaveBeenCalledWith(undefined)
      await read
      await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    } finally {
      release.resolve()
    }
  })

  it('settles an existing account read when a delayed startup lookup requires invalid-state reset', async () => {
    const lookup = new ExposedPromise<void>()
    const entered = new ExposedPromise<void>()
    const reset = new ExposedPromise<void>()
    class FailingStartupStorage extends LocalStorage {
      private firstLookup = true
      public get<K extends StorageKey>(key: K): Promise<StorageKeyReturnType[K]> {
        if (key === StorageKey.ACTIVE_ACCOUNT && this.firstLookup) {
          this.firstLookup = false
          entered.resolve()
          return lookup.promise.then(() => super.get(key))
        }
        return super.get(key)
      }
    }
    const storage = new FailingStartupStorage()
    const resettingClient = new DAppClient({
      name: 'Failed startup lookup',
      storage,
      disableDefaultEvents: true,
      eventHandlers: {
        [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: { handler: () => reset.resolve() }
      }
    })
    await entered.promise
    const settled = vi.fn()
    const read = resettingClient.getActiveAccount().then(settled)
    lookup.reject(new Error('Storage read failed'))
    await reset.promise
    expect(settled).toHaveBeenCalledWith(undefined)
    await read
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    await expect(resettingClient.getAccounts()).resolves.toEqual([])
  })

  it('does not restore a disconnected account when an older startup connection completes', async () => {
    const { startupClient, storage, selected, release, startup, account } = await delayedStartup()
    await startupClient.disconnect({ notifyPeers: false })
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    selected.mockClear()
    release.resolve()
    await expect(startup).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    expect(startupClient.hasSelectedTransport()).toBe(false)
    expect(selected).not.toHaveBeenCalledWith(account, undefined)
  })

  it('restores a valid account without rewriting the shared account pointer', async () => {
    const { startupClient, storage, selected, release, startup, account } = await delayedStartup()
    const write = vi.spyOn(storage, 'set')
    release.resolve()
    await expect(startup).resolves.toEqual(account)
    await expect(startupClient.getActiveAccount()).resolves.toEqual(account)
    expect(write).not.toHaveBeenCalledWith(StorageKey.ACTIVE_ACCOUNT, expect.anything())
    expect(selected).toHaveBeenCalledWith(account, undefined)
  })

  it('invalidates pending startup even when clearActiveAccount is repeated', async () => {
    const { startupClient, storage, release, startup } = await delayedStartup()
    await startupClient.clearActiveAccount()
    await startupClient.clearActiveAccount()
    release.resolve()
    await expect(startup).resolves.toBeUndefined()
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    expect(startupClient.hasSelectedTransport()).toBe(false)
  })

  it('handles a storage clear event while startup is pending', async () => {
    const { startupClient, storage, release, startup } = await delayedStartup()
    await storage.delete(StorageKey.ACTIVE_ACCOUNT)
    await storageChangedCallback?.({
      eventType: 'storageCleared',
      key: null,
      oldValue: null,
      newValue: null
    })
    release.resolve()
    await expect(startup).resolves.toBeUndefined()
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    expect(startupClient.hasSelectedTransport()).toBe(false)
  })

  it.each(['pointer', 'membership'])(
    'rejects a startup snapshot after its %s changes without an event',
    async (changed) => {
      const { startupClient, storage, release, startup } = await delayedStartup()
      if (changed === 'pointer') {
        await storage.delete(StorageKey.ACTIVE_ACCOUNT)
      } else {
        await storage.set(StorageKey.ACCOUNTS, [])
      }
      const write = vi.spyOn(storage, 'set')
      release.resolve()
      await expect(startup).resolves.toBeUndefined()
      await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
      expect(startupClient.hasSelectedTransport()).toBe(false)
      expect(write).not.toHaveBeenCalledWith(StorageKey.ACTIVE_ACCOUNT, expect.anything())
    }
  )

  it('does not publish an older startup selection after a newer explicit selection', async () => {
    const { startupClient, storage, release, startup, account } = await delayedStartup()
    const newer = { ...account, accountIdentifier: 'newer-account' }
    const selection = startupClient.setActiveAccount(newer)
    release.resolve()
    await selection
    await expect(startup).resolves.toBeUndefined()
    await expect(startupClient.getActiveAccount()).resolves.toEqual(newer)
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(newer.accountIdentifier)
  })

  it('allows a new intentional selection after disconnect cancels startup', async () => {
    const { startupClient, storage, release, startup, account } = await delayedStartup()
    await startupClient.disconnect({ notifyPeers: false })
    release.resolve()
    await startup
    await startupClient.setActiveAccount(account)
    await expect(startupClient.getActiveAccount()).resolves.toEqual(account)
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(account.accountIdentifier)
    expect(startupClient.hasSelectedTransport()).toBe(true)
  })

  it('does not publish startup state after destroy', async () => {
    const { startupClient, storage, release, startup, selected } = await delayedStartup()
    await startupClient.destroy()
    const write = vi.spyOn(storage, 'set')
    selected.mockClear()
    release.resolve()
    await expect(startup).resolves.toBeUndefined()
    expect(write).not.toHaveBeenCalledWith(StorageKey.ACTIVE_ACCOUNT, expect.anything())
    expect(selected).not.toHaveBeenCalled()
    expect(startupClient.hasSelectedTransport()).toBe(false)
  })

  it('cancels pending startup on a broadcast disconnect before transport selection', async () => {
    const { startupClient, storage, release, startup } = await delayedStartup()
    expect(startupClient.hasSelectedTransport()).toBe(false)
    if (!mockBroadcastMessage) {
      throw new Error('Missing broadcast subscription')
    }
    await mockBroadcastMessage({ type: 'DISCONNECT' })
    release.resolve()
    await expect(startup).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    expect(startupClient.hasSelectedTransport()).toBe(false)
  })

  it('orders a clear after an explicit account write already in progress', async () => {
    const { startupClient, storage, release, startup, account } = await delayedStartup()
    await startupClient.clearActiveAccount()
    release.resolve()
    await startup
    const entered = new ExposedPromise<void>()
    const commit = new ExposedPromise<void>()
    const write = storage.set.bind(storage)
    vi.spyOn(storage, 'set').mockImplementation(async (key, value) => {
      if (key === StorageKey.ACTIVE_ACCOUNT) {
        entered.resolve()
        await commit.promise
      }
      await write(key, value)
    })
    const selection = startupClient.setActiveAccount(account)
    await entered.promise
    const clear = startupClient.clearActiveAccount()
    commit.resolve()
    await Promise.all([selection, clear])
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
  })

  it('does not create transports after disconnect supersedes slow seed loading', async () => {
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    class SlowSeedStorage extends LocalStorage {
      public holdSeed = false
      public async get<K extends StorageKey>(key: K) {
        if (this.holdSeed && key === StorageKey.BEACON_SDK_SECRET_SEED) {
          entered.resolve()
          await release.promise
        }
        return super.get(key)
      }
    }
    class ResourceClient extends DAppClient {
      public hasInitializedTransports(): boolean {
        return Boolean(
          this.postMessageTransport || this.p2pTransport || this.walletConnectTransport
        )
      }
    }
    const storage = new SlowSeedStorage()
    Reflect.set(window, 'beaconCreatedClientInstance', false)
    const resourceClient = new ResourceClient({
      name: 'Slow seed',
      storage,
      disableDefaultEvents: true
    })
    await resourceClient.getActiveAccount()
    await resourceClient.beaconId
    storage.holdSeed = true
    const initialization = resourceClient.initInternalTransports()
    await entered.promise
    await resourceClient.disconnect({ notifyPeers: false })
    release.resolve()
    await initialization
    expect(resourceClient.hasInitializedTransports()).toBe(false)
    await expect(resourceClient.getActiveAccount()).resolves.toBeUndefined()
  })
  it('cancels an init waiting for startup before the delayed connection completes', async () => {
    const { startupClient, release, startup } = await delayedStartup()
    const initialization = expect(startupClient.init()).rejects.toMatchObject({
      errorType: BeaconErrorType.ABORTED_ERROR
    })
    await startupClient.disconnect({ notifyPeers: false })
    await initialization
    release.resolve()
    await startup
    expect(startupClient.hasSelectedTransport()).toBe(false)
  })

  it('allows a new explicit init without waiting for canceled startup work', async () => {
    const { startupClient, release, startup, transport } = await delayedStartup()
    await startupClient.disconnect({ notifyPeers: false })
    await expect(startupClient.init(transport)).resolves.toBe(TransportType.P2P)
    const disconnect = vi.spyOn(transport, 'disconnect')
    disconnect.mockClear()
    release.resolve()
    await startup
    expect(startupClient.hasSelectedTransport()).toBe(true)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('removes a stored account without waiting for startup transport connection', async () => {
    const { startupClient, storage, release, startup, account } = await delayedStartup()
    await startupClient.removeAccount(account.accountIdentifier)
    await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toEqual([])
    release.resolve()
    await expect(startup).resolves.toBeUndefined()
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
  })

  it('clears a dangling shared pointer when memory is already empty', async () => {
    const { startupClient, storage, release, startup } = await delayedStartup()
    await storage.set(StorageKey.ACCOUNTS, [])
    release.resolve()
    await startup
    await storageChangedCallback?.({
      eventType: 'entryModified',
      key: StorageKey.ACCOUNTS,
      oldValue: '[{}]',
      newValue: '[]'
    })
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
  })

  it('keeps a committed account when a newer account pointer write fails', async () => {
    const { startupClient, storage, release, startup, account, selected } = await delayedStartup()
    release.resolve()
    await startup
    selected.mockClear()
    const failure = new Error('account write failed')
    const write = storage.set.bind(storage)
    vi.spyOn(storage, 'set').mockImplementation(async (key, value) => {
      if (key === StorageKey.ACTIVE_ACCOUNT) {
        throw failure
      }
      await write(key, value)
    })
    const newer = { ...account, accountIdentifier: 'newer-account' }
    await expect(startupClient.setActiveAccount(newer)).rejects.toBe(failure)
    await expect(startupClient.getActiveAccount()).resolves.toEqual(account)
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(account.accountIdentifier)
    expect(selected).not.toHaveBeenCalled()
  })

  it('settles empty account state when the first explicit selection fails', async () => {
    const { startupClient, release, startup, account, transport } = await delayedStartup()
    const failure = new Error('connection failed')
    vi.spyOn(transport, 'connect').mockRejectedValueOnce(failure)
    await expect(
      startupClient.setActiveAccount({ ...account, accountIdentifier: 'newer-account' })
    ).rejects.toBe(failure)
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    release.resolve()
    await startup
  })

  it('does not emit a stale account when a transport event synchronously clears selection', async () => {
    const { startupClient, storage, release, startup, selected } = await delayedStartup()
    let cleared: Promise<void> | undefined
    await startupClient.subscribeToEvent(BeaconEvent.ACTIVE_TRANSPORT_SET, (transport) => {
      if (transport && !cleared) {
        cleared = startupClient.clearActiveAccount()
      }
    })
    release.resolve()
    await startup
    await cleared
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    expect(startupClient.hasSelectedTransport()).toBe(false)
    expect(selected.mock.calls.some(([account]) => account !== undefined)).toBe(false)
  })

  it('waits for an account write already in progress before destroy completes', async () => {
    const { startupClient, storage, release, startup, account } = await delayedStartup()
    await startupClient.clearActiveAccount()
    release.resolve()
    await startup
    const entered = new ExposedPromise<void>()
    const commit = new ExposedPromise<void>()
    const write = storage.set.bind(storage)
    vi.spyOn(storage, 'set').mockImplementation(async (key, value) => {
      if (key === StorageKey.ACTIVE_ACCOUNT) {
        entered.resolve()
        await commit.promise
      }
      await write(key, value)
    })
    const selection = startupClient.setActiveAccount(account)
    await entered.promise
    const destroy = startupClient.destroy()
    await expect(
      Promise.race([destroy.then(() => 'destroyed'), Promise.resolve('pending')])
    ).resolves.toBe('pending')
    commit.resolve()
    await Promise.all([selection, destroy])
    const writeCount = vi.mocked(storage.set).mock.calls.length
    await startup
    expect(vi.mocked(storage.set).mock.calls).toHaveLength(writeCount)
  })

  it('keeps a pending stored selection when an unrelated account is removed', async () => {
    const { startupClient, storage, release, startup, account } = await delayedStartup()
    const inactive = { ...account, accountIdentifier: 'inactive-account' }
    await storage.set(StorageKey.ACCOUNTS, [account, inactive])
    await startupClient.removeAccount(inactive.accountIdentifier)
    release.resolve()
    await expect(startup).resolves.toEqual(account)
    await expect(startupClient.getActiveAccount()).resolves.toEqual(account)
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBe(account.accountIdentifier)
    await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toEqual([account])
  })
  it('settles account reads and logs a failed remote selection while startup is pending', async () => {
    const { startupClient, storage, release, startup, account, transport } = await delayedStartup()
    const remote = { ...account, accountIdentifier: 'remote-account' }
    await storage.set(StorageKey.ACCOUNTS, [account, remote])
    await storage.set(StorageKey.ACTIVE_ACCOUNT, remote.accountIdentifier)
    const failure = new Error('remote transport failed')
    vi.spyOn(transport, 'connect').mockRejectedValueOnce(failure)
    await storageChangedCallback?.({
      eventType: 'entryModified',
      key: StorageKey.ACTIVE_ACCOUNT,
      oldValue: account.accountIdentifier,
      newValue: remote.accountIdentifier
    })
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    expect(mockLoggerError).toHaveBeenCalledWith('storageChanged', failure)
    release.resolve()
    await startup
  })

  it('does not select a transport from canceled delayed init registration', async () => {
    const { startupClient, storage, release, startup, transport } = await delayedStartup()
    await startupClient.disconnect({ notifyPeers: false })
    const registered = new ExposedPromise<void>()
    const finishRegistration = new ExposedPromise<void>()
    vi.spyOn(transport, 'addListener').mockImplementation(async () => {
      registered.resolve()
      await finishRegistration.promise
    })
    const originalInit = expect(startupClient.init(transport)).rejects.toMatchObject({
      errorType: BeaconErrorType.ABORTED_ERROR
    })
    await registered.promise
    await startupClient.clearActiveAccount()
    await originalInit
    const freshTransport = new DappP2PTransport(
      'Fresh init',
      { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
      storage,
      {}
    )
    const freshInit = startupClient.init(freshTransport)
    finishRegistration.resolve()
    await freshInit
    await expect(startupClient.selectedTransport()).resolves.toBe(freshTransport)
    release.resolve()
    await startup
    await expect(startupClient.selectedTransport()).resolves.toBe(freshTransport)
  })

  it('ignores a retained pairing callback after a newer init owns selection', async () => {
    const originalBroadcastChannel = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel')
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      value: class {
        public onmessage: unknown
        public onmessageerror: unknown
        public postMessage(_message: unknown): void {}
        public close(): void {}
      }
    })
    const extensions = vi
      .spyOn(PostMessageTransport, 'getAvailableExtensions')
      .mockResolvedValue([])
    try {
      const storage = new LocalStorage()
      const keys = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) }
      const post = new DappPostMessageTransport('Old pairing', keys, storage)
      const p2p = new DappP2PTransport('Old pairing', keys, storage, {})
      const wc = new DappWalletConnectTransport(
        'Old pairing',
        keys,
        storage,
        { network: NetworkType.MAINNET, opts: { projectId: 'test-project' } },
        async () => true
      )
      for (const transport of [post, p2p, wc]) {
        vi.spyOn(transport, 'connect').mockResolvedValue(undefined)
        vi.spyOn(transport, 'disconnect').mockResolvedValue(undefined)
        vi.spyOn(transport, 'getPeers').mockResolvedValue([])
        vi.spyOn(transport, 'removeAllPeers').mockResolvedValue(undefined)
        vi.spyOn(transport, 'stopListeningForNewPeers').mockResolvedValue(undefined)
      }
      vi.spyOn(post, 'getPairingRequestInfo').mockResolvedValue({
        id: 'post',
        type: 'postmessage-pairing-request',
        name: 'Old pairing',
        publicKey: 'post-key',
        version: '4'
      })
      vi.spyOn(p2p, 'getPairingRequestInfo').mockResolvedValue({
        id: 'p2p',
        type: 'p2p-pairing-request',
        name: 'Old pairing',
        publicKey: 'p2p-key',
        version: '4',
        relayServer: 'matrix.example.com'
      })
      let retained: Parameters<DappPostMessageTransport['listenForNewPeer']>[0] | undefined
      const registered = new ExposedPromise<void>()
      vi.spyOn(post, 'listenForNewPeer').mockImplementation(async (callback) => {
        retained = callback
        registered.resolve()
      })
      class PairingClient extends DAppClient {
        public selectedTransport() {
          return this.transport
        }
        public async initInternalTransports(): Promise<void> {
          this.postMessageTransport = post
          this.p2pTransport = p2p
          this.walletConnectTransport = wc
        }
      }
      Reflect.set(window, 'beaconCreatedClientInstance', false)
      const pairingClient = new PairingClient({
        name: 'Pairing ownership',
        storage,
        disableDefaultEvents: true
      })
      await pairingClient.getActiveAccount()
      const paired = vi.fn()
      await pairingClient.subscribeToEvent(BeaconEvent.PAIR_SUCCESS, paired)
      const oldInit = expect(pairingClient.init()).rejects.toMatchObject({
        errorType: BeaconErrorType.ABORTED_ERROR
      })
      await registered.promise
      await pairingClient.clearActiveAccount()
      await oldInit
      const fresh = new DappP2PTransport('New init', keys, storage, {})
      await pairingClient.init(fresh)
      for (const transport of [post, p2p, wc]) {
        vi.mocked(transport.stopListeningForNewPeers).mockClear()
      }
      if (!retained) {
        throw new Error('Missing retained pairing callback')
      }
      retained({
        id: 'old-peer',
        type: 'postmessage-pairing-response',
        name: 'Old wallet',
        publicKey: 'old-key',
        version: '4',
        extensionId: 'old-extension',
        senderId: 'old-sender'
      })
      await expect(pairingClient.selectedTransport()).resolves.toBe(fresh)
      expect(paired).not.toHaveBeenCalled()
      for (const transport of [post, p2p, wc]) {
        expect(transport.stopListeningForNewPeers).not.toHaveBeenCalled()
      }
      vi.spyOn(wc, 'forceUpdate').mockReturnValue(undefined)
      const walletConnectAccount = createStoredAccount()
      walletConnectAccount.origin.type = Origin.WALLETCONNECT
      await pairingClient.setActiveAccount(walletConnectAccount)
      for (const transport of [post, p2p, wc]) {
        vi.mocked(transport.disconnect).mockClear()
      }
      await pairingClient.clearActiveAccount()
      for (const transport of [post, p2p, wc]) {
        expect(transport.disconnect).toHaveBeenCalledTimes(1)
      }
    } finally {
      extensions.mockRestore()
      if (originalBroadcastChannel) {
        Object.defineProperty(globalThis, 'BroadcastChannel', originalBroadcastChannel)
      } else {
        Reflect.deleteProperty(globalThis, 'BroadcastChannel')
      }
    }
  })
  it('settles an account read already waiting on startup when the client is destroyed', async () => {
    const { startupClient, release, startup } = await delayedStartup()
    const read = startupClient.getActiveAccount()
    await startupClient.destroy()
    await expect(read).resolves.toBeUndefined()
    release.resolve()
    await expect(startup).resolves.toBeUndefined()
  })
  it('notifies subscribers when account-list removal clears a previously active account', async () => {
    const { startupClient, storage, release, startup, selected } = await delayedStartup()
    release.resolve()
    await startup
    selected.mockClear()
    await storage.set(StorageKey.ACCOUNTS, [])
    await storageChangedCallback?.({
      eventType: 'entryModified',
      key: StorageKey.ACCOUNTS,
      oldValue: '[{}]',
      newValue: '[]'
    })
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    expect(selected).toHaveBeenCalledWith(undefined, undefined)
  })
  it('completes the account-clear notification when a transport subscriber clears again', async () => {
    const { startupClient, storage, release, startup, selected } = await delayedStartup()
    release.resolve()
    await startup
    selected.mockClear()
    let nestedClear: Promise<void> | undefined
    let requested = false
    await startupClient.subscribeToEvent(BeaconEvent.ACTIVE_TRANSPORT_SET, (transport) => {
      if (!transport && !requested) {
        requested = true
        nestedClear = startupClient.clearActiveAccount()
      }
    })
    await startupClient.clearActiveAccount()
    await nestedClear
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    expect(startupClient.hasSelectedTransport()).toBe(false)
    expect(selected).toHaveBeenCalledWith(undefined, undefined)
    const peerState: unknown = Reflect.get(startupClient, '_activePeer')
    if (
      typeof peerState !== 'object' ||
      peerState === null ||
      !('promise' in peerState) ||
      !(peerState.promise instanceof Promise)
    ) {
      throw new Error('Missing selected peer state')
    }
    await expect(peerState.promise).resolves.toBeUndefined()
  })
  it('notifies a committed clear when the superseding selection fails', async () => {
    const { startupClient, storage, release, startup, selected, account, transport } =
      await delayedStartup()
    release.resolve()
    await startup
    selected.mockClear()
    const failure = new Error('new selection failed')
    vi.spyOn(transport, 'connect').mockRejectedValueOnce(failure)
    let attempted = false
    let selection: Promise<void> | undefined
    let rejected: unknown
    await startupClient.subscribeToEvent(BeaconEvent.ACTIVE_TRANSPORT_SET, (selectedTransport) => {
      if (!selectedTransport && !attempted) {
        attempted = true
        selection = startupClient
          .setActiveAccount({ ...account, accountIdentifier: 'newer-account' })
          .catch((error: unknown) => {
            rejected = error
          })
      }
    })
    await startupClient.clearActiveAccount()
    await selection
    expect(rejected).toBe(failure)
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    expect(startupClient.hasSelectedTransport()).toBe(false)
    expect(selected).toHaveBeenCalledWith(undefined, undefined)
    expect(selected.mock.calls.some(([account]) => account !== undefined)).toBe(false)
  })
  it('finishes a clear notification when account-list recovery observes already-empty memory', async () => {
    const { startupClient, storage, release, startup, selected } = await delayedStartup()
    release.resolve()
    await startup
    selected.mockClear()
    let recovered: Promise<void> | undefined
    let notified = false
    await startupClient.subscribeToEvent(BeaconEvent.ACTIVE_TRANSPORT_SET, (transport) => {
      if (!transport && !notified) {
        notified = true
        recovered = storageChangedCallback?.({
          eventType: 'entryModified',
          key: StorageKey.ACCOUNTS,
          oldValue: '[]',
          newValue: '[{}]'
        })
      }
    })
    await startupClient.clearActiveAccount()
    await recovered
    await expect(startupClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
    expect(selected).toHaveBeenCalledWith(undefined, undefined)
  })
  it('settles account reads when a remote lookup fails before account preparation', async () => {
    const { startupClient, release, startup, account } = await delayedStartup()
    const read = startupClient.getActiveAccount()
    const failure = new Error('account lookup failed')
    vi.spyOn(startupClient, 'getAccount').mockRejectedValueOnce(failure)
    await storageChangedCallback?.({
      eventType: 'entryModified',
      key: StorageKey.ACTIVE_ACCOUNT,
      oldValue: account.accountIdentifier,
      newValue: 'remote-account'
    })
    expect(mockLoggerError).toHaveBeenCalledWith('storageChanged', failure)
    await expect(read).resolves.toBeUndefined()
    release.resolve()
    await startup
  })
})

describe('DAppClient toast configuration', () => {
  it('passes uiOptions to the event handler used by showPrepare', async () => {
    vi.mocked(openToast).mockClear()
    const quiet = new DAppClient({ name: 'Quiet dApp', uiOptions: { enableToasts: false } })
    const defaults = new DAppClient({ name: 'Default dApp' })
    try {
      await quiet.showPrepare()
      expect(openToast).not.toHaveBeenCalled()
      await defaults.showPrepare()
      expect(openToast).toHaveBeenCalledTimes(1)
      expect(openToast).toHaveBeenCalledWith(expect.objectContaining({ state: 'prepare' }))
    } finally {
      await quiet.destroy()
      await defaults.destroy()
    }
  })
})

describe('DAppClient WalletConnect projectId deprecation warning', () => {
  it('warns when walletConnectOptions.projectId is omitted and falls back to the demo projectId', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const clientWithoutProjectId = new DAppClient({ name: 'Demo Fallback dApp' })
    try {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('demo')
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://dashboard.reown.com/')
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Terms of Service')
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('next minor release')
      )
      expect((clientWithoutProjectId as unknown as { wcProjectId?: string }).wcProjectId).toBe(
        '24469fd0a06df227b6e5f7dc7de0ff4f'
      )
    } finally {
      warnSpy.mockRestore()
      await clientWithoutProjectId.destroy()
    }
  })

  it('does not warn when walletConnectOptions.projectId is provided', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const clientWithProjectId = new DAppClient({
      name: 'Configured dApp',
      walletConnectOptions: { projectId: 'custom-project-id' }
    })
    try {
      const wcWarnings = warnSpy.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && msg.includes('WalletConnect projectId')
      )
      expect(wcWarnings).toHaveLength(0)
      expect((clientWithProjectId as unknown as { wcProjectId?: string }).wcProjectId).toBe(
        'custom-project-id'
      )
    } finally {
      warnSpy.mockRestore()
      await clientWithProjectId.destroy()
    }
  })
})
