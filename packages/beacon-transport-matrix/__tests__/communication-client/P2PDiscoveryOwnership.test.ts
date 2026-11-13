import { setImmediate } from 'node:timers/promises'
import { ClientEvents, LocalStorage } from '@ecadlabs/beacon-core'
import { Regions, StorageKey } from '@ecadlabs/beacon-types'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { P2PCommunicationClient } from '../../src/communication-client/P2PCommunicationClient'
import { MatrixHttpClient } from '../../src/matrix-client/MatrixHttpClient'
import { MatrixEventService } from '../../src/matrix-client/services/MatrixEventService'
import { MatrixUserService } from '../../src/matrix-client/services/MatrixUserService'
import { MatrixSyncResponse } from '../../src/matrix-client/models/api/MatrixSync'

const relay = 'relay.example'
const relayResponse = (timestamp = 12345) =>
  new Response(
    JSON.stringify({
      region: Regions.EUROPE_WEST,
      known_servers: [relay],
      timestamp
    })
  )

describe('Matrix discovery ownership', () => {
  const clients: P2PCommunicationClient[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.stop()))
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    localStorage.clear()
  })

  const create = async () => {
    const storage = new LocalStorage('discovery-ownership')
    const client = new P2PCommunicationClient(
      'Test',
      await getKeypairFromSeed('discovery-ownership'),
      1,
      storage,
      { [Regions.EUROPE_WEST]: [relay] }
    )
    clients.push(client)
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => relayResponse())
    const login = vi.spyOn(MatrixUserService.prototype, 'login').mockResolvedValue({
      user_id: '@self:relay.example',
      device_id: 'device',
      access_token: 'current-token'
    })
    const polling = new ExposedPromise<MatrixSyncResponse>()
    const sync = vi
      .spyOn(MatrixEventService.prototype, 'sync')
      .mockResolvedValueOnce({ next_batch: 'initial', rooms: {} })
      .mockImplementation(() => polling.promise)
    return { client, storage, fetch, login, sync }
  }

  it('releases the discovery deadline after the relay response succeeds', async () => {
    const { client, storage } = await create()
    await expect(client.getRelayServer()).resolves.toEqual({ server: relay, timestamp: 12345 })
    await expect(storage.get(StorageKey.MATRIX_SELECTED_NODE)).resolves.toBe(relay)
    // Drain queued storage events before checking discovery timer disposal.
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains stored relay recovery when a relay-change callback throws synchronously', async () => {
    const { client, storage, fetch } = await create()
    client.relayServer = ExposedPromise.resolve({
      server: 'previous.example',
      timestamp: 1,
      localTimestamp: Date.now()
    })
    await client.getRelayServer()
    client.relayServer = undefined
    await storage.set(StorageKey.MATRIX_SELECTED_NODE, relay)
    const remove = vi.spyOn(storage, 'delete')
    const status = vi.fn(() => {
      throw new Error('consumer callback failed')
    })
    client.eventHandlers.set(ClientEvents.TRANSPORT_STATUS, status)

    await expect(client.getRelayServer()).resolves.toMatchObject({
      server: relay,
      timestamp: 12345
    })

    expect(status).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenCalledWith({ reason: 'relay_changed', relayServer: relay })
    expect(remove).toHaveBeenCalledWith(StorageKey.MATRIX_SELECTED_NODE)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(client.currentRelayServer).toBe(relay)
    await expect(storage.get(StorageKey.MATRIX_SELECTED_NODE)).resolves.toBe(relay)
  })

  it('rejects both discovery callers and permits a successful retry', async () => {
    const { client, storage, fetch } = await create()
    const entered = new ExposedPromise<void>()
    const response = new ExposedPromise<Response>()
    fetch.mockImplementationOnce(() => {
      entered.resolve()
      return response.promise
    })
    let settled = 0
    const observe = (call: ReturnType<P2PCommunicationClient['getRelayServer']>) =>
      call.then(
        (value) => {
          settled += 1
          return { status: 'resolved', value }
        },
        (reason: unknown) => {
          settled += 1
          return { status: 'rejected', reason }
        }
      )
    const first = observe(client.getRelayServer())
    await entered.promise
    const second = observe(client.getRelayServer())
    try {
      response.reject(new Error('offline'))
      await setImmediate()
      // Observe settlement before awaiting either caller, so a missing rejection fails promptly.
      expect(settled).toBe(2)
      for (const call of [first, second]) {
        await expect(call).resolves.toMatchObject({
          status: 'rejected',
          reason: { message: 'No server responded.' }
        })
      }
      expect(fetch).toHaveBeenCalledTimes(1)

      await expect(client.getRelayServer()).resolves.toEqual({ server: relay, timestamp: 12345 })
      expect(fetch).toHaveBeenCalledTimes(2)
      await expect(storage.get(StorageKey.MATRIX_SELECTED_NODE)).resolves.toBe(relay)
    } finally {
      response.reject(new Error('offline'))
      await client.stop()
    }
  })

  it('joins replacement discovery after two stale refreshes fail across queued deletions', async () => {
    const { client, storage, fetch } = await create()
    client.relayServer = ExposedPromise.resolve({
      server: 'stale.example',
      timestamp: 1,
      localTimestamp: Date.now() - 60_001
    })
    const refreshesEntered = new ExposedPromise<void>()
    const refreshes = [new ExposedPromise<Response>(), new ExposedPromise<Response>()]
    let refreshCount = 0
    for (const refresh of refreshes) {
      fetch.mockImplementationOnce(() => {
        refreshCount += 1
        if (refreshCount === 2) refreshesEntered.resolve()
        return refresh.promise
      })
    }
    const replacementEntered = new ExposedPromise<void>()
    const replacement = new ExposedPromise<Response>()
    fetch.mockImplementationOnce(() => {
      replacementEntered.resolve()
      return replacement.promise
    })
    const releaseFirstDelete = new ExposedPromise<void>()
    const releaseSecondDelete = new ExposedPromise<void>()
    const secondDeleteEntered = new ExposedPromise<void>()
    const remove = storage.delete.bind(storage)
    let deletions = 0
    vi.spyOn(storage, 'delete').mockImplementation(async (key) => {
      if (key === StorageKey.MATRIX_SELECTED_NODE) {
        deletions += 1
        if (deletions === 1) await releaseFirstDelete.promise
        if (deletions === 2) {
          secondDeleteEntered.resolve()
          await releaseSecondDelete.promise
        }
      }
      await remove(key)
    })
    const calls = [client.getRelayServer(), client.getRelayServer()]
    // Keep failures observable while the scheduled storage operations are held.
    const outcomes = Promise.allSettled(calls)
    try {
      await refreshesEntered.promise
      for (const refresh of refreshes) refresh.reject(new Error('stale relay offline'))
      releaseFirstDelete.resolve()
      await Promise.all([replacementEntered.promise, secondDeleteEntered.promise])
      releaseSecondDelete.resolve()
      await setImmediate()
      expect(fetch).toHaveBeenCalledTimes(3)
      replacement.resolve(relayResponse())

      await expect(outcomes).resolves.toEqual([
        { status: 'fulfilled', value: { server: relay, timestamp: 12345 } },
        { status: 'fulfilled', value: { server: relay, timestamp: 12345 } }
      ])
      await expect(storage.get(StorageKey.MATRIX_SELECTED_NODE)).resolves.toBe(relay)
    } finally {
      for (const refresh of refreshes) refresh.reject(new Error('stale relay offline'))
      releaseFirstDelete.resolve()
      releaseSecondDelete.resolve()
      replacement.resolve(relayResponse())
      await client.stop()
      await outcomes
    }
  })

  it('aborts held discovery on stop and leaves a replacement unchanged after its late response', async () => {
    const { client, storage, fetch, login } = await create()
    const entered = new ExposedPromise<void>()
    const response = new ExposedPromise<Response>()
    let requestSignal: AbortSignal | null | undefined
    fetch.mockImplementationOnce((_url, options) => {
      requestSignal = options?.signal
      entered.resolve()
      // A response can still finish after cancellation reaches the request boundary.
      return response.promise
    })
    const starting = client.start()
    const cancelled = expect(starting).rejects.toMatchObject({ name: 'AbortError' })
    await entered.promise
    try {
      await client.stop()
      await cancelled
      expect.soft(requestSignal?.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      expect.soft(vi.getTimerCount()).toBe(0)

      await client.start()
      await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'replacement-relay.example')
      response.resolve(relayResponse(54321))
      await setImmediate()
      await expect(client.getRelayServer()).resolves.toEqual({ server: relay, timestamp: 12345 })
      await expect(storage.get(StorageKey.MATRIX_SELECTED_NODE)).resolves.toBe(
        'replacement-relay.example'
      )
      expect(login).toHaveBeenCalledTimes(1)
    } finally {
      response.resolve(relayResponse(54321))
      await setImmediate()
    }
  })

  it('discovers again on the same object after stop removes the stored relay', async () => {
    const { client, storage, login, sync } = await create()
    await client.start()
    await client.stop()
    await expect(storage.get(StorageKey.MATRIX_SELECTED_NODE)).resolves.toBeUndefined()
    sync.mockResolvedValueOnce({ next_batch: 'replacement', rooms: {} })

    await expect(client.start()).resolves.toBeUndefined()

    expect(login).toHaveBeenCalledTimes(2)
    await expect(client.getRelayServer()).resolves.toEqual({ server: relay, timestamp: 12345 })
    await expect(storage.get(StorageKey.MATRIX_SELECTED_NODE)).resolves.toBe(relay)
  })

  it.each(['DOMException', 'Error'] as const)(
    'cleans up login interrupted by %s and restores registration readiness on direct retry',
    async (kind) => {
      const { client, storage, login } = await create()
      // Use the stored-node path to isolate readiness recovery from full discovery selection.
      await storage.set(StorageKey.MATRIX_SELECTED_NODE, relay)
      const cancel = vi.spyOn(MatrixHttpClient.prototype, 'cancelAllRequests')
      const failure =
        kind === 'DOMException'
          ? new DOMException('Relay login interrupted', 'AbortError')
          : Object.assign(new Error('Relay login interrupted'), { name: 'AbortError' })
      login.mockRejectedValueOnce(failure)
      await expect(client.start()).rejects.toMatchObject({ name: 'AbortError' })
      expect.soft(cancel).toHaveBeenCalledTimes(1)
      await storage.set(StorageKey.MATRIX_SELECTED_NODE, relay)

      await client.start()
      const peerKey = Buffer.from((await getKeypairFromSeed('discovery-peer')).publicKey).toString(
        'hex'
      )
      await expect(client.listenForEncryptedMessage(peerKey, vi.fn())).resolves.toBeUndefined()
      expect(login).toHaveBeenCalledTimes(2)
    }
  )
})
