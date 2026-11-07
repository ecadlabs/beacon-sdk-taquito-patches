import { ExtensionMessageTarget } from '@ecadlabs/beacon-types'

type MessageHandler = (event: unknown) => void
type WindowIdentity = { location: { origin: string } }

const loadTransport = async () => {
  vi.resetModules()
  const listeners: MessageHandler[] = []
  const postMessage = vi.fn<(...args: [unknown, string?]) => void>()
  const addEventListener = vi.fn<(...args: [string, MessageHandler]) => void>((name, handler) => {
    if (name === 'message') {
      listeners.push(handler)
    }
  })
  const removeEventListener = vi.fn<(...args: [string, MessageHandler]) => void>()
  const windowRef = {
    location: { origin: 'https://dapp.example' },
    postMessage,
    addEventListener,
    removeEventListener
  }
  vi.doMock('@ecadlabs/beacon-core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
    windowRef
  }))
  const { PostMessageTransport } = await import('../src/PostMessageTransport')
  PostMessageTransport.getAvailableExtensions()
  const discovery = listeners[0]
  if (!discovery) {
    throw new Error('Expected explicit discovery to register its listener')
  }

  return { PostMessageTransport, discovery, listeners, windowRef }
}

const trustedEvent = (windowRef: WindowIdentity, data: unknown) => ({
  source: windowRef,
  origin: windowRef.location.origin,
  data
})

const malformedDiscoveryEvents: Array<[string, (windowRef: WindowIdentity) => unknown]> = [
  ['undefined event', () => undefined],
  ['null event', () => null],
  ['number event', () => 7],
  ['string event', () => 'pong'],
  ['array event', () => []],
  ['missing data', (ref) => ({ source: ref, origin: ref.location.origin })],
  ['null data', (ref) => trustedEvent(ref, null)],
  ['number data', (ref) => trustedEvent(ref, 7)],
  ['string data', (ref) => trustedEvent(ref, 'pong')],
  ['array data', (ref) => trustedEvent(ref, [])],
  ['missing sender', (ref) => trustedEvent(ref, { payload: 'pong' })],
  ['null sender', (ref) => trustedEvent(ref, { payload: 'pong', sender: null })],
  ['number sender', (ref) => trustedEvent(ref, { payload: 'pong', sender: 7 })],
  ['string sender', (ref) => trustedEvent(ref, { payload: 'pong', sender: 'wallet' })],
  ['array sender', (ref) => trustedEvent(ref, { payload: 'pong', sender: [] })],
  ['missing id', (ref) => trustedEvent(ref, { payload: 'pong', sender: { name: 'Wallet' } })],
  ['missing name', (ref) => trustedEvent(ref, { payload: 'pong', sender: { id: 'wallet' } })],
  [
    'numeric id',
    (ref) => trustedEvent(ref, { payload: 'pong', sender: { id: 7, name: 'Wallet' } })
  ],
  [
    'object name',
    (ref) => trustedEvent(ref, { payload: 'pong', sender: { id: 'wallet', name: {} } })
  ],
  [
    'wrong payload',
    (ref) => trustedEvent(ref, { payload: 'ping', sender: { id: 'wallet', name: 'Wallet' } })
  ]
]

const malformedOptionalFields: Array<[string, unknown]> = [
  ['shortName', null],
  ['shortName', 7],
  ['shortName', {}],
  ['iconUrl', null],
  ['iconUrl', 7],
  ['iconUrl', []],
  ['color', null],
  ['color', false],
  ['color', {}]
]

describe('PostMessageTransport public extension discovery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
    vi.doUnmock('@ecadlabs/beacon-core')
  })

  it('shares one timed collection and keeps its cached array', async () => {
    const { PostMessageTransport, windowRef } = await loadTransport()
    const first = PostMessageTransport.getAvailableExtensions()
    const second = PostMessageTransport.getAvailableExtensions()
    let settled = false
    first.then(() => {
      settled = true
    })

    expect(windowRef.addEventListener).toHaveBeenCalledTimes(1)
    expect(windowRef.postMessage).toHaveBeenCalledTimes(1)
    expect(windowRef.postMessage).toHaveBeenCalledWith(
      { target: ExtensionMessageTarget.EXTENSION, payload: 'ping' },
      windowRef.location.origin
    )
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const collected = await first
    expect(collected).toEqual([])
    expect(await second).toBe(collected)
    expect(await PostMessageTransport.getAvailableExtensions()).toBe(collected)
    expect(windowRef.addEventListener).toHaveBeenCalledTimes(1)
    expect(windowRef.postMessage).toHaveBeenCalledTimes(1)
  })

  it('retains valid sender identity, canonical optional metadata and extra fields without requiring a target', async () => {
    const { PostMessageTransport, discovery, windowRef } = await loadTransport()
    const sender = {
      id: 'wallet',
      name: 'Wallet',
      shortName: 'Short',
      iconUrl: 'https://wallet.example/icon.png',
      color: '#123456',
      iconURL: 'legacy-extra',
      link: 'https://wallet.example'
    }
    discovery(trustedEvent(windowRef, { payload: 'pong', sender }))
    await vi.advanceTimersByTimeAsync(1000)
    const extensions = await PostMessageTransport.getAvailableExtensions()

    expect(extensions).toEqual([sender])
    expect(extensions[0]).toBe(sender)
    expect(windowRef.postMessage).toHaveBeenLastCalledWith(
      'extensionsUpdated',
      windowRef.location.origin
    )
  })

  it('accepts empty strings and explicitly absent optional metadata', async () => {
    const { PostMessageTransport, discovery, windowRef } = await loadTransport()
    const empty = { id: '', name: '', shortName: '', iconUrl: '', color: '' }
    const absent = {
      id: 'absent',
      name: 'Absent',
      shortName: undefined,
      iconUrl: undefined,
      color: undefined
    }
    discovery(trustedEvent(windowRef, { payload: 'pong', sender: empty }))
    discovery(trustedEvent(windowRef, { payload: 'pong', sender: absent }))
    await vi.advanceTimersByTimeAsync(1000)

    expect(await PostMessageTransport.getAvailableExtensions()).toEqual([empty, absent])
  })

  it('deduplicates by id and posts an update only for a new id', async () => {
    const { PostMessageTransport, discovery, windowRef } = await loadTransport()
    const first = { id: 'wallet', name: 'First Wallet' }
    discovery(trustedEvent(windowRef, { payload: 'pong', sender: first }))
    discovery(
      trustedEvent(windowRef, { payload: 'pong', sender: { id: 'wallet', name: 'Replacement' } })
    )
    discovery(
      trustedEvent(windowRef, { payload: 'pong', sender: { id: 'another', name: 'Another' } })
    )
    await vi.advanceTimersByTimeAsync(1000)

    expect(await PostMessageTransport.getAvailableExtensions()).toEqual([
      first,
      { id: 'another', name: 'Another' }
    ])
    expect(
      windowRef.postMessage.mock.calls.filter(([message]) => message === 'extensionsUpdated')
    ).toHaveLength(2)
  })

  it('keeps collecting valid late responses into the cached array', async () => {
    const { PostMessageTransport, discovery, windowRef } = await loadTransport()
    await vi.advanceTimersByTimeAsync(1000)
    const extensions = await PostMessageTransport.getAvailableExtensions()
    const late = { id: 'late', name: 'Late Wallet' }

    discovery(trustedEvent(windowRef, { payload: 'pong', sender: late }))

    expect(await PostMessageTransport.getAvailableExtensions()).toBe(extensions)
    expect(extensions).toEqual([late])
  })

  it('requires the existing exact discovery source and origin', async () => {
    const { PostMessageTransport, discovery, windowRef } = await loadTransport()
    const data = { payload: 'pong', sender: { id: 'wallet', name: 'Wallet' } }
    discovery({ source: {}, origin: windowRef.location.origin, data })
    discovery({ source: windowRef, origin: 'https://other.example', data })
    discovery({ source: windowRef, data })
    await vi.advanceTimersByTimeAsync(1000)

    expect(await PostMessageTransport.getAvailableExtensions()).toEqual([])
    expect(windowRef.postMessage).toHaveBeenCalledTimes(1)
  })

  it.each(malformedDiscoveryEvents)(
    'ignores %s before caching or notification',
    async (_name, makeEvent) => {
      const { PostMessageTransport, discovery, windowRef } = await loadTransport()
      expect(() => discovery(makeEvent(windowRef))).not.toThrow()
      await vi.advanceTimersByTimeAsync(1000)

      expect(await PostMessageTransport.getAvailableExtensions()).toEqual([])
      expect(windowRef.postMessage).toHaveBeenCalledTimes(1)
    }
  )

  it.each(malformedOptionalFields)('rejects a non-string %s value %p', async (field, value) => {
    const { PostMessageTransport, discovery, windowRef } = await loadTransport()
    const sender = { id: 'wallet', name: 'Wallet', [field]: value }
    discovery(trustedEvent(windowRef, { payload: 'pong', sender }))
    await vi.advanceTimersByTimeAsync(1000)

    expect(await PostMessageTransport.getAvailableExtensions()).toEqual([])
    expect(windowRef.postMessage).toHaveBeenCalledTimes(1)
  })
})

describe('PostMessageTransport public availability probe', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
    vi.doUnmock('@ecadlabs/beacon-core')
  })

  it('preserves the weaker availability policy and removes its exact listener after pong', async () => {
    const { PostMessageTransport, listeners, discovery, windowRef } = await loadTransport()
    const available = PostMessageTransport.isAvailable()
    const probe = listeners[1]
    if (!probe) {
      throw new Error('Expected availability to register its public listener')
    }
    probe({ source: {}, origin: 'https://other.example', data: { payload: 'pong' } })

    await expect(available).resolves.toBe(true)
    expect(windowRef.removeEventListener).toHaveBeenCalledTimes(1)
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('message', probe)
    expect(windowRef.removeEventListener).not.toHaveBeenCalledWith('message', discovery)
    expect(windowRef.postMessage).toHaveBeenLastCalledWith(
      { target: ExtensionMessageTarget.EXTENSION, payload: 'ping' },
      windowRef.location.origin
    )
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['number', 7],
    ['string', 'pong'],
    ['empty event', {}],
    ['null data', { data: null }],
    ['wrong payload', { data: { payload: 'ping' } }]
  ])('ignores malformed or non-pong availability input %s', async (_name, event) => {
    const { PostMessageTransport, listeners, windowRef } = await loadTransport()
    let settled = false
    const available = PostMessageTransport.isAvailable().then((value) => {
      settled = true
      return value
    })
    const probe = listeners[1]
    if (!probe) {
      throw new Error('Expected availability to register its public listener')
    }

    expect(() => probe(event)).not.toThrow()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(windowRef.removeEventListener).not.toHaveBeenCalled()
    probe({ data: { payload: 'pong' } })
    await expect(available).resolves.toBe(true)
  })
})
