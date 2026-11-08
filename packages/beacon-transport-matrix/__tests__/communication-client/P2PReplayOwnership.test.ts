import { setImmediate } from 'node:timers/promises'
import { LocalStorage, getSenderId } from '@ecadlabs/beacon-core'
import {
  ExposedPromise,
  KeyPair,
  encryptCryptoboxPayload,
  getHexHash,
  getKeypairFromSeed
} from '@ecadlabs/beacon-utils'
import { P2PPairingRequest, StorageKey, StorageKeyReturnType } from '@ecadlabs/beacon-types'
import { P2PCommunicationClient } from '../../src/communication-client/P2PCommunicationClient'
import { MatrixClient } from '../../src/matrix-client/MatrixClient'
import { MatrixRoom } from '../../src/matrix-client/models/MatrixRoom'
import { MatrixClientEventType } from '../../src/matrix-client/models/MatrixClientEvent'
import { MatrixSyncResponse } from '../../src/matrix-client/models/api/MatrixSync'
import { MatrixEventService } from '../../src/matrix-client/services/MatrixEventService'
import { MatrixUserService } from '../../src/matrix-client/services/MatrixUserService'

const gate = () => ({ entered: new ExposedPromise<void>(), release: new ExposedPromise<void>() })
type Gate = ReturnType<typeof gate>
let messageEncryption: Gate | undefined

vi.mock('@ecadlabs/beacon-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecadlabs/beacon-utils')>()
  return {
    ...actual,
    encryptCryptoboxPayload: async (...args: Parameters<typeof actual.encryptCryptoboxPayload>) => {
      const result = await actual.encryptCryptoboxPayload(...args)
      const pending = messageEncryption
      if (pending) {
        messageEncryption = undefined
        pending.entered.resolve()
        await pending.release.promise
      }
      return result
    }
  }
})
const relay = 'relay.example'
const oldRoom = '!old:relay.example'
const replacementRoom = '!replacement:relay.example'
const emptySync = (): MatrixSyncResponse => ({ next_batch: 'empty', rooms: {} })

class ControlledStorage extends LocalStorage {
  public roomRead: Gate | undefined

  public override async get<K extends StorageKey>(key: K): Promise<StorageKeyReturnType[K]> {
    const result = await super.get(key)
    const pending = key === StorageKey.MATRIX_PEER_ROOM_IDS ? this.roomRead : undefined
    if (pending) {
      this.roomRead = undefined
      pending.entered.resolve()
      await pending.release.promise
    }
    return result
  }
}

class ReplayClient extends P2PCommunicationClient {
  public receiverSetup: { publicKey: string; gate: Gate } | undefined
  public senderSetup: Gate | undefined
  public pairingEncryption: Gate | undefined

  protected override async createCryptoBoxClient(publicKey: string, keys: KeyPair) {
    const result = await super.createCryptoBoxClient(publicKey, keys)
    const pending = this.senderSetup
    if (pending) {
      this.senderSetup = undefined
      pending.entered.resolve()
      await pending.release.promise
    }
    return result
  }

  protected override async encryptMessageAsymmetric(publicKey: string, message: string) {
    const result = await super.encryptMessageAsymmetric(publicKey, message)
    const pending = this.pairingEncryption
    if (pending) {
      this.pairingEncryption = undefined
      pending.entered.resolve()
      await pending.release.promise
    }
    return result
  }

  protected override async createCryptoBoxServer(publicKey: string, keys: KeyPair) {
    const result = await super.createCryptoBoxServer(publicKey, keys)
    const pending = this.receiverSetup
    if (pending?.publicKey === publicKey) {
      this.receiverSetup = undefined
      pending.gate.entered.resolve()
      await pending.gate.release.promise
    }
    return result
  }

  public async encodeFor(publicKey: string, keys: KeyPair, message: string): Promise<string> {
    const shared = await this.createCryptoBoxClient(publicKey, keys)
    return encryptCryptoboxPayload(message, shared.send)
  }
}

const messageSync = (sender: string, body: string): MatrixSyncResponse => ({
  next_batch: body.slice(0, 12),
  rooms: {
    join: {
      [oldRoom]: {
        state: { events: [] },
        timeline: {
          events: [
            {
              type: 'm.room.message',
              sender,
              event_id: `$${body.slice(0, 12)}`,
              origin_server_ts: Date.now(),
              content: { msgtype: 'm.text', body }
            }
          ]
        }
      }
    }
  }
})

const joinedRoom = (id: string, recipient: string): MatrixRoom => {
  const room = MatrixRoom.from(id)
  room.members.push('@self:relay.example', recipient)
  return room
}

describe('Matrix replay and room ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    vi.spyOn(P2PCommunicationClient.prototype, 'getRelayServer').mockResolvedValue({
      server: relay,
      timestamp: 12345
    })
    vi.spyOn(P2PCommunicationClient.prototype, 'getBeaconInfo').mockResolvedValue({
      region: 'test',
      known_servers: [relay],
      timestamp: 12345
    })
    vi.spyOn(MatrixUserService.prototype, 'login').mockResolvedValue({
      user_id: '@self:relay.example',
      device_id: 'device',
      access_token: 'token'
    })
  })

  afterEach(() => {
    messageEncryption = undefined
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    localStorage.clear()
  })

  const create = async () => {
    const storage = new ControlledStorage('replay-ownership')
    const keys = await getKeypairFromSeed('replay-owner')
    const peerKeys = await getKeypairFromSeed('replay-peer')
    const publicKey = Buffer.from(peerKeys.publicKey).toString('hex')
    const recipient = `@${await getHexHash(peerKeys.publicKey)}:${relay}`
    const peer: P2PPairingRequest = {
      id: 'pairing',
      type: 'p2p-pairing-request',
      name: 'Peer',
      version: '3',
      publicKey,
      relayServer: relay
    }
    const client = new ReplayClient('Test', keys, 1, storage)
    const instances: MatrixClient[] = []
    const makeMatrix = MatrixClient.create.bind(MatrixClient)
    vi.spyOn(MatrixClient, 'create').mockImplementation((options) => {
      const matrix = makeMatrix(options)
      instances.push(matrix)
      return matrix
    })
    const polling = new ExposedPromise<MatrixSyncResponse>()
    const sync = vi
      .spyOn(MatrixEventService.prototype, 'sync')
      .mockResolvedValueOnce(emptySync())
      .mockImplementation(() => polling.promise)
    const matrix = () => {
      const instance = instances[instances.length - 1]
      if (!instance) throw new Error('Matrix client has not started')
      return instance
    }
    const restart = async () => {
      await client.stop()
      sync.mockResolvedValueOnce(emptySync())
      await client.start()
      await client.updatePeerRoom(recipient, replacementRoom)
      return matrix()
    }
    const payload = JSON.stringify({ id: 'message', senderId: await getSenderId(publicKey) })
    const body = await client.encodeFor(
      Buffer.from(keys.publicKey).toString('hex'),
      peerKeys,
      payload
    )
    return { client, storage, peer, recipient, sync, matrix, restart, body, payload }
  }

  it('keeps the zero-peer buffer through overlapping registrations and closes it after the batch', async () => {
    const { client, sync, matrix, peer, recipient, body, payload } = await create()
    sync
      .mockReset()
      .mockResolvedValueOnce(messageSync(recipient, body))
      .mockImplementation(() => new Promise<MatrixSyncResponse>(() => {}))
    await client.start()
    const unsubscribe = vi.spyOn(matrix(), 'unsubscribe')
    const pending = gate()
    client.receiverSetup = { publicKey: peer.publicKey, gate: pending }
    const callback = vi.fn()
    const matching = client.listenForEncryptedMessage(peer.publicKey, callback)
    await pending.entered.promise
    const otherKey = Buffer.from((await getKeypairFromSeed('other-peer')).publicKey).toString('hex')
    try {
      await client.listenForEncryptedMessage(otherKey, vi.fn())
      expect(callback).not.toHaveBeenCalled()
      expect(unsubscribe).not.toHaveBeenCalled()
      pending.release.resolve()
      await matching
      expect(callback).toHaveBeenCalledExactlyOnceWith(payload)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      expect(unsubscribe).toHaveBeenCalledWith(MatrixClientEventType.MESSAGE, expect.any(Function))
      await client.unsubscribeFromEncryptedMessage(peer.publicKey)
      const late = vi.fn()
      await client.listenForEncryptedMessage(peer.publicKey, late)
      expect(late).not.toHaveBeenCalled()
    } finally {
      pending.release.resolve()
      await matching
      await client.stop()
    }
  })

  it('settles a registration waiting for startup when stop retires its session', async () => {
    const { client, peer } = await create()
    const callback = vi.fn()
    let settled = false
    // Registration can wait for client readiness; stop retires that pending work.
    void client.listenForEncryptedMessage(peer.publicKey, callback).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await client.stop()
    await setImmediate()
    expect(settled).toBe(true)
    expect(callback).not.toHaveBeenCalled()
  })

  it('keeps a replacement buffer when an old replay registration completes after restart', async () => {
    const { client, sync, peer, recipient, body, payload } = await create()
    sync
      .mockReset()
      .mockResolvedValueOnce(messageSync(recipient, body))
      .mockImplementation(() => new Promise<MatrixSyncResponse>(() => {}))
    await client.start()
    const pending = gate()
    client.receiverSetup = { publicKey: peer.publicKey, gate: pending }
    const retired = vi.fn()
    const registration = client.listenForEncryptedMessage(peer.publicKey, retired)
    await pending.entered.promise
    try {
      await client.stop()
      sync.mockResolvedValueOnce(messageSync(recipient, body))
      await client.start()
      pending.release.resolve()
      await registration
      const current = vi.fn()
      await client.listenForEncryptedMessage(peer.publicKey, current)
      expect(retired).not.toHaveBeenCalled()
      expect(current).toHaveBeenCalledExactlyOnceWith(payload)
    } finally {
      pending.release.resolve()
      await registration
      await client.stop()
    }
  })

  it.each(['stored room', 'joined rooms', 'room creation', 'created room lookup'] as const)(
    'does not send through a replacement client after a delayed %s',
    async (stage) => {
      const { client, storage, peer, recipient, matrix, restart } = await create()
      await client.start()
      const original = matrix()
      const pending = gate()
      if (stage === 'stored room') {
        await client.updatePeerRoom(recipient, oldRoom)
        storage.roomRead = pending
      } else if (stage === 'joined rooms') {
        vi.spyOn(original, 'joinedRooms', 'get').mockImplementation(async () => {
          pending.entered.resolve()
          await pending.release.promise
          return [joinedRoom(oldRoom, recipient)]
        })
      } else {
        vi.spyOn(original, 'createTrustedPrivateRoom').mockImplementation(async () => {
          if (stage === 'room creation') {
            pending.entered.resolve()
            await pending.release.promise
          }
          return oldRoom
        })
        vi.spyOn(original, 'getRoomById').mockImplementation(async () => {
          pending.entered.resolve()
          await pending.release.promise
          return joinedRoom(oldRoom, recipient)
        })
      }
      const sending = client.sendMessage('old request', peer).catch(() => undefined)
      await pending.entered.promise
      try {
        const replacement = await restart()
        const getRoom = vi
          .spyOn(replacement, 'getRoomById')
          .mockResolvedValue(joinedRoom(oldRoom, recipient))
        const send = vi.spyOn(replacement, 'sendTextMessage').mockResolvedValue(undefined)
        pending.release.resolve()
        await sending
        expect(send).not.toHaveBeenCalled()
        expect(getRoom).not.toHaveBeenCalled()
        await expect(storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)).resolves.toEqual({
          [recipient]: replacementRoom
        })
      } finally {
        pending.release.resolve()
        await sending
        await client.stop()
      }
    }
  )

  it.each(['shared key', 'message encryption'] as const)(
    'does not send retired work when its %s finishes after restart',
    async (stage) => {
      const { client, storage, peer, recipient, restart } = await create()
      await client.start()
      await client.updatePeerRoom(recipient, oldRoom)
      const pending = gate()
      if (stage === 'shared key') {
        client.senderSetup = pending
      } else {
        messageEncryption = pending
      }
      const sending = client.sendMessage('old request', peer).catch(() => undefined)
      await pending.entered.promise
      try {
        const replacement = await restart()
        const send = vi.spyOn(replacement, 'sendTextMessage').mockResolvedValue(undefined)
        pending.release.resolve()
        await sending
        expect(send).not.toHaveBeenCalled()
        await expect(storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)).resolves.toEqual({
          [recipient]: replacementRoom
        })
      } finally {
        pending.release.resolve()
        await sending
        await client.stop()
      }
    }
  )

  it.each(['response info', 'asymmetric encryption'] as const)(
    'does not send a retired pairing when its %s finishes after restart',
    async (stage) => {
      const { client, storage, peer, recipient, matrix, restart } = await create()
      await client.start()
      vi.spyOn(matrix(), 'createTrustedPrivateRoom').mockResolvedValue(oldRoom)
      vi.spyOn(matrix(), 'getRoomById').mockResolvedValue(joinedRoom(oldRoom, recipient))
      const pending = gate()
      if (stage === 'response info') {
        const getInfo = client.getPairingResponseInfo.bind(client)
        vi.spyOn(client, 'getPairingResponseInfo').mockImplementation(async (request) => {
          const info = await getInfo(request)
          pending.entered.resolve()
          await pending.release.promise
          return info
        })
      } else {
        client.pairingEncryption = pending
      }
      const pairing = client.sendPairingResponse(peer).catch(() => undefined)
      await pending.entered.promise
      try {
        const replacement = await restart()
        const send = vi.spyOn(replacement, 'sendTextMessage').mockResolvedValue(undefined)
        pending.release.resolve()
        await pairing
        expect(send).not.toHaveBeenCalled()
        await expect(storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)).resolves.toEqual({
          [recipient]: replacementRoom
        })
      } finally {
        pending.release.resolve()
        await pairing
        await client.stop()
      }
    }
  )

  it('does not poll the replacement client when an old join retry becomes due', async () => {
    const { client, peer, recipient, matrix, restart } = await create()
    await client.start()
    const waiting = new ExposedPromise<void>()
    vi.spyOn(matrix(), 'createTrustedPrivateRoom').mockResolvedValue(oldRoom)
    vi.spyOn(matrix(), 'getRoomById').mockImplementation(async () => {
      waiting.resolve()
      return MatrixRoom.from(oldRoom)
    })
    const sending = client.sendMessage('old request', peer).catch(() => undefined)
    await waiting.promise
    await setImmediate()
    try {
      const replacement = await restart()
      const getRoom = vi
        .spyOn(replacement, 'getRoomById')
        .mockResolvedValue(joinedRoom(oldRoom, recipient))
      const send = vi.spyOn(replacement, 'sendTextMessage').mockResolvedValue(undefined)
      await vi.advanceTimersByTimeAsync(100)
      await sending
      expect(getRoom).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    } finally {
      await client.stop()
    }
  })

  it('does not retry a retired send when its forbidden response arrives after restart', async () => {
    const { client, storage, peer, recipient, matrix, restart } = await create()
    await client.start()
    await client.updatePeerRoom(recipient, oldRoom)
    const pending = gate()
    vi.spyOn(matrix(), 'sendTextMessage').mockImplementation(async () => {
      pending.entered.resolve()
      await pending.release.promise
      throw Object.assign(new Error('Room unavailable'), { errcode: 'M_FORBIDDEN' })
    })
    const sending = client.sendMessage('old request', peer).catch(() => undefined)
    await pending.entered.promise
    try {
      const replacement = await restart()
      const send = vi.spyOn(replacement, 'sendTextMessage').mockResolvedValue(undefined)
      const write = vi.spyOn(storage, 'set')
      pending.release.resolve()
      await sending
      expect(send).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalledWith(StorageKey.MATRIX_PEER_ROOM_IDS, expect.anything())
      await expect(storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)).resolves.toEqual({
        [recipient]: replacementRoom
      })
    } finally {
      pending.release.resolve()
      await sending
      await client.stop()
    }
  })

  it('does not overwrite a replacement room when an old pairing room creation completes', async () => {
    const { client, storage, peer, recipient, matrix, restart } = await create()
    await client.start()
    const pending = gate()
    vi.spyOn(matrix(), 'createTrustedPrivateRoom').mockImplementation(async () => {
      pending.entered.resolve()
      await pending.release.promise
      return oldRoom
    })
    const pairing = client.sendPairingResponse(peer).catch(() => undefined)
    await pending.entered.promise
    try {
      const replacement = await restart()
      vi.spyOn(replacement, 'getRoomById').mockResolvedValue(joinedRoom(oldRoom, recipient))
      const send = vi.spyOn(replacement, 'sendTextMessage').mockResolvedValue(undefined)
      pending.release.resolve()
      await pairing
      await expect(storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)).resolves.toEqual({
        [recipient]: replacementRoom
      })
      expect(send).not.toHaveBeenCalled()
    } finally {
      pending.release.resolve()
      await pairing
      await client.stop()
    }
  })
})
