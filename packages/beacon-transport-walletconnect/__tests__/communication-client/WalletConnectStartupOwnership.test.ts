import { NetworkType } from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { SessionTypes } from '@walletconnect/types'
import { WalletConnectCommunicationClient } from '../../src/communication-client/WalletConnectCommunicationClient'

const { initialize } = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<unknown>>()
}))

vi.mock('@walletconnect/sign-client', () => ({ default: { init: initialize } }))
vi.mock('@walletconnect/utils', () => ({
  getSdkError: () => ({ code: 6000, message: 'User disconnected.' })
}))

type Listener = (value: unknown) => void | Promise<void>

class Events {
  private readonly callbacks = new Map<string, Set<Listener>>()

  on(event: string, callback: Listener): void {
    const callbacks = this.callbacks.get(event) ?? new Set<Listener>()
    callbacks.add(callback)
    this.callbacks.set(event, callbacks)
  }

  off(event: string, callback: Listener): void {
    this.callbacks.get(event)?.delete(callback)
  }

  removeListener(event: string, callback: Listener): void {
    this.off(event, callback)
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.callbacks.delete(event)
    } else {
      this.callbacks.clear()
    }
  }

  listenerCount(event: string): number {
    return this.callbacks.get(event)?.size ?? 0
  }

  async emit(event: string, value: unknown): Promise<void> {
    await Promise.all(Array.from(this.callbacks.get(event) ?? [], (callback) => callback(value)))
  }
}

const metadata = { name: 'Wallet', description: '', url: 'https://wallet.example', icons: [] }

function session(topic: string): SessionTypes.Struct {
  return {
    topic,
    pairingTopic: `${topic}-pairing`,
    relay: { protocol: 'irn' },
    expiry: Math.floor(Date.now() / 1000) + 3 * 86400,
    acknowledged: true,
    controller: 'wallet',
    namespaces: {
      tezos: {
        accounts: ['tezos:mainnet:tz1account'],
        methods: ['tezos_getAccounts', 'tezos_send', 'tezos_sign'],
        events: ['accountsChanged', 'chainChanged']
      }
    },
    requiredNamespaces: {},
    optionalNamespaces: {},
    self: { publicKey: 'dapp-key', metadata },
    peer: { publicKey: `${topic}-wallet-key`, metadata }
  }
}

function remote(topic: string) {
  const events = new Events()
  const sessions = new Map([[topic, session(topic)]])
  return {
    events,
    on: events.on.bind(events),
    off: events.off.bind(events),
    removeListener: events.removeListener.bind(events),
    removeAllListeners: events.removeAllListeners.bind(events),
    session: {
      get keys() {
        return Array.from(sessions.keys())
      },
      get: (key: string) => sessions.get(key),
      getAll: () => Array.from(sessions.values())
    },
    pairing: { getAll: () => [] },
    ping: vi.fn(async (_input: { topic: string }) => {}),
    extend: vi.fn(async (_input: { topic: string }) => {}),
    disconnect: vi.fn(async (input: { topic: string }) => {
      sessions.delete(input.topic)
    }),
    connect: vi.fn(async () => ({
      uri: `wc:${topic}-proposal@2?symKey=key`,
      approval: () => new Promise<SessionTypes.Struct>(() => {})
    })),
    core: {
      events: new Events(),
      heartbeat: { stop: vi.fn() },
      pairing: {
        events: new Events(),
        getPairings: () => [],
        disconnect: vi.fn(async (_input: { topic: string }) => {}),
        ping: vi.fn(async (_input: { topic: string }) => {})
      },
      relayer: {
        transportClose: vi.fn(async () => {}),
        onProviderErrorHandler: (_error: Error): void | Promise<void> => {},
        events: new Events(),
        provider: { events: new Events(), connection: { events: new Events() } },
        subscriber: { events: new Events() }
      }
    }
  }
}

class LocalBroadcastChannel {
  onmessage: unknown
  onmessageerror: unknown
  postMessage(_message: unknown): void {}
  close(): void {}
}

describe('WalletConnect startup ownership', () => {
  let client: WalletConnectCommunicationClient
  let first: ReturnType<typeof remote>
  let second: ReturnType<typeof remote>
  let release: ExposedPromise<void>
  const channels = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel')

  beforeAll(() => {
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      value: LocalBroadcastChannel
    })
  })

  afterAll(() => {
    if (channels) {
      Object.defineProperty(globalThis, 'BroadcastChannel', channels)
    } else {
      Reflect.deleteProperty(globalThis, 'BroadcastChannel')
    }
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    localStorage.clear()
    release = new ExposedPromise<void>()
    first = remote('first')
    second = remote('second')
    initialize.mockReset().mockResolvedValue(first)
    client = new WalletConnectCommunicationClient(
      { network: NetworkType.MAINNET, opts: {} },
      async () => true
    )
  })

  afterEach(async () => {
    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await client.close().catch(() => undefined)
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function observe<T>(promise: Promise<T>) {
    const settled = vi.fn()
    const outcome = promise.then(
      (value) => {
        settled({ value })
        return { value }
      },
      (error: unknown) => {
        settled({ error })
        return { error }
      }
    )
    return { settled, outcome }
  }

  it('keeps every startup caller pending until restoration finishes', async () => {
    first.ping.mockImplementationOnce(() => release.promise)
    const one = observe(client.init())
    const two = observe(client.init())
    await vi.advanceTimersByTimeAsync(0)
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(first.ping).toHaveBeenCalledTimes(1)
    expect.soft(one.settled).not.toHaveBeenCalled()
    expect.soft(two.settled).not.toHaveBeenCalled()

    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(one.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    expect(two.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    expect(client.currentSession()?.topic).toBe('first')
    expect(first.events.listenerCount('session_update')).toBe(1)
  })

  it('creates a fresh pairing URI while an earlier restoration is still pending', async () => {
    first.ping.mockImplementationOnce(() => release.promise)
    const restoring = observe(client.init())
    await vi.advanceTimersByTimeAsync(0)
    expect(first.ping).toHaveBeenCalledTimes(1)
    initialize.mockResolvedValue(second)

    const pairing = await client.getPairingRequestInfo()
    expect(pairing.uri).toBe('wc:second-proposal@2?symKey=key')
    expect(first.disconnect).toHaveBeenCalledWith(expect.objectContaining({ topic: 'first' }))
    expect(client.currentSession()).toBeUndefined()

    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(restoring.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    expect(client.currentSession()).toBeUndefined()
    expect(pairing.uri).toBe('wc:second-proposal@2?symKey=key')
  })

  it('settles stopped startup before the initializer returns and disposes its late client', async () => {
    initialize.mockImplementationOnce(async () => {
      await release.promise
      return first
    })
    const startup = observe(client.init())
    await vi.advanceTimersByTimeAsync(0)
    await client.close()
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(startup.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })

    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(startup.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    expect.soft(first.core.relayer.transportClose).toHaveBeenCalledTimes(1)
    expect.soft(first.events.listenerCount('session_update')).toBe(0)
    expect.soft(client.signClient).toBeUndefined()
    expect(client.currentSession()).toBeUndefined()
    expect(first.connect).not.toHaveBeenCalled()
  })

  it('settles stopped restoration without waiting for its ping', async () => {
    first.ping.mockImplementationOnce(() => release.promise)
    const startup = observe(client.init())
    await vi.advanceTimersByTimeAsync(0)
    expect(first.ping).toHaveBeenCalledTimes(1)
    await client.close()
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(startup.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })

    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(startup.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    expect(client.currentSession()).toBeUndefined()
    expect(first.core.relayer.transportClose).toHaveBeenCalledTimes(1)
  })

  it('settles stopped proposal creation and discards its eventual approval', async () => {
    await first.disconnect({ topic: 'first' })
    first.disconnect.mockClear()
    const approval = new ExposedPromise<SessionTypes.Struct>()
    first.connect.mockImplementationOnce(async () => {
      await release.promise
      return { uri: 'wc:late-proposal@2?symKey=key', approval: () => approval.promise }
    })
    const startup = observe(client.init())
    await vi.advanceTimersByTimeAsync(0)
    expect(first.connect).toHaveBeenCalledTimes(1)
    await client.close()
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(startup.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })

    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(startup.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    approval.resolve(session('late-approved'))
    await vi.advanceTimersByTimeAsync(0)
    expect(first.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'late-approved' })
    )
    expect(client.currentSession()).toBeUndefined()
  })

  it('disposes a timed-out initializer that returns after fallback is ready', async () => {
    initialize
      .mockImplementationOnce(async () => {
        await release.promise
        return first
      })
      .mockResolvedValue(second)
    const startup = observe(client.init())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(startup.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    expect(client.currentSession()?.topic).toBe('second')

    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(first.core.relayer.transportClose).toHaveBeenCalledTimes(1)
    expect(first.events.listenerCount('session_update')).toBe(0)
    expect(second.core.relayer.transportClose).not.toHaveBeenCalled()
    expect(client.signClient).toBe(second)
    expect(client.currentSession()?.topic).toBe('second')
  })

  it('retains the fallback session when an earlier initializer later rejects', async () => {
    initialize
      .mockImplementationOnce(async () => {
        await release.promise
        throw new Error('Previous relay attempt ended')
      })
      .mockResolvedValue(second)
    const startup = observe(client.init())
    await vi.advanceTimersByTimeAsync(15_000)
    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(startup.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    expect(client.currentSession()?.topic).toBe('second')
    expect(second.core.relayer.transportClose).not.toHaveBeenCalled()
    expect(initialize).toHaveBeenCalledTimes(2)
  })

  it('starts a fresh client after teardown instead of returning while the old relay closes', async () => {
    await client.init()
    first.core.relayer.transportClose.mockImplementationOnce(() => release.promise)
    initialize.mockResolvedValue(second)
    const closing = client.close()
    await vi.advanceTimersByTimeAsync(0)
    const restarting = observe(client.init())
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(restarting.settled).not.toHaveBeenCalled()
    expect.soft(first.connect).not.toHaveBeenCalled()

    release.resolve()
    await closing
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(restarting.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    expect.soft(client.currentSession()?.topic).toBe('second')
    expect.soft(initialize).toHaveBeenCalledTimes(2)
    expect(second.events.listenerCount('session_update')).toBe(1)
    expect(second.core.relayer.transportClose).not.toHaveBeenCalled()
  })

  it('joins repeated client shutdown while its relay close remains pending', async () => {
    await client.init()
    first.core.relayer.transportClose.mockImplementation(() => release.promise)
    const one = observe(client.closeSignClient())
    const two = observe(client.closeSignClient())
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(first.core.relayer.transportClose).toHaveBeenCalledTimes(1)
    expect(one.settled).not.toHaveBeenCalled()
    expect(two.settled).not.toHaveBeenCalled()

    release.resolve()
    await Promise.all([one.outcome, two.outcome])
    expect(one.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    expect(two.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    expect.soft(first.core.heartbeat.stop).toHaveBeenCalledTimes(1)
  })

  it('allows a new startup after relay close rejects', async () => {
    await client.init()
    first.core.relayer.transportClose.mockRejectedValueOnce(new Error('Relay close failed'))
    await client.close()
    initialize.mockResolvedValue(second)
    await client.init()
    expect(client.currentSession()?.topic).toBe('second')
    expect(first.events.listenerCount('session_update')).toBe(0)
    expect(second.events.listenerCount('session_update')).toBe(1)
  })

  it('finishes owned listener cleanup when another resource disposer throws', async () => {
    await client.init()
    first.core.heartbeat.stop.mockImplementationOnce(() => {
      throw new Error('Heartbeat stop failed')
    })
    await observe(client.close()).outcome
    expect.soft(first.events.listenerCount('session_update')).toBe(0)
    initialize.mockResolvedValue(second)
    await client.init()
    expect(client.currentSession()?.topic).toBe('second')
  })

  it('removes its session callbacks without removing another observer', async () => {
    const observer = vi.fn()
    first.on('session_update', observer)
    await client.init()
    expect(first.events.listenerCount('session_update')).toBe(2)
    await client.close()
    await first.events.emit('session_update', { topic: 'first', params: { namespaces: {} } })
    expect.soft(observer).toHaveBeenCalledTimes(1)
    expect.soft(first.events.listenerCount('session_update')).toBe(1)
    expect(client.currentSession()).toBeUndefined()
  })

  it('ignores a provider callback retained from a closed client', async () => {
    await client.init()
    const previousHandler = first.core.relayer.onProviderErrorHandler
    await client.close()
    initialize.mockResolvedValue(second)
    await client.init()
    await previousHandler(new Error('Previous relay reported an error'))
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(client.currentSession()?.topic).toBe('second')
    expect.soft(second.disconnect).not.toHaveBeenCalled()
    expect.soft(second.core.relayer.transportClose).not.toHaveBeenCalled()
  })

  it('closes the current session when its current provider reports an error', async () => {
    await client.init()
    await first.core.relayer.onProviderErrorHandler(new Error('Current relay reported an error'))
    expect(client.currentSession()).toBeUndefined()
    expect(first.disconnect).toHaveBeenCalledTimes(1)
    expect(first.core.relayer.transportClose).toHaveBeenCalledTimes(1)
  })

  it('keeps a later startup independent of an initializer released after stop', async () => {
    initialize
      .mockImplementationOnce(async () => {
        await release.promise
        return first
      })
      .mockResolvedValue(second)
    const previous = observe(client.init())
    await vi.advanceTimersByTimeAsync(0)
    await client.close()
    const current = observe(client.init())
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(previous.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    expect.soft(current.settled).toHaveBeenCalledExactlyOnceWith({ value: undefined })
    expect.soft(initialize).toHaveBeenCalledTimes(2)

    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(client.currentSession()?.topic).toBe('second')
    expect.soft(client.signClient).toBe(second)
    expect.soft(first.core.relayer.transportClose).toHaveBeenCalledTimes(1)
    expect(second.core.relayer.transportClose).not.toHaveBeenCalled()
    expect(current.settled).toHaveBeenCalledTimes(1)
  })
})
