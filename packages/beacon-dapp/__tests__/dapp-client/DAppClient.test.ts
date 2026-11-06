// __tests__/DAppClient.test.ts
import { DAppClient } from '../../src/dapp-client/DAppClient'
import {
  AccountInfo,
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
import { LocalStorage } from '@ecadlabs/beacon-core'
import { WalletConnectTransport } from '@ecadlabs/beacon-transport-walletconnect'
import { BeaconEvent } from '../../src/events'
import { DappPostMessageTransport } from '../../src/transports/DappPostMessageTransport'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'
import { PostMessageTransport } from '@ecadlabs/beacon-transport-postmessage'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { getDAppClientInstance } from '../../src/utils/get-instance'

const mockLoggerWarn = jest.fn()
const mockLoggerError = jest.fn()
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
    generateGUID: jest.fn().mockResolvedValue('guid'),
    getSenderId: jest.fn().mockResolvedValue('senderId'),
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
    },
    getError: (_t: any, _d: any) => new Error('beacon error')
  }
})

jest.mock('@walletconnect/sign-client', () => ({}))
jest.mock('@walletconnect/types', () => ({}))
jest.mock('@walletconnect/utils', () => ({ getSdkError: jest.fn() }))

describe('DAppClient — basic unit tests', () => {
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
          senderId: 'wallet-sender-id',
          type: BeaconMessageType.Disconnect
        },
        {
          origin: Origin.P2P,
          id: 'wallet-public-key'
        }
      )
    ).resolves.toBeUndefined()

    expect(removeAccountsForPeerIds).toHaveBeenCalledWith(['wallet-sender-id'])
    expect(channelClosedHandler).toHaveBeenCalled()

    removeAccountsForPeerIds.mockRestore()
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
    const initialize = jest.spyOn(client, 'initInternalTransports').mockResolvedValue(undefined)

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
    jest.spyOn(storedStateClient as any, 'onNewAccount').mockResolvedValue(accountInfo)
    jest.spyOn(storedStateClient as any, 'notifySuccess').mockResolvedValue(undefined)
    jest.spyOn(storedStateClient as any, 'getWalletInfo').mockResolvedValue({})
    jest.spyOn((storedStateClient as any).accountManager, 'addAccount').mockResolvedValue(undefined)

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
    const disconnectP2P = jest.fn().mockResolvedValue(undefined)
    const initInternalTransports = jest
      .spyOn(DAppClient.prototype as any, 'initInternalTransports')
      .mockImplementation(async function (this: any) {
        this.p2pTransport = {
          connectionStatus: TransportStatus.CONNECTED,
          getPeers: jest.fn().mockResolvedValue([p2pPeer]),
          disconnect: disconnectP2P
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

  it.each(['valid', 'unknown', 'closed'])(
    'handles a %s ACK without clearing unrelated request timeouts',
    async (ackKind) => {
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

        if (ackKind === 'closed') {
          timeoutClient['addOpenRequest']('closed-request-id', new ExposedPromise())
          timeoutClient['clearOpenRequest']('closed-request-id')
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

        jest.advanceTimersByTime(10)
        await Promise.resolve()

        if (ackKind === 'valid') {
          expect(rejection).not.toHaveBeenCalled()
          expect(channelClosedHandler).not.toHaveBeenCalled()
          expect(timeoutClient['openRequests'].has('acknowledged-request-id')).toBe(true)
        } else {
          expect(rejection).toHaveBeenCalledWith(
            expect.objectContaining({
              id: 'acknowledged-request-id',
              errorType: BeaconErrorType.PEER_UNREACHABLE
            })
          )
          expect(channelClosedHandler).toHaveBeenCalledTimes(1)
          expect(timeoutClient['openRequests'].has('acknowledged-request-id')).toBe(false)
        }
      } finally {
        ;(timeoutClient as any).clearOpenRequest('acknowledged-request-id')
        jest.useRealTimers()
      }
    }
  )

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
    jest.spyOn(transport, 'connect').mockImplementation(async () => {
      entered.resolve()
      await release.promise
    })
    jest
      .spyOn(transport, 'getPeers')
      .mockResolvedValue([{ ...createV480P2PPeer(), type: 'p2p-pairing-response' }])
    jest.spyOn(transport, 'removeAllPeers').mockResolvedValue(undefined)
    jest.spyOn(transport, 'disconnect').mockResolvedValue(undefined)
    jest.spyOn(transport, 'removePeer').mockResolvedValue(undefined)
    let incoming: Parameters<DappP2PTransport['addListener']>[0] | undefined
    jest.spyOn(transport, 'addListener').mockImplementation(async (listener) => {
      incoming = listener
    })
    const selected = jest.fn()
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
        jest.requireActual<typeof import('@ecadlabs/beacon-core')>('@ecadlabs/beacon-core')
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
    jest.spyOn(transport, 'connect').mockImplementationOnce(async () => {
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
      jest.spyOn(storage, 'set').mockImplementation(async (key, value) => {
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
      jest.spyOn(storage, 'get').mockImplementation(async (key) => {
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
      jest.spyOn(storage, 'set').mockImplementation(async (key, value) => {
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
    const settled = jest.fn()
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
    const settled = jest.fn()
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
    const write = jest.spyOn(storage, 'set')
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
      const write = jest.spyOn(storage, 'set')
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
    const write = jest.spyOn(storage, 'set')
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
    jest.spyOn(storage, 'set').mockImplementation(async (key, value) => {
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
    const disconnect = jest.spyOn(transport, 'disconnect')
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
    jest.spyOn(storage, 'set').mockImplementation(async (key, value) => {
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
    jest.spyOn(transport, 'connect').mockRejectedValueOnce(failure)
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
    jest.spyOn(storage, 'set').mockImplementation(async (key, value) => {
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
    const writeCount = jest.mocked(storage.set).mock.calls.length
    await startup
    expect(jest.mocked(storage.set).mock.calls).toHaveLength(writeCount)
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
    jest.spyOn(transport, 'connect').mockRejectedValueOnce(failure)
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
    jest.spyOn(transport, 'addListener').mockImplementation(async () => {
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
    const extensions = jest
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
        jest.spyOn(transport, 'connect').mockResolvedValue(undefined)
        jest.spyOn(transport, 'disconnect').mockResolvedValue(undefined)
        jest.spyOn(transport, 'getPeers').mockResolvedValue([])
        jest.spyOn(transport, 'removeAllPeers').mockResolvedValue(undefined)
        jest.spyOn(transport, 'stopListeningForNewPeers').mockResolvedValue(undefined)
      }
      jest.spyOn(post, 'getPairingRequestInfo').mockResolvedValue({
        id: 'post',
        type: 'postmessage-pairing-request',
        name: 'Old pairing',
        publicKey: 'post-key',
        version: '4'
      })
      jest.spyOn(p2p, 'getPairingRequestInfo').mockResolvedValue({
        id: 'p2p',
        type: 'p2p-pairing-request',
        name: 'Old pairing',
        publicKey: 'p2p-key',
        version: '4',
        relayServer: 'matrix.example.com'
      })
      let retained: Parameters<DappPostMessageTransport['listenForNewPeer']>[0] | undefined
      const registered = new ExposedPromise<void>()
      jest.spyOn(post, 'listenForNewPeer').mockImplementation(async (callback) => {
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
      const paired = jest.fn()
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
        jest.mocked(transport.stopListeningForNewPeers).mockClear()
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
      jest.spyOn(wc, 'forceUpdate').mockReturnValue(undefined)
      const walletConnectAccount = createStoredAccount()
      walletConnectAccount.origin.type = Origin.WALLETCONNECT
      await pairingClient.setActiveAccount(walletConnectAccount)
      for (const transport of [post, p2p, wc]) {
        jest.mocked(transport.disconnect).mockClear()
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
    jest.spyOn(transport, 'connect').mockRejectedValueOnce(failure)
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
    jest.spyOn(startupClient, 'getAccount').mockRejectedValueOnce(failure)
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
