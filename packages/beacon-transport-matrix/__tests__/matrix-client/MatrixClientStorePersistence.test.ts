import { setImmediate } from 'node:timers/promises'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { LocalStorage, Logger } from '@ecadlabs/beacon-core'
import { StorageKey } from '@ecadlabs/beacon-types'
import { MatrixClientStore } from '../../src/matrix-client/MatrixClientStore'
import { MatrixRoom, MatrixRoomStatus } from '../../src/matrix-client/models/MatrixRoom'
import { MatrixMessageType } from '../../src/matrix-client/models/MatrixMessage'

describe('Matrix preserved room state', () => {
  beforeEach(() => localStorage.clear())

  afterEach(() => {
    localStorage.clear()
    jest.restoreAllMocks()
  })

  it('persists only sync and room state without storing messages or mutating live rooms', async () => {
    const storage = new LocalStorage()
    const store = new MatrixClientStore(storage)
    const [room] = MatrixRoom.fromSync({
      join: {
        '!room:relay': {
          state: { events: [] },
          timeline: {
            events: [
              {
                type: 'm.room.message',
                sender: '@peer:relay',
                content: { msgtype: MatrixMessageType.TEXT, body: 'private message' },
                event_id: '$event',
                origin_server_ts: 123
              }
            ]
          }
        }
      }
    })

    await store.update({
      accessToken: 'do-not-persist',
      userId: '@user:relay',
      syncToken: 'next-sync',
      rooms: [room]
    })

    const persisted = await storage.get(StorageKey.MATRIX_PRESERVED_STATE)
    expect(Object.keys(persisted).sort()).toEqual(['rooms', 'syncToken'])
    expect(persisted).toEqual({
      syncToken: 'next-sync',
      rooms: {
        '!room:relay': {
          id: '!room:relay',
          status: MatrixRoomStatus.JOINED,
          members: [],
          messages: []
        }
      }
    })
    expect(store.get('rooms')['!room:relay'].messages).toHaveLength(1)
    expect(room.messages).toHaveLength(1)
  })

  it('keeps non-preserved fields and empty sync updates from triggering a write', async () => {
    const storage = new LocalStorage()
    const write = jest.spyOn(storage, 'set')
    const store = new MatrixClientStore(storage)

    await store.update({ accessToken: 'access-token', userId: '@user:relay' })
    await store.update({ syncToken: '' })

    expect(write).not.toHaveBeenCalled()

    await store.update({ syncToken: 'next-sync' })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('does not resolve update until its preserved-state write settles', async () => {
    const storage = new LocalStorage()
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    const set = storage.set.bind(storage)
    jest.spyOn(storage, 'set').mockImplementationOnce(async (key, value) => {
      entered.resolve()
      await release.promise
      await set(key, value)
    })
    const store = new MatrixClientStore(storage)
    let settled = false
    const updating = store.update({ syncToken: 'held-sync' }).then(() => {
      settled = true
    })
    await entered.promise
    try {
      await setImmediate()
      expect(settled).toBe(false)
    } finally {
      release.resolve()
      await updating
    }
    await expect(storage.get(StorageKey.MATRIX_PRESERVED_STATE)).resolves.toMatchObject({
      syncToken: 'held-sync'
    })
  })

  it('does not block non-preserved updates behind a held preserved-state write', async () => {
    const storage = new LocalStorage()
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    const set = storage.set.bind(storage)
    const write = jest.spyOn(storage, 'set').mockImplementationOnce(async (key, value) => {
      entered.resolve()
      await release.promise
      await set(key, value)
    })
    const store = new MatrixClientStore(storage)
    const persisting = store.update({ syncToken: 'held-sync' })
    await entered.promise
    let updated = false
    const updating = store.update({ txnNo: 1 }).then(() => {
      updated = true
    })
    let flushed = false
    const flushing = store.flush().then(() => {
      flushed = true
    })
    try {
      await setImmediate()
      expect(updated).toBe(true)
      expect(store.get('txnNo')).toBe(1)
      expect(write).toHaveBeenCalledTimes(1)
      expect(flushed).toBe(false)
    } finally {
      release.resolve()
      await Promise.all([persisting, updating, flushing])
    }
    await expect(storage.get(StorageKey.MATRIX_PRESERVED_STATE)).resolves.toMatchObject({
      syncToken: 'held-sync'
    })
  })

  it('keeps the newer snapshot when successful preserved-state writes overlap', async () => {
    const storage = new LocalStorage()
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    const set = storage.set.bind(storage)
    const write = jest.spyOn(storage, 'set').mockImplementationOnce(async (key, value) => {
      entered.resolve()
      await release.promise
      await set(key, value)
    })
    const store = new MatrixClientStore(storage)
    const first = store.update({ syncToken: 'old-sync' })
    await entered.promise
    const second = store.update({ syncToken: 'new-sync' })
    try {
      await setImmediate()
      expect(write).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve()
      await Promise.all([first, second])
    }
    expect(write).toHaveBeenCalledTimes(2)
    await expect(storage.get(StorageKey.MATRIX_PRESERVED_STATE)).resolves.toMatchObject({
      syncToken: 'new-sync'
    })
  })

  it('persists a later update after a held write rejects', async () => {
    const storage = new LocalStorage()
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    const failure = new Error('held write failed')
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    jest.spyOn(storage, 'set').mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      throw failure
    })
    const store = new MatrixClientStore(storage)
    const first = store.update({ syncToken: 'failed-sync' })
    await entered.promise
    const second = store.update({ syncToken: 'new-sync' })
    release.resolve()
    await Promise.all([first, second])
    await setImmediate()
    expect(error).toHaveBeenCalledWith('updateStorage', 'failed to persist matrix state', failure)
    await expect(storage.get(StorageKey.MATRIX_PRESERVED_STATE)).resolves.toMatchObject({
      syncToken: 'new-sync'
    })
  })

  it('logs storage-write failures while retaining the updated in-memory state', async () => {
    const storage = new LocalStorage()
    const failure = new Error('Storage write failed')
    jest.spyOn(storage, 'set').mockRejectedValue(failure)
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const store = new MatrixClientStore(storage)

    await expect(store.update({ syncToken: 'next-sync' })).resolves.toBeUndefined()

    expect(store.get('syncToken')).toBe('next-sync')
    expect(error).toHaveBeenCalledWith('updateStorage', 'failed to persist matrix state', failure)
  })
})
