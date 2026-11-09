import { PostMessageClient } from '../../../beacon-transport-postmessage/src/PostMessageClient'
import { Serializer, getSenderId, PendingPairingRequests, windowRef } from '@ecadlabs/beacon-core'
// __tests__/communication-client/P2PCommunicationClient.test.ts

// Mock external dependencies
jest.mock('@ecadlabs/beacon-utils', () => {
  const actual = jest.requireActual('@ecadlabs/beacon-utils')

  class ExposedPromise<T> {
    public promise: Promise<T>
    private _resolve!: (value: T) => void
    private _reject!: (reason?: any) => void

    constructor() {
      this.promise = new Promise<T>((res, rej) => {
        this._resolve = res
        this._reject = rej
      })
      // Prevent unhandled rejection when promise is rejected without a concurrent awaiter
      this.promise.catch(() => {})
    }
    resolve(value: T) {
      this._resolve(value)
    }
    reject(reason?: any) {
      this._reject(reason)
    }
    static resolve<T>(value: T) {
      const promise = new ExposedPromise<T>()
      promise.resolve(value)
      return promise
    }
    isResolved(): boolean {
      return true
    }
  }

  return {
    ...actual,
    ExposedPromise,
    generateGUID: jest.fn(),
    getHexHash: jest.fn(),
    recipientString: jest.fn(),
    encryptCryptoboxPayload: jest.fn(),
    decryptCryptoboxPayload: jest.fn(),
    openCryptobox: jest.fn(),
    toHex: jest.fn(),
    getKeypairFromSeed: jest.fn(),
    secretbox_NONCEBYTES: 8,
    secretbox_MACBYTES: 16
  }
})

jest.mock('../../src/matrix-client/MatrixClient', () => ({
  MatrixClient: { create: jest.fn() }
}))

// Imports
import {
  ExposedPromise,
  generateGUID,
  getHexHash,
  recipientString,
  encryptCryptoboxPayload,
  decryptCryptoboxPayload,
  openCryptobox,
  toHex,
  getKeypairFromSeed
} from '@ecadlabs/beacon-utils'
import { MatrixClient } from '../../src/matrix-client/MatrixClient'
import { P2PPairingRequest, StorageKey } from '@ecadlabs/beacon-types'
import { P2PCommunicationClient } from '../../src/communication-client/P2PCommunicationClient'

describe('P2PCommunicationClient', () => {
  let client: P2PCommunicationClient
  let fakeMatrixClient: {
    subscribe: jest.Mock
    unsubscribe: jest.Mock
    unsubscribeAll: jest.Mock
    joinRooms: jest.Mock
    sendTextMessage: jest.Mock
    start: jest.Mock
    stop: jest.Mock
    getRoomById: jest.Mock
    createTrustedPrivateRoom: jest.Mock
    joinedRooms: Promise<unknown[]>
  }
  const mockStorage = {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn()
  }
  const fakeKeyPair = { publicKey: 'pub', secretKey: 'sec' }
  const createDeferred = <T>() => {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })

    return { promise, resolve, reject }
  }
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 10; i++) {
      if (predicate()) {
        return
      }

      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    throw new Error('Timed out waiting for condition')
  }

  beforeEach(() => {
    jest.clearAllMocks()

    // beacon-utils mocks
    ;(generateGUID as jest.Mock).mockResolvedValue('generated-guid')
    ;(getHexHash as jest.Mock).mockResolvedValue('hex-hash')
    ;(recipientString as jest.Mock).mockReturnValue('@hex-hash:relay.server')
    ;(encryptCryptoboxPayload as jest.Mock).mockResolvedValue('encrypted-payload')
    ;(decryptCryptoboxPayload as jest.Mock).mockResolvedValue('decrypted-payload')
    ;(openCryptobox as jest.Mock).mockResolvedValue(JSON.stringify({ foo: 'bar' }))
    ;(toHex as jest.Mock).mockReturnValue('deadbeef')
    ;(getKeypairFromSeed as jest.Mock).mockResolvedValue(fakeKeyPair)

    // MatrixClient.create stub
    fakeMatrixClient = {
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      unsubscribeAll: jest.fn(),
      joinRooms: jest.fn(),
      sendTextMessage: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      getRoomById: jest.fn().mockResolvedValue({ members: ['@peer:relay'] }),
      createTrustedPrivateRoom: jest.fn().mockResolvedValue('!room:id'),
      joinedRooms: Promise.resolve([])
    }
    ;(MatrixClient.create as jest.Mock).mockReturnValue(fakeMatrixClient)

    client = new P2PCommunicationClient('MyApp', fakeKeyPair as any, 2, mockStorage as any)

    // Stub getPublicKey and getRelayServer
    ;(client as any).getPublicKey = jest.fn().mockResolvedValue('pub')
    jest
      .spyOn(client as any, 'getRelayServer')
      .mockResolvedValue({ server: 'relay.server', timestamp: 1234 })
    ;(client as any).client.resolve(fakeMatrixClient)
  })

  it.each([true, false])(
    'discovers a room for the first outbound send, existing room=%s',
    async (existing) => {
      const recipient = '@hex-hash:relay.server'
      const room = {
        id: existing ? '!existing:relay' : '!created:relay',
        members: [recipient, '@self:relay']
      }
      fakeMatrixClient.joinedRooms = Promise.resolve(existing ? [room] : [])
      fakeMatrixClient.getRoomById.mockResolvedValue(room)
      fakeMatrixClient.createTrustedPrivateRoom.mockResolvedValue(room.id)
      ;(client as any).client.resolve(fakeMatrixClient)
      mockStorage.get.mockResolvedValue({})
      jest.spyOn(client as any, 'createCryptoBoxClient').mockResolvedValue({ send: 'shared' })
      await client.sendMessage('first request', {
        publicKey: '11'.repeat(32),
        relayServer: 'relay.server'
      } as any)
      expect(fakeMatrixClient.sendTextMessage).toHaveBeenCalledWith(room.id, 'encrypted-payload')
      if (existing) expect(fakeMatrixClient.createTrustedPrivateRoom).not.toHaveBeenCalled()
      else expect(fakeMatrixClient.createTrustedPrivateRoom).toHaveBeenCalledWith(recipient)
      expect(mockStorage.set).toHaveBeenCalledWith(StorageKey.MATRIX_PEER_ROOM_IDS, {
        [recipient]: room.id
      })
    }
  )

  describe('encrypted message sender matching', () => {
    it('requires the complete Matrix localpart', async () => {
      const event = { content: { message: { sender: '@hex-hash-extra:relay' } } }
      await expect(client.isSender(event as any, '11'.repeat(32))).resolves.toBe(false)
      event.content.message.sender = '@hex-hash:relay'
      await expect(client.isSender(event as any, '11'.repeat(32))).resolves.toBe(true)
    })

    it.each(['base58', 'json'])(
      'delivers matching %s messages and rejects mismatched sender IDs',
      async (encoding) => {
        const key = '11'.repeat(32)
        const senderId = await getSenderId(key)
        const callback = jest.fn()
        jest.spyOn(client as any, 'createCryptoBoxServer').mockResolvedValue({ receive: 'key' })
        jest.spyOn(client as any, 'isTextMessage').mockReturnValue(true)
        const room = jest.spyOn(client, 'updatePeerRoom').mockResolvedValue(undefined)
        jest.spyOn(client as any, 'updateRelayServer').mockResolvedValue(undefined)
        await client.listenForEncryptedMessage(key, callback)
        const listener = fakeMatrixClient.subscribe.mock.calls.at(-1)![1]
        const event = {
          content: {
            roomId: '!room',
            message: {
              sender: '@hex-hash:relay',
              content: '00'.repeat(64)
            }
          }
        }
        const message = { id: 'message', version: '2', type: 'disconnect', senderId }
        const payload =
          encoding === 'json' ? JSON.stringify(message) : await new Serializer().serialize(message)
        ;(decryptCryptoboxPayload as jest.Mock).mockResolvedValue(payload)
        await listener(event)
        expect(callback).toHaveBeenCalledWith(payload)
        callback.mockClear()
        room.mockClear()
        const mismatched = { ...message, senderId: 'another-wallet' }
        ;(decryptCryptoboxPayload as jest.Mock).mockResolvedValue(
          encoding === 'json'
            ? JSON.stringify(mismatched)
            : await new Serializer().serialize(mismatched)
        )
        await listener(event)
        expect(callback).not.toHaveBeenCalled()
        expect(room).not.toHaveBeenCalled()
      }
    )

    it('rejects encrypted messages from an untrusted relay domain and rejects replayed ciphertexts', async () => {
      const key = '11'.repeat(32)
      const senderId = await getSenderId(key)
      const callback = jest.fn()
      const actualUtils = jest.requireActual('@ecadlabs/beacon-utils') as typeof import('@ecadlabs/beacon-utils')
      const sharedKey = new Uint8Array(32).fill(7)
      mockStorage.get.mockResolvedValue([{ publicKey: key, relayServer: 'relay.server' }])
      jest.spyOn(client as any, 'createCryptoBoxServer').mockResolvedValue({ receive: sharedKey })
      jest.spyOn(client as any, 'isTextMessage').mockReturnValue(true)
      const room = jest.spyOn(client, 'updatePeerRoom').mockResolvedValue(undefined)
      const relay = jest.spyOn(client as any, 'updateRelayServer').mockResolvedValue(undefined)
      await client.listenForEncryptedMessage(key, callback)
      const listener = fakeMatrixClient.subscribe.mock.calls.at(-1)![1]
      const payload = JSON.stringify({
        id: 'message-1',
        version: '2',
        type: 'disconnect',
        senderId
      })
      const realCiphertext = await actualUtils.encryptCryptoboxPayload(payload, sharedKey)
      ;(decryptCryptoboxPayload as jest.Mock).mockImplementation((ct: string, rx: Uint8Array) =>
        actualUtils.decryptCryptoboxPayload(ct, rx)
      )

      // 1) Cross-domain ciphertext from an untrusted server must be rejected
      await listener({
        content: {
          roomId: '!other-room',
          message: {
            sender: '@hex-hash:other.server',
            content: realCiphertext
          }
        }
      })
      expect(callback).not.toHaveBeenCalled()
      expect(room).not.toHaveBeenCalled()
      expect(relay).not.toHaveBeenCalled()

      // 2) Legitimate message from peer's relayServer succeeds once
      const validEvent = {
        content: {
          roomId: '!valid-room',
          message: {
            sender: '@hex-hash:relay.server',
            content: realCiphertext
          }
        }
      }
      await listener(validEvent)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(room).toHaveBeenCalledTimes(1)
      expect(relay).toHaveBeenCalledTimes(1)

      // 3) Replaying the exact same ciphertext must be rejected
      await listener(validEvent)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(room).toHaveBeenCalledTimes(1)
      expect(relay).toHaveBeenCalledTimes(1)

      // 4) Replaying uppercase equivalent or trailing non-hex suffix must also be rejected
      await listener({
        content: {
          roomId: '!valid-room',
          message: {
            sender: '@hex-hash:relay.server',
            content: realCiphertext.toUpperCase()
          }
        }
      })
      await listener({
        content: {
          roomId: '!valid-room',
          message: {
            sender: '@hex-hash:relay.server',
            content: `${realCiphertext}:nonhex`
          }
        }
      })
      expect(callback).toHaveBeenCalledTimes(1)
      expect(room).toHaveBeenCalledTimes(1)
      expect(relay).toHaveBeenCalledTimes(1)
    })

    it('allows retrying an identical ciphertext if routing persistence fails before delivery', async () => {
      const key = '11'.repeat(32)
      const senderId = await getSenderId(key)
      const callback = jest.fn()
      mockStorage.get.mockResolvedValue([{ publicKey: key, relayServer: 'relay.server' }])
      jest.spyOn(client as any, 'createCryptoBoxServer').mockResolvedValue({ receive: 'key' })
      jest.spyOn(client as any, 'isTextMessage').mockReturnValue(true)
      const room = jest
        .spyOn(client, 'updatePeerRoom')
        .mockRejectedValueOnce(new Error('room storage write failed'))
        .mockResolvedValue(undefined)
      const relay = jest
        .spyOn(client as any, 'updateRelayServer')
        .mockRejectedValueOnce(new Error('storage write failed'))
        .mockResolvedValue(undefined)
      await client.listenForEncryptedMessage(key, callback)
      const listener = fakeMatrixClient.subscribe.mock.calls.at(-1)![1]
      const payload = JSON.stringify({
        id: 'message-retry',
        version: '2',
        type: 'disconnect',
        senderId
      })
      ;(decryptCryptoboxPayload as jest.Mock).mockResolvedValue(payload)

      const validEvent = {
        content: {
          roomId: '!valid-room',
          message: {
            sender: '@hex-hash:relay.server',
            content: 'cc'.repeat(64)
          }
        }
      }

      // First attempt fails during updateRelayServer and does not deliver to callback
      await listener(validEvent).catch(() => undefined)
      expect(callback).not.toHaveBeenCalled()

      // Second attempt fails during updatePeerRoom and does not deliver to callback
      await listener(validEvent).catch(() => undefined)
      expect(callback).not.toHaveBeenCalled()

      // Retrying the same ciphertext concurrently delivers to callback exactly once
      await Promise.all([listener(validEvent), listener(validEvent)])
      expect(callback).toHaveBeenCalledTimes(1)
      expect(room).toHaveBeenCalledTimes(2)
      expect(relay).toHaveBeenCalledTimes(3)
    })

    it('migrates a known peer to a new trusted relay server end-to-end on invite and encrypted message', async () => {
      const key = '11'.repeat(32)
      const senderId = await getSenderId(key)
      const newTrustedRelay = 'beacon-node-1.octez.io'
      const dappPeers = [{ publicKey: key, relayServer: 'relay.server', name: 'Wallet' }]
      let peerRooms: Record<string, string> = {}

      mockStorage.get.mockImplementation(async (storageKey: StorageKey) => {
        if (storageKey === StorageKey.TRANSPORT_P2P_PEERS_DAPP) return dappPeers
        if (storageKey === StorageKey.TRANSPORT_P2P_PEERS_WALLET) return []
        if (storageKey === StorageKey.MATRIX_PEER_ROOM_IDS) return peerRooms
        return undefined
      })
      mockStorage.set.mockImplementation(async (storageKey: StorageKey, value: any) => {
        if (storageKey === StorageKey.MATRIX_PEER_ROOM_IDS) {
          peerRooms = value
        }
      })

      jest.spyOn(client as any, 'getPublicKeyHash').mockResolvedValue('hex-hash')
      const join = jest.spyOn(client as any, 'tryJoinRooms').mockResolvedValue(undefined)
      await client.start().catch(() => undefined)
      const invite = fakeMatrixClient.subscribe.mock.calls.find(([type]) => type === 'invite')![1]

      await invite({
        content: {
          roomId: '!migrated-room',
          members: [`@hex-hash:${newTrustedRelay}`],
          invitations: [
            {
              sender: `@hex-hash:${newTrustedRelay}`,
              target: '@hex-hash:relay.server'
            }
          ]
        }
      })
      expect(join).toHaveBeenCalledWith('!migrated-room', 1, expect.any(Function))

      const callback = jest.fn()
      jest.spyOn(client as any, 'createCryptoBoxServer').mockResolvedValue({ receive: 'key' })
      jest.spyOn(client as any, 'isTextMessage').mockReturnValue(true)
      await client.listenForEncryptedMessage(key, callback)
      const listener = fakeMatrixClient.subscribe.mock.calls.at(-1)![1]
      const payload = JSON.stringify({
        id: 'migrated-msg',
        version: '2',
        type: 'disconnect',
        senderId
      })
      ;(decryptCryptoboxPayload as jest.Mock).mockResolvedValue(payload)

      await listener({
        content: {
          roomId: '!migrated-room',
          message: {
            sender: `@hex-hash:${newTrustedRelay}`,
            content: 'dd'.repeat(64)
          }
        }
      })

      expect(callback).toHaveBeenCalledWith(payload)
      expect(dappPeers[0].relayServer).toBe(newTrustedRelay)
      expect(peerRooms[`@hex-hash:${newTrustedRelay}`]).toBe('!migrated-room')
    })
  })

  describe('room invitation matching', () => {
    it.each([
      [
        'persisted identity before listeners start',
        '@hex-hash:relay.server',
        '@hex-hash:relay.server',
        false,
        true
      ],
      [
        'known peer migrating to another trusted Beacon relay server',
        '@hex-hash:beacon-node-1.octez.io',
        '@hex-hash:relay.server',
        false,
        true
      ],
      ['wrong homeserver', '@hex-hash:other.server', '@hex-hash:relay.server', false, false],
      ['wrong target', '@hex-hash:relay.server', '@other:relay.server', false, false],
      ['unknown peer', '@unknown:relay.server', '@hex-hash:relay.server', false, false],
      ['pending pairing, wrong target', '@unknown:relay.server', '@other:relay.server', true, false],
      ['pending pairing', '@unknown:relay.server', '@hex-hash:relay.server', true, true]
    ])('%s', async (_name, sender, target, pending, allowed) => {
      mockStorage.get.mockResolvedValue([
        { publicKey: '11'.repeat(32), relayServer: 'relay.server' }
      ])
      jest.spyOn(client as any, 'getPublicKeyHash').mockResolvedValue('hex-hash')
      const join = jest.spyOn(client as any, 'tryJoinRooms').mockResolvedValue(undefined)
      const routing = jest.spyOn(client, 'updatePeerRoom').mockResolvedValue(undefined)
      // The invitation subscription is registered before login.
      await client.start().catch(() => undefined)
      const invite = fakeMatrixClient.subscribe.mock.calls.find(([type]) => type === 'invite')![1]
      if (pending) await client.getPairingRequestInfo()
      await invite({
        content: {
          roomId: '!room',
          members: ['@hex-hash:relay.server'],
          invitations: [{ sender, target }]
        }
      })
      expect(join).toHaveBeenCalledTimes(allowed ? 1 : 0)
      expect(routing).not.toHaveBeenCalled()
    })

    it('rejects an invite with conflicting inviters for ownId when no pairing is pending', async () => {
      mockStorage.get.mockResolvedValue([
        { publicKey: '11'.repeat(32), relayServer: 'relay.server' }
      ])
      jest.spyOn(client as any, 'getPublicKeyHash').mockResolvedValue('hex-hash')
      const join = jest.spyOn(client as any, 'tryJoinRooms').mockResolvedValue(undefined)
      await client.start().catch(() => undefined)
      const invite = fakeMatrixClient.subscribe.mock.calls.find(([type]) => type === 'invite')![1]
      await invite({
        content: {
          roomId: '!room',
          members: ['@hex-hash:relay.server', '@unpaired:relay.server'],
          invitations: [
            { sender: '@hex-hash:relay.server', target: '@hex-hash:relay.server' },
            { sender: '@unpaired:relay.server', target: '@hex-hash:relay.server' }
          ]
        }
      })
      expect(join).not.toHaveBeenCalled()
    })

    it('rejects a room parsed by MatrixRoom.fromSync with conflicting invite_state for ownId even when pairing is pending', async () => {
      const { MatrixRoom } = require('../../src/matrix-client/models/MatrixRoom')
      const [conflictingRoom] = MatrixRoom.fromSync({
        invite: {
          '!conflict-during-pending:relay': {
            invite_state: {
              events: [
                {
                  type: 'm.room.member',
                  sender: '@trusted:relay.server',
                  state_key: '@hex-hash:relay.server',
                  content: { membership: 'invite' }
                },
                {
                  type: 'm.room.member',
                  sender: '@unpaired:relay.server',
                  state_key: '@hex-hash:relay.server',
                  content: { membership: 'invite' }
                }
              ]
            }
          }
        }
      })

      mockStorage.get.mockResolvedValue([])
      jest.spyOn(client as any, 'getPublicKeyHash').mockResolvedValue('hex-hash')
      const join = jest.spyOn(client as any, 'tryJoinRooms').mockResolvedValue(undefined)
      await client.start().catch(() => undefined)
      const invite = fakeMatrixClient.subscribe.mock.calls.find(([type]) => type === 'invite')![1]
      await client.getPairingRequestInfo()

      await invite({
        content: {
          roomId: conflictingRoom.id,
          members: conflictingRoom.members,
          invitations: conflictingRoom.invitations
        }
      })

      expect(join).not.toHaveBeenCalled()
    })
  })

  describe('pairing response matching', () => {
    const key = '11'.repeat(32)
    const event = {
      content: {
        roomId: '!unpaired:relay',
        message: {
          sender: '@hex-hash:relay.server',
          content: '@channel-open:00'.padEnd(100, '0')
        }
      }
    }
    let routing: jest.SpyInstance
    let relay: jest.SpyInstance
    let accept: jest.Mock
    let handler: (event: unknown) => Promise<void>

    beforeEach(async () => {
      routing = jest.spyOn(client, 'updatePeerRoom').mockResolvedValue(undefined)
      relay = jest.spyOn(client as any, 'updateRelayServer').mockResolvedValue(undefined)
      jest.spyOn(client as any, 'isTextMessage').mockReturnValue(true)
      jest.spyOn(client as any, 'isChannelOpenMessage').mockResolvedValue(true)
      jest.spyOn(client as any, 'isSender').mockResolvedValue(true)
      accept = jest.fn()
      await client.listenForChannelOpening(accept)
      handler = fakeMatrixClient.subscribe.mock.calls.at(-1)![1]
    })
    const respond = (id: string) => {
      ;(openCryptobox as jest.Mock).mockResolvedValue(
        JSON.stringify({
          id,
          publicKey: key,
          name: 'Wallet',
          version: '2',
          type: 'p2p-pairing-request',
          relayServer: 'relay.server'
        })
      )
    }

    it('allows only one response across Matrix and extension transports', async () => {
      const shared = new PendingPairingRequests()
      ;(client as any).pendingPairings = shared
      const extension = new PostMessageClient('App', fakeKeyPair as any, shared)
      const listen = jest.spyOn(windowRef, 'addEventListener')
      const extensionAccept = jest.fn()
      await extension.listenForChannelOpening(extensionAccept)
      const extensionHandler = listen.mock.calls.at(-1)![1] as unknown as (
        event: unknown
      ) => Promise<void>
      const request = await client.getPairingRequestInfo()
      respond(request.id)
      await Promise.all([
        handler(event),
        extensionHandler({
          source: windowRef,
          origin: windowRef.location.origin,
          data: {
            sender: { id: 'wallet-extension' },
            message: {
              target: 'toPage',
              payload: '00'.repeat(64)
            }
          }
        })
      ])
      expect(accept.mock.calls.length + extensionAccept.mock.calls.length).toBe(1)
      listen.mockRestore()
    })

    it('rejects a mismatched sender response without routing writes or peer acceptance', async () => {
      await client.getPairingRequestInfo()
      respond('wrong-id')
      await handler(event)
      expect(accept).not.toHaveBeenCalled()
      expect(routing).not.toHaveBeenCalled()
      expect(relay).not.toHaveBeenCalled()
    })

    it('accepts a matching response once under concurrent delivery', async () => {
      const request = await client.getPairingRequestInfo()
      respond(request.id)
      await Promise.all([handler(event), handler(event)])
      expect(accept).toHaveBeenCalledTimes(1)
      expect(routing).not.toHaveBeenCalled()
      expect(relay).not.toHaveBeenCalled()
    })

    it('rejects a matching response from another Matrix identity', async () => {
      const request = await client.getPairingRequestInfo()
      respond(request.id)
      ;(client as any).isSender.mockResolvedValue(false)
      await handler(event)
      expect(accept).not.toHaveBeenCalled()
      expect(routing).not.toHaveBeenCalled()
    })

    it('revokes requests on cancellation', async () => {
      const request = await client.getPairingRequestInfo()
      respond(request.id)
      client.cancelPairingRequests()
      await handler(event)
      expect(accept).not.toHaveBeenCalled()
    })

    it('does not issue a capability after cancellation during generation', async () => {
      const relay = createDeferred<{ server: string; timestamp: number }>()
      ;(client as any).getRelayServer.mockReturnValue(relay.promise)
      const request = client.getPairingRequestInfo()
      client.cancelPairingRequests()
      relay.resolve({ server: 'relay.server', timestamp: 1 })
      await expect(request).rejects.toThrow('cancelled')
    })

    it('rejects a channel-open message with non-hex payload without calling openCryptobox', async () => {
      await client.getPairingRequestInfo()
      ;(openCryptobox as jest.Mock).mockClear()
      await handler({
        content: {
          roomId: '!unpaired:relay',
          message: {
            sender: '@hex-hash:relay.server',
            content: `@channel-open:${'a'.repeat(49)}`
          }
        }
      })
      expect(openCryptobox).not.toHaveBeenCalled()
      expect(accept).not.toHaveBeenCalled()
    })
  })

  describe('getPairingRequestInfo', () => {
    it('builds a P2PPairingRequest with id, name, publicKey, version & relayServer', async () => {
      const req = await client.getPairingRequestInfo()
      expect(generateGUID).toHaveBeenCalled()
      expect(req.id).toBe('generated-guid')
      expect(req.name).toBe('MyApp')
      expect(req.publicKey).toBe('pub')
      expect(req.version).toBeDefined()
      expect(req.relayServer).toBe('relay.server')
    })
  })

  describe('getPairingResponseInfo', () => {
    it('builds a P2PPairingResponse using current relayServer, not request’s', async () => {
      const fakeRequest = {
        id: 'req-id',
        name: 'peer-name',
        publicKey: 'peer-pub',
        version: '1.0.0',
        relayServer: 'relay.peer'
      }
      const res = await client.getPairingResponseInfo(fakeRequest as any)
      expect(res.id).toBe('req-id')
      expect(res.name).toBe('MyApp')
      expect(res.publicKey).toBe('pub')
      expect(res.version).toBe('1.0.0')
      // now matches stubbed getRelayServer()
      expect(res.relayServer).toBe('relay.server')
    })
  })

  describe('getBeaconInfo', () => {
    const originalFetch = global.fetch

    afterEach(() => {
      global.fetch = originalFetch
    })

    it('fetches /_synapse/client/beacon/info and maps the response', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          region: 'eu',
          known_servers: ['a', 'b'],
          timestamp: 9876
        })
      })
      global.fetch = fetchMock as unknown as typeof fetch

      const info = await client.getBeaconInfo('relay.test')
      expect(fetchMock).toHaveBeenCalledWith(
        'https://relay.test/_synapse/client/beacon/info',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
      expect(info).toEqual({
        region: 'eu',
        known_servers: ['a', 'b'],
        timestamp: 9876
      })
    })
  })

  describe('sendMessage', () => {
    const peer = new P2PPairingRequest('peer-id', 'Kukai', 'peer-pub', '3', 'relay.server')
    let deleteRoomIdFromRoomsSpy: jest.SpyInstance<Promise<void>, [string]>

    beforeEach(() => {
      jest.spyOn(client as any, 'createCryptoBoxClient').mockResolvedValue({ send: 'send-key' })
      jest.spyOn(client as any, 'getRelevantRoom').mockResolvedValue('!room:id')
      deleteRoomIdFromRoomsSpy = jest
        .spyOn(client, 'deleteRoomIdFromRooms')
        .mockResolvedValue(undefined)
    })

    it('does not resolve until the Matrix text message send resolves', async () => {
      const matrixSend = createDeferred<void>()
      fakeMatrixClient.sendTextMessage.mockReturnValue(matrixSend.promise)

      const send = client.sendMessage('disconnect-payload', peer).then(() => 'resolved')
      await waitFor(() => fakeMatrixClient.sendTextMessage.mock.calls.length === 1)

      await expect(Promise.race([send, Promise.resolve('pending')])).resolves.toBe('pending')
      expect(fakeMatrixClient.sendTextMessage).toHaveBeenCalledWith('!room:id', 'encrypted-payload')

      matrixSend.resolve(undefined)

      await expect(send).resolves.toBe('resolved')
    })

    it('awaits the M_FORBIDDEN retry send before resolving', async () => {
      const retrySend = createDeferred<void>()
      ;(client as any).getRelevantRoom
        .mockResolvedValueOnce('!old-room:id')
        .mockResolvedValueOnce('!new-room:id')
      fakeMatrixClient.sendTextMessage
        .mockRejectedValueOnce({ errcode: 'M_FORBIDDEN' })
        .mockReturnValueOnce(retrySend.promise)

      const send = client.sendMessage('disconnect-payload', peer).then(() => 'resolved')
      await waitFor(() => fakeMatrixClient.sendTextMessage.mock.calls.length === 2)

      await expect(Promise.race([send, Promise.resolve('pending')])).resolves.toBe('pending')
      expect(deleteRoomIdFromRoomsSpy).toHaveBeenCalledWith('!old-room:id')
      expect(fakeMatrixClient.sendTextMessage).toHaveBeenNthCalledWith(
        2,
        '!new-room:id',
        'encrypted-payload'
      )

      retrySend.resolve(undefined)

      await expect(send).resolves.toBe('resolved')
      expect(fakeMatrixClient.sendTextMessage).toHaveBeenCalledTimes(2)
      expect(deleteRoomIdFromRoomsSpy).toHaveBeenCalledTimes(1)
    })

    it('rejects when the Matrix text message send fails with a non-M_FORBIDDEN error', async () => {
      const sendError = new Error('send failed')
      fakeMatrixClient.sendTextMessage.mockRejectedValueOnce(sendError)

      await expect(client.sendMessage('disconnect-payload', peer)).rejects.toBe(sendError)
      expect(fakeMatrixClient.sendTextMessage).toHaveBeenCalledTimes(1)
      expect(deleteRoomIdFromRoomsSpy).not.toHaveBeenCalled()
    })

    it('rejects when the M_FORBIDDEN retry send fails', async () => {
      const retryError = new Error('retry failed')
      ;(client as any).getRelevantRoom
        .mockResolvedValueOnce('!old-room:id')
        .mockResolvedValueOnce('!new-room:id')
      fakeMatrixClient.sendTextMessage
        .mockRejectedValueOnce({ errcode: 'M_FORBIDDEN' })
        .mockRejectedValueOnce(retryError)

      await expect(client.sendMessage('disconnect-payload', peer)).rejects.toBe(retryError)
      expect(fakeMatrixClient.sendTextMessage).toHaveBeenCalledTimes(2)
    })
  })

  describe('getRelayServer (dead node recovery)', () => {
    let freshClient: P2PCommunicationClient
    type RelayServerRecord = { server: string; timestamp: number; localTimestamp: number }

    beforeEach(() => {
      freshClient = new P2PCommunicationClient('MyApp', fakeKeyPair as any, 2, mockStorage as any)
    })

    it('ships only octez.io relay nodes by default', () => {
      const enabledRelayServers = (freshClient as any).ENABLED_RELAY_SERVERS
      const defaultServers = Object.values(enabledRelayServers).flat()

      expect(defaultServers).toEqual([
        'beacon-node-1.octez.io',
        'beacon-node-2.octez.io',
        'beacon-node-3.octez.io',
        'beacon-node-4.octez.io',
        'beacon-node-5.octez.io',
        'beacon-node-6.octez.io',
        'beacon-node-7.octez.io',
        'beacon-node-8.octez.io'
      ])
    })

    const setCachedRelay = (relay: RelayServerRecord): void => {
      ;(freshClient as any).relayServer = ExposedPromise.resolve(relay)
    }

    it('returns in-memory relay server when cache is fresh', async () => {
      const now = Date.now()
      setCachedRelay({ server: 'cached-node.papers.tech', timestamp: 1234, localTimestamp: now })

      const beaconInfoSpy = jest.spyOn(freshClient, 'getBeaconInfo')
      const discoverySpy = jest.spyOn(freshClient as any, 'findBestRegionAndGetServer')
      mockStorage.get.mockResolvedValue('should-not-be-read')

      const result = await freshClient.getRelayServer()

      expect(result).toEqual({ server: 'cached-node.papers.tech', timestamp: 1234 })
      expect(beaconInfoSpy).not.toHaveBeenCalled()
      expect(discoverySpy).not.toHaveBeenCalled()
      expect(mockStorage.get).not.toHaveBeenCalled()
    })

    it('refreshes stale in-memory relay server when cached server is reachable', async () => {
      setCachedRelay({ server: 'cached-node.papers.tech', timestamp: 1000, localTimestamp: 0 })

      const beaconInfoSpy = jest
        .spyOn(freshClient, 'getBeaconInfo')
        .mockResolvedValue({ region: 'eu', known_servers: [], timestamp: 2222 })
      const discoverySpy = jest.spyOn(freshClient as any, 'findBestRegionAndGetServer')

      const result = await freshClient.getRelayServer()

      expect(result).toEqual({ server: 'cached-node.papers.tech', timestamp: 2222 })
      expect(beaconInfoSpy).toHaveBeenCalledWith('cached-node.papers.tech')
      expect(discoverySpy).not.toHaveBeenCalled()
      expect(mockStorage.delete).not.toHaveBeenCalled()
    })

    it('falls through to server discovery when stored node is unreachable', async () => {
      // Stored node exists but is dead
      mockStorage.get.mockResolvedValue('dead-node.papers.tech')
      mockStorage.delete.mockResolvedValue(undefined)
      mockStorage.set.mockResolvedValue(undefined)

      // First call (stored node) rejects, second call (discovery probe) succeeds
      jest
        .spyOn(freshClient, 'getBeaconInfo')
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue({ region: 'eu', known_servers: ['a'], timestamp: 5000 })

      const result = await freshClient.getRelayServer()

      // Should have deleted the dead node from storage
      expect(mockStorage.delete).toHaveBeenCalledWith(StorageKey.MATRIX_SELECTED_NODE)

      // Should have resolved via discovery
      expect(result.server).toBeDefined()
      expect(result.timestamp).toBe(5000)
    })

    it('uses stored node when it is reachable', async () => {
      mockStorage.get.mockResolvedValue('healthy-node.papers.tech')

      jest
        .spyOn(freshClient, 'getBeaconInfo')
        .mockResolvedValue({ region: 'eu', known_servers: ['a'], timestamp: 7777 })

      const result = await freshClient.getRelayServer()

      expect(result.server).toBe('healthy-node.papers.tech')
      expect(result.timestamp).toBe(7777)
      // Should NOT have deleted the node
      expect(mockStorage.delete).not.toHaveBeenCalledWith(StorageKey.MATRIX_SELECTED_NODE)
    })

    it('rejects ExposedPromise when all servers fail, preventing concurrent caller deadlock', async () => {
      mockStorage.get.mockResolvedValue('')
      mockStorage.delete.mockResolvedValue(undefined)

      // All discovery probes fail
      jest.spyOn(freshClient, 'getBeaconInfo').mockRejectedValue(new Error('ECONNREFUSED'))

      await expect(freshClient.getRelayServer()).rejects.toThrow()

      // The ExposedPromise should be cleared so subsequent callers get a fresh attempt
      expect((freshClient as any).relayServer).toBeUndefined()
    })

    it('falls through to discovery when stale cached server is unreachable', async () => {
      setCachedRelay({ server: 'cached-node.papers.tech', timestamp: 1000, localTimestamp: 0 })
      mockStorage.delete.mockResolvedValue(undefined)
      mockStorage.set.mockResolvedValue(undefined)
      mockStorage.get.mockResolvedValue('')

      const beaconInfoSpy = jest
        .spyOn(freshClient, 'getBeaconInfo')
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      const discoverySpy = jest
        .spyOn(freshClient as any, 'findBestRegionAndGetServer')
        .mockResolvedValue({ server: 'discovered-node.papers.tech', timestamp: 5000 })

      const result = await freshClient.getRelayServer()

      expect(result).toEqual({ server: 'discovered-node.papers.tech', timestamp: 5000 })
      expect(beaconInfoSpy).toHaveBeenCalledWith('cached-node.papers.tech')
      expect(discoverySpy).toHaveBeenCalledTimes(1)
      expect(mockStorage.delete).toHaveBeenCalledWith(StorageKey.MATRIX_SELECTED_NODE)
    })

    it('clears in-flight relay promise when discovery fails', async () => {
      const storageGet = createDeferred<string>()
      mockStorage.get.mockReturnValue(storageGet.promise)
      mockStorage.delete.mockResolvedValue(undefined)

      jest.spyOn(freshClient as any, 'findBestRegionAndGetServer').mockImplementation(() => {
        throw new Error('offline')
      })

      const relayCall = freshClient.getRelayServer()
      await Promise.resolve()
      const internalRelayPromise = (freshClient as any).relayServer?.promise
      internalRelayPromise?.catch(() => undefined)
      storageGet.resolve('')

      await expect(relayCall).rejects.toThrow('offline')

      expect((freshClient as any).relayServer).toBeUndefined()
    })

    it('reuses a single in-flight discovery for concurrent callers', async () => {
      mockStorage.get.mockResolvedValue('')
      mockStorage.set.mockResolvedValue(undefined)
      const discoverySpy = jest
        .spyOn(freshClient as any, 'findBestRegionAndGetServer')
        .mockResolvedValue({ server: 'discovered-node.papers.tech', timestamp: 3000 })

      const [resultA, resultB] = await Promise.all([
        freshClient.getRelayServer(),
        freshClient.getRelayServer()
      ])

      expect(resultA).toEqual({ server: 'discovered-node.papers.tech', timestamp: 3000 })
      expect(resultB).toEqual({ server: 'discovered-node.papers.tech', timestamp: 3000 })
      expect(discoverySpy).toHaveBeenCalledTimes(1)
    })

    it('preserves successful cache when concurrent stale refresh has mixed success and failure', async () => {
      setCachedRelay({ server: 'cached-node.papers.tech', timestamp: 1000, localTimestamp: 0 })
      mockStorage.get.mockResolvedValue('')
      mockStorage.set.mockResolvedValue(undefined)
      mockStorage.delete.mockResolvedValue(undefined)

      let callCount = 0
      let resolveSecond!: (value: {
        region: string
        known_servers: string[]
        timestamp: number
      }) => void
      let rejectFirst!: (reason?: unknown) => void

      const firstRefresh = new Promise<{
        region: string
        known_servers: string[]
        timestamp: number
      }>((_, reject) => {
        rejectFirst = reject
      })
      const secondRefresh = new Promise<{
        region: string
        known_servers: string[]
        timestamp: number
      }>((resolve) => {
        resolveSecond = resolve
      })

      jest.spyOn(freshClient, 'getBeaconInfo').mockImplementation(async () => {
        callCount += 1
        if (callCount === 1) {
          return firstRefresh
        }
        if (callCount === 2) {
          return secondRefresh
        }
        throw new Error(`Unexpected getBeaconInfo call #${callCount}`)
      })

      const discoverySpy = jest
        .spyOn(freshClient as any, 'findBestRegionAndGetServer')
        .mockResolvedValue({ server: 'unexpected-discovery.papers.tech', timestamp: 9999 })

      const call1 = freshClient.getRelayServer().catch((error) => error)
      const call2 = freshClient.getRelayServer()
      await Promise.resolve()
      const internalRelayPromise = (freshClient as any).relayServer?.promise
      internalRelayPromise?.catch(() => undefined)

      resolveSecond({ region: 'us', known_servers: [], timestamp: 2000 })
      const secondResult = await call2
      expect(secondResult).toEqual({ server: 'cached-node.papers.tech', timestamp: 2000 })

      rejectFirst(new Error('stale refresh failed in one caller'))
      await call1

      const thirdResult = await freshClient.getRelayServer()
      expect(thirdResult).toEqual({ server: 'cached-node.papers.tech', timestamp: 2000 })
      expect(discoverySpy).not.toHaveBeenCalled()
    })
  })

  describe('updatePeerRoom', () => {
    it('throws if sender is invalid', async () => {
      await expect(client.updatePeerRoom('invalid-sender', '!room')).rejects.toThrow(
        'Invalid sender'
      )
    })

    it('pushes the 2nd character of old room into ignoredRooms and updates storage', async () => {
      const sender = '@abcdef:relay.server'
      const oldRoom = '!old:room'
      mockStorage.get.mockResolvedValue({ [sender]: oldRoom })
      mockStorage.set.mockResolvedValue(undefined)

      await client.updatePeerRoom(sender, '!new:room')

      // per implementation, room[1] === 'o' is what gets pushed
      expect((client as any).ignoredRooms).toContain(oldRoom[1])
      expect(mockStorage.set).toHaveBeenCalledWith(StorageKey.MATRIX_PEER_ROOM_IDS, {
        [sender]: '!new:room'
      })
    })
  })

  describe('updateRelayServer', () => {
    it('updates matching dApp peer relayServer via storage without requiring raw localStorage', async () => {
      localStorage.removeItem('beacon:communication-peers-dapp')
      const dappPeer = {
        id: 'peer-id',
        name: 'Wallet',
        publicKey: '11'.repeat(32),
        version: '3',
        relayServer: 'relay.server',
        senderId: 'sender-id',
        type: 'p2p-pairing-response'
      }
      mockStorage.get.mockImplementation(async (key: StorageKey) => {
        if (key === StorageKey.TRANSPORT_P2P_PEERS_DAPP) {
          return [dappPeer]
        }
        return []
      })
      mockStorage.set.mockResolvedValue(undefined)

      await client.updateRelayServer('@hex-hash:beacon-node-1.octez.io')

      expect(mockStorage.set).toHaveBeenCalledWith(
        StorageKey.TRANSPORT_P2P_PEERS_DAPP,
        expect.arrayContaining([
          expect.objectContaining({
            publicKey: '11'.repeat(32),
            relayServer: 'beacon-node-1.octez.io'
          })
        ])
      )
    })
  })

  describe('stop', () => {
    it('still resets session storage when startingClient.stop() rejects', async () => {
      mockStorage.delete.mockResolvedValue(undefined)
      fakeMatrixClient.stop.mockResolvedValue(undefined)
      const stopFailure = new Error('starting client stop failed')
      ;(client as any).startingClient = {
        stop: jest.fn().mockRejectedValue(stopFailure)
      }

      await expect(client.stop()).rejects.toBe(stopFailure)
      expect(mockStorage.delete).toHaveBeenCalledWith(StorageKey.MATRIX_PEER_ROOM_IDS)
      expect(mockStorage.delete).toHaveBeenCalledWith(StorageKey.MATRIX_PRESERVED_STATE)
      expect(mockStorage.delete).toHaveBeenCalledWith(StorageKey.MATRIX_SELECTED_NODE)
    })
  })
})
