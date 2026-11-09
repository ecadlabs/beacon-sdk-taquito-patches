import { setImmediate } from 'node:timers/promises'
import { LocalStorage, Logger } from '@ecadlabs/beacon-core'
import {
  ExposedPromise,
  getHexHash,
  getKeypairFromSeed,
  sealCryptobox
} from '@ecadlabs/beacon-utils'
import { StorageKey, StorageKeyReturnType } from '@ecadlabs/beacon-types'
import { P2PTransport } from '../src/P2PTransport'
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

jest.mock('@ecadlabs/beacon-utils', () => {
  const actual =
    jest.requireActual<typeof import('@ecadlabs/beacon-utils')>('@ecadlabs/beacon-utils')

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

jest.mock('@ecadlabs/beacon-core', () => {
  const actual = jest.requireActual<typeof import('@ecadlabs/beacon-core')>('@ecadlabs/beacon-core')

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
const inviteSync = (target: string): MatrixSyncResponse => ({
  next_batch: 'invite',
  rooms: {
    invite: {
      [room]: {
        invite_state: {
          events: [
            {
              type: 'm.room.member',
              sender,
              content: { membership: 'invite' },
              state_key: target,
              origin_server_ts: Date.now()
            }
          ]
        }
      }
    }
  }
})
const messageSync = (body: string, messageSender = sender): MatrixSyncResponse => ({
  next_batch: 'message',
  rooms: {
    join: {
      [room]: {
        state: { events: [] },
        timeline: {
          events: [
            {
              type: 'm.room.message',
              sender: messageSender,
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
    jest.useFakeTimers()
    localStorage.clear()
    jest
      .spyOn(P2PCommunicationClient.prototype, 'getRelayServer')
      .mockResolvedValue({ server: 'relay.example', timestamp: 12345 })
    jest.spyOn(MatrixUserService.prototype, 'login').mockResolvedValue({
      user_id: '@sdk:relay.example',
      device_id: 'device',
      access_token: 'token'
    })
  })
  afterEach(() => {
    mockOpenGate = undefined
    mockSenderIdGate = undefined
    jest.restoreAllMocks()
    jest.clearAllTimers()
    jest.useRealTimers()
    localStorage.clear()
  })

  const create = async (initial: MatrixSyncResponse = emptySync()) => {
    const storage = new ControlledStorage('callback-lifecycle')
    const keys = await getKeypairFromSeed('callback-lifecycle')
    const client = new P2PCommunicationClient('Test', keys, 1, storage)
    const polling = new ExposedPromise<MatrixSyncResponse>()
    const sync = jest
      .spyOn(MatrixEventService.prototype, 'sync')
      .mockResolvedValueOnce(initial)
      .mockImplementation(() => polling.promise)

    return { storage, keys, client, polling, sync }
  }

  it('retries startup on the same transport after the first attempt fails', async () => {
    const { storage, keys } = await create()
    const transport = new P2PTransport(
      'Test',
      keys,
      storage,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    const failure = new Error('relay unavailable')
    const start = jest
      .spyOn(P2PCommunicationClient.prototype, 'start')
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined)

    await expect(transport.connect()).rejects.toBe(failure)
    await expect(transport.connect()).resolves.toBeUndefined()
    expect(start).toHaveBeenCalledTimes(2)
    await transport.disconnect()
  })

  it('lets a single caller retry failed discovery without a detached rejection', async () => {
    jest.mocked(P2PCommunicationClient.prototype.getRelayServer).mockRestore()
    const { storage, keys } = await create()
    const client = new P2PCommunicationClient('Test', keys, 1, storage, {
      test: ['relay.example']
    })
    const probe = jest
      .spyOn(client, 'getBeaconInfo')
      .mockRejectedValue(new Error('relay unavailable'))

    await expect(client.getRelayServer()).rejects.toThrow('No server responded')
    await setImmediate()
    const failedProbes = probe.mock.calls.length
    probe.mockResolvedValue({ region: 'test', known_servers: [], timestamp: 12345 })
    await expect(client.getRelayServer()).resolves.toEqual({
      server: expect.any(String),
      timestamp: 12345
    })
    expect(failedProbes).toBeGreaterThan(0)
    expect(probe).toHaveBeenCalledTimes(2 * failedProbes)
  })

  it('rediscovers the relay after a failed login and after stop', async () => {
    jest.mocked(P2PCommunicationClient.prototype.getRelayServer).mockRestore()
    const { storage, keys, sync } = await create()
    const client = new P2PCommunicationClient('Test', keys, 1, storage, {
      test: ['relay.example']
    })
    const probe = jest.spyOn(client, 'getBeaconInfo').mockResolvedValue({
      region: 'test',
      known_servers: [],
      timestamp: 12345
    })
    const login = jest.mocked(MatrixUserService.prototype.login)
    login.mockRejectedValueOnce(new Error('first login failed'))

    await client.start()
    expect(login).toHaveBeenCalledTimes(2)
    const firstStartProbes = probe.mock.calls.length
    expect(firstStartProbes).toBeGreaterThan(1)
    await client.stop()

    sync.mockResolvedValueOnce(emptySync())
    try {
      await client.start()
      expect(login).toHaveBeenCalledTimes(3)
      expect(probe.mock.calls.length).toBeGreaterThan(firstStartProbes)
    } finally {
      await client.stop()
    }
  })

  it('connects healthy saved peers even if one listener fails to register', async () => {
    const { storage, keys } = await create()
    const transport = new P2PTransport(
      'Test',
      keys,
      storage,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    await storage.set(
      StorageKey.TRANSPORT_P2P_PEERS_DAPP,
      ['bad-key', 'good-key'].map((publicKey) => ({
        type: 'p2p-pairing-response',
        id: publicKey,
        name: publicKey,
        publicKey,
        senderId: publicKey,
        version: '2',
        relayServer: 'relay.example'
      }))
    )
    jest.spyOn(P2PCommunicationClient.prototype, 'start').mockResolvedValue(undefined)
    const listen = jest.spyOn(transport, 'listen').mockImplementation(async (key) => {
      if (key === 'bad-key') {
        throw new Error('bad saved peer')
      }
    })

    await expect(transport.connect()).resolves.toBeUndefined()
    expect(listen).toHaveBeenCalledWith('good-key')
    await transport.disconnect()
  })

  it('shares a pending disconnect and reconnects only after cleanup', async () => {
    const { storage, keys } = await create()
    const transport = new P2PTransport(
      'Test',
      keys,
      storage,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    const cleanup = gate()
    const start = jest.spyOn(P2PCommunicationClient.prototype, 'start').mockResolvedValue(undefined)
    const stop = jest.spyOn(P2PCommunicationClient.prototype, 'stop').mockImplementation(async () => {
      cleanup.entered.resolve()
      await cleanup.release.promise
    })

    await transport.connect()
    const first = transport.disconnect()
    await cleanup.entered.promise
    const second = transport.disconnect()
    await transport.connect()
    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    cleanup.release.resolve()
    await Promise.all([first, second])

    await transport.connect()
    expect(start).toHaveBeenCalledTimes(2)
    await transport.disconnect()
  })

  it('registers a saved peer on the replacement Matrix client', async () => {
    const { client, sync } = await create()
    const peer = await getKeypairFromSeed('saved-peer')
    const key = Buffer.from(peer.publicKey).toString('hex')
    const subscribe = jest.spyOn(MatrixClient.prototype, 'subscribe')
    await client.start()
    try {
      await client.listenForEncryptedMessage(key, jest.fn())
      const first = subscribe.mock.contexts.at(-1)
      const count = subscribe.mock.calls.length
      await client.stop()
      sync.mockResolvedValueOnce(emptySync())
      await client.start()
      const beforeRegistration = subscribe.mock.calls.length
      expect(beforeRegistration).toBeGreaterThan(count)
      await client.listenForEncryptedMessage(key, jest.fn())
      expect(subscribe.mock.calls).toHaveLength(beforeRegistration + 1)
      expect(subscribe.mock.contexts.at(-1)).not.toBe(first)
    } finally {
      await client.stop()
    }
  })

  it('does not restore a peer room when an old invite join finishes after stop and restart', async () => {
    const { client, storage, sync } = await create(inviteSync(`@${await getHexHash(Buffer.from((await getKeypairFromSeed('callback-lifecycle')).publicKey))}:relay.example`))
    const join = gate()
    jest.spyOn(MatrixClient.prototype, 'joinRooms').mockImplementation(async () => {
      join.entered.resolve()
      await join.release.promise
    })
    await client.getPairingRequestInfo()
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
    const { client, sync } = await create(inviteSync(`@${await getHexHash(Buffer.from((await getKeypairFromSeed('callback-lifecycle')).publicKey))}:relay.example`))
    const entered = new ExposedPromise<void>()
    const join = jest.spyOn(MatrixClient.prototype, 'joinRooms').mockImplementation(async () => {
      entered.resolve()
      throw Object.assign(new Error('Forbidden'), { errcode: 'M_FORBIDDEN' })
    })
    await client.getPairingRequestInfo()
    await client.start()
    await entered.promise
    await setImmediate()
    try {
      await client.stop()
      sync.mockResolvedValueOnce(emptySync())
      await client.start()
      await jest.advanceTimersByTimeAsync(200)
      expect(join).toHaveBeenCalledTimes(1)
    } finally {
      await client.stop()
    }
  })

  it.each(['cancelled', 'expired', 'replaced', 'valid'])('rechecks pending invite eligibility on a %s retry', async (outcome) => {
    const keys = await getKeypairFromSeed('callback-lifecycle')
    const target = `@${await getHexHash(Buffer.from(keys.publicKey))}:relay.example`
    const { client } = await create(inviteSync(target))
    const join = jest.spyOn(MatrixClient.prototype, 'joinRooms')
      .mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { errcode: 'M_FORBIDDEN' }))
      .mockResolvedValue(undefined)
    await client.getPairingRequestInfo()
    await client.start()
    await setImmediate()
    expect(join).toHaveBeenCalledTimes(1)
    if (outcome === 'cancelled' || outcome === 'replaced') await client.cancelPairingRequests()
    if (outcome === 'replaced') await client.getPairingRequestInfo()
    if (outcome === 'expired') jest.setSystemTime(Date.now() + 31 * 60 * 1000)
    await jest.advanceTimersByTimeAsync(200)
    expect(join).toHaveBeenCalledTimes(outcome === 'valid' ? 2 : 1)
    await client.stop()
  })

  it('does not retry a known-peer invite after that peer is removed', async () => {
    const keys = await getKeypairFromSeed('callback-lifecycle')
    const peerKeys = await getKeypairFromSeed('known-inviter')
    const target = `@${await getHexHash(Buffer.from(keys.publicKey))}:relay.example`
    const invitation = inviteSync(target)
    const inviter = `@${await getHexHash(Buffer.from(peerKeys.publicKey))}:relay.example`
    const events = invitation.rooms?.invite?.[room].invite_state.events
    if (!events) throw new Error('Missing invite fixture')
    events[0].sender = inviter
    const { client, storage } = await create(invitation)
    await storage.set(StorageKey.TRANSPORT_P2P_PEERS_DAPP, [{
      id: 'known', type: 'p2p-pairing-response', name: 'Known', version: '3',
      publicKey: Buffer.from(peerKeys.publicKey).toString('hex'), relayServer: 'relay.example', senderId: 'known'
    }])
    const join = jest.spyOn(MatrixClient.prototype, 'joinRooms')
      .mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { errcode: 'M_FORBIDDEN' }))
      .mockResolvedValue(undefined)
    await client.start()
    await setImmediate()
    expect(join).toHaveBeenCalledTimes(1)
    await storage.set(StorageKey.TRANSPORT_P2P_PEERS_DAPP, [])
    await jest.advanceTimersByTimeAsync(200)
    expect(join).toHaveBeenCalledTimes(1)
    await client.stop()
  })

  it.each([false, true])('retains known peer matching after pairing ends, previously stored=%s', async (existing) => {
    const keys = await getKeypairFromSeed('callback-lifecycle')
    const peerKeys = await getKeypairFromSeed('known-inviter')
    const target = `@${await getHexHash(Buffer.from(keys.publicKey))}:relay.example`
    const invitation = inviteSync(target)
    const events = invitation.rooms?.invite?.[room].invite_state.events
    if (!events) throw new Error('Missing invite fixture')
    events[0].sender = `@${await getHexHash(Buffer.from(peerKeys.publicKey))}:relay.example`
    const { client, storage } = await create(invitation)
    const peer = {
      id: 'known', type: 'p2p-pairing-response' as const, name: 'Known', version: '3',
      publicKey: Buffer.from(peerKeys.publicKey).toString('hex'), relayServer: 'relay.example', senderId: 'known'
    }
    if (existing) await storage.set(StorageKey.TRANSPORT_P2P_PEERS_DAPP, [peer])
    const join = jest.spyOn(MatrixClient.prototype, 'joinRooms')
      .mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { errcode: 'M_FORBIDDEN' }))
      .mockResolvedValue(undefined)
    await client.getPairingRequestInfo()
    await client.start()
    await setImmediate()
    expect(join).toHaveBeenCalledTimes(1)
    await client.cancelPairingRequests()
    if (!existing) await storage.set(StorageKey.TRANSPORT_P2P_PEERS_DAPP, [peer])
    await jest.advanceTimersByTimeAsync(200)
    expect(join).toHaveBeenCalledTimes(2)
    await client.stop()
  })

  it('does not accept a delayed invite using a replacement pairing', async () => {
    const { client, keys, polling } = await create()
    const target = `@${await getHexHash(Buffer.from(keys.publicKey))}:relay.example`
    await client.getPairingRequestInfo()
    await client.start()
    await jest.advanceTimersByTimeAsync(0)
    const pending = gate()
    const getHash = client.getPublicKeyHash.bind(client)
    jest.spyOn(client, 'getPublicKeyHash').mockImplementationOnce(async () => {
      pending.entered.resolve()
      await pending.release.promise
      return getHash()
    })
    const join = jest.spyOn(MatrixClient.prototype, 'joinRooms').mockResolvedValue(undefined)
    polling.resolve(inviteSync(target))
    await pending.entered.promise
    await client.cancelPairingRequests()
    await client.getPairingRequestInfo()
    pending.release.resolve()
    await setImmediate()
    expect(join).not.toHaveBeenCalled()
    await client.stop()
  })

})
