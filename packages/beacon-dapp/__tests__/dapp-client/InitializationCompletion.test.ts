import { CommunicationClient, LocalStorage, PeerManager, Transport } from '@ecadlabs/beacon-core'
import {
  BeaconErrorType,
  PeerInfoType,
  StorageKey,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { BeaconEvent } from '../../src/events'

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  MultiTabChannel: class {
    async init() {}
    isLeader() {
      return true
    }
    async hasLeader() {
      return true
    }
    async getLeadership() {}
    postMessage() {}
    async close() {}
  }
}))

class ControlledClient extends CommunicationClient {
  async sendMessage(): Promise<void> {}
  async unsubscribeFromEncryptedMessages(): Promise<void> {}
  async unsubscribeFromEncryptedMessage(): Promise<void> {}
}

class ControlledTransport extends Transport<
  PeerInfoType,
  StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP,
  ControlledClient
> {
  constructor(
    storage: LocalStorage,
    public readonly type = TransportType.POST_MESSAGE
  ) {
    super(
      'Initialization completion',
      new ControlledClient(),
      new PeerManager(storage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
    )
  }
  async listen(): Promise<void> {}
}

describe('DApp initialization completion', () => {
  let dapp: DAppClient
  let storage: LocalStorage
  let transport: ControlledTransport
  const changed = vi.fn()
  const paired = vi.fn()
  const releases: ExposedPromise<void>[] = []

  beforeEach(async () => {
    vi.useFakeTimers()
    localStorage.clear()
    Object.defineProperty(window, 'beaconCreatedClientInstance', {
      value: false,
      writable: true,
      configurable: true
    })
    storage = new LocalStorage('initialization-completion')
    transport = new ControlledTransport(storage)
    dapp = new DAppClient({
      name: 'Initialization completion',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false
    })
    await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    await dapp.subscribeToEvent(BeaconEvent.ACTIVE_TRANSPORT_SET, changed)
    await dapp.subscribeToEvent(BeaconEvent.PAIR_SUCCESS, paired)
    await dapp.getActiveAccount()
    await vi.advanceTimersByTimeAsync(0)
    vi.clearAllMocks()
  })

  afterEach(async () => {
    for (const release of releases.splice(0)) release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await dapp.destroy()
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  function hold() {
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    releases.push(release)
    return {
      entered: entered.promise,
      release: () => release.resolve(),
      wait: async () => {
        entered.resolve()
        await release.promise
      }
    }
  }

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
    return { outcome, settled }
  }

  it('shares supplied transport registration and leaves connection to the caller', async () => {
    const registration = hold()
    const addListener = transport.addListener.bind(transport)
    const added = vi.spyOn(transport, 'addListener').mockImplementation(async (listener) => {
      await registration.wait()
      await addListener(listener)
    })
    const connected = vi.spyOn(transport, 'connect')
    const first = observe(dapp.init(transport))
    await registration.entered
    const second = observe(dapp.init(transport))
    await vi.advanceTimersByTimeAsync(0)
    expect(first.settled).not.toHaveBeenCalled()
    expect(second.settled).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()

    registration.release()
    await expect(first.outcome).resolves.toEqual({ value: TransportType.POST_MESSAGE })
    await expect(second.outcome).resolves.toEqual({ value: TransportType.POST_MESSAGE })
    expect(added).toHaveBeenCalledTimes(1)
    expect(connected).not.toHaveBeenCalled()
    expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ type: transport.type }),
      undefined
    )
    expect(paired).not.toHaveBeenCalled()
  })

  it.each(['disconnect', 'destroy'])(
    'settles registration waiters on %s before registration returns',
    async (action) => {
      const registration = hold()
      const addListener = transport.addListener.bind(transport)
      vi.spyOn(transport, 'addListener').mockImplementation(async (listener) => {
        await registration.wait()
        await addListener(listener)
      })
      const first = observe(dapp.init(transport))
      await registration.entered
      const second = observe(dapp.init(transport))
      const teardown =
        action === 'disconnect' ? dapp.disconnect({ notifyPeers: false }) : dapp.destroy()
      await vi.advanceTimersByTimeAsync(0)
      expect(first.settled).toHaveBeenCalledWith({
        error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
      })
      expect(second.settled).toHaveBeenCalledWith({
        error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
      })
      await Promise.all([first.outcome, second.outcome])
      registration.release()
      await teardown
      await vi.advanceTimersByTimeAsync(0)
      expect(changed.mock.calls.some(([selected]) => selected !== undefined)).toBe(false)
      expect(paired).not.toHaveBeenCalled()
      if (action === 'destroy') {
        await expect(dapp.init(transport)).rejects.toThrow('destroyed')
      } else {
        const replacement = new ControlledTransport(storage, TransportType.P2P)
        await expect(dapp.init(replacement)).resolves.toBe(TransportType.P2P)
        expect(changed).toHaveBeenLastCalledWith(
          expect.objectContaining({ type: TransportType.P2P }),
          undefined
        )
      }
    }
  )

  it('retries supplied registration after all shared callers receive its failure', async () => {
    const registration = hold()
    const failure = new Error('Listener registration failed')
    const added = vi.spyOn(transport, 'addListener').mockImplementationOnce(async () => {
      await registration.wait()
      throw failure
    })
    const first = observe(dapp.init(transport))
    await registration.entered
    const second = observe(dapp.init(transport))
    registration.release()
    await expect(first.outcome).resolves.toEqual({ error: failure })
    await expect(second.outcome).resolves.toEqual({ error: failure })
    expect(changed).not.toHaveBeenCalled()
    await expect(dapp.init(transport)).resolves.toBe(TransportType.POST_MESSAGE)
    expect(added).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('retries a selected transport connection after shared initialization fails', async () => {
    // Account restoration can select a transport before the first public init call.
    await dapp['setTransport'](transport)
    changed.mockClear()
    const connection = hold()
    const failure = new Error('Transport connection failed')
    const connected = vi.spyOn(transport, 'connect').mockImplementationOnce(async () => {
      await connection.wait()
      throw failure
    })
    const first = observe(dapp.init())
    await connection.entered
    const second = observe(dapp.init())
    connection.release()
    await expect(first.outcome).resolves.toEqual({ error: failure })
    await expect(second.outcome).resolves.toEqual({ error: failure })
    await expect(dapp.init()).resolves.toBe(TransportType.POST_MESSAGE)
    expect(connected).toHaveBeenCalledTimes(2)
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    expect(changed).not.toHaveBeenCalled()
    expect(paired).not.toHaveBeenCalled()
  })

  it.each(['peer removal', 'transport shutdown'])(
    'waits for %s before initializing a replacement',
    async (stage) => {
      await transport.connect()
      await dapp.init(transport)
      const cleanup = hold()
      if (stage === 'peer removal') {
        const removeAllPeers = transport.removeAllPeers.bind(transport)
        vi.spyOn(transport, 'removeAllPeers').mockImplementationOnce(async () => {
          await cleanup.wait()
          await removeAllPeers()
        })
      } else {
        const disconnect = transport.disconnect.bind(transport)
        vi.spyOn(transport, 'disconnect').mockImplementationOnce(async () => {
          await cleanup.wait()
          await disconnect()
        })
      }
      const teardown = dapp.disconnect({ notifyPeers: false })
      await cleanup.entered
      changed.mockClear()
      const replacement = new ControlledTransport(storage, TransportType.P2P)
      const registered = vi.spyOn(replacement, 'addListener')
      const first = observe(dapp.init(replacement))
      const second = observe(dapp.init(replacement))
      await vi.advanceTimersByTimeAsync(0)
      expect(first.settled).not.toHaveBeenCalled()
      expect(second.settled).not.toHaveBeenCalled()
      expect(registered).not.toHaveBeenCalled()
      expect(changed.mock.calls.some(([selected]) => selected !== undefined)).toBe(false)

      cleanup.release()
      await teardown
      await expect(first.outcome).resolves.toEqual({ value: TransportType.P2P })
      await expect(second.outcome).resolves.toEqual({ value: TransportType.P2P })
      expect(registered).toHaveBeenCalledTimes(1)
      expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: TransportType.P2P }),
        undefined
      )
      await expect(dapp.init()).resolves.toBe(TransportType.P2P)
      expect(paired).not.toHaveBeenCalled()
    }
  )

  it('allows replacement initialization after a transport shutdown failure is handled', async () => {
    await transport.connect()
    await dapp.init(transport)
    vi.spyOn(transport, 'disconnect').mockRejectedValueOnce(new Error('Transport shutdown failed'))
    await expect(dapp.disconnect({ notifyPeers: false })).resolves.toBeUndefined()
    const replacement = new ControlledTransport(storage, TransportType.P2P)
    await expect(dapp.init(replacement)).resolves.toBe(TransportType.P2P)
    await expect(dapp.init()).resolves.toBe(TransportType.P2P)
    expect(paired).not.toHaveBeenCalled()
  })

  it('rejects initialization waiting for teardown when the client is destroyed', async () => {
    await transport.connect()
    await dapp.init(transport)
    const cleanup = hold()
    const disconnect = transport.disconnect.bind(transport)
    vi.spyOn(transport, 'disconnect').mockImplementationOnce(async () => {
      await cleanup.wait()
      await disconnect()
    })
    const teardown = observe(dapp.disconnect({ notifyPeers: false }))
    await cleanup.entered
    changed.mockClear()
    const replacement = new ControlledTransport(storage, TransportType.P2P)
    const registered = vi.spyOn(replacement, 'addListener')
    const first = observe(dapp.init(replacement))
    const second = observe(dapp.init(replacement))
    await vi.advanceTimersByTimeAsync(0)
    const destruction = observe(dapp.destroy())
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(first.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.anything() })
    expect.soft(second.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.anything() })
    expect.soft(registered).not.toHaveBeenCalled()
    expect.soft(changed.mock.calls.some(([selected]) => selected !== undefined)).toBe(false)

    cleanup.release()
    await teardown.outcome
    await destruction.outcome
    await vi.advanceTimersByTimeAsync(0)
    expect(first.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.anything() })
    expect(second.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.anything() })
    expect(registered).not.toHaveBeenCalled()
    expect(changed.mock.calls.some(([selected]) => selected !== undefined)).toBe(false)
    expect(paired).not.toHaveBeenCalled()
    await expect(dapp.init(replacement)).rejects.toThrow('destroyed')
  })
})
