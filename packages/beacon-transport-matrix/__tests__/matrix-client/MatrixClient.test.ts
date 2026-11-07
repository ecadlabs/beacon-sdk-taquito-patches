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
      get: vi.fn((key: string) => state[key]),
      update: vi.fn(async (update: Record<string, unknown>) => {
        Object.assign(state, update)
      }),
      flush: vi.fn().mockResolvedValue(undefined),
      onStateChanged: vi.fn(),
      getRoom: vi.fn()
    }
  }

  it('treats manual stop during polling as normal shutdown', async () => {
    vi.useFakeTimers()
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      const store = createStore()
      const eventEmitter = {
        onStateChanged: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn()
      }
      const userService = {
        login: vi.fn().mockResolvedValue({ access_token: 'access-token' })
      }
      const eventService = {
        sync: vi.fn().mockResolvedValue({
          next_batch: 'sync-token',
          rooms: {}
        })
      }
      const httpClient = {
        cancelAllRequests: vi.fn().mockResolvedValue(undefined)
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
      await vi.runOnlyPendingTimersAsync()
      await Promise.resolve()

      expect(unhandledRejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      vi.useRealTimers()
    }
  })

  it.each(['joinedRooms', 'invitedRooms', 'leftRooms'] as const)(
    'rejects %s when connection setup fails',
    async (property) => {
      const client = new MatrixClient(
        createStore() as any,
        { onStateChanged: vi.fn() } as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
      )
      vi.spyOn(client, 'isConnected').mockRejectedValue(new Error('connection failed'))

      await expect(client[property]).rejects.toThrow('connection failed')
    }
  )

  it('generates unique txn ids for concurrent sends', async () => {
    const store = createStore()
    await store.update({ accessToken: 'access-token' })
    const eventEmitter = {
      onStateChanged: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const eventService = {
      sendMessage: vi.fn().mockResolvedValue({ event_id: '$event' })
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
  describe('revoked access tokens', () => {
    const user = { id: 'matrix-user', password: 'password', deviceId: 'device' }
    const setup = () => {
      const store = createStore()
      const login = vi
        .fn()
        .mockResolvedValueOnce({ access_token: 'old' })
        .mockResolvedValue({ access_token: 'new' })
      const sync = vi.fn().mockResolvedValue({ next_batch: 'batch', rooms: {} })
      const client = new MatrixClient(
        store as any,
        { onStateChanged: vi.fn() } as any,
        { login } as any,
        {} as any,
        { sync } as any,
        { cancelAllRequests: vi.fn().mockResolvedValue(undefined) } as any
      )
      return { client, store, login, sync }
    }

    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('logs in with the same identity and resumes sync with the replacement token', async () => {
      const { client, login, sync } = setup()
      await client.start(user)
      sync.mockRejectedValueOnce({ errcode: 'M_UNKNOWN_TOKEN' })
      await vi.runOnlyPendingTimersAsync()
      expect(login.mock.calls).toEqual([
        [user.id, user.password, user.deviceId],
        [user.id, user.password, user.deviceId]
      ])
      expect(sync.mock.calls.map((call) => call[0])).toEqual(['old', 'old', 'new'])
      await client.stop()
      await vi.runOnlyPendingTimersAsync()
    })

    it('backs off failed reauthentication and stops retrying after stop', async () => {
      const { client, login, sync } = setup()
      await client.start(user)
      sync.mockRejectedValue({ errcode: 'M_UNKNOWN_TOKEN' })
      login.mockRejectedValue(new Error('login unavailable'))
      for (let i = 0; i < 4; i++) await vi.runOnlyPendingTimersAsync()
      expect(login).toHaveBeenCalledTimes(5)
      await vi.advanceTimersByTimeAsync(4999)
      expect(login).toHaveBeenCalledTimes(5)
      await client.stop()
      await vi.runOnlyPendingTimersAsync()
      expect(login).toHaveBeenCalledTimes(5)
    })

    it('does not apply a replacement token or sync after stopping during login', async () => {
      const { client, store, login, sync } = setup()
      await client.start(user)
      let finish!: (value: { access_token: string }) => void
      login.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      sync.mockRejectedValueOnce({ errcode: 'M_UNKNOWN_TOKEN' })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      vi.runOnlyPendingTimers()
      for (let i = 0; i < 20 && login.mock.calls.length < 2; i++) await Promise.resolve()
      await client.stop()
      finish({ access_token: 'late' })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(store.get('accessToken')).toBe('old')
      expect(store.get('isRunning')).toBe(false)
      expect(sync).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    })
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
        const sync = vi.fn(
          () =>
            new Promise((resolve, reject) => {
              finish = resolve
              fail = reject
            })
        )
        const client = new MatrixClient(
          store as any,
          { onStateChanged: vi.fn() } as any,
          { login: vi.fn().mockResolvedValue({ access_token: 'token' }) } as any,
          {} as any,
          { sync } as any,
          { cancelAllRequests: vi.fn().mockResolvedValue(undefined) } as any
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

    it('does not send a login after cancellation while fresh credentials are pending', async () => {
      const store = createStore()
      let passwordReady!: (value: string) => void
      const password = () =>
        new Promise<string>((resolve) => {
          passwordReady = resolve
        })
      const login = vi.fn()
      const client = new MatrixClient(
        store as any,
        { onStateChanged: vi.fn() } as any,
        { login } as any,
        {} as any,
        { sync: vi.fn() } as any,
        { cancelAllRequests: vi.fn().mockResolvedValue(undefined) } as any
      )
      const started = client.start({ id: 'user', password, deviceId: 'device' })
      const rejected = expect(started).rejects.toMatchObject({ name: 'AbortError' })
      await client.stop()
      await rejected
      passwordReady('late-password')
      await flush()
      expect(login).not.toHaveBeenCalled()
      expect(store.get('accessToken')).toBeUndefined()
    })
    it('settles stopped startup while login is pending and does not apply its result', async () => {
      const store = createStore()
      let loginDone!: (value: any) => void
      const login = vi.fn(
        () =>
          new Promise((resolve) => {
            loginDone = resolve
          })
      )
      const sync = vi.fn()
      const client = new MatrixClient(
        store as any,
        { onStateChanged: vi.fn() } as any,
        { login } as any,
        {} as any,
        { sync } as any,
        { cancelAllRequests: vi.fn().mockResolvedValue(undefined) } as any
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
      vi.useFakeTimers()
      try {
        const store = createStore()
        let oldLogin!: (value: any) => void
        const login = vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                oldLogin = resolve
              })
          )
          .mockResolvedValue({ access_token: 'current' })
        const sync = vi.fn().mockResolvedValue({ next_batch: 'current-batch', rooms: {} })
        const client = new MatrixClient(
          store as any,
          { onStateChanged: vi.fn() } as any,
          { login } as any,
          {} as any,
          { sync } as any,
          { cancelAllRequests: vi.fn().mockResolvedValue(undefined) } as any
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
        await vi.runOnlyPendingTimersAsync()
      } finally {
        vi.useRealTimers()
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
