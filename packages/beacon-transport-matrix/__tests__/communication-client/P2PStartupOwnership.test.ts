import { setImmediate } from 'node:timers/promises'
import { LocalStorage } from '@ecadlabs/beacon-core'
import { Regions, StorageKey } from '@ecadlabs/beacon-types'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { P2PCommunicationClient } from '../../src/communication-client/P2PCommunicationClient'
import { MatrixClient } from '../../src/matrix-client/MatrixClient'
import { MatrixHttpClient } from '../../src/matrix-client/MatrixHttpClient'
import { MatrixEventService } from '../../src/matrix-client/services/MatrixEventService'
import { MatrixRoomService } from '../../src/matrix-client/services/MatrixRoomService'
import { MatrixUserService } from '../../src/matrix-client/services/MatrixUserService'
import { MatrixLoginResponse } from '../../src/matrix-client/models/api/MatrixLogin'

type Outcome =
  { status: 'pending' } | { status: 'resolved' } | { status: 'rejected'; reason: unknown }

function observe(promise: Promise<void>) {
  let outcome: Outcome = { status: 'pending' }
  const settled = promise.then(
    () => {
      outcome = { status: 'resolved' }
    },
    (reason: unknown) => {
      outcome = { status: 'rejected', reason }
    }
  )
  return {
    settled,
    get outcome(): Outcome {
      return outcome
    }
  }
}

const relayInfo = { region: Regions.EUROPE_WEST, known_servers: [], timestamp: 12345 }
const loginResponse = (token: string): MatrixLoginResponse => ({
  user_id: '@sdk:relay.example',
  device_id: 'device',
  access_token: token
})

describe('P2P startup ownership', () => {
  const allocatedClients: MatrixClient[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(async () => {
    await Promise.allSettled(allocatedClients.splice(0).map((client) => client.stop()))
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    localStorage.clear()
  })

  async function setup() {
    const storage = new LocalStorage('p2p-startup-ownership')
    await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'relay.example')
    const client = new P2PCommunicationClient(
      'Test',
      await getKeypairFromSeed('p2p-startup-ownership'),
      1,
      storage,
      { [Regions.EUROPE_WEST]: ['relay.example'] }
    )
    const info = vi.spyOn(client, 'getBeaconInfo').mockResolvedValue(relayInfo)
    const login = vi
      .spyOn(MatrixUserService.prototype, 'login')
      .mockResolvedValue(loginResponse('current-token'))
    const sync = vi
      .spyOn(MatrixEventService.prototype, 'sync')
      .mockImplementation(async (token) => ({
        next_batch: token,
        rooms: {}
      }))
    const create = MatrixClient.create
    const allocate = vi.spyOn(MatrixClient, 'create').mockImplementation((options) => {
      const matrixClient = create(options)
      allocatedClients.push(matrixClient)
      return matrixClient
    })
    const cancel = vi.spyOn(MatrixHttpClient.prototype, 'cancelAllRequests')
    const join = vi
      .spyOn(MatrixRoomService.prototype, 'joinRoom')
      .mockResolvedValue({ room_id: '!current:relay.example' })
    return { storage, client, info, login, sync, allocate, cancel, join }
  }

  it.each(['relay', 'login'])('joins startup already waiting for %s', async (boundary) => {
    const { client, info, login, allocate } = await setup()
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    if (boundary === 'relay') {
      info.mockImplementationOnce(async () => {
        entered.resolve()
        await release.promise
        return relayInfo
      })
    } else {
      login.mockImplementationOnce(async () => {
        entered.resolve()
        await release.promise
        return loginResponse('current-token')
      })
    }
    const first = observe(client.start())
    await entered.promise
    const second = observe(client.start())
    try {
      await setImmediate()
      const beforeRelease = [first.outcome.status, second.outcome.status]
      release.resolve()
      await Promise.all([first.settled, second.settled])

      expect(beforeRelease).toEqual(['pending', 'pending'])
      expect(first.outcome).toEqual({ status: 'resolved' })
      expect(second.outcome).toEqual({ status: 'resolved' })
      expect(allocate).toHaveBeenCalledTimes(1)
      expect(login).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve()
      await Promise.all([first.settled, second.settled])
      await client.stop()
    }
  })

  it('keeps the ready client when start is repeated', async () => {
    const { client, allocate, login, join } = await setup()
    await client.start()
    try {
      await client.start()
      await client.tryJoinRooms('!current:relay.example')

      expect(allocate).toHaveBeenCalledTimes(1)
      expect(login).toHaveBeenCalledTimes(1)
      expect(join).toHaveBeenCalledWith(
        'current-token',
        expect.objectContaining({ id: '!current:relay.example' })
      )
    } finally {
      await client.stop()
    }
  })

  it.each(['success', 'failure'])(
    'aborts startup before held relay discovery reports %s',
    async (completion) => {
      const { client, info, allocate, storage } = await setup()
      const entered = new ExposedPromise<void>()
      const discovery = new ExposedPromise<typeof relayInfo>()
      info.mockImplementationOnce(() => {
        entered.resolve()
        return discovery.promise
      })
      const starting = observe(client.start())
      await entered.promise
      try {
        await client.stop()
        await setImmediate()
        const afterStop = starting.outcome
        await client.start()
        await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'current-relay.example')
        if (completion === 'success') discovery.resolve(relayInfo)
        else discovery.reject(new Error('Previous relay unavailable'))
        await starting.settled

        expect(afterStop).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } })
        expect(starting.outcome).toMatchObject({
          status: 'rejected',
          reason: { name: 'AbortError' }
        })
        expect(allocate).toHaveBeenCalledTimes(1)
        await expect(storage.get(StorageKey.MATRIX_SELECTED_NODE)).resolves.toBe(
          'current-relay.example'
        )
      } finally {
        discovery.resolve(relayInfo)
        await starting.settled
        await client.stop()
      }
    }
  )

  it('joins repeated stop while the owned HTTP cleanup is pending', async () => {
    const { client, cancel } = await setup()
    await client.start()
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    cancel.mockImplementationOnce(() => {
      entered.resolve()
      return release.promise
    })
    const first = observe(client.stop())
    await entered.promise
    const second = observe(client.stop())
    try {
      await setImmediate()
      const beforeRelease = [first.outcome.status, second.outcome.status]
      release.resolve()
      await Promise.all([first.settled, second.settled])

      expect(beforeRelease).toEqual(['pending', 'pending'])
      expect(first.outcome).toEqual({ status: 'resolved' })
      expect(second.outcome).toEqual({ status: 'resolved' })
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve()
      await Promise.all([first.settled, second.settled])
      await client.stop()
    }
  })

  it('starts a fresh client after the previous HTTP cleanup completes', async () => {
    const { client, cancel, login, allocate, join } = await setup()
    await client.start()
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    cancel.mockImplementationOnce(() => {
      entered.resolve()
      return release.promise
    })
    const stopping = observe(client.stop())
    await entered.promise
    login.mockResolvedValue(loginResponse('replacement-token'))
    const restarting = observe(client.start())
    try {
      await setImmediate()
      const beforeRelease = {
        outcome: restarting.outcome.status,
        allocations: allocate.mock.calls.length
      }
      release.resolve()
      await Promise.all([stopping.settled, restarting.settled])

      expect(beforeRelease).toEqual({ outcome: 'pending', allocations: 1 })
      expect(restarting.outcome).toEqual({ status: 'resolved' })
      expect(allocate).toHaveBeenCalledTimes(2)
      await client.tryJoinRooms('!current:relay.example')
      expect(join).toHaveBeenCalledWith(
        'replacement-token',
        expect.objectContaining({ id: '!current:relay.example' })
      )
    } finally {
      release.resolve()
      await Promise.all([stopping.settled, restarting.settled])
      await client.stop()
    }
  })

  it('releases the pending polling retry timer on stop', async () => {
    const { client, sync } = await setup()
    vi.spyOn(client, 'getRelayServer').mockResolvedValue({
      server: 'relay.example',
      timestamp: relayInfo.timestamp
    })
    await client.start()
    try {
      await setImmediate()
      sync.mockRejectedValue(new Error('Sync unavailable'))
      for (let retry = 0; retry < 4; retry++) await vi.runOnlyPendingTimersAsync()
      expect(sync).toHaveBeenCalledTimes(5)
      await vi.advanceTimersByTimeAsync(4999)
      expect(sync).toHaveBeenCalledTimes(5)
      expect(vi.getTimerCount()).toBeGreaterThan(0)

      await client.stop()
      // Drain storage notifications while the polling retry is still one millisecond away.
      await vi.advanceTimersByTimeAsync(0)
      const timersAfterStop = vi.getTimerCount()
      await vi.advanceTimersByTimeAsync(5000)

      expect(sync).toHaveBeenCalledTimes(5)
      expect(timersAfterStop).toBe(0)
    } finally {
      await client.stop()
    }
  })

  it('resets after cleanup failure and retains a restart when the previous login later fails', async () => {
    const { client, login, sync, cancel, storage, join } = await setup()
    const entered = new ExposedPromise<void>()
    const previousLogin = new ExposedPromise<MatrixLoginResponse>()
    login.mockImplementationOnce(() => {
      entered.resolve()
      return previousLogin.promise
    })
    const starting = observe(client.start())
    await entered.promise
    await storage.set(StorageKey.MATRIX_PEER_ROOM_IDS, { previous: '!previous:relay.example' })
    await storage.set(StorageKey.MATRIX_PRESERVED_STATE, { syncToken: 'previous-sync', rooms: {} })
    const cleanupError = new Error('HTTP cleanup failed')
    cancel.mockRejectedValueOnce(cleanupError)
    try {
      await expect(client.stop()).rejects.toBe(cleanupError)
      await starting.settled
      expect(starting.outcome).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } })
      await expect(storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)).resolves.toEqual({})
      expect(
        localStorage.getItem(storage.getPrefixedKey(StorageKey.MATRIX_PRESERVED_STATE))
      ).toBeNull()
      await client.start()
      await storage.set(StorageKey.MATRIX_PEER_ROOM_IDS, { current: '!current:relay.example' })
      previousLogin.reject(new Error('Previous login failed'))
      await setImmediate()
      await client.tryJoinRooms('!current:relay.example')

      expect(sync).toHaveBeenCalledTimes(1)
      expect(join).toHaveBeenCalledWith(
        'current-token',
        expect.objectContaining({ id: '!current:relay.example' })
      )
      await expect(storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)).resolves.toEqual({
        current: '!current:relay.example'
      })
    } finally {
      previousLogin.resolve(loginResponse('previous-token'))
      await starting.settled
      await client.stop()
    }
  })
})
