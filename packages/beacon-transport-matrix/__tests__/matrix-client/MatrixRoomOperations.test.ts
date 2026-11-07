import { LocalStorage, Logger } from '@ecadlabs/beacon-core'
import { MatrixClient } from '../../src/matrix-client/MatrixClient'
import { MatrixClientStore } from '../../src/matrix-client/MatrixClientStore'
import { MatrixClientEventEmitter } from '../../src/matrix-client/MatrixClientEventEmitter'
import { MatrixHttpClient } from '../../src/matrix-client/MatrixHttpClient'
import { MatrixRoom } from '../../src/matrix-client/models/MatrixRoom'
import { MatrixRoomInviteResponse } from '../../src/matrix-client/models/api/MatrixRoomInvite'
import { MatrixRoomJoinResponse } from '../../src/matrix-client/models/api/MatrixRoomJoin'
import { MatrixEventService } from '../../src/matrix-client/services/MatrixEventService'
import { MatrixRoomService } from '../../src/matrix-client/services/MatrixRoomService'
import { MatrixUserService } from '../../src/matrix-client/services/MatrixUserService'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Let already-queued promise reactions finish without resolving the controlled requests.
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const createReadyClient = async () => {
  const store = new MatrixClientStore(new LocalStorage())
  await store.update({ accessToken: 'access-token' })
  const http = new MatrixHttpClient('https://matrix.example')
  const roomService = new MatrixRoomService(http)
  const eventService = new MatrixEventService(http)
  const client = new MatrixClient(
    store,
    new MatrixClientEventEmitter(),
    new MatrixUserService(http),
    roomService,
    eventService,
    http
  )
  // Login/polling readiness is a precondition; this suite exercises room operations.
  vi.spyOn(client, 'isConnected').mockResolvedValue(undefined)
  return { client, roomService, eventService, store }
}

describe('Matrix room operation completion', () => {
  beforeEach(() => localStorage.clear())

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it.each(['IDs', 'instances'] as const)(
    'waits for every invitation using room %s',
    async (kind) => {
      const { client, roomService } = await createReadyClient()
      const first = deferred<MatrixRoomInviteResponse>()
      const second = deferred<MatrixRoomInviteResponse>()
      const started = deferred<void>()
      let calls = 0
      const invite = vi.spyOn(roomService, 'inviteToRoom').mockImplementation(() => {
        calls += 1
        if (calls === 2) {
          started.resolve(undefined)
        }
        return calls === 1 ? first.promise : second.promise
      })
      const ids = ['!first:relay', '!second:relay']
      const rooms = kind === 'IDs' ? ids : ids.map((id) => MatrixRoom.from(id))
      let completed = false
      const operation = client.inviteToRooms('@friend:relay', ...rooms).then(() => {
        completed = true
      })

      await started.promise
      await nextTask()
      expect(completed).toBe(false)
      expect(invite).toHaveBeenCalledTimes(2)
      expect(invite.mock.calls.map(([token, user, room]) => [token, user, room.id])).toEqual([
        ['access-token', '@friend:relay', '!first:relay'],
        ['access-token', '@friend:relay', '!second:relay']
      ])

      first.resolve({})
      await nextTask()
      expect(completed).toBe(false)

      second.resolve({})
      await expect(operation).resolves.toBeUndefined()
      expect(completed).toBe(true)
    }
  )

  it('logs an invitation failure and still waits for the other invitation', async () => {
    const { client, roomService } = await createReadyClient()
    const first = deferred<MatrixRoomInviteResponse>()
    const second = deferred<MatrixRoomInviteResponse>()
    const started = deferred<void>()
    const failure = new Error('Invitation denied')
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    let calls = 0
    vi.spyOn(roomService, 'inviteToRoom').mockImplementation(() => {
      calls += 1
      if (calls === 2) {
        started.resolve(undefined)
      }
      return calls === 1 ? first.promise : second.promise
    })
    let completed = false
    const operation = client
      .inviteToRooms('@friend:relay', '!first:relay', '!second:relay')
      .then(() => {
        completed = true
      })

    await started.promise
    first.reject(failure)
    await nextTask()
    expect(warn).toHaveBeenCalledWith('inviteToRooms', failure)
    expect(completed).toBe(false)

    second.resolve({})
    await expect(operation).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps join completion tied to the room-service response', async () => {
    const { client, roomService } = await createReadyClient()
    const response = deferred<MatrixRoomJoinResponse>()
    const started = deferred<void>()
    vi.spyOn(roomService, 'joinRoom').mockImplementation(() => {
      started.resolve(undefined)
      return response.promise
    })
    let completed = false
    const operation = client.joinRooms('!room:relay').then(() => {
      completed = true
    })

    await started.promise
    await nextTask()
    expect(completed).toBe(false)

    response.resolve({ room_id: '!room:relay' })
    await expect(operation).resolves.toBeUndefined()
    expect(completed).toBe(true)
  })

  it('does not join a room when stopped after readiness resolves', async () => {
    const { client, roomService } = await createReadyClient()
    const join = vi.spyOn(roomService, 'joinRoom').mockResolvedValue({ room_id: '!room:relay' })
    const operation = client.joinRooms('!room:relay')
    const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' })

    await client.stop()

    await rejection
    expect(join).not.toHaveBeenCalled()
  })

  it('does not send a message when stopped while its transaction ID is pending', async () => {
    const { client, eventService, store } = await createReadyClient()
    const updating = deferred<void>()
    const release = deferred<void>()
    const update = store.update.bind(store)
    vi.spyOn(store, 'update').mockImplementation(async (state) => {
      if (state.txnNo !== undefined) {
        updating.resolve(undefined)
        await release.promise
      }
      await update(state)
    })
    const send = vi.spyOn(eventService, 'sendMessage').mockResolvedValue({ event_id: '$event' })
    const operation = client.sendTextMessage('!room:relay', 'hello')
    const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' })

    await updating.promise
    await client.stop()
    release.resolve(undefined)

    await rejection
    expect(send).not.toHaveBeenCalled()
  })
})
