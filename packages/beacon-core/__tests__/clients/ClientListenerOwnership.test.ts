import { setImmediate } from 'node:timers/promises'
import {
  BeaconMessageType,
  ConnectionContext,
  Origin,
  PeerInfo,
  StorageKey,
  TransportType
} from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { Client } from '../../src/clients/client/Client'
import { windowRef } from '../../src/MockWindow'
import { PeerManager } from '../../src/managers/PeerManager'
import { Serializer } from '../../src/Serializer'
import { LocalStorage } from '../../src/storage/LocalStorage'
import { Transport } from '../../src/transports/Transport'
import { CommunicationClient } from '../../src/transports/clients/CommunicationClient'

class ListenerCommunicationClient extends CommunicationClient {
  public async unsubscribeFromEncryptedMessages(): Promise<void> {}
  public async unsubscribeFromEncryptedMessage(_publicKey: string): Promise<void> {}
  public async sendMessage(): Promise<void> {}
}

class ListenerTransport extends Transport<
  PeerInfo,
  StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP,
  ListenerCommunicationClient
> {
  public readonly type: TransportType

  constructor(storage: LocalStorage, type = TransportType.POST_MESSAGE) {
    super(
      'listener-owner',
      new ListenerCommunicationClient(),
      new PeerManager(storage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
    )
    this.type = type
  }

  public async listen(_publicKey: string): Promise<void> {}

  public deliver(message: string, context: ConnectionContext): Promise<void> {
    return this.notifyListeners(message, context)
  }
}

class ListenerClient extends Client {
  constructor(storage: LocalStorage, handler: Client['handleResponse']) {
    super({ name: 'listener-owner', storage })
    this.handleResponse = handler
  }

  protected async initSDK(): Promise<void> {}

  public register(transport: ListenerTransport): Promise<void> {
    return this.addListener(transport)
  }

  public clear(transports?: ListenerTransport[]): Promise<void> {
    return this.cleanup(transports)
  }
}

describe('Client listener ownership', () => {
  const context: ConnectionContext = { origin: Origin.EXTENSION, id: 'current-peer' }
  const message = {
    id: 'current-message',
    version: '2',
    senderId: 'current-sender',
    type: BeaconMessageType.Disconnect
  }

  beforeEach(() => {
    windowRef.beaconCreatedClientInstance = false
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    windowRef.beaconCreatedClientInstance = false
    localStorage.clear()
  })

  async function setup() {
    const storage = new LocalStorage('client-listener-ownership')
    const handler = vi.fn(async () => undefined)
    const client = new ListenerClient(storage, handler)
    const first = new ListenerTransport(storage)
    const second = new ListenerTransport(storage)
    const wire = await new Serializer().serialize(message)
    return { storage, handler, client, first, second, wire }
  }

  it('moves its subscription to a replacement instance without removing another observer', async () => {
    const { client, handler, first, second, wire } = await setup()
    const otherObserver = vi.fn()
    await first.addListener(otherObserver)
    await client.register(first)
    await client.register(second)
    try {
      await first.deliver(wire, context)
      const previousDeliveries = handler.mock.calls.length
      await second.deliver(wire, context)

      expect(previousDeliveries).toBe(0)
      expect(handler).toHaveBeenCalledExactlyOnceWith(message, context)
      expect(otherObserver).toHaveBeenCalledExactlyOnceWith(wire, context)
    } finally {
      await client.clear([first, second])
    }
  })

  it('keeps a replacement subscription owned when previous cleanup completes later', async () => {
    const { client, handler, first, second, wire } = await setup()
    await client.register(first)
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    const remove = first.removeListener.bind(first)
    vi.spyOn(first, 'removeListener').mockImplementationOnce(async (listener) => {
      entered.resolve()
      await release.promise
      await remove(listener)
    })
    const cleanup = client.clear([first])
    await entered.promise
    const replacement = client.register(second)
    try {
      await setImmediate()
      release.resolve()
      await Promise.all([cleanup, replacement])
      await second.deliver(wire, context)
      expect(handler).toHaveBeenCalledTimes(1)

      await client.clear([second])
      await second.deliver(wire, context)
      expect(handler).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve()
      await Promise.allSettled([cleanup, replacement])
      await client.clear([first, second])
    }
  })

  it('cleans all owned instances while retaining independent observers', async () => {
    const { storage, client, handler, first, wire } = await setup()
    const second = new ListenerTransport(storage, TransportType.P2P)
    const firstObserver = vi.fn()
    const secondObserver = vi.fn()
    await first.addListener(firstObserver)
    await second.addListener(secondObserver)
    await client.init(first)
    await client.register(first)
    await client.register(second)

    await client.clear()
    await first.deliver(wire, context)
    await second.deliver(wire, context)

    expect(handler).not.toHaveBeenCalled()
    expect(firstObserver).toHaveBeenCalledExactlyOnceWith(wire, context)
    expect(secondObserver).toHaveBeenCalledExactlyOnceWith(wire, context)
  })

  it.each(['completion', 'rejection'])(
    'retires in-flight delivery before listener removal reports %s',
    async (outcome) => {
      const { client, handler, first, wire } = await setup()
      const otherObserver = vi.fn()
      await first.addListener(otherObserver)
      await client.register(first)
      const entered = new ExposedPromise<void>()
      const release = new ExposedPromise<void>()
      const removalEntered = new ExposedPromise<void>()
      const removalRelease = new ExposedPromise<void>()
      const failure = new Error('Listener removal failed')
      const deserialize = Serializer.prototype.deserialize
      vi.spyOn(Serializer.prototype, 'deserialize').mockImplementationOnce(async (encoded) => {
        entered.resolve()
        await release.promise
        return deserialize.call(new Serializer(), encoded)
      })
      const remove = first.removeListener.bind(first)
      vi.spyOn(first, 'removeListener').mockImplementationOnce(async (listener) => {
        removalEntered.resolve()
        await removalRelease.promise
        if (outcome === 'rejection') throw failure
        await remove(listener)
      })
      const delivery = first.deliver(wire, context)
      await entered.promise
      let cleanupFailure: unknown
      const cleanup = client.clear([first]).catch((error: unknown) => {
        cleanupFailure = error
      })
      await removalEntered.promise
      try {
        release.resolve()
        await delivery
        const deliveriesDuringRemoval = handler.mock.calls.length
        removalRelease.resolve()
        await cleanup
        await first.deliver(wire, context)

        expect(deliveriesDuringRemoval).toBe(0)
        expect(handler).not.toHaveBeenCalled()
        expect(cleanupFailure).toBe(outcome === 'rejection' ? failure : undefined)
        expect(otherObserver).toHaveBeenCalledTimes(2)
        expect(otherObserver).toHaveBeenLastCalledWith(wire, context)
      } finally {
        release.resolve()
        removalRelease.resolve()
        await Promise.all([delivery, cleanup])
        await client.clear([first]).catch(() => undefined)
      }
    }
  )

  it('finishes scoped cleanup without waiting for an unrelated registration', async () => {
    const { storage, client, handler, first, wire } = await setup()
    const second = new ListenerTransport(storage, TransportType.P2P)
    await client.register(first)
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    const add = second.addListener.bind(second)
    vi.spyOn(second, 'addListener').mockImplementationOnce(async (listener) => {
      entered.resolve()
      await release.promise
      await add(listener)
    })
    const registration = client.register(second)
    await entered.promise
    let cleanupFinished = false
    const cleanup = client.clear([first]).then(() => {
      cleanupFinished = true
    })
    try {
      await setImmediate()
      const finishedBeforeRelease = cleanupFinished
      release.resolve()
      await Promise.all([cleanup, registration])
      await first.deliver(wire, context)
      const previousDeliveries = handler.mock.calls.length
      await second.deliver(wire, context)

      expect(finishedBeforeRelease).toBe(true)
      expect(previousDeliveries).toBe(0)
      expect(handler).toHaveBeenCalledExactlyOnceWith(message, context)
    } finally {
      release.resolve()
      await Promise.allSettled([cleanup, registration])
      await client.clear([first, second])
    }
  })
})
