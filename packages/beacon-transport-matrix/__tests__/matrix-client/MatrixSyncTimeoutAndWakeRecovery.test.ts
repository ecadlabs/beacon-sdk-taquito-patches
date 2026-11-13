import { LocalStorage, Logger } from '@ecadlabs/beacon-core'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { MatrixClient, MatrixHealthTransition } from '../../src/matrix-client/MatrixClient'
import { MatrixClientEventType } from '../../src/matrix-client/models/MatrixClientEvent'
import { MatrixHttpClient } from '../../src/matrix-client/MatrixHttpClient'
import { MatrixSyncResponse } from '../../src/matrix-client/models/api/MatrixSync'
import { MatrixEventService } from '../../src/matrix-client/services/MatrixEventService'

const user = { id: 'matrix-user', password: 'matrix-password', deviceId: 'matrix-device' }
const loginResponse = {
  user_id: '@matrix-user:relay.example',
  device_id: 'matrix-device',
  access_token: 'access-token-1'
}

type Outcome<T = unknown> =
  | { status: 'pending' }
  | { status: 'resolved'; value: T }
  | { status: 'rejected'; reason: unknown }

const observe = <T>(promise: Promise<T>) => {
  let outcome: Outcome<T> = { status: 'pending' }
  const settled = promise.then(
    (value) => {
      outcome = { status: 'resolved', value }
    },
    (reason: unknown) => {
      outcome = { status: 'rejected', reason }
    }
  )
  return {
    settled,
    get outcome(): Outcome<T> {
      return outcome
    }
  }
}

const flushMicrotasks = async (ticks = 20): Promise<void> => {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve()
  }
}

const createAbortAwarePendingFetch = () =>
  vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        return
      }
      signal?.addEventListener(
        'abort',
        () => {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        },
        { once: true }
      )
    })
  })

const setDocumentVisibilityState = (state: DocumentVisibilityState): void => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
}

describe('Matrix /sync client-side fetch timeout and wake/visibility recovery (Issue #204)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    setDocumentVisibilityState('visible')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    localStorage.clear()
    setDocumentVisibilityState('visible')
  })

  describe('MatrixHttpClient per-request timeout', () => {
    it('aborts hung GET, POST, and PUT requests after the default 30000ms timeout without aborting later concurrent requests', async () => {
      const fetchMock = createAbortAwarePendingFetch()
      let resolveConcurrentPut!: (response: Response) => void
      fetchMock.mockImplementationOnce(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true }
            )
          })
      )
      fetchMock.mockImplementationOnce(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true }
            )
          })
      )
      fetchMock.mockImplementationOnce(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            resolveConcurrentPut = resolve
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true }
            )
          })
      )
      vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)

      const client = new MatrixHttpClient('https://relay.example')
      const getRequest = observe(client.get('/sync'))
      const postRequest = observe(
        client.post('/rooms/!room:relay/join', {}, { accessToken: 'access-token-1' })
      )

      try {
        await vi.advanceTimersByTimeAsync(10_000)
        const putRequest = observe(
          client.put(
            '/rooms/!room:relay/send/m.room.message/txn-1',
            { msgtype: 'm.text', body: 'ciphertext' },
            { accessToken: 'access-token-1' }
          )
        )

        await vi.advanceTimersByTimeAsync(19_999)
        await flushMicrotasks()
        expect(getRequest.outcome).toEqual({ status: 'pending' })
        expect(postRequest.outcome).toEqual({ status: 'pending' })

        await vi.advanceTimersByTimeAsync(1)
        await flushMicrotasks()
        expect(getRequest.outcome).toMatchObject({
          status: 'rejected',
          reason: { name: 'AbortError' }
        })
        expect(postRequest.outcome).toMatchObject({
          status: 'rejected',
          reason: { name: 'AbortError' }
        })

        const putSignal = fetchMock.mock.calls[2]?.[1]?.signal
        expect(putSignal?.aborted).toBe(false)

        resolveConcurrentPut(Response.json({ event_id: '$event-1' }))
        await putRequest.settled
        expect(putRequest.outcome).toEqual({
          status: 'resolved',
          value: { event_id: '$event-1' }
        })
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        await client.cancelAllRequests()
      }
    })

    it('schedules a per-request timeout timer while in flight and clears it on settlement or cancelAllRequests()', async () => {
      const fetchMock = createAbortAwarePendingFetch()
      let resolveFirst!: (response: Response) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve
          })
      )
      vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)
      const client = new MatrixHttpClient('https://relay.example')

      const first = observe(client.get<MatrixSyncResponse>('/sync'))
      await flushMicrotasks()
      expect(vi.getTimerCount()).toBe(1)

      resolveFirst(Response.json({ next_batch: 'batch-1', rooms: {} }))
      await first.settled
      expect(first.outcome).toEqual({
        status: 'resolved',
        value: { next_batch: 'batch-1', rooms: {} }
      })
      expect(vi.getTimerCount()).toBe(0)

      // Starting a second request schedules a timer that is cleared immediately when cancelAllRequests() runs
      const second = observe(client.get<MatrixSyncResponse>('/sync'))
      await flushMicrotasks()
      expect(vi.getTimerCount()).toBe(1)

      await client.cancelAllRequests()
      await second.settled
      expect(second.outcome).toMatchObject({
        status: 'rejected',
        reason: { name: 'AbortError' }
      })
      expect(vi.getTimerCount()).toBe(0)
    })

    it('aborts a request that stalls while streaming the response body after headers arrive', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_input, init) => {
        const signal = init?.signal
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener(
              'abort',
              () => controller.error(signal.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true }
            )
          }
        })
        return new Response(body)
      })

      const client = new MatrixHttpClient('https://relay.example')
      const pending = observe(client.get<MatrixSyncResponse>('/sync'))

      try {
        await vi.advanceTimersByTimeAsync(29_999)
        await flushMicrotasks()
        expect(pending.outcome).toEqual({ status: 'pending' })

        await vi.advanceTimersByTimeAsync(1)
        await flushMicrotasks()
        expect(pending.outcome).toMatchObject({
          status: 'rejected',
          reason: { name: 'AbortError' }
        })
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        await client.cancelAllRequests()
      }
    })

    it('logs logger.error when a request times out, but suppresses logger.error on intentional signal or cancelAllRequests() aborts', async () => {
      const loggerErrorSpy = vi.spyOn(Logger.prototype, 'error')
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true }
            )
          })
      )

      const client = new MatrixHttpClient('https://relay.example')
      const callerController = new AbortController()
      const callerAborted = observe(
        client.get<MatrixSyncResponse>('/sync', undefined, { signal: callerController.signal })
      )
      await flushMicrotasks()
      callerController.abort(new DOMException('Matrix sync refreshed on wake', 'AbortError'))
      await callerAborted.settled
      expect(callerAborted.outcome).toMatchObject({
        status: 'rejected',
        reason: { name: 'AbortError' }
      })
      expect(loggerErrorSpy).not.toHaveBeenCalled()

      const clientCancelled = observe(client.get<MatrixSyncResponse>('/sync'))
      await flushMicrotasks()
      await client.cancelAllRequests()
      await clientCancelled.settled
      expect(clientCancelled.outcome).toMatchObject({
        status: 'rejected',
        reason: { name: 'AbortError' }
      })
      expect(loggerErrorSpy).not.toHaveBeenCalled()

      const timedOut = observe(client.get<MatrixSyncResponse>('/sync', undefined, { timeoutMs: 5_000 }))
      await vi.advanceTimersByTimeAsync(5_000)
      await timedOut.settled
      expect(timedOut.outcome).toMatchObject({
        status: 'rejected',
        reason: { name: 'AbortError' }
      })
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('MatrixEventService.sync client-side timeout and cache eviction', () => {
    it.each([
      { label: 'default 30000ms when pollingTimeout is undefined', pollingTimeout: undefined, expectedTimeoutMs: 30_000 },
      { label: 'pollingTimeout + 10000ms for custom 15000ms long-poll', pollingTimeout: 15_000, expectedTimeoutMs: 25_000 },
      { label: 'pollingTimeout + 10000ms for standard 30000ms long-poll', pollingTimeout: 30_000, expectedTimeoutMs: 40_000 }
    ])(
      'enforces $label ($expectedTimeoutMs ms) and evicts the cached promise on timeout',
      async ({ pollingTimeout, expectedTimeoutMs }) => {
        const fetchMock = createAbortAwarePendingFetch()
        vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)

        const httpClient = new MatrixHttpClient('https://relay.example')
        const eventService = new MatrixEventService(httpClient)

        const firstSync = observe(
          eventService.sync(
            'access-token-1',
            pollingTimeout !== undefined
              ? { pollingTimeout, syncToken: 'batch-1' }
              : undefined
          )
        )

        try {
          await vi.advanceTimersByTimeAsync(expectedTimeoutMs - 1)
          await flushMicrotasks()
          expect(firstSync.outcome).toEqual({ status: 'pending' })

          await vi.advanceTimersByTimeAsync(1)
          await flushMicrotasks()
          expect(firstSync.outcome).toMatchObject({
            status: 'rejected',
            reason: { name: 'AbortError' }
          })

          // Subsequent sync() must not return the rejected cached promise; it must issue a new request
          fetchMock.mockResolvedValueOnce(Response.json({ next_batch: 'batch-2', rooms: {} }))
          await expect(
            eventService.sync('access-token-1', {
              pollingTimeout,
              syncToken: 'batch-1'
            })
          ).resolves.toEqual({ next_batch: 'batch-2', rooms: {} })
          expect(fetchMock).toHaveBeenCalledTimes(2)
        } finally {
          await httpClient.cancelAllRequests()
        }
      }
    )
  })

  describe('MatrixClient half-open /sync timeout and wake/visibility recovery', () => {
    it('aborts a half-open long-poll /sync after 40000ms, counts repeated timeouts toward degraded health and 5000ms backoff, and recovers when a retry succeeds', async () => {
      let syncCallCount = 0
      const fetchMock = vi.fn(
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = String(input)
          if (url.endsWith('/login')) {
            return Response.json(loginResponse)
          }
          if (url.includes('/sync')) {
            syncCallCount += 1
            if (syncCallCount === 1) {
              return Response.json({ next_batch: 'batch-1', rooms: {} })
            }
            // Calls 2, 3, 4: 3 consecutive half-open long-polls that hang until their 40000ms client timeout
            if (syncCallCount <= 4) {
              return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener(
                  'abort',
                  () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
                  { once: true }
                )
              })
            }
            // Call 5: succeeds with queued room message
            return Response.json({
              next_batch: 'batch-2',
              rooms: {
                join: {
                  '!room:relay.example': {
                    state: {
                      events: [
                        {
                          type: 'm.room.member',
                          sender: '@dapp:relay.example',
                          content: { membership: 'join' }
                        }
                      ]
                    },
                    timeline: {
                      events: [
                        {
                          type: 'm.room.message',
                          sender: '@dapp:relay.example',
                          event_id: '$msg-1',
                          origin_server_ts: 1000,
                          content: { msgtype: 'm.text', body: 'encrypted-operation-request' }
                        }
                      ]
                    }
                  }
                }
              }
            })
          }
          throw new Error(`Unexpected URL: ${url}`)
        }
      )
      vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)

      const client = MatrixClient.create({
        baseUrl: 'https://relay.example',
        storage: new LocalStorage('matrix-half-open-timeout')
      })
      const healthTransitions: MatrixHealthTransition[] = []
      client.onHealthTransition((event) => {
        healthTransitions.push(event)
      })
      const receivedMessages: string[] = []
      client.subscribe(MatrixClientEventType.MESSAGE, (event) => {
        receivedMessages.push(event.content.message.content)
      })

      try {
        await client.start(user)
        await vi.advanceTimersByTimeAsync(0)
        await flushMicrotasks()
        expect(syncCallCount).toBe(2)

        // Timeout 1 (Call 2): aborts at 40000ms and retries immediately (nested timer tick 1ms -> Call 3)
        await vi.advanceTimersByTimeAsync(39_999)
        expect(syncCallCount).toBe(2)
        await vi.advanceTimersByTimeAsync(1)
        await flushMicrotasks()
        await vi.advanceTimersByTimeAsync(1)
        await flushMicrotasks()
        expect(syncCallCount).toBe(3)
        expect(healthTransitions).toEqual([])

        // Timeout 2 (Call 3): aborts at 40000ms and retries immediately (nested timer tick 1ms -> Call 4)
        await vi.advanceTimersByTimeAsync(40_000)
        await flushMicrotasks()
        await vi.advanceTimersByTimeAsync(1)
        await flushMicrotasks()
        expect(syncCallCount).toBe(4)
        expect(healthTransitions).toEqual([])

        // Timeout 3 (Call 4): aborts at 40000ms, transitions health to degraded, and enters 5000ms backoff
        await vi.advanceTimersByTimeAsync(40_000)
        await flushMicrotasks()
        expect(healthTransitions).toEqual([{ health: 'degraded', reason: 'sync_failing' }])
        await vi.advanceTimersByTimeAsync(4_999)
        await flushMicrotasks()
        expect(syncCallCount).toBe(4)

        // Reaching 5000ms backoff triggers Call 5, which resolves and delivers the message
        await vi.advanceTimersByTimeAsync(1)
        await flushMicrotasks()
        await vi.advanceTimersByTimeAsync(0)
        await flushMicrotasks()
        expect(syncCallCount).toBeGreaterThanOrEqual(5)
        expect(receivedMessages).toEqual(['encrypted-operation-request'])
        expect(healthTransitions).toEqual([
          { health: 'degraded', reason: 'sync_failing' },
          { health: 'ok' }
        ])
      } finally {
        await client.stop()
        await vi.runOnlyPendingTimersAsync()
      }
    })

    it.each(['online', 'visibilitychange', 'focus'] as const)(
      'aborts an in-flight long-poll /sync on %s, deduplicates same-tick visibilitychange + focus events, and immediately re-polls without aborting concurrent sends or altering retry failure counts',
      async (wakeTrigger) => {
        let syncCallCount = 0
        const longPollSignals: AbortSignal[] = []
        let sendSignal: AbortSignal | undefined
        let resolveSend!: (response: Response) => void

        const fetchMock = vi.fn(
          async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const url = String(input)
            if (url.endsWith('/login')) {
              return Response.json(loginResponse)
            }
            if (url.includes('/send/m.room.message/')) {
              sendSignal = init?.signal ?? undefined
              return new Promise<Response>((resolve, reject) => {
                resolveSend = resolve
                init?.signal?.addEventListener(
                  'abort',
                  () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
                  { once: true }
                )
              })
            }
            if (url.includes('/sync')) {
              syncCallCount += 1
              // Call 1: initial sync resolves immediately
              if (syncCallCount === 1) {
                return Response.json({ next_batch: 'batch-1', rooms: {} })
              }
              if (init?.signal) {
                longPollSignals.push(init.signal)
              }
              // Calls 2, 3, 4: long-polls that hang until aborted by wake trigger
              if (syncCallCount <= 4) {
                return new Promise<Response>((_resolve, reject) => {
                  init?.signal?.addEventListener(
                    'abort',
                    () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
                    { once: true }
                  )
                })
              }
              // Call 5: fresh long-poll after wake resolves with message
              if (syncCallCount === 5) {
                return Response.json({
                  next_batch: 'batch-2',
                  rooms: {
                    join: {
                      '!room:relay.example': {
                        state: {
                          events: [
                            {
                              type: 'm.room.member',
                              sender: '@dapp:relay.example',
                              content: { membership: 'join' }
                            }
                          ]
                        },
                        timeline: {
                          events: [
                            {
                              type: 'm.room.message',
                              sender: '@dapp:relay.example',
                              event_id: '$msg-wake',
                              origin_server_ts: 2000,
                              content: { msgtype: 'm.text', body: 'wake-recovered-payload' }
                            }
                          ]
                        }
                      }
                    }
                  }
                })
              }
              // Call 6: hangs peacefully until client.stop()
              return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener(
                  'abort',
                  () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
                  { once: true }
                )
              })
            }
            throw new Error(`Unexpected URL: ${url}`)
          }
        )
        vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)

        const client = MatrixClient.create({
          baseUrl: 'https://relay.example',
          storage: new LocalStorage(`matrix-wake-${wakeTrigger}`)
        })
        const healthTransitions: MatrixHealthTransition[] = []
        client.onHealthTransition((event) => {
          healthTransitions.push(event)
        })
        const receivedMessages: string[] = []
        client.subscribe(MatrixClientEventType.MESSAGE, (event) => {
          receivedMessages.push(event.content.message.content)
        })

        try {
          await client.start(user)
          await vi.advanceTimersByTimeAsync(0)
          await flushMicrotasks()
          expect(syncCallCount).toBe(2)

          // Start a concurrent outbound send while the long-poll /sync is in flight
          const pendingSend = observe(
            client.sendTextMessage('!room:relay.example', 'outbound-ack')
          )
          await flushMicrotasks()
          expect(sendSignal).toBeDefined()
          expect(sendSignal?.aborted).toBe(false)

          // Trigger wake recovery 3 times in a row on hung long-polls (calls 2, 3, 4) after >= 1000ms in flight
          for (let wakeAttempt = 0; wakeAttempt < 3; wakeAttempt++) {
            await vi.advanceTimersByTimeAsync(1_000)
            if (wakeTrigger === 'online') {
              window.dispatchEvent(new Event('online'))
            } else if (wakeTrigger === 'focus') {
              window.dispatchEvent(new Event('focus'))
            } else {
              setDocumentVisibilityState('visible')
              document.dispatchEvent(new Event('visibilitychange'))
              // Simulate browser firing window focus right after visibilitychange on tab switch (< 1000ms)
              await flushMicrotasks()
              await vi.advanceTimersByTimeAsync(0)
              await flushMicrotasks()
              window.dispatchEvent(new Event('focus'))
            }
            await flushMicrotasks()
            await vi.advanceTimersByTimeAsync(0)
            await flushMicrotasks()
          }

          // All 3 hung long-poll /sync requests were aborted by wake recovery, and call 5 succeeded
          expect(longPollSignals.slice(0, 3).map((signal) => signal.aborted)).toEqual([
            true,
            true,
            true
          ])
          expect(syncCallCount).toBe(6)
          expect(receivedMessages).toEqual(['wake-recovered-payload'])

          // Wake-initiated refreshes must not degrade health or abort the concurrent outbound PUT
          expect(healthTransitions).toEqual([])
          expect(sendSignal?.aborted).toBe(false)
          resolveSend(Response.json({ event_id: '$outbound-1' }))
          await pendingSend.settled
          expect(pendingSend.outcome).toEqual({ status: 'resolved', value: undefined })
        } finally {
          await client.stop()
          await vi.runOnlyPendingTimersAsync()
        }
      }
    )

    it.each(['online', 'visibilitychange', 'focus'] as const)(
      'short-circuits an active 5000ms pollingRetry backoff timer immediately on %s without swallowing a subsequent sync failure',
      async (wakeTrigger) => {
        let syncCallCount = 0
        const fetchMock = vi.fn(
          async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const url = String(input)
            if (url.endsWith('/login')) {
              return Response.json(loginResponse)
            }
            syncCallCount += 1
            if (syncCallCount === 1) {
              return Response.json({ next_batch: 'batch-1', rooms: {} })
            }
            // Calls 2, 3, 4 fail -> enters 5000ms backoff; Call 5 (woken from backoff) also fails!
            if (syncCallCount <= 5) {
              throw new Error(`transient network error ${syncCallCount}`)
            }
            // Call 6 (woken from second backoff) succeeds
            if (syncCallCount === 6) {
              return Response.json({ next_batch: 'batch-2', rooms: {} })
            }
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
                { once: true }
              )
            })
          }
        )
        vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)

        const client = MatrixClient.create({
          baseUrl: 'https://relay.example',
          storage: new LocalStorage(`matrix-backoff-wake-${wakeTrigger}`)
        })
        const healthTransitions: MatrixHealthTransition[] = []
        client.onHealthTransition((event) => {
          healthTransitions.push(event)
        })

        const triggerWake = () => {
          if (wakeTrigger === 'online') {
            window.dispatchEvent(new Event('online'))
          } else if (wakeTrigger === 'focus') {
            window.dispatchEvent(new Event('focus'))
          } else {
            setDocumentVisibilityState('visible')
            document.dispatchEvent(new Event('visibilitychange'))
          }
        }

        try {
          await client.start(user)
          // Drain initial immediate retries (calls 2, 3, 4 fail -> enters 5000ms backoff)
          for (let i = 0; i < 3; i++) {
            await vi.advanceTimersByTimeAsync(1)
            await flushMicrotasks()
          }
          expect(syncCallCount).toBe(4)
          expect(healthTransitions).toEqual([{ health: 'degraded', reason: 'sync_failing' }])

          // 100ms into first 5000ms backoff, wake event fires -> triggers Call 5 immediately
          await vi.advanceTimersByTimeAsync(100)
          expect(syncCallCount).toBe(4)
          triggerWake()
          await flushMicrotasks()
          expect(syncCallCount).toBe(5)

          // Because Call 5 ALSO failed (retry #4), it must NOT be swallowed as a wake abort;
          // it must re-enter the 5000ms backoff (not retry at 0ms!)
          await vi.advanceTimersByTimeAsync(4_999)
          await flushMicrotasks()
          expect(syncCallCount).toBe(5)

          // Waking again during the second backoff triggers Call 6, which succeeds and restores health
          triggerWake()
          await flushMicrotasks()
          await vi.advanceTimersByTimeAsync(0)
          await flushMicrotasks()
          expect(syncCallCount).toBe(7)
          expect(healthTransitions).toEqual([
            { health: 'degraded', reason: 'sync_failing' },
            { health: 'ok' }
          ])
        } finally {
          await client.stop()
          await vi.runOnlyPendingTimersAsync()
        }
      }
    )

    it('does not fail startup if online or visibilitychange fires while login or initial sync is in flight', async () => {
      let resolveLogin!: (response: Response) => void
      let resolveInitialSync!: (response: Response) => void
      let syncCallCount = 0

      const fetchMock = vi.fn(
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = String(input)
          if (url.endsWith('/login')) {
            return new Promise<Response>((resolve, reject) => {
              resolveLogin = resolve
              init?.signal?.addEventListener(
                'abort',
                () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
                { once: true }
              )
            })
          }
          syncCallCount += 1
          if (syncCallCount === 1) {
            return new Promise<Response>((resolve, reject) => {
              resolveInitialSync = resolve
              init?.signal?.addEventListener(
                'abort',
                () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
                { once: true }
              )
            })
          }
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true }
            )
          })
        }
      )
      vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)

      const client = MatrixClient.create({
        baseUrl: 'https://relay.example',
        storage: new LocalStorage('matrix-startup-wake-safety')
      })

      try {
        const starting = observe(client.start(user))
        await flushMicrotasks()

        // Fire wake events while login is in flight
        window.dispatchEvent(new Event('online'))
        window.dispatchEvent(new Event('focus'))
        setDocumentVisibilityState('visible')
        document.dispatchEvent(new Event('visibilitychange'))
        await flushMicrotasks()
        expect(starting.outcome).toEqual({ status: 'pending' })

        resolveLogin(Response.json(loginResponse))
        await flushMicrotasks()
        expect(syncCallCount).toBe(1)

        // Fire wake events while initial sync (before readiness settles) is in flight
        await vi.advanceTimersByTimeAsync(1_000)
        window.dispatchEvent(new Event('online'))
        window.dispatchEvent(new Event('focus'))
        setDocumentVisibilityState('visible')
        document.dispatchEvent(new Event('visibilitychange'))
        await flushMicrotasks()
        expect(starting.outcome).toEqual({ status: 'pending' })

        resolveInitialSync(Response.json({ next_batch: 'batch-1', rooms: {} }))
        await starting.settled
        expect(starting.outcome).toEqual({ status: 'resolved', value: undefined })
        await expect(client.isConnected()).resolves.toBeUndefined()

        // Now that initial sync has settled and long-poll (Call 2) is in flight, wake refreshes it (Call 3)
        await vi.advanceTimersByTimeAsync(1_000)
        await flushMicrotasks()
        expect(syncCallCount).toBe(2)
        window.dispatchEvent(new Event('online'))
        await flushMicrotasks()
        await vi.advanceTimersByTimeAsync(0)
        await flushMicrotasks()
        expect(syncCallCount).toBe(3)
      } finally {
        await client.stop()
        await vi.runOnlyPendingTimersAsync()
      }
    })

    it('ignores visibilitychange when visibilityState is hidden and refreshes only when visibilityState becomes visible', async () => {
      let syncCallCount = 0
      const longPollSignals: AbortSignal[] = []
      const fetchMock = vi.fn(
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = String(input)
          if (url.endsWith('/login')) {
            return Response.json(loginResponse)
          }
          syncCallCount += 1
          if (syncCallCount === 1) {
            return Response.json({ next_batch: 'batch-1', rooms: {} })
          }
          if (init?.signal) {
            longPollSignals.push(init.signal)
          }
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true }
            )
          })
        }
      )
      vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)

      const client = MatrixClient.create({
        baseUrl: 'https://relay.example',
        storage: new LocalStorage('matrix-hidden-visibility')
      })

      try {
        await client.start(user)
        await vi.advanceTimersByTimeAsync(1_000)
        await flushMicrotasks()
        expect(syncCallCount).toBe(2)
        expect(longPollSignals[0]?.aborted).toBe(false)

        // Hidden transition must be ignored
        setDocumentVisibilityState('hidden')
        document.dispatchEvent(new Event('visibilitychange'))
        await flushMicrotasks()
        await vi.advanceTimersByTimeAsync(0)
        await flushMicrotasks()

        expect(longPollSignals[0]?.aborted).toBe(false)
        expect(syncCallCount).toBe(2)

        // Visible transition must abort the in-flight long-poll and trigger call 3
        setDocumentVisibilityState('visible')
        document.dispatchEvent(new Event('visibilitychange'))
        await flushMicrotasks()
        await vi.advanceTimersByTimeAsync(0)
        await flushMicrotasks()

        expect(longPollSignals[0]?.aborted).toBe(true)
        expect(syncCallCount).toBe(3)
      } finally {
        await client.stop()
        await vi.runOnlyPendingTimersAsync()
      }
    })

    it('does not accumulate duplicate wake listeners across repeated start() calls and removes all listeners on stop()', async () => {
      let syncCallCount = 0
      const fetchMock = vi.fn(
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = String(input)
          if (url.endsWith('/login')) {
            return Response.json(loginResponse)
          }
          syncCallCount += 1
          if (syncCallCount === 1 || syncCallCount === 3) {
            return Response.json({ next_batch: `batch-${syncCallCount}`, rooms: {} })
          }
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true }
            )
          })
        }
      )
      vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)

      const client = MatrixClient.create({
        baseUrl: 'https://relay.example',
        storage: new LocalStorage('matrix-stop-listener-cleanup')
      })

      try {
        await client.start(user)
        await vi.advanceTimersByTimeAsync(0)
        await flushMicrotasks()
        expect(syncCallCount).toBe(2)

        // Call start() a second time without calling stop() first: must abort Session 1's in-flight /sync
        const secondStart = observe(client.start(user))
        await flushMicrotasks()
        await vi.advanceTimersByTimeAsync(1_000)
        await flushMicrotasks()
        expect(secondStart.outcome).toEqual({ status: 'resolved', value: undefined })
        expect(syncCallCount).toBe(4)

        // Verify a single online event triggers exactly one wake re-poll (Call 5)
        window.dispatchEvent(new Event('online'))
        await flushMicrotasks()
        await vi.advanceTimersByTimeAsync(0)
        await flushMicrotasks()
        expect(syncCallCount).toBe(5)

        await client.stop()
        await vi.runOnlyPendingTimersAsync()
        const callsAtStop = syncCallCount

        window.dispatchEvent(new Event('online'))
        window.dispatchEvent(new Event('focus'))
        setDocumentVisibilityState('visible')
        document.dispatchEvent(new Event('visibilitychange'))
        await flushMicrotasks()

        expect(syncCallCount).toBe(callsAtStop)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        await client.stop()
        await vi.runOnlyPendingTimersAsync()
      }
    })

    it('removes wake listeners if start() fails during login and stop() is never called', async () => {
      const windowAddSpy = vi.spyOn(window, 'addEventListener')
      const windowRemoveSpy = vi.spyOn(window, 'removeEventListener')
      const documentAddSpy = vi.spyOn(document, 'addEventListener')
      const documentRemoveSpy = vi.spyOn(document, 'removeEventListener')

      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch login'))

      const client = MatrixClient.create({
        baseUrl: 'https://relay.example',
        storage: new LocalStorage('matrix-failed-login-listener-cleanup')
      })

      await expect(client.start(user)).rejects.toThrow('Failed to fetch login')

      const addedOnline = windowAddSpy.mock.calls.filter(([event]) => event === 'online').length
      const removedOnline = windowRemoveSpy.mock.calls.filter(([event]) => event === 'online').length
      const addedFocus = windowAddSpy.mock.calls.filter(([event]) => event === 'focus').length
      const removedFocus = windowRemoveSpy.mock.calls.filter(([event]) => event === 'focus').length
      const addedVisibility = documentAddSpy.mock.calls.filter(
        ([event]) => event === 'visibilitychange'
      ).length
      const removedVisibility = documentRemoveSpy.mock.calls.filter(
        ([event]) => event === 'visibilitychange'
      ).length

      expect(addedOnline).toBe(removedOnline)
      expect(addedFocus).toBe(removedFocus)
      expect(addedVisibility).toBe(removedVisibility)
    })
  })
})
