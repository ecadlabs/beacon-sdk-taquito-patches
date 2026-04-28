// __tests__/client/WalletClient.test.ts

import { Client, LocalStorage } from '@ecadlabs/beacon-core'
import { BeaconMessageType, StorageKey, TransportStatus } from '@ecadlabs/beacon-types'
import { WalletClient } from '../../src/client/WalletClient'
import { WalletP2PTransport } from '../../src/transports/WalletP2PTransport'

const fetchMock = jest.fn()
const originalFetch = global.fetch
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch
})
afterAll(() => {
  global.fetch = originalFetch
})
beforeEach(() => {
  fetchMock.mockReset()
})

const jsonResponse = <T>(data: T): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data
  } as unknown as Response)

// Stub out all of beacon-utils, including generateGUID
jest.mock('@ecadlabs/beacon-utils', () => ({
  ExposedPromise: class {
    public promise = new Promise<boolean>(() => {})
    public resolve = jest.fn()
  },
  toHex: jest.fn().mockReturnValue('abcd'),
  generateGUID: jest.fn().mockReturnValue('guid-123')
}))

// Stub everything from beacon-core *except* Client, so subclassing still works
jest.mock('@ecadlabs/beacon-core', () => {
  const actual = jest.requireActual('@ecadlabs/beacon-core')
  return {
    ...actual,
    LocalStorage: jest.fn().mockImplementation(() => ({
      get: jest.fn().mockResolvedValue([]),
      set: jest.fn().mockResolvedValue(undefined)
    })),
    PermissionManager: jest.fn().mockImplementation(() => ({
      getPermissions: jest.fn().mockResolvedValue([]),
      getPermission: jest.fn(),
      removePermissions: jest.fn(),
      removePermission: jest.fn(),
      removeAllPermissions: jest.fn()
    })),
    AppMetadataManager: jest.fn().mockImplementation(() => ({
      getAppMetadataList: jest.fn(),
      getAppMetadata: jest.fn(),
      removeAppMetadata: jest.fn(),
      removeAllAppMetadata: jest.fn()
    })),
    getSenderId: jest.fn().mockResolvedValue('sender-id'),
    Logger: jest.fn().mockImplementation(() => ({
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }))
  }
})

jest.mock('../../src/transports/WalletP2PTransport')
jest.mock('../../src/interceptors/IncomingRequestInterceptor')
jest.mock('../../src/interceptors/OutgoingResponseInterceptor')

describe('WalletClient', () => {
  const backendUrl = 'https://my.backend'
  const accountKey = 'account-pubkey'
  const oracleUrl = 'https://oracle.test'

  let client: WalletClient
  let storage: jest.Mocked<LocalStorage>
  let initSpy: jest.SpyInstance<Promise<any>, [any?]>

  beforeEach(() => {
    jest.clearAllMocks()

    // Silence the multiple‐instances warning in BeaconClient constructor
    jest.spyOn(console, 'error').mockImplementation(() => {})

    // Spy on super.init() so we don’t actually initialize anything real
    initSpy = jest.spyOn(Client.prototype, 'init').mockResolvedValue('transport-type' as any)

    storage = new LocalStorage() as any
    client = new WalletClient({ name: 'test-client', storage })

    // *** Stub the keyPair getter so `await this.keyPair` in init() resolves immediately ***
    jest
      .spyOn(client as any, 'keyPair', 'get')
      .mockReturnValue(Promise.resolve({ publicKey: 'pub', secretKey: 'sec' } as any))
  })

  describe('init()', () => {
    it('should call super.init with a P2P transport and return its result', async () => {
      const transportType = await client.init()

      expect(transportType).toBe('transport-type')
      expect(initSpy).toHaveBeenCalledWith(expect.any(WalletP2PTransport))
      expect(WalletP2PTransport).toHaveBeenCalledWith(
        'test-client',
        expect.anything(),
        storage,
        (client as any).matrixNodes,
        client.iconUrl,
        client.appUrl
      )
    })
  })

  describe('getRegisterPushChallenge()', () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue(
        jsonResponse({ id: 'challenge-id', timestamp: '2025-04-24T12:00:00Z' })
      )
    })

    it('fetches a challenge and builds payload correctly', async () => {
      const { challenge, payloadToSign } = await client.getRegisterPushChallenge(
        backendUrl,
        accountKey,
        oracleUrl
      )

      expect(fetchMock).toHaveBeenCalledWith(`${oracleUrl}/challenge`)
      expect(challenge).toEqual({ id: 'challenge-id', timestamp: '2025-04-24T12:00:00Z' })
      // toHex is mocked to 'abcd'
      expect(payloadToSign).toBe('050100000004abcd')
    })
  })

  describe('registerPush()', () => {
    const challenge = { id: 'cid', timestamp: 'ts' }
    const signature = 'sig'
    const protocol = 'tezos'
    const deviceId = 'dev-123'

    it('returns existing token if found in storage', async () => {
      const existing = {
        publicKey: accountKey,
        backendUrl,
        accessToken: 'a1',
        managementToken: 'm1'
      }
      storage.get.mockResolvedValue([existing])

      const result = await client.registerPush(
        challenge,
        signature,
        backendUrl,
        accountKey,
        protocol,
        deviceId,
        oracleUrl
      )

      expect(storage.get).toHaveBeenCalledWith(StorageKey.PUSH_TOKENS)
      expect(result).toBe(existing)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('registers new token when none exists', async () => {
      storage.get.mockResolvedValue([])
      fetchMock.mockResolvedValue(
        jsonResponse({
          accessToken: 'newA',
          managementToken: 'newM',
          message: 'ok',
          success: true
        })
      )

      const result = await client.registerPush(
        challenge,
        signature,
        backendUrl,
        accountKey,
        protocol,
        deviceId,
        oracleUrl
      )

      expect(fetchMock).toHaveBeenCalledWith(`${oracleUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test-client',
          challenge,
          accountPublicKey: accountKey,
          signature,
          backendUrl,
          protocolIdentifier: protocol,
          deviceId
        })
      })
      expect(storage.set).toHaveBeenCalledWith(StorageKey.PUSH_TOKENS, [
        {
          publicKey: accountKey,
          backendUrl,
          accessToken: 'newA',
          managementToken: 'newM'
        }
      ])
      expect(result).toEqual({
        publicKey: accountKey,
        backendUrl,
        accessToken: 'newA',
        managementToken: 'newM'
      })
    })
  })

  describe('respond()', () => {
    it('throws if no matching pending request', async () => {
      await expect(client.respond({ id: 'nope', type: 0 } as any)).rejects.toThrow(
        'No matching request found!'
      )
    })
  })

  describe('addPeer()', () => {
    it('forwards peer info to transport.addPeer()', async () => {
      const fakePeer = { id: '1', name: 'p', publicKey: 'pk', version: '2' } as any
      const extended = { senderId: 'sender-id', ...fakePeer }
      jest.spyOn(client as any, 'getPeerInfo').mockResolvedValue(extended)

      const transportMock = { addPeer: jest.fn().mockResolvedValue(undefined) }
      jest
        .spyOn(client as any, 'transport', 'get')
        .mockReturnValue(Promise.resolve(transportMock as any))

      await client.addPeer(fakePeer)
      expect(transportMock.addPeer).toHaveBeenCalledWith(extended, true)
    })
  })

  describe('connect()', () => {
    const createConnectedTransport = () => {
      const peerA = {
        id: 'peer-a',
        name: 'Peer A',
        publicKey: 'public-key-a',
        version: '2',
        senderId: 'sender-a'
      } as any
      const peerB = {
        id: 'peer-b',
        name: 'Peer B',
        publicKey: 'public-key-b',
        version: '2',
        senderId: 'sender-b'
      } as any
      let peers = [peerA, peerB]

      const transportMock = {
        connectionStatus: TransportStatus.CONNECTED,
        getPeers: jest.fn().mockImplementation(async () => peers),
        removePeer: jest.fn().mockImplementation(async (peer) => {
          peers = peers.filter((existingPeer) => existingPeer.publicKey !== peer.publicKey)
        }),
        disconnect: jest.fn()
      }

      jest
        .spyOn(client as any, 'transport', 'get')
        .mockReturnValue(Promise.resolve(transportMock as any))
      jest.spyOn(client as any, '_connect').mockResolvedValue(undefined)

      return { peerA, peerB, transportMock }
    }

    it('handles inbound disconnect for one peer without tearing down the transport', async () => {
      const { peerA, peerB, transportMock } = createConnectedTransport()
      const disconnectListener = jest.fn()
      const newMessageCallback = jest.fn()

      client.subscribeToDisconnect(disconnectListener)

      await client.connect(newMessageCallback)
      await (client as any).handleResponse(
        {
          id: 'disconnect-message',
          type: BeaconMessageType.Disconnect,
          version: '2',
          senderId: 'sender-a'
        },
        { id: peerA.publicKey } as any
      )

      expect(await client.getPeers()).toEqual([peerB])
      expect(transportMock.removePeer).toHaveBeenCalledWith(peerA)
      expect(transportMock.disconnect).not.toHaveBeenCalled()
      expect(transportMock.connectionStatus).toBe(TransportStatus.CONNECTED)
      expect(disconnectListener).toHaveBeenCalledWith('sender-a')
      expect(newMessageCallback).not.toHaveBeenCalled()
    })

    it('handles flat v3 disconnect messages', async () => {
      const { peerA, peerB, transportMock } = createConnectedTransport()
      const disconnectListener = jest.fn()

      client.subscribeToDisconnect(disconnectListener)

      await client.connect(jest.fn())
      await (client as any).handleResponse(
        {
          id: 'disconnect-message',
          type: BeaconMessageType.Disconnect,
          version: '3',
          senderId: 'sender-a'
        },
        { id: peerA.publicKey } as any
      )

      expect(await client.getPeers()).toEqual([peerB])
      expect(transportMock.removePeer).toHaveBeenCalledWith(peerA)
      expect(transportMock.disconnect).not.toHaveBeenCalled()
      expect(disconnectListener).toHaveBeenCalledWith('sender-a')
    })

    it('handles wrapped v3 disconnect messages', async () => {
      const { peerA, peerB, transportMock } = createConnectedTransport()
      const disconnectListener = jest.fn()

      client.subscribeToDisconnect(disconnectListener)

      await client.connect(jest.fn())
      await (client as any).handleResponse(
        {
          id: 'disconnect-message',
          version: '3',
          senderId: 'sender-a',
          message: {
            type: BeaconMessageType.Disconnect
          }
        },
        { id: peerA.publicKey } as any
      )

      expect(await client.getPeers()).toEqual([peerB])
      expect(transportMock.removePeer).toHaveBeenCalledWith(peerA)
      expect(transportMock.disconnect).not.toHaveBeenCalled()
      expect(disconnectListener).toHaveBeenCalledWith('sender-a')
    })

    it('does not notify disconnect listeners for an unknown sender', async () => {
      const { peerA, peerB, transportMock } = createConnectedTransport()
      const disconnectListener = jest.fn()

      client.subscribeToDisconnect(disconnectListener)

      await client.connect(jest.fn())
      await (client as any).handleResponse(
        {
          id: 'disconnect-message',
          type: BeaconMessageType.Disconnect,
          version: '2',
          senderId: 'unknown-sender'
        },
        { id: peerA.publicKey } as any
      )

      expect(await client.getPeers()).toEqual([peerA, peerB])
      expect(transportMock.removePeer).not.toHaveBeenCalled()
      expect(transportMock.disconnect).not.toHaveBeenCalled()
      expect(disconnectListener).not.toHaveBeenCalled()
    })

    it('notifies disconnect listeners even if peer cleanup fails', async () => {
      const { peerA, transportMock } = createConnectedTransport()
      const disconnectListener = jest.fn()
      const cleanupError = new Error('cleanup failed')

      transportMock.removePeer.mockRejectedValueOnce(cleanupError)
      client.subscribeToDisconnect(disconnectListener)

      await client.connect(jest.fn())
      await expect(
        (client as any).handleResponse(
          {
            id: 'disconnect-message',
            type: BeaconMessageType.Disconnect,
            version: '2',
            senderId: 'sender-a'
          },
          { id: peerA.publicKey } as any
        )
      ).rejects.toThrow(cleanupError)

      expect(disconnectListener).toHaveBeenCalledWith('sender-a')
      expect(transportMock.disconnect).not.toHaveBeenCalled()
    })

    it('continues notifying disconnect listeners after an async listener rejects', async () => {
      const { peerA } = createConnectedTransport()
      const rejectedListener = jest.fn().mockRejectedValue(new Error('listener failed'))
      const nextListener = jest.fn().mockResolvedValue(undefined)

      client.subscribeToDisconnect(rejectedListener)
      client.subscribeToDisconnect(nextListener)

      await client.connect(jest.fn())
      await (client as any).handleResponse(
        {
          id: 'disconnect-message',
          type: BeaconMessageType.Disconnect,
          version: '2',
          senderId: 'sender-a'
        },
        { id: peerA.publicKey } as any
      )

      expect(rejectedListener).toHaveBeenCalledWith('sender-a')
      expect(nextListener).toHaveBeenCalledWith('sender-a')
    })

    it('continues notifying disconnect listeners after a sync listener throws', async () => {
      const { peerA } = createConnectedTransport()
      const throwingListener = jest.fn(() => {
        throw new Error('listener failed')
      })
      const nextListener = jest.fn()

      client.subscribeToDisconnect(throwingListener)
      client.subscribeToDisconnect(nextListener)

      await client.connect(jest.fn())
      await (client as any).handleResponse(
        {
          id: 'disconnect-message',
          type: BeaconMessageType.Disconnect,
          version: '2',
          senderId: 'sender-a'
        },
        { id: peerA.publicKey } as any
      )

      expect(throwingListener).toHaveBeenCalledWith('sender-a')
      expect(nextListener).toHaveBeenCalledWith('sender-a')
    })

    it('deduplicates disconnect subscriptions by listener identity', async () => {
      const { peerA } = createConnectedTransport()
      const disconnectListener = jest.fn()

      client.subscribeToDisconnect(disconnectListener)
      client.subscribeToDisconnect(disconnectListener)

      await client.connect(jest.fn())
      await (client as any).handleResponse(
        {
          id: 'disconnect-message',
          type: BeaconMessageType.Disconnect,
          version: '2',
          senderId: 'sender-a'
        },
        { id: peerA.publicKey } as any
      )

      expect(disconnectListener).toHaveBeenCalledTimes(1)
    })

    it('unsubscribes disconnect listeners by identity', async () => {
      const { peerA } = createConnectedTransport()
      const disconnectListener = jest.fn()

      client.subscribeToDisconnect(disconnectListener)
      client.unsubscribeFromDisconnect(disconnectListener)

      await client.connect(jest.fn())
      await (client as any).handleResponse(
        {
          id: 'disconnect-message',
          type: BeaconMessageType.Disconnect,
          version: '2',
          senderId: 'sender-a'
        },
        { id: peerA.publicKey } as any
      )

      expect(disconnectListener).not.toHaveBeenCalled()
    })
  })
})
