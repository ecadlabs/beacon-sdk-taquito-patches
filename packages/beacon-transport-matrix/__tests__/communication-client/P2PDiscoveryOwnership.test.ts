import { setImmediate } from 'node:timers/promises'
import { LocalStorage } from '@ecadlabs/beacon-core'
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
