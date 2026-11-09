// __tests__/DAppClient.test.ts
import { DAppClient } from '../../src/dapp-client/DAppClient'
import {
  BeaconMessageType,
  BeaconErrorType,
  NetworkType,
  Origin,
  PermissionScope,
  StorageKey,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { LocalStorage } from '@ecadlabs/beacon-core'
import { WalletConnectTransport } from '@ecadlabs/beacon-transport-walletconnect'
import { BeaconEvent } from '../../src/events'
import { getDAppClientInstance } from '../../src/utils/get-instance'

const mockLoggerWarn = jest.fn()
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

jest.mock('@ecadlabs/beacon-ui', () => ({
  setColorMode: jest.fn(),
  getColorMode: jest.fn().mockReturnValue('light'),
  setDesktopList: jest.fn(),
  setExtensionList: jest.fn(),
  setWebList: jest.fn(),
  setiOSList: jest.fn(),
  getiOSList: jest.fn().mockReturnValue([]),
  getDesktopList: jest.fn().mockReturnValue([]),
  getExtensionList: jest.fn().mockReturnValue([]),
  getWebList: jest.fn().mockReturnValue([]),
  isBrowser: jest.fn().mockReturnValue(true),
  isDesktop: jest.fn().mockReturnValue(false),
  isMobileOS: jest.fn().mockReturnValue(false),
  isIOS: jest.fn().mockReturnValue(false),
  currentOS: jest.fn().mockReturnValue('test'),
  closeToast: jest.fn()
}))

jest.mock('@ecadlabs/beacon-core', () => {
  const actual = jest.requireActual('@ecadlabs/beacon-core')
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
    generateGUID: jest.fn().mockResolvedValue('guid'),
    getSenderId: jest.fn().mockResolvedValue('senderId'),
    Logger: class {
      constructor(_name: string) {}
      error() {}
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
    IndexedDBStorage: class {
      constructor() {}
      set() {}
      getAllKeys() {
        return Promise.resolve([])
      }
      delete() {}
    },
    MultiTabChannel: class {
      constructor(_a: any, _b: any, _c: any) {}
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
    },
    BACKEND_URL: '',
    getError: (_t: any, _d: any) => new Error('beacon error')
  }
})

jest.mock('@walletconnect/sign-client', () => ({}))
jest.mock('@walletconnect/types', () => ({}))
jest.mock('@walletconnect/utils', () => ({ getSdkError: jest.fn() }))

describe('DAppClient: basic unit tests', () => {
  let client: DAppClient

  beforeEach(() => {
    ;(window as any).beaconCreatedClientInstance = false
    mockLoggerWarn.mockClear()
    storageChangedCallback = undefined
    client = new DAppClient({
      name: 'TestApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET
    })
    client.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
  })

  const seedPeerStorage = async () => {
    await (client as any).storage.set(StorageKey.TRANSPORT_P2P_PEERS_DAPP, [])
    await (client as any).storage.set(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP, [])
    await (client as any).storage.set(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP, [])
  }

  const createStoredAccount = () => ({
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

  it('addQueryParam returns "key=value"', () => {
    // addQueryParam is private; cast to any to reach it
    const result = (client as any).addQueryParam('foo', 'bar')
    expect(result).toBe('foo=bar')
  })

  it('addOpenRequest stores given promise in openRequests map', () => {
    const p = new ExposedPromise<{ foo: string }, any>()
    ;(client as any).addOpenRequest('myId', p)
    expect((client as any).openRequests.get('myId')).toBe(p)
  })

  it('addBlockchain / removeBlockchain manage internal map', async () => {
    // define a minimal fake chain
    const fakeChain = {
      identifier: 'chain-1',
      getWalletLists: jest.fn().mockResolvedValue({
        desktopList: [],
        extensionList: [],
        webList: [],
        iOSList: []
      }),
      handleResponse: jest.fn()
    }
    client.addBlockchain(fakeChain as any)
    expect((client as any).blockchains.has('chain-1')).toBe(true)

    client.removeBlockchain('chain-1')
    expect((client as any).blockchains.has('chain-1')).toBe(false)
  })

  it('handles raw v3 disconnect messages without a nested message wrapper', async () => {
    const publicKey = '11'.repeat(32)
    const senderId = await require('@ecadlabs/beacon-core').getSenderId(publicKey)
    ;(client as any)._activePeer = ExposedPromise.resolve({
      type: 'p2p-pairing-response',
      publicKey,
      senderId
    })
    const channelClosedHandler = jest.fn()
    const removeAccountsForPeerIds = jest
      .spyOn(client as any, 'removeAccountsForPeerIds')
      .mockResolvedValue(undefined)

    ;(client as any).p2pTransport = {
      getPeers: jest.fn().mockResolvedValue([]),
      removePeer: jest.fn()
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
    const senderId = await require('@ecadlabs/beacon-core').getSenderId(publicKey)
    ;(client as any)._activePeer = ExposedPromise.resolve({
      type: 'p2p-pairing-response',
      publicKey,
      senderId
    })
    const removeAccounts = jest
      .spyOn(client as any, 'removeAccountsForPeerIds')
      .mockResolvedValue(undefined)
    const closed = jest.fn()
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
    const acknowledgeHandler = jest.fn()
    const getWalletInfo = jest.spyOn(client as any, 'getWalletInfo').mockResolvedValue({})

    ;(client as any).openRequests.set(
      'request-id',
      new ExposedPromise<{ message: unknown; connectionInfo: unknown }, any>()
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

    const acknowledgeHandler = jest.fn()
    const getWalletInfo = jest.spyOn(client as any, 'getWalletInfo').mockResolvedValue({})

    ;(client as any).openRequests.set(
      'wrapper-request-id',
      new ExposedPromise<{ message: unknown; connectionInfo: unknown }, any>()
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
    const makeRequest = jest
      .spyOn(client as any, 'makeRequest')
      .mockReturnValue(deferredRequest.promise)
    jest.spyOn(client as any, 'checkMakeRequest').mockResolvedValue(true)
    jest.spyOn(client as any, 'getOwnAppMetadata').mockResolvedValue({
      senderId: 'dapp-sender-id',
      name: 'TestApp'
    })
    jest.spyOn(client as any, 'buildPayload').mockResolvedValue({})
    jest.spyOn(client as any, 'sendMetrics').mockResolvedValue(undefined)
    jest.spyOn(client as any, 'onNewAccount').mockResolvedValue(output.accountInfo)
    jest.spyOn(client as any, 'notifySuccess').mockResolvedValue(undefined)
    jest.spyOn(client as any, 'getWalletInfo').mockResolvedValue({})
    jest.spyOn((client as any).accountManager, 'addAccount').mockResolvedValue(undefined)

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
    jest.spyOn(client as any, 'getOwnAppMetadata').mockReturnValue(new Promise(() => {}))

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
    jest.spyOn(client as any, 'getOwnAppMetadata').mockReturnValue(new Promise(() => {}))

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
    const makeRequest = jest
      .spyOn(client as any, 'makeRequest')
      .mockReturnValueOnce(rejectedRequest.promise)
      .mockReturnValueOnce(successfulRequest.promise)
    jest.spyOn(client as any, 'checkMakeRequest').mockResolvedValue(true)
    jest.spyOn(client as any, 'getOwnAppMetadata').mockResolvedValue({
      senderId: 'dapp-sender-id',
      name: 'TestApp'
    })
    jest.spyOn(client as any, 'buildPayload').mockResolvedValue({})
    jest.spyOn(client as any, 'sendMetrics').mockResolvedValue(undefined)
    jest.spyOn(client as any, 'runRequestErrorSideEffects').mockResolvedValue(undefined)
    jest.spyOn(client as any, 'onNewAccount').mockResolvedValue(output.accountInfo)
    jest.spyOn(client as any, 'notifySuccess').mockResolvedValue(undefined)
    jest.spyOn(client as any, 'getWalletInfo').mockResolvedValue({})
    jest.spyOn((client as any).accountManager, 'addAccount').mockResolvedValue(undefined)

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
      disconnect: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
    })
    const postMessageTransport = createTransport(TransportType.POST_MESSAGE)
    const p2pTransport = createTransport(TransportType.P2P)
    const walletConnectTransport = {
      ...createTransport(TransportType.WALLETCONNECT),
      doClientCleanup: jest.fn().mockResolvedValue(undefined)
    }
    const closeMultiTabChannel = jest.fn().mockResolvedValue(undefined)
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
    ;(client as any)._initSubstratePairing = false
    ;(client as any)._requestPermissionsPromise = initPromise
    ;(client as any)._requestPermissionsKey = 'sign'
    const removeAllPeers = jest.spyOn(client, 'removeAllPeers')

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
    expect((client as any)._initSubstratePairing).toBeUndefined()
    expect((client as any)._requestPermissionsPromise).toBeUndefined()
    expect((client as any)._requestPermissionsKey).toBeUndefined()
  })

  it('rejects a pending init with different pairing options', async () => {
    ;(client as any)._initPromise = new Promise(() => {})
    ;(client as any)._initReject = jest.fn()
    ;(client as any)._initSubstratePairing = false

    await expect((client as any).init(undefined, true)).rejects.toThrow(
      'Cannot start a permission request with different pairing options while another pairing is pending'
    )
  })

  it('does not create a WalletConnect pairing request before the WC payload is awaited', async () => {
    const pairInitHandler = jest.fn()
    const createBaseTransport = (type: TransportType) => ({
      type,
      connectionStatus: TransportStatus.CONNECTED,
      connect: jest.fn().mockResolvedValue(undefined),
      listenForNewPeer: jest.fn().mockResolvedValue(undefined),
      stopListeningForNewPeers: jest.fn().mockResolvedValue(undefined),
      getPairingRequestInfo: jest.fn().mockResolvedValue({}),
      getPeers: jest.fn().mockResolvedValue([]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
    })
    const postMessageTransport = createBaseTransport(TransportType.POST_MESSAGE)
    const p2pTransport = createBaseTransport(TransportType.P2P)
    const walletConnectTransport = {
      ...createBaseTransport(TransportType.WALLETCONNECT),
      getPairingRequestInfo: jest.fn().mockResolvedValue({ uri: 'wc:test-topic@2?symKey=test' })
    }
    const initInternalTransports = jest
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
    const channelClosedHandler = jest.fn()

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
    const channelClosedHandler = jest.fn()
    const transport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: jest.fn().mockResolvedValue([peer]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
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
      getPeers: jest.fn().mockResolvedValue([]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
    }
    const pendingRequest = new ExposedPromise<unknown, any>()
    const pendingRejection = pendingRequest.promise.catch((error) => error)

    ;(client as any)._activeAccount = ExposedPromise.resolve(staleAccount)
    await (client as any).storage.set(StorageKey.ACCOUNTS, [])
    await (client as any).setTransport(transport)
    ;(client as any).openRequests.set('pending-after-disconnect', pendingRequest)

    await client.disconnect()

    expect((client as any).openRequests.size).toBe(0)
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
    const storageDelete = jest.spyOn(testClient.storage, 'delete')
    const emit = jest.spyOn(testClient.events, 'emit')

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
    const storageDelete = jest.spyOn(testClient.storage, 'delete')
    const emit = jest.spyOn(testClient.events, 'emit')

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
    const setActiveAccount = jest.spyOn(testClient, 'setActiveAccount').mockResolvedValue(undefined)

    await storageChangedCallback?.({
      eventType: 'entryModified',
      key: testClient.storage.getPrefixedKey(StorageKey.ACCOUNTS),
      oldValue: '[]',
      newValue: JSON.stringify([account])
    })

    expect(setActiveAccount).toHaveBeenCalledWith(account)
    setActiveAccount.mockRestore()
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
    const setActiveAccount = jest.spyOn(testClient, 'setActiveAccount').mockResolvedValue(undefined)

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
      getPeers: jest.fn().mockResolvedValue([]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
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
    ;(client as any)._initSubstratePairing = false
    ;(client as any)._requestPermissionsPromise = initPromise
    ;(client as any)._requestPermissionsKey = 'sign'

    await client.disconnect()
    await initRejection

    expect((client as any)._initPromise).toBeUndefined()
    expect((client as any)._initReject).toBeUndefined()
    expect((client as any)._initSubstratePairing).toBeUndefined()
    expect((client as any)._requestPermissionsPromise).toBeUndefined()
    expect((client as any)._requestPermissionsKey).toBeUndefined()
  })

  it('disconnect tears down initialized transports while pairing is still pending', async () => {
    const createTransport = (type: TransportType) => ({
      type,
      connectionStatus: TransportStatus.CONNECTING,
      getPeers: jest.fn().mockResolvedValue([]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
    })
    const postMessageTransport = createTransport(TransportType.POST_MESSAGE)
    const p2pTransport = createTransport(TransportType.P2P)
    const walletConnectTransport = {
      ...createTransport(TransportType.WALLETCONNECT),
      doClientCleanup: jest.fn().mockResolvedValue(undefined)
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
      getPeers: jest.fn().mockReturnValue(getPeersPromise),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
    }

    ;(client as any).removeAccountsForPeers = jest.fn().mockResolvedValue(undefined)
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
    const disconnectInternal = jest
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
      getPeers: jest.fn().mockReturnValue(getPeersPromise),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
    }

    ;(client as any).removeAccountsForPeers = jest.fn().mockResolvedValue(undefined)
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
      getPeers: jest.fn().mockResolvedValue([]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
    })
    const postMessageTransport = createTransport(TransportType.POST_MESSAGE)
    const p2pTransport = createTransport(TransportType.P2P)
    const walletConnectTransport = {
      ...createTransport(TransportType.WALLETCONNECT),
      doClientCleanup: jest.fn().mockResolvedValue(undefined)
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
      getPeers: jest.fn().mockResolvedValue([]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
    })
    const postMessageTransport = createTransport(TransportType.POST_MESSAGE)
    const p2pTransport = createTransport(TransportType.P2P)
    const walletConnectTransport = {
      ...createTransport(TransportType.WALLETCONNECT),
      doClientCleanup: jest.fn().mockResolvedValue(undefined)
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
      getPeers: jest.fn().mockResolvedValue([]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockRejectedValue(new Error('postmessage cleanup failed')),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
    }
    const p2pTransport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: jest.fn().mockResolvedValue([]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
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
      getPeers: jest.fn().mockResolvedValue([peer]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockReturnValue(sendPromise),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
    }

    ;(client as any).removeAccountsForPeers = jest.fn().mockResolvedValue(undefined)
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
      getPeers: jest.fn().mockResolvedValue([peer]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
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
      getPeers: jest.fn().mockResolvedValue([peer]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
    })
    const firstTransport = createTransport()
    const secondTransport = createTransport()

    ;(client as any).removeAccountsForPeers = jest.fn().mockResolvedValue(undefined)
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
      getPeers: jest.fn().mockResolvedValue([]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
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
      getPeers: jest.fn().mockResolvedValue([]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockImplementation(() => {
        transport.connectionStatus = TransportStatus.NOT_CONNECTED

        return Promise.resolve()
      }),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
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
      getPeers: jest.fn().mockResolvedValue([peer]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockRejectedValue(new Error('peer offline')),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
    }
    const pendingRequest = new ExposedPromise<unknown, any>()
    const pendingRejection = pendingRequest.promise.catch((error) => error)

    ;(client as any)._activeAccount = ExposedPromise.resolve(staleAccount)
    await (client as any).storage.set(StorageKey.ACCOUNTS, [])
    await (client as any).setTransport(transport)
    ;(client as any).openRequests.set('pending-after-disconnect', pendingRequest)

    await expect(client.disconnect()).resolves.toBeUndefined()

    expect(transport.send).toHaveBeenCalledWith(expect.any(String), peer)
    expect(transport.disconnect).toHaveBeenCalledTimes(1)
    expect((client as any).openRequests.size).toBe(0)
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
    ;(client as any).openRequests.set('pending-after-disconnect', pendingRequest)
    await (client as any).storage.delete(StorageKey.ACTIVE_ACCOUNT)

    await expect(client.disconnect()).resolves.toBeUndefined()

    expect((client as any).openRequests.size).toBe(0)
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
      getPeers: jest.fn().mockResolvedValue([]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
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
      getPeers: jest.fn().mockResolvedValue([peer]),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      doClientCleanup: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined)
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

    const request = new ExposedPromise<{ message: unknown; connectionInfo: unknown }, any>()
    ;(client as any).openRequests.set('wrapper-request-id', request)

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

    expect((client as any).openRequests.has('wrapper-request-id')).toBe(false)
  })

  it('rejects open requests when the wallet peer never answers', async () => {
    jest.useFakeTimers()
    ;(window as any).beaconCreatedClientInstance = false
    const timeoutClient = new DAppClient({
      name: 'TimeoutApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      requestTimeoutMs: 10
    })
    timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    const channelClosedHandler = jest.fn()
    timeoutClient.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, channelClosedHandler)

    const operationRequest = new ExposedPromise<unknown, unknown>()
    const rejection = jest.fn()
    void operationRequest.promise.catch(rejection)

    try {
      ;(timeoutClient as any).addOpenRequest('ghost-request-id', operationRequest)

      jest.advanceTimersByTime(10)
      await Promise.resolve()

      expect(rejection).toHaveBeenCalledWith(
        expect.objectContaining({
          type: BeaconMessageType.Error,
          errorType: BeaconErrorType.PEER_UNREACHABLE,
          id: 'ghost-request-id'
        })
      )
      expect((timeoutClient as any).openRequests.has('ghost-request-id')).toBe(false)
      expect(channelClosedHandler).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('clears delegated open requests when another tab receives the wallet response', async () => {
    jest.useFakeTimers()
    ;(window as any).beaconCreatedClientInstance = false
    const timeoutClient = new DAppClient({
      name: 'TimeoutApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      requestTimeoutMs: 10
    })
    timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    const channelClosedHandler = jest.fn()
    timeoutClient.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, channelClosedHandler)
    const postMessage = jest.spyOn((timeoutClient as any).multiTabChannel, 'postMessage')

    try {
      ;(timeoutClient as any).openRequestsOtherTabs.add('delegated-request-id')
      ;(timeoutClient as any).addOpenRequest(
        'delegated-request-id',
        new ExposedPromise<unknown, unknown>()
      )

      expect((timeoutClient as any).openRequestsOtherTabs.has('delegated-request-id')).toBe(true)

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
      expect((timeoutClient as any).openRequests.has('delegated-request-id')).toBe(false)
      expect((timeoutClient as any).openRequestsOtherTabs.has('delegated-request-id')).toBe(false)

      jest.advanceTimersByTime(10)
      await Promise.resolve()

      expect(channelClosedHandler).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps delegated acknowledged requests open without timing them out', async () => {
    jest.useFakeTimers()
    ;(window as any).beaconCreatedClientInstance = false
    const timeoutClient = new DAppClient({
      name: 'TimeoutApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      requestTimeoutMs: 10
    })
    timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    const channelClosedHandler = jest.fn()
    timeoutClient.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, channelClosedHandler)
    const postMessage = jest.spyOn((timeoutClient as any).multiTabChannel, 'postMessage')

    const operationRequest = new ExposedPromise<unknown, unknown>()
    const rejection = jest.fn()
    void operationRequest.promise.catch(rejection)

    try {
      ;(timeoutClient as any).openRequestsOtherTabs.add('delegated-acknowledged-request-id')
      ;(timeoutClient as any).addOpenRequest('delegated-acknowledged-request-id', operationRequest)

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

      jest.advanceTimersByTime(10)
      await Promise.resolve()

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'delegated-acknowledged-request-id',
          type: 'RESPONSE'
        })
      )
      expect(rejection).not.toHaveBeenCalled()
      expect(channelClosedHandler).not.toHaveBeenCalled()
      expect((timeoutClient as any).openRequests.has('delegated-acknowledged-request-id')).toBe(
        true
      )
      expect(
        (timeoutClient as any).openRequestsOtherTabs.has('delegated-acknowledged-request-id')
      ).toBe(true)
    } finally {
      ;(timeoutClient as any).clearOpenRequest('delegated-acknowledged-request-id')
      jest.useRealTimers()
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

    const postMessage = jest.spyOn((timeoutClient as any).multiTabChannel, 'postMessage')
    jest.spyOn((timeoutClient as any).multiTabChannel, 'isLeader').mockReturnValue(true)
    ;(timeoutClient as any)._transport = ExposedPromise.resolve({
      waitForResolution: jest.fn().mockResolvedValue(undefined)
    })

    const sendFailure: ErrorResponse = {
      id: 'delegated-send-failure-id',
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.UNKNOWN_ERROR,
      senderId: '',
      version: '2'
    }
    jest.spyOn(timeoutClient as any, 'makeRequest').mockRejectedValue(sendFailure)

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
    expect((timeoutClient as any).openRequestsOtherTabs.has('delegated-send-failure-id')).toBe(
      false
    )
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
      send: jest.fn().mockRejectedValue(sendError)
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

    jest.spyOn(timeoutClient as any, 'init').mockResolvedValue(TransportType.P2P)
    jest.spyOn(timeoutClient as any, 'transport', 'get').mockReturnValue(Promise.resolve(transport))
    jest.spyOn(timeoutClient as any, 'checkPermissions').mockResolvedValue(true)
    jest.spyOn(timeoutClient as any, 'addRequestAndCheckIfRateLimited').mockResolvedValue(false)
    jest.spyOn(timeoutClient as any, 'getActiveAccount').mockResolvedValue(undefined)
    jest.spyOn(timeoutClient as any, 'getPeer').mockResolvedValue(peer)
    jest.spyOn(timeoutClient as any, 'getWalletInfo').mockResolvedValue({})

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

    expect((timeoutClient as any).openRequests.has('guid')).toBe(false)
  })

  it('restores an upstream v4.8.0-style P2P persisted session without deactivating it', async () => {
    const activeAccountHandler = jest.fn()
    const invalidAccountHandler = jest.fn()
    const storedAccount = createStoredAccount()
    const p2pPeer = createV480P2PPeer()
    const storage = new LocalStorage({
      [StorageKey.ACTIVE_ACCOUNT]: storedAccount.accountIdentifier,
      [StorageKey.ACCOUNTS]: [storedAccount],
      [StorageKey.PERMISSION_LIST]: [createV480Permission()],
      [StorageKey.TRANSPORT_P2P_PEERS_DAPP]: [p2pPeer]
    })
    const initInternalTransports = jest
      .spyOn(DAppClient.prototype as any, 'initInternalTransports')
      .mockImplementation(async function (this: any) {
        this.p2pTransport = {
          connectionStatus: TransportStatus.CONNECTED,
          getPeers: jest.fn().mockResolvedValue([p2pPeer])
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
    const initSDK = jest.spyOn(client as any, 'initSDK')

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
    const invalidAccountHandler = jest.fn()
    const legacyInvalidAccountHandler = jest.fn()
    const activeAccountHandler = jest.fn()
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
    const invalidAccountHandler = jest.fn()
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
    const invalidAccountHandler = jest.fn()
    const activeAccountHandler = jest.fn()
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
    const invalidAccountHandler = jest.fn()
    const activeAccountHandler = jest.fn()
    const storedAccount = createStoredAccount()
    const { LocalStorage: RealLocalStorage } = jest.requireActual(
      '@ecadlabs/beacon-core'
    ) as typeof import('@ecadlabs/beacon-core')
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
    const invalidAccountHandler = jest.fn()
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
    const hideUI = jest.spyOn(storedStateClient as any, 'hideUI')
    const makeRequest = jest
      .spyOn(storedStateClient as any, 'makeRequest')
      .mockResolvedValue(permissionResult)
    jest.spyOn(storedStateClient as any, 'checkMakeRequest').mockResolvedValue(true)
    jest.spyOn(storedStateClient as any, 'getOwnAppMetadata').mockResolvedValue({
      senderId: 'dapp-sender-id',
      name: 'RepairThenConnectApp'
    })
    jest.spyOn(storedStateClient as any, 'buildPayload').mockResolvedValue({})
    jest.spyOn(storedStateClient as any, 'sendMetrics').mockResolvedValue(undefined)
    jest.spyOn(storedStateClient as any, 'onNewAccount').mockResolvedValue(accountInfo)
    jest.spyOn(storedStateClient as any, 'notifySuccess').mockResolvedValue(undefined)
    jest.spyOn(storedStateClient as any, 'getWalletInfo').mockResolvedValue({})
    jest.spyOn((storedStateClient as any).accountManager, 'addAccount').mockResolvedValue(undefined)

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
    const storedAccount = createStoredAccount()
    const storage = new LocalStorage({
      [StorageKey.ACTIVE_ACCOUNT]: storedAccount.accountIdentifier,
      [StorageKey.ACCOUNTS]: [storedAccount]
    })

    ;(window as any).beaconCreatedClientInstance = false
    const storedStateClient = new DAppClient({
      name: 'ClearActiveAccountStorageApp',
      storage,
      preferredNetwork: NetworkType.MAINNET,
      disableDefaultEvents: true,
      eventHandlers: {
        [BeaconEvent.ACTIVE_ACCOUNT_SET]: {
          handler: jest.fn()
        }
      }
    })

    jest.spyOn(storedStateClient, 'initInternalTransports').mockResolvedValue(undefined)
    jest.spyOn(storedStateClient, 'getPeer').mockResolvedValue(undefined)

    await (storedStateClient as any).storageValidated
    await storedStateClient.clearActiveAccount()

    await expect(storedStateClient.getActiveAccount()).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
  })

  it('emits account deactivated and clears state when stored accounts are malformed', async () => {
    const invalidAccountHandler = jest.fn()
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
    const invalidAccountHandler = jest.fn()
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
    const invalidAccountHandler = jest.fn()
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
    const invalidAccountHandler = jest.fn()
    const storedAccount = createStoredAccount()
    const storage = new LocalStorage({
      [StorageKey.ACTIVE_ACCOUNT]: storedAccount.accountIdentifier,
      [StorageKey.ACCOUNTS]: [storedAccount]
    })
    const firstValidation = new ExposedPromise<boolean>()
    ;(storage as any).validateResults = [firstValidation.promise, false]
    const p2pPeer = createV480P2PPeer()
    const initInternalTransports = jest
      .spyOn(DAppClient.prototype as any, 'initInternalTransports')
      .mockImplementation(async function (this: any) {
        this.p2pTransport = {
          connectionStatus: TransportStatus.CONNECTED,
          getPeers: jest.fn().mockResolvedValue([p2pPeer])
        }
      })
    const getWalletInfo = jest
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
    const invalidAccountHandler = jest.fn()
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
      send: jest.fn().mockRejectedValue(sendError)
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

    jest.spyOn(timeoutClient as any, 'init').mockResolvedValue(TransportType.P2P)
    jest.spyOn(timeoutClient as any, 'transport', 'get').mockReturnValue(Promise.resolve(transport))
    jest.spyOn(timeoutClient as any, 'addRequestAndCheckIfRateLimited').mockResolvedValue(false)
    jest.spyOn(timeoutClient as any, 'getActiveAccount').mockResolvedValue(undefined)
    jest.spyOn(timeoutClient as any, 'getPeer').mockResolvedValue(peer)
    jest.spyOn(timeoutClient as any, 'getWalletInfo').mockResolvedValue({})

    await expect(
      (timeoutClient as any).makeRequestV3({
        type: BeaconMessageType.SignPayloadRequest,
        signingType: 'raw',
        payload: 'payload',
        sourceAddress: 'tz1-address'
      })
    ).rejects.toBe(sendError)

    expect((timeoutClient as any).openRequests.has('guid')).toBe(false)
  })

  it('clears delegated request markers when the delegated request times out', async () => {
    jest.useFakeTimers()
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
      ;(timeoutClient as any).openRequestsOtherTabs.add('delegated-request-id')
      ;(timeoutClient as any).addOpenRequest('delegated-request-id', operationRequest)

      jest.advanceTimersByTime(10)
      await Promise.resolve()

      expect((timeoutClient as any).openRequestsOtherTabs.has('delegated-request-id')).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps acknowledged requests open without timing them out', async () => {
    jest.useFakeTimers()
    ;(window as any).beaconCreatedClientInstance = false
    const timeoutClient = new DAppClient({
      name: 'TimeoutApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      requestTimeoutMs: 10
    })
    timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    const channelClosedHandler = jest.fn()
    timeoutClient.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, channelClosedHandler)
    jest.spyOn(timeoutClient as any, 'getWalletInfo').mockResolvedValue({})

    const operationRequest = new ExposedPromise<unknown, unknown>()
    const rejection = jest.fn()
    void operationRequest.promise.catch(rejection)

    try {
      ;(timeoutClient as any).addOpenRequest('acknowledged-request-id', operationRequest)

      await (timeoutClient as any).handleResponse(
        {
          id: 'acknowledged-request-id',
          version: '2',
          senderId: 'wallet-sender-id',
          type: BeaconMessageType.Acknowledge
        },
        {
          origin: Origin.P2P,
          id: 'wallet-public-key'
        }
      )

      jest.advanceTimersByTime(10)
      await Promise.resolve()

      expect(rejection).not.toHaveBeenCalled()
      expect(channelClosedHandler).not.toHaveBeenCalled()
      expect((timeoutClient as any).openRequests.has('acknowledged-request-id')).toBe(true)
    } finally {
      ;(timeoutClient as any).clearOpenRequest('acknowledged-request-id')
      jest.useRealTimers()
    }
  })

  it('does not time out the walletconnect session_update marker', async () => {
    jest.useFakeTimers()
    ;(window as any).beaconCreatedClientInstance = false
    const timeoutClient = new DAppClient({
      name: 'TimeoutApp',
      storage: new LocalStorage(),
      preferredNetwork: NetworkType.MAINNET,
      requestTimeoutMs: 10
    })
    timeoutClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    const channelClosedHandler = jest.fn()
    timeoutClient.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, channelClosedHandler)

    const sessionUpdate = new ExposedPromise<unknown, unknown>()
    const rejection = jest.fn()
    void sessionUpdate.promise.catch(rejection)

    try {
      ;(timeoutClient as any).addOpenRequest('session_update', sessionUpdate)

      jest.advanceTimersByTime(10)
      await Promise.resolve()

      expect(rejection).not.toHaveBeenCalled()
      expect(channelClosedHandler).not.toHaveBeenCalled()
      expect((timeoutClient as any).openRequests.has('session_update')).toBe(true)
    } finally {
      ;(timeoutClient as any).clearOpenRequest('session_update')
      jest.useRealTimers()
    }
  })

  it('processes buffered Disconnect delivered during transport.connect() when restoring active account on startup', async () => {
    const publicKey = '11'.repeat(32)
    const senderId = await require('@ecadlabs/beacon-core').getSenderId(publicKey)
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
      getPeers: jest.fn().mockResolvedValue([p2pPeer]),
      removePeer: jest.fn().mockResolvedValue(undefined),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      connect: jest.fn().mockImplementation(async () => {
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

    const initInternalTransports = jest
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
    const { getSenderId: mockGetSenderId } = require('@ecadlabs/beacon-core')
    const pubKeyA = 'aa'.repeat(32)
    const pubKeyB = 'bb'.repeat(32)
    const senderIdA = 'sender-wallet-a'
    const senderIdB = 'sender-wallet-b'
    ;(mockGetSenderId as jest.Mock).mockImplementation(async (pk: string) => {
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
      getPeers: jest.fn().mockResolvedValue([peerA, peerB]),
      removePeer: jest.fn().mockResolvedValue(undefined)
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
      ;(mockGetSenderId as jest.Mock).mockResolvedValue('senderId')
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
      getPeers: jest.fn().mockResolvedValue([])
    }
    ;(client as any).p2pTransport = {
      type: TransportType.P2P,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: jest.fn().mockResolvedValue([activePeer])
    }
    ;(client as any).walletConnectTransport = {
      type: TransportType.WALLETCONNECT,
      connectionStatus: TransportStatus.CONNECTED,
      getPeers: jest.fn().mockResolvedValue([]),
      forceUpdate: jest.fn()
    }

    const setActiveAccountSpy = jest.spyOn(client, 'setActiveAccount')

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
    const setActiveAccountSpy = jest
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
    const senderId = await require('@ecadlabs/beacon-core').getSenderId(publicKey)
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
      getPeers: jest.fn().mockResolvedValue([p2pPeer]),
      removePeer: jest.fn().mockResolvedValue(undefined),
      removeAllPeers: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      connect: jest.fn().mockImplementation(async () => {
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

    const initInternalTransports = jest
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
      getPeers: jest.fn().mockResolvedValue([]),
      removePeer: jest.fn().mockResolvedValue(undefined)
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

  it.each(['account', 'peer'])('does not activate an account removed during startup by %s', async (removal) => {
    const account = createStoredAccount()
    const storage = new LocalStorage({
      [StorageKey.ACCOUNTS]: [account],
      [StorageKey.ACTIVE_ACCOUNT]: account.accountIdentifier
    })
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    const get = storage.get.bind(storage)
    let first = true
    jest.spyOn(storage, 'get').mockImplementation(async (key) => {
      const value = await get(key)
      if (key === StorageKey.ACCOUNTS && first) {
        first = false
        entered.resolve()
        await release.promise
      }
      return value
    })
    Reflect.set(window, 'beaconCreatedClientInstance', false)
    const restoring = new DAppClient({ name: 'Removing during restore', storage, disableDefaultEvents: true })
    jest.spyOn(restoring, 'initInternalTransports').mockResolvedValue(undefined)
    jest.spyOn(restoring, 'getPeer').mockResolvedValue(undefined)
    await entered.promise
    const removed = removal === 'account'
      ? restoring.removeAccount(account.accountIdentifier)
      : Reflect.get(restoring, 'removeAccountsForPeerIds').call(restoring, [account.senderId])
    for (let i = 0; i < 30; i++) await Promise.resolve()
    release.resolve()
    await Promise.all([removed, Reflect.get(restoring, 'activeAccountLoaded')])
    expect(await storage.get(StorageKey.ACCOUNTS)).toEqual([])
    expect(await storage.get(StorageKey.ACTIVE_ACCOUNT)).toBeUndefined()
    expect(await restoring.getActiveAccount()).toBeUndefined()
  })

  it('does not restore durable active pointer after a held write is cleared', async () => {
    await client.getActiveAccount()
    const account = createStoredAccount()
    const storage: LocalStorage = Reflect.get(client, 'storage')
    await storage.set(StorageKey.ACCOUNTS, [account])
    jest.spyOn(client, 'initInternalTransports').mockResolvedValue(undefined)
    jest.spyOn(client, 'getPeer').mockResolvedValue(createV480P2PPeer())
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    const set = storage.set.bind(storage)
    jest.spyOn(storage, 'set').mockImplementation(async (key, value) => {
      if (key === StorageKey.ACTIVE_ACCOUNT && value === account.accountIdentifier) {
        entered.resolve()
        await release.promise
      }
      return set(key, value)
    })
    const selection = client.setActiveAccount(account)
    await entered.promise
    const cleared = client.clearActiveAccount()
    for (let i = 0; i < 30; i++) await Promise.resolve()
    release.resolve()
    await Promise.all([selection, cleared])
    expect(await storage.get(StorageKey.ACTIVE_ACCOUNT)).toBeUndefined()
    expect(await client.getActiveAccount()).toBeUndefined()
  })

  it.each([
    ['lookup', 'remove'], ['write', 'remove'],
    ['lookup', 'disconnect'], ['write', 'disconnect'],
    ['lookup', 'destroy'], ['write', 'destroy']
  ])('does not restore durable accounts held at %s after %s', async (stage, teardown) => {
    const storage: LocalStorage = Reflect.get(client, 'storage')
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    await client.getActiveAccount()
    const get = storage.get.bind(storage)
    const set = storage.set.bind(storage)
    jest.spyOn(storage, 'get').mockImplementation(async (key) => {
      if (stage === 'lookup' && key === StorageKey.LAST_SELECTED_WALLET) { entered.resolve(); await release.promise }
      const result = await get(key)
      return key === StorageKey.ACCOUNTS ? result ?? [] : result
    })
    if (stage === 'write') {
      jest.spyOn(storage, 'set').mockImplementation(async (key, value) => {
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
    const removed = teardown === 'destroy'
      ? client.destroy()
      : teardown === 'disconnect'
        ? client.disconnect({ notifyPeers: false })
        : client.removeAllAccounts()
    // Let cleanup reach storage while the earlier operation remains held.
    for (let i = 0; i < 30; i++) await Promise.resolve()
    release.resolve()
    await Promise.all([change, removed])
    expect((await storage.get(StorageKey.ACCOUNTS)) ?? []).toEqual([])
    expect(await storage.get(StorageKey.ACTIVE_ACCOUNT)).toBeUndefined()
    if (teardown === 'destroy') {
      await expect(client.getActiveAccount()).rejects.toThrow('destroyed')
    } else {
      expect(await client.getActiveAccount()).toBeUndefined()
    }
  })

  it('does not overwrite active account when a peer switch occurs while ChangeAccountRequest is awaiting storage in onNewAccount', async () => {
    const { getSenderId: mockGetSenderId } = require('@ecadlabs/beacon-core')
    const pubKeyA = 'aa'.repeat(32)
    const pubKeyB = 'bb'.repeat(32)
    const senderIdA = 'sender-wallet-a'
    const senderIdB = 'sender-wallet-b'
    ;(mockGetSenderId as jest.Mock).mockImplementation(async (pk: string) => {
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
    const addAccountSpy = jest
      .spyOn((client as any).accountManager, 'addAccount')
      .mockImplementationOnce(async (account: any) => {
        await new Promise<void>((resolve) => {
          releaseAddAccount = resolve
          entered.resolve()
        })
        return originalAddAccount(account)
      })
    const initTransportsSpy = jest
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
      ;(mockGetSenderId as jest.Mock).mockImplementation(async (pk: string) =>
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
    const addAccountSpy = jest
      .spyOn((client as any).accountManager, 'addAccount')
      .mockImplementationOnce(async (account: any) => {
        await new Promise<void>((resolve) => {
          releaseFirstAdd = resolve
          entered.resolve()
        })
        return originalAddAccount(account)
      })
    const initTransportsSpy = jest
      .spyOn(client as any, 'initInternalTransports')
      .mockResolvedValue(undefined)
    const getPeerSpy = jest.spyOn(client as any, 'getPeer').mockResolvedValue(wcPeer)

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
    const { getSenderId: mockGetSenderId } = require('@ecadlabs/beacon-core')
    const pubKeyA = 'aa'.repeat(32)
    const pubKeyB = 'bb'.repeat(32)
    const senderIdA = 'sender-wallet-a'
    const senderIdB = 'sender-wallet-b'
    ;(mockGetSenderId as jest.Mock).mockImplementation(async (pk: string) => {
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
    const invalidStateSpy = jest
      .spyOn(client as any, 'isInvalidState')
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseInvalidStateCheck = resolve
          entered.resolve()
        })
        return false
      })
    const initTransportsSpy = jest
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
      ;(mockGetSenderId as jest.Mock).mockResolvedValue('senderId')
    }
  })

  it('does not overwrite a newer active peer or transport when setActivePeer awaits initInternalTransports', async () => {
    const peerA = {
      ...createV480P2PPeer(),
      type: 'p2p-pairing-response' as const,
      id: 'peer-a',
      publicKey: 'aa'.repeat(32),
      senderId: 'sender-a',
      name: 'Wallet A'
    }
    const peerB = {
      ...createV480P2PPeer(),
      type: 'p2p-pairing-response' as const,
      id: 'peer-b',
      publicKey: 'bb'.repeat(32),
      senderId: 'sender-b',
      name: 'Wallet B'
    }

    let releaseInit!: () => void
    const initTransportsSpy = jest
      .spyOn(client as any, 'initInternalTransports')
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseInit = resolve
        })
      })
      .mockResolvedValue(undefined)
    const setTransportSpy = jest.spyOn(client as any, 'setTransport').mockResolvedValue(undefined)

    try {
      const firstSetPeer = (client as any).setActivePeer(peerA)
      for (let i = 0; i < 10 && !releaseInit; i++) {
        await Promise.resolve()
      }
      expect(releaseInit).toBeDefined()

      await (client as any).setActivePeer(peerB)
      expect(setTransportSpy).toHaveBeenCalledTimes(1)

      releaseInit()
      await firstSetPeer

      expect(setTransportSpy).toHaveBeenCalledTimes(1)
      const resolvedPeer = await (client as any)._activePeer.promise
      expect(resolvedPeer).toEqual(peerB)
    } finally {
      initTransportsSpy.mockRestore()
      setTransportSpy.mockRestore()
    }
  })
})
