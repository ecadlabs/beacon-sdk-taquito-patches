import type { Mocked, MockInstance } from 'vitest'
// __tests__/client/WalletClient.test.ts

import { Client, LocalStorage, Serializer } from '@ecadlabs/beacon-core'
import { BeaconMessageType, Origin, StorageKey, TransportStatus } from '@ecadlabs/beacon-types'
import { WalletClient } from '../../src/client/WalletClient'
import { WalletP2PTransport } from '../../src/transports/WalletP2PTransport'

const fetchMock = vi.fn()
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
  }) as unknown as Response

// Stub out all of beacon-utils, including generateGUID
vi.mock('@ecadlabs/beacon-utils', () => ({
  ExposedPromise: class {
    public promise = new Promise<boolean>(() => {})
    public resolve = vi.fn()
  },
  toHex: vi.fn().mockReturnValue('abcd'),
  generateGUID: vi.fn().mockReturnValue('guid-123')
}))

// Stub everything from beacon-core *except* Client, so subclassing still works
vi.mock('@ecadlabs/beacon-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecadlabs/beacon-core')>()
  return {
    ...actual,
    LocalStorage: vi.fn().mockImplementation(function () {
      return {
        get: vi.fn().mockResolvedValue([]),
        set: vi.fn().mockResolvedValue(undefined)
      }
    }),
    PermissionManager: vi.fn().mockImplementation(function () {
      return {
        getPermissions: vi.fn().mockResolvedValue([]),
        getPermission: vi.fn(),
        removePermissions: vi.fn(),
        removePermission: vi.fn(),
        removeAllPermissions: vi.fn()
      }
    }),
    AppMetadataManager: vi.fn().mockImplementation(function () {
      return {
        getAppMetadataList: vi.fn(),
        getAppMetadata: vi.fn(),
        removeAppMetadata: vi.fn(),
        removeAllAppMetadata: vi.fn()
      }
    }),
    getSenderId: vi.fn().mockResolvedValue('sender-id'),
    Logger: vi.fn().mockImplementation(function () {
      return {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      }
    })
  }
})

vi.mock('../../src/transports/WalletP2PTransport')
vi.mock('../../src/interceptors/IncomingRequestInterceptor')
vi.mock('../../src/interceptors/OutgoingResponseInterceptor')

describe('WalletClient', () => {
  const backendUrl = 'https://my.backend'
  const accountKey = 'account-pubkey'
  const oracleUrl = 'https://oracle.test'

  let client: WalletClient
  let storage: Mocked<LocalStorage>
  let initSpy: MockInstance<(...args: [any?]) => Promise<any>>

  beforeEach(() => {
    vi.clearAllMocks()

    // Silence the multiple‐instances warning in BeaconClient constructor
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // Spy on super.init() so we don’t actually initialize anything real
    initSpy = vi.spyOn(Client.prototype, 'init').mockResolvedValue('transport-type' as any)

    storage = new LocalStorage() as any
    client = new WalletClient({ name: 'test-client', storage })

    // *** Stub the keyPair getter so `await this.keyPair` in init() resolves immediately ***
    vi.spyOn(client as any, 'keyPair', 'get').mockReturnValue(
      Promise.resolve({ publicKey: 'pub', secretKey: 'sec' } as any)
    )
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
      vi.spyOn(client as any, 'getPeerInfo').mockResolvedValue(extended)

      const transportMock = { addPeer: vi.fn().mockResolvedValue(undefined) }
      vi.spyOn(client as any, 'transport', 'get').mockReturnValue(
        Promise.resolve(transportMock as any)
      )

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
        getPeers: vi.fn().mockImplementation(async () => peers),
        removePeer: vi.fn().mockImplementation(async (peer) => {
          peers = peers.filter((existingPeer) => existingPeer.publicKey !== peer.publicKey)
        }),
        disconnect: vi.fn()
      }

      vi.spyOn(client as any, 'transport', 'get').mockReturnValue(
        Promise.resolve(transportMock as any)
      )
      vi.spyOn(client as any, '_connect').mockResolvedValue(undefined)

      return { peerA, peerB, transportMock }
    }

    it('handles inbound disconnect for one peer without tearing down the transport', async () => {
      const { peerA, peerB, transportMock } = createConnectedTransport()
      const disconnectListener = vi.fn()
      const newMessageCallback = vi.fn()

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
      const disconnectListener = vi.fn()

      client.subscribeToDisconnect(disconnectListener)

      await client.connect(vi.fn())
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
      const disconnectListener = vi.fn()

      client.subscribeToDisconnect(disconnectListener)

      await client.connect(vi.fn())
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
      const disconnectListener = vi.fn()

      client.subscribeToDisconnect(disconnectListener)

      await client.connect(vi.fn())
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
      const disconnectListener = vi.fn()
      const cleanupError = new Error('cleanup failed')

      transportMock.removePeer.mockRejectedValueOnce(cleanupError)
      client.subscribeToDisconnect(disconnectListener)

      await client.connect(vi.fn())
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
      const rejectedListener = vi.fn().mockRejectedValue(new Error('listener failed'))
      const nextListener = vi.fn().mockResolvedValue(undefined)

      client.subscribeToDisconnect(rejectedListener)
      client.subscribeToDisconnect(nextListener)

      await client.connect(vi.fn())
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
      const throwingListener = vi.fn(() => {
        throw new Error('listener failed')
      })
      const nextListener = vi.fn()

      client.subscribeToDisconnect(throwingListener)
      client.subscribeToDisconnect(nextListener)

      await client.connect(vi.fn())
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
      const disconnectListener = vi.fn()

      client.subscribeToDisconnect(disconnectListener)
      client.subscribeToDisconnect(disconnectListener)

      await client.connect(vi.fn())
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

    it('returns idempotent disconnect cleanup that preserves other listeners', async () => {
      const { peerA } = createConnectedTransport()
      const listener = vi.fn()
      const other = vi.fn()
      const unsubscribe = client.subscribeToDisconnect(listener)
      client.subscribeToDisconnect(other)
      expect(unsubscribe).toBeTypeOf('function')
      unsubscribe()
      unsubscribe()

      await client.connect(vi.fn())
      await client['handleResponse'](
        { id: 'disconnect', type: BeaconMessageType.Disconnect, version: '2', senderId: 'sender-a' },
        { id: peerA.publicKey, origin: Origin.P2P }
      )
      expect(listener).not.toHaveBeenCalled()
      expect(other).toHaveBeenCalledWith('sender-a')
    })

    it.each(['cleanup', 'identity'] as const)(
      'keeps a new disconnect subscription when stale cleanup follows removal by %s',
      async (removal) => {
        const { peerA } = createConnectedTransport()
        const listener = vi.fn()
        const first = client.subscribeToDisconnect(listener)
        const duplicate = client.subscribeToDisconnect(listener)
        expect(first).toBeTypeOf('function')
        expect(duplicate).toBeTypeOf('function')
        if (removal === 'cleanup') first()
        else client.unsubscribeFromDisconnect(listener)

        const current = client.subscribeToDisconnect(listener)
        first()
        duplicate()
        await client.connect(vi.fn())
        await client['handleResponse'](
          { id: 'disconnect', type: BeaconMessageType.Disconnect, version: '2', senderId: 'sender-a' },
          { id: peerA.publicKey, origin: Origin.P2P }
        )
        expect(listener).toHaveBeenCalledTimes(1)
        current()
      }
    )

    it('unsubscribes disconnect listeners by identity', async () => {
      const { peerA } = createConnectedTransport()
      const disconnectListener = vi.fn()

      client.subscribeToDisconnect(disconnectListener)
      client.unsubscribeFromDisconnect(disconnectListener)

      await client.connect(vi.fn())
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
  it('propagates response handling failures through its transport subscription', async () => {
    const transport = {
      connectionStatus: TransportStatus.NOT_CONNECTED,
      connect: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue(undefined)
    }
    vi.spyOn(client as any, 'transport', 'get').mockResolvedValue(transport)
    const failure = new Error('response handler failed')
    ;(client as any).handleResponse = vi.fn().mockRejectedValue(failure)
    const deserialize = vi
      .spyOn(Serializer.prototype, 'deserialize')
      .mockResolvedValue({ id: 'request' } as any)
    try {
      await client._connect()
      const receive = transport.addListener.mock.calls[0][0]
      await expect(receive('serialized', { origin: 'p2p', id: 'peer' })).rejects.toBe(failure)
    } finally {
      deserialize.mockRestore()
    }
  })
  it('delivers requests emitted during connect and keeps one listener after retry', async () => {
    const listeners = new Set<any>()
    const request = { id: 'startup-request' }
    const context = { origin: 'p2p', id: 'peer' }
    const transport = {
      type: 'p2p',
      connectionStatus: TransportStatus.NOT_CONNECTED,
      addListener: vi.fn(async (listener: any) => {
        listeners.add(listener)
      }),
      removeListener: vi.fn(async (listener: any) => {
        listeners.delete(listener)
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi
        .fn()
        .mockRejectedValueOnce(new Error('retry connection'))
        .mockImplementationOnce(async () => {
          for (const listener of listeners) await listener('serialized', context)
        })
    }
    vi.spyOn(client as any, 'transport', 'get').mockResolvedValue(transport)
    const handler = vi.fn().mockResolvedValue(undefined)
    ;(client as any).handleResponse = handler
    const deserialize = vi
      .spyOn(Serializer.prototype, 'deserialize')
      .mockResolvedValue(request as any)
    try {
      await client._connect()
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(request, context, transport.type)
      expect(listeners.size).toBe(1)
      expect(transport.removeListener).toHaveBeenCalledTimes(1)
    } finally {
      deserialize.mockRestore()
    }
  })
})
