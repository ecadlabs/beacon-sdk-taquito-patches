import { MatrixClient } from '../../src/matrix-client/MatrixClient'

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
})
