import { MatrixClient } from '../src/matrix-client/MatrixClient'
import { setImmediate } from 'node:timers/promises'
import { LocalStorage, Logger } from '@ecadlabs/beacon-core'
import { StorageKey, StorageKeyReturnType } from '@ecadlabs/beacon-types'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { P2PCommunicationClient } from '../src/communication-client/P2PCommunicationClient'
import { MatrixEventService } from '../src/matrix-client/services/MatrixEventService'
import { MatrixUserService } from '../src/matrix-client/services/MatrixUserService'
import { MatrixSyncResponse } from '../src/matrix-client/models/api/MatrixSync'

class HeldPreservedStorage extends LocalStorage {
  public readonly entered = new ExposedPromise<void>()
  public readonly release = new ExposedPromise<void>()
  public hold = false
  public failure: Error | undefined

  public override async set<K extends StorageKey>(
    key: K,
    value: StorageKeyReturnType[K]
  ): Promise<void> {
    if (key === StorageKey.MATRIX_PRESERVED_STATE && this.hold) {
      this.hold = false
      this.entered.resolve()
      await this.release.promise
      if (this.failure) {
        throw this.failure
      }
    }
    await super.set(key, value)
  }
}

describe('preserved Matrix state during teardown', () => {
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
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    localStorage.clear()
  })

  it('allows teardown after preserved-state initialization fails', async () => {
    const storage = new LocalStorage()
    const failure = new Error('preserved-state read failed')
    vi.spyOn(storage, 'get').mockRejectedValue(failure)
    const write = vi.spyOn(storage, 'set')
    const client = MatrixClient.create({ baseUrl: 'https://relay.example', storage })

    await expect(client.start({ id: 'sdk', password: 'token', deviceId: 'device' })).rejects.toBe(
      failure
    )
    await expect(client.stop()).resolves.toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })

  it.each([
    { teardown: 'stop', rejects: false },
    { teardown: 'reset', rejects: false },
    { teardown: 'reset', rejects: true }
  ])('drains a held write before $teardown (rejects: $rejects)', async ({ teardown, rejects }) => {
    const storage = new HeldPreservedStorage()
    const write = vi.spyOn(storage, 'set')
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const client = new P2PCommunicationClient(
      'Test',
      await getKeypairFromSeed('preserved-race'),
      1,
      storage
    )
    const polling = new ExposedPromise<MatrixSyncResponse>()
    vi.spyOn(MatrixEventService.prototype, 'sync')
      .mockResolvedValueOnce({ next_batch: 'initial', rooms: {} })
      .mockImplementation(() => polling.promise)
    await client.start()
    await setImmediate()
    await expect(storage.get(StorageKey.MATRIX_PRESERVED_STATE)).resolves.toMatchObject({
      syncToken: 'initial'
    })
    storage.hold = true
    storage.failure = rejects ? new Error('held write failed') : undefined
    polling.resolve({
      next_batch: 'stale-sync',
      rooms: {
        join: { '!stale:relay.example': { state: { events: [] }, timeline: { events: [] } } }
      }
    })
    await vi.advanceTimersByTimeAsync(0)
    await storage.entered.promise
    expect(write).toHaveBeenLastCalledWith(
      StorageKey.MATRIX_PRESERVED_STATE,
      expect.objectContaining({
        syncToken: 'stale-sync',
        rooms: expect.objectContaining({
          '!stale:relay.example': expect.objectContaining({ id: '!stale:relay.example' })
        })
      })
    )
    let stopped = false
    const stopping = (teardown === 'stop' ? client.stop() : client.reset()).then(() => {
      stopped = true
    })
    try {
      // Let teardown finish if it can, while the old write is still held.
      await setImmediate()
      const finishedBeforeWrite = stopped
      storage.release.resolve()
      await stopping
      await setImmediate()
      // Inspect durable storage after both teardown and the delayed write settle.
      expect(localStorage.getItem(StorageKey.MATRIX_PRESERVED_STATE)).toBeNull()
      expect(finishedBeforeWrite).toBe(false)
      if (rejects) {
        expect(error).toHaveBeenCalledWith(
          'updateStorage',
          'failed to persist matrix state',
          storage.failure
        )
      }
    } finally {
      storage.release.resolve()
      await stopping
      await client.stop()
    }
  })
})
