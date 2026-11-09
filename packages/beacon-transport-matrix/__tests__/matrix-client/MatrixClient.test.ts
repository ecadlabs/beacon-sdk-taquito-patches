import { MatrixClient } from '../../src/matrix-client/MatrixClient'
import { MatrixRoom } from '../../src/matrix-client/models/MatrixRoom'

describe('MatrixClient', () => {
  const createStore = () => {
    const state: Record<string, unknown> = {
      accessToken: undefined,
      isRunning: false,
      pollingRetries: 0,
      pollingTimeout: undefined,
      rooms: {},
      syncToken: undefined,
      txnNo: 0
    }

    return {
      get: jest.fn((key: string) => state[key]),
      update: jest.fn(async (update: Record<string, unknown>) => {
        Object.assign(state, update)
      }),
      onStateChanged: jest.fn(),
      getRoom: jest.fn()
    }
  }

  it('treats manual stop during polling as normal shutdown', async () => {
    jest.useFakeTimers()
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      const store = createStore()
      const eventEmitter = {
        onStateChanged: jest.fn(),
        on: jest.fn(),
        removeListener: jest.fn()
      }
      const userService = {
        login: jest.fn().mockResolvedValue({ access_token: 'access-token' })
      }
      const eventService = {
        sync: jest.fn().mockResolvedValue({
          next_batch: 'sync-token',
          rooms: {}
        })
      }
      const httpClient = {
        cancelAllRequests: jest.fn().mockResolvedValue(undefined)
      }

      const client = new MatrixClient(
        store as any,
        eventEmitter as any,
        userService as any,
        {} as any,
        eventService as any,
        httpClient as any
      )

      await expect(
        client.start({
          id: 'matrix-user',
          password: 'matrix-password',
          deviceId: 'matrix-device'
        })
      ).resolves.toBeUndefined()

      await expect(client.stop()).resolves.toBeUndefined()
      await expect(jest.runOnlyPendingTimersAsync()).resolves.toBeUndefined()
      await Promise.resolve()

      expect(unhandledRejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      jest.useRealTimers()
    }
  })

  it('aborts HTTP before a pending store update fails during stop', async () => {
    const store = createStore()
    let failWrite!: (reason: Error) => void
    store.update.mockImplementationOnce(() => new Promise<void>((_, reject) => {
      failWrite = reject
    }))
    const cancelAllRequests = jest.fn().mockResolvedValue(undefined)
    const client = new MatrixClient(
      store as any, {} as any, {} as any, {} as any, {} as any, { cancelAllRequests } as any
    )

    const stopped = client.stop()
    const failure = new Error('storage unavailable')
    const rejected = expect(stopped).rejects.toBe(failure)
    await Promise.resolve()
    expect(cancelAllRequests).toHaveBeenCalledTimes(1)
    failWrite(failure)
    await rejected
  })

  it('generates unique txn ids for concurrent sends', async () => {
    const store = createStore()
    await store.update({ accessToken: 'access-token' })
    const eventEmitter = {
      onStateChanged: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn()
    }
    const eventService = {
      sendMessage: jest.fn().mockResolvedValue({ event_id: '$event' })
    }
    const client = new MatrixClient(
      store as any,
      eventEmitter as any,
      {} as any,
      {} as any,
      eventService as any,
      {} as any
    )
    ;(client as any)._isReady.resolve()

    await Promise.all([
      client.sendTextMessage('!room:id', 'message-a'),
      client.sendTextMessage('!room:id', 'message-b')
    ])

    const txnIds = eventService.sendMessage.mock.calls.map((call) => call[3])

    expect(txnIds).toHaveLength(2)
    expect(new Set(txnIds).size).toBe(2)
  })
  describe('startup cancellation', () => {
    const flush = async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve()
    }
    it.each(['resolve', 'reject'])(
      'settles startup immediately on stop before first sync can %s',
      async (completion) => {
        const store = createStore()
        let finish!: (value: any) => void
        let fail!: (reason: any) => void
        const sync = jest.fn(
          () =>
            new Promise((resolve, reject) => {
              finish = resolve
              fail = reject
            })
        )
        const client = new MatrixClient(
          store as any,
          { onStateChanged: jest.fn() } as any,
          { login: jest.fn().mockResolvedValue({ access_token: 'token' }) } as any,
          {} as any,
          { sync } as any,
          { cancelAllRequests: jest.fn().mockResolvedValue(undefined) } as any
        )
        let outcome = 'pending'
        const started = client.start({ id: 'user', password: 'password', deviceId: 'device' }).then(
          () => {
            outcome = 'resolved'
          },
          (error) => {
            outcome = error.name
          }
        )
        await flush()
        expect(sync).toHaveBeenCalledTimes(1)
        await client.stop()
        await flush()
        expect(outcome).toBe('AbortError')
        if (completion === 'resolve') finish({ next_batch: 'late', rooms: {} })
        else fail(new DOMException('cancelled', 'AbortError'))
        await started
        await flush()
        expect(store.get('isRunning')).toBe(false)
        expect(store.get('syncToken')).toBeUndefined()
      }
    )

    it('settles stopped startup while login is pending and does not apply its result', async () => {
      const store = createStore()
      let loginDone!: (value: any) => void
      const login = jest.fn(
        () =>
          new Promise((resolve) => {
            loginDone = resolve
          })
      )
      const sync = jest.fn()
      const client = new MatrixClient(
        store as any,
        { onStateChanged: jest.fn() } as any,
        { login } as any,
        {} as any,
        { sync } as any,
        { cancelAllRequests: jest.fn().mockResolvedValue(undefined) } as any
      )
      let outcome = 'pending'
      const started = client.start({ id: 'user', password: 'password', deviceId: 'device' }).then(
        () => {
          outcome = 'resolved'
        },
        (error) => {
          outcome = error.name
        }
      )
      await flush()
      await client.stop()
      await flush()
      expect(outcome).toBe('AbortError')
      loginDone({ access_token: 'late' })
      await started
      await flush()
      expect(store.get('accessToken')).toBeUndefined()
      expect(sync).not.toHaveBeenCalled()
    })

    it('rejects superseded startup and lets the new session become ready', async () => {
      jest.useFakeTimers()
      try {
        const store = createStore()
        let oldLogin!: (value: any) => void
        const login = jest
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                oldLogin = resolve
              })
          )
          .mockResolvedValue({ access_token: 'current' })
        const sync = jest.fn().mockResolvedValue({ next_batch: 'current-batch', rooms: {} })
        const client = new MatrixClient(
          store as any,
          { onStateChanged: jest.fn() } as any,
          { login } as any,
          {} as any,
          { sync } as any,
          { cancelAllRequests: jest.fn().mockResolvedValue(undefined) } as any
        )
        let oldOutcome = 'pending'
        const old = client.start({ id: 'user', password: 'password', deviceId: 'device' }).then(
          () => {
            oldOutcome = 'resolved'
          },
          (error) => {
            oldOutcome = error.name
          }
        )
        await flush()
        await client.start({ id: 'user', password: 'password', deviceId: 'device' })
        await old
        expect(oldOutcome).toBe('AbortError')
        oldLogin({ access_token: 'stale' })
        await flush()
        expect(store.get('accessToken')).toBe('current')
        expect(store.get('syncToken')).toBe('current-batch')
        await client.isConnected()
        await client.stop()
        await jest.runOnlyPendingTimersAsync()
      } finally {
        jest.useRealTimers()
      }
    })
  })

  describe('MatrixRoom.fromSync invite_state validation', () => {
    it('excludes invitations when stripped invite_state has conflicting senders or non-invite membership for a target', () => {
      const [conflictingSendersRoom] = MatrixRoom.fromSync({
        invite: {
          '!conflict-senders:relay': {
            invite_state: {
              events: [
                {
                  type: 'm.room.member',
                  sender: '@trusted:relay',
                  state_key: '@recipient:relay',
                  content: { membership: 'invite' }
                } as any,
                {
                  type: 'm.room.member',
                  sender: '@unpaired:relay',
                  state_key: '@recipient:relay',
                  content: { membership: 'invite' }
                } as any
              ]
            }
          }
        }
      })

      const [nonInviteStateRoom] = MatrixRoom.fromSync({
        invite: {
          '!conflict-membership:relay': {
            invite_state: {
              events: [
                {
                  type: 'm.room.member',
                  sender: '@trusted:relay',
                  state_key: '@recipient:relay',
                  content: { membership: 'invite' }
                } as any,
                {
                  type: 'm.room.member',
                  sender: '@unpaired:relay',
                  state_key: '@recipient:relay',
                  content: { membership: 'leave' }
                } as any
              ]
            }
          }
        }
      })

      expect(conflictingSendersRoom.invitations).toEqual([])
      expect(nonInviteStateRoom.invitations).toEqual([])
    })
  })
})
