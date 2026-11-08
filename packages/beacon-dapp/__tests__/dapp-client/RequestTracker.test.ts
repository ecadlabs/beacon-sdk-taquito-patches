import { RequestTracker } from '../../src/dapp-client/RequestTracker'

const routes = ['Direct', 'Follower', 'LeaderProxy'] as const

describe('Request tracker ownership', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  function register(
    tracker: RequestTracker<string, string>,
    id: string,
    route: (typeof routes)[number] = 'Direct'
  ) {
    const settled = vi.fn()
    const key = tracker.admit(id, route, settled)
    if (!key) throw new Error('Expected fresh request admission')
    return { key, settled }
  }

  it.each(routes)('keeps the first live %s admission and its settlement sink', (route) => {
    const tracker = new RequestTracker<string, string>()
    const first = register(tracker, 'request', route)
    const duplicate = vi.fn()

    expect(tracker.admit('request', route, duplicate)).toBeUndefined()
    expect(tracker.get('request')?.key).toEqual(first.key)
    expect(tracker.size).toBe(1)
    expect(tracker.resolve(first.key, 'response')).toBe(true)
    expect(first.settled).toHaveBeenCalledExactlyOnceWith({ tag: 'Resolved', response: 'response' })
    expect(duplicate).not.toHaveBeenCalled()
    expect(tracker.size).toBe(0)
  })

  it('ignores inputs from an earlier instance without disabling its replacement deadline', async () => {
    const tracker = new RequestTracker<string, string>()
    const previous = register(tracker, 'request')
    tracker.beginPreparation(previous.key)
    tracker.abort(previous.key, 'previous-abort')
    const current = register(tracker, 'request')
    tracker.armDeadline(current.key, 25, 'current-timeout')

    expect(current.key.instance).not.toBe(previous.key.instance)
    expect(tracker.isCurrent(previous.key)).toBe(false)
    expect(tracker.acknowledge(previous.key)).toBe(false)
    expect(tracker.beginPreparation(previous.key)).toBe(false)
    expect(tracker.resolve(previous.key, 'late-response')).toBe(false)
    expect(tracker.prepared(previous.key, 'late-preparation')).toBe(false)
    expect(tracker.reject(previous.key, 'late-rejection')).toBe(false)
    expect(tracker.preparationFailed(previous.key, 'late-preparation-failure')).toBe(false)
    expect(tracker.abort(previous.key, 'late-abort')).toBe(false)
    tracker.armDeadline(previous.key, 1, 'old-timeout')
    await vi.advanceTimersByTimeAsync(1)
    expect(current.settled).not.toHaveBeenCalled()
    expect(tracker.isCurrent(current.key)).toBe(true)
    await vi.advanceTimersByTimeAsync(24)

    expect(current.settled).toHaveBeenCalledExactlyOnceWith({
      tag: 'TimedOut',
      error: 'current-timeout'
    })
    expect(previous.settled).toHaveBeenCalledExactlyOnceWith({
      tag: 'Aborted',
      error: 'previous-abort'
    })
    expect(tracker.size).toBe(0)
  })

  it('disposes an earlier instance attachment without cancelling the replacement', () => {
    const tracker = new RequestTracker<string, string>()
    const previous = register(tracker, 'request')
    tracker.abort(previous.key, 'previous-abort')
    const current = register(tracker, 'request')
    const currentCleanup = vi.fn()
    const lateCleanup = vi.fn()
    tracker.attachCleanup(current.key, currentCleanup)

    tracker.attachCleanup(previous.key, lateCleanup)
    expect(lateCleanup).toHaveBeenCalledTimes(1)
    expect(currentCleanup).not.toHaveBeenCalled()
    expect(current.settled).not.toHaveBeenCalled()
    expect(tracker.isCurrent(current.key)).toBe(true)
    tracker.resolve(current.key, 'current-response')
    expect(currentCleanup).toHaveBeenCalledTimes(1)
    expect(lateCleanup).toHaveBeenCalledTimes(1)
  })

  it.each(['Resolved', 'Rejected', 'TimedOut', 'Aborted'] as const)(
    'immediately disposes a cleanup attached after %s',
    async (terminal) => {
      const tracker = new RequestTracker<string, string>()
      const request = register(tracker, 'request')
      if (terminal === 'Resolved') tracker.resolve(request.key, 'response')
      if (terminal === 'Rejected') tracker.reject(request.key, 'rejection')
      if (terminal === 'Aborted') tracker.abort(request.key, 'abort')
      if (terminal === 'TimedOut') {
        tracker.armDeadline(request.key, 25, 'timeout')
        await vi.advanceTimersByTimeAsync(25)
      }
      expect(request.settled).toHaveBeenCalledTimes(1)
      expect(tracker.get('request')).toBeUndefined()
      const cleanup = vi.fn()

      tracker.attachCleanup(request.key, cleanup)
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(tracker.size).toBe(0)
      expect(tracker.resolve(request.key, 'late-response')).toBe(false)
      expect(tracker.abort(request.key, 'late-abort')).toBe(false)
      await vi.advanceTimersByTimeAsync(100)
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(request.settled).toHaveBeenCalledTimes(1)
    }
  )

  it('removes lookup and timer ownership before invoking a cleanup or settlement sink', async () => {
    const tracker = new RequestTracker<string, string>()
    const order: string[] = []
    const key = tracker.admit('request', 'Direct', () => {
      expect(tracker.get('request')).toBeUndefined()
      order.push('settled')
    })
    if (!key) throw new Error('Expected fresh request admission')
    tracker.armDeadline(key, 25, 'timeout')
    const cleanup = vi.fn(() => {
      expect(tracker.get('request')).toBeUndefined()
      expect(tracker.isCurrent(key)).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      expect(tracker.abort(key, 'reentrant-abort')).toBe(false)
      order.push('cleanup')
    })
    tracker.attachCleanup(key, cleanup)
    tracker.attachCleanup(key, cleanup)

    expect(tracker.resolve(key, 'response')).toBe(true)
    expect(order).toEqual(['cleanup', 'settled'])
    await vi.advanceTimersByTimeAsync(25)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['cleanup', 'settled'])
  })

  it('settles every aborted record even when one cleanup throws', () => {
    const observedError = vi.fn()
    const tracker = new RequestTracker<string, string>({ onError: observedError })
    const first = register(tracker, 'first')
    const second = register(tracker, 'second')
    const cleanupError = new Error('Cleanup failed')
    const secondCleanup = vi.fn()
    tracker.attachCleanup(first.key, () => {
      throw cleanupError
    })
    tracker.attachCleanup(second.key, secondCleanup)

    expect(() => tracker.abortAll((key) => `${key.id}-abort`)).not.toThrow()
    expect(first.settled).toHaveBeenCalledExactlyOnceWith({ tag: 'Aborted', error: 'first-abort' })
    expect(second.settled).toHaveBeenCalledExactlyOnceWith({
      tag: 'Aborted',
      error: 'second-abort'
    })
    expect(secondCleanup).toHaveBeenCalledTimes(1)
    expect(observedError).toHaveBeenCalledExactlyOnceWith(cleanupError)
    expect(tracker.size).toBe(0)
  })

  it('settles its completion when the delivery sink throws', async () => {
    const tracker = new RequestTracker<string, string>()
    const sink = vi.fn(() => {
      throw new Error('Delivery failed')
    })
    const key = tracker.admit('request', 'LeaderProxy', sink)
    if (!key) throw new Error('Expected fresh request admission')
    const completion = tracker.get('request')?.completion
    expect(completion).toBeDefined()

    expect(() => tracker.resolve(key, 'response')).not.toThrow()
    await expect(completion).resolves.toEqual({ tag: 'Resolved', response: 'response' })
    expect(sink).toHaveBeenCalledExactlyOnceWith({ tag: 'Resolved', response: 'response' })
    expect(tracker.get('request')).toBeUndefined()
    expect(tracker.resolve(key, 'duplicate-response')).toBe(false)
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('keeps preparation owned through a first ACK and ignores competing completion inputs', async () => {
    const tracker = new RequestTracker<string, string>()
    const request = register(tracker, 'request')
    tracker.armDeadline(request.key, 25, 'timeout')
    expect(tracker.beginPreparation(request.key)).toBe(true)
    expect(tracker.beginPreparation(request.key)).toBe(false)
    expect(tracker.resolve(request.key, 'duplicate-response')).toBe(false)
    expect(tracker.reject(request.key, 'late-send-failure')).toBe(false)
    expect(tracker.acknowledge(request.key)).toBe(true)
    expect(tracker.acknowledge(request.key)).toBe(false)
    tracker.armDeadline(request.key, 1, 'late-timeout')
    await vi.advanceTimersByTimeAsync(100)
    expect(request.settled).not.toHaveBeenCalled()
    expect(tracker.get('request')).toEqual(
      expect.objectContaining({ state: 'ResponsePreparing', deadline: 'Acknowledged' })
    )

    expect(tracker.prepared(request.key, 'prepared-response')).toBe(true)
    expect(request.settled).toHaveBeenCalledExactlyOnceWith({
      tag: 'Resolved',
      response: 'prepared-response'
    })
    expect(tracker.preparationFailed(request.key, 'late-failure')).toBe(false)
    expect(tracker.size).toBe(0)
  })
})
