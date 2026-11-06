import { setImmediate } from 'node:timers/promises'
import { LocalStorage, Logger } from '@ecadlabs/beacon-core'
import {
  ExposedPromise,
  getHexHash,
  getKeypairFromSeed,
  sealCryptobox
} from '@ecadlabs/beacon-utils'
import { StorageKey, StorageKeyReturnType } from '@ecadlabs/beacon-types'
import { P2PCommunicationClient } from '../src/communication-client/P2PCommunicationClient'
import { MatrixClient } from '../src/matrix-client/MatrixClient'
import { MatrixUserService } from '../src/matrix-client/services/MatrixUserService'
import { MatrixEventService } from '../src/matrix-client/services/MatrixEventService'
import { MatrixSyncResponse } from '../src/matrix-client/models/api/MatrixSync'

interface Gate {
  entered: ExposedPromise<void>
  release: ExposedPromise<void>
}
const gate = (): Gate => ({ entered: new ExposedPromise(), release: new ExposedPromise() })
let mockOpenGate: Gate | undefined
let mockSenderIdGate: Gate | undefined

vi.mock('@ecadlabs/beacon-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecadlabs/beacon-utils')>()

  return {
    ...actual,
    openCryptobox: async (...args: Parameters<typeof actual.openCryptobox>) => {
      const result = await actual.openCryptobox(...args)
      const pending = mockOpenGate
      if (pending) {
        pending.entered.resolve()
        await pending.release.promise
      }

      return result
    }
  }
})

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecadlabs/beacon-core')>()

  return {
    ...actual,
    getSenderId: async (...args: Parameters<typeof actual.getSenderId>) => {
      const result = await actual.getSenderId(...args)
      const pending = mockSenderIdGate
      if (pending) {
        pending.entered.resolve()
        await pending.release.promise
      }

      return result
    }
  }
})

class ControlledStorage extends LocalStorage {
  public readGate: Gate | undefined
  public writeGate: Gate | undefined

  public override async get<K extends StorageKey>(key: K): Promise<StorageKeyReturnType[K]> {
    const result = await super.get(key)
    const pending = key === StorageKey.MATRIX_PEER_ROOM_IDS ? this.readGate : undefined
    if (pending) {
      this.readGate = undefined
      pending.entered.resolve()
      await pending.release.promise
    }

    return result
  }

  public override async set<K extends StorageKey>(
    key: K,
    value: StorageKeyReturnType[K]
  ): Promise<void> {
    const pending = key === StorageKey.MATRIX_PEER_ROOM_IDS ? this.writeGate : undefined
    if (pending) {
      this.writeGate = undefined
      pending.entered.resolve()
      await pending.release.promise
    }
    await super.set(key, value)
  }
}

const room = '!invited:relay.example'
const sender = '@peer:relay.example'
const emptySync = (): MatrixSyncResponse => ({ next_batch: 'next', rooms: {} })
const inviteSync = (): MatrixSyncResponse => ({
  next_batch: 'invite',
  rooms: {
    invite: {
      [room]: {
        invite_state: {
          events: [
            {
              type: 'm.room.member',
              sender,
              content: { membership: 'join' },
              origin_server_ts: Date.now()
            }
          ]
        }
      }
    }
  }
})
const messageSync = (body: string): MatrixSyncResponse => ({
  next_batch: 'message',
  rooms: {
    join: {
      [room]: {
        state: { events: [] },
        timeline: {
          events: [
            {
              type: 'm.room.message',
              sender,
              content: { msgtype: 'm.text', body },
              event_id: '$channel',
              origin_server_ts: Date.now()
            }
          ]
        }
      }
    }
  }
})

describe('P2P callbacks retired by stop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    vi.spyOn(P2PCommunicationClient.prototype, 'getRelayServer').mockResolvedValue({
      server: 'relay.example',
      timestamp: 12345
    })
    vi.spyOn(MatrixUserService.prototype, 'login').mockResolvedValue({
      user_id: '@sdk:relay.example',
      device_id: 'device',
      access_token: 'token'
    })
  })
  afterEach(() => {
    mockOpenGate = undefined
    mockSenderIdGate = undefined
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    localStorage.clear()
  })

  const create = async (initial: MatrixSyncResponse = emptySync()) => {
    const storage = new ControlledStorage('callback-lifecycle')
    const keys = await getKeypairFromSeed('callback-lifecycle')
    const client = new P2PCommunicationClient('Test', keys, 1, storage)
    const polling = new ExposedPromise<MatrixSyncResponse>()
    const sync = vi
      .spyOn(MatrixEventService.prototype, 'sync')
      .mockResolvedValueOnce(initial)
      .mockImplementation(() => polling.promise)

    return { storage, keys, client, polling, sync }
  }

  it('does not restore a peer room when an old invite join finishes after stop and restart', async () => {
    const { client, storage, sync } = await create(inviteSync())
    const join = gate()
    vi.spyOn(MatrixClient.prototype, 'joinRooms').mockImplementation(async () => {
      join.entered.resolve()
      await join.release.promise
    })
    await client.start()
    await join.entered.promise
    try {
      await client.stop()
      sync.mockResolvedValueOnce(emptySync())
      await client.start()
      await storage.set(StorageKey.MATRIX_PEER_ROOM_IDS, { newer: '!new:relay.example' })
      join.release.resolve()
      await setImmediate()
      await expect(storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)).resolves.toEqual({
        newer: '!new:relay.example'
      })
    } finally {
      join.release.resolve()
      await client.stop()
    }
  })

  it('does not retry an old forbidden invite using a replacement Matrix client', async () => {
    const { client, sync } = await create(inviteSync())
    const entered = new ExposedPromise<void>()
    const join = vi.spyOn(MatrixClient.prototype, 'joinRooms').mockImplementation(async () => {
      entered.resolve()
      throw Object.assign(new Error('Forbidden'), { errcode: 'M_FORBIDDEN' })
    })
    await client.start()
    await entered.promise
    await setImmediate()
    try {
      await client.stop()
      sync.mockResolvedValueOnce(emptySync())
      await client.start()
      await vi.advanceTimersByTimeAsync(200)
      expect(join).toHaveBeenCalledTimes(1)
    } finally {
      await client.stop()
    }
  })

  const openChannel = async () => {
    const setup = await create()
    await setup.client.start()
    const callback = vi.fn()
    await setup.client.listenForChannelOpening(callback)
    const peerKeys = await getKeypairFromSeed('callback-peer')
    const publicKey = Buffer.from(peerKeys.publicKey).toString('hex')
    const pairing = {
      id: 'pairing',
      name: 'Peer',
      publicKey,
      version: '3',
      relayServer: 'relay.example'
    }
    const payload = await sealCryptobox(JSON.stringify(pairing), setup.keys.publicKey)
    const body = `@channel-open:@${await getHexHash(Buffer.from(setup.keys.publicKey))}:${payload}`
    await vi.advanceTimersByTimeAsync(0)

    return { ...setup, callback, pairing, body }
  }

  it('delivers a valid current-session channel opening using real cryptography', async () => {
    const { client, polling, callback, pairing, body } = await openChannel()
    try {
      polling.resolve(messageSync(body))
      await setImmediate()
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(expect.objectContaining(pairing))
    } finally {
      await client.stop()
    }
  })

  it.each(['decrypt', 'senderId'])(
    'does not deliver a channel opening whose %s resumes after stop',
    async (stage) => {
      const { client, polling, callback, body } = await openChannel()
      const pending = gate()
      if (stage === 'decrypt') {
        mockOpenGate = pending
      } else {
        mockSenderIdGate = pending
      }
      polling.resolve(messageSync(body))
      await pending.entered.promise
      try {
        await client.stop()
        pending.release.resolve()
        await setImmediate()
        expect(callback).not.toHaveBeenCalled()
      } finally {
        pending.release.resolve()
        await client.stop()
      }
    }
  )

  it('does not persist an old channel opening after its target match resumes', async () => {
    const { client, storage, polling, callback, body } = await openChannel()
    const pending = gate()
    const getPublicKey = client.getPublicKey.bind(client)
    vi.spyOn(client, 'getPublicKey').mockImplementationOnce(async () => {
      const result = await getPublicKey()
      pending.entered.resolve()
      await pending.release.promise

      return result
    })
    polling.resolve(messageSync(body))
    await pending.entered.promise
    try {
      await client.stop()
      pending.release.resolve()
      await setImmediate()
      expect(callback).not.toHaveBeenCalled()
      await expect(storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)).resolves.toEqual({})
    } finally {
      pending.release.resolve()
      await client.stop()
    }
  })

  it.each(['read', 'write'])(
    'does not leave an old peer mapping after an in-flight storage %s',
    async (stage) => {
      const { client, storage } = await create(inviteSync())
      const write = vi.spyOn(storage, 'set')
      const pending = gate()
      if (stage === 'read') {
        storage.readGate = pending
      } else {
        storage.writeGate = pending
      }
      vi.spyOn(MatrixClient.prototype, 'joinRooms').mockResolvedValue(undefined)
      await client.start()
      await pending.entered.promise
      const stopping = client.stop()
      try {
        await setImmediate()
        pending.release.resolve()
        await stopping
        await setImmediate()
        await expect(storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)).resolves.toEqual({})
        if (stage === 'read') {
          expect(write).not.toHaveBeenCalledWith(StorageKey.MATRIX_PEER_ROOM_IDS, {
            [sender]: room
          })
        }
      } finally {
        pending.release.resolve()
        await stopping
        await client.stop()
      }
    }
  )

  it('preserves both peer mappings when public updates overlap a storage read', async () => {
    const { client, storage } = await create()
    await client.start()
    const pending = gate()
    storage.readGate = pending
    const first = client.updatePeerRoom('@alice:relay.example', '!alice:relay.example')
    await pending.entered.promise
    const second = client.updatePeerRoom('@bob:relay.example', '!bob:relay.example')
    try {
      await setImmediate()
      pending.release.resolve()
      await Promise.all([first, second])
      await expect(storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)).resolves.toEqual({
        '@alice:relay.example': '!alice:relay.example',
        '@bob:relay.example': '!bob:relay.example'
      })
    } finally {
      pending.release.resolve()
      await Promise.allSettled([first, second])
      await client.stop()
    }
  })

  const updateMethods: Array<'updatePeerRoom' | 'updateRelayServer'> = [
    'updatePeerRoom',
    'updateRelayServer'
  ]
  it.each(updateMethods)('preserves asynchronous error boundaries for %s', async (method) => {
    const { client } = await create()
    const failure = new Error('Logger failed')
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      throw failure
    })
    try {
      const result =
        method === 'updatePeerRoom'
          ? client.updatePeerRoom(sender, room)
          : client.updateRelayServer(sender)
      await expect(result).rejects.toBe(failure)
    } finally {
      log.mockRestore()
    }
  })
})
