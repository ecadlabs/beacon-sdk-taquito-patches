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
import { BeaconEvent } from '../../src/events'

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
    // a minimal in-memory LocalStorage stub
    LocalStorage: class {
      private store = new Map<string, any>()
      async get(key: string) {
        return this.store.get(key)
      }
      async set(key: string, value: any) {
        this.store.set(key, value)
      }
      subscribeToStorageChanged(_cb: any) {
        /* no op */
      }
      getPrefixedKey(key: string) {
        return key
      }
    },
    // StorageValidator always “valid”
    StorageValidator: class {
      constructor(_s: any) {}
      validate() {
        return Promise.resolve(true)
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
      postMessage(_msg: any) {}
    },
    BACKEND_URL: '',
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

  it('addQueryParam returns "key=value"', () => {
    // addQueryParam is private — cast to any to reach it
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

  it('rejects a pending init with different pairing options', async () => {
    ;(client as any)._initPromise = new Promise(() => {})
    ;(client as any)._initReject = jest.fn()
    ;(client as any)._initSubstratePairing = false

    await expect((client as any).init(undefined, true)).rejects.toThrow(
      'Cannot start a permission request with different pairing options while another pairing is pending'
    )
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
})
