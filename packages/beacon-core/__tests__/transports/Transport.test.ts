import {
  BeaconMessageType,
  ConnectionContext,
  Origin,
  PeerInfo,
  PeerInfoType,
  StorageKey
} from '@ecadlabs/beacon-types'
import { Client } from '../../src/clients/client/Client'
import { ClientOptions } from '../../src/clients/client/ClientOptions'
import { PeerManager } from '../../src/managers/PeerManager'
import { windowRef } from '../../src/MockWindow'
import { Serializer } from '../../src/Serializer'
import { LocalStorage } from '../../src/storage/LocalStorage'
import { Transport } from '../../src/transports/Transport'
import { CommunicationClient } from '../../src/transports/clients/CommunicationClient'

const mockLoggerWarn = jest.fn()

jest.mock('../../src/utils/Logger', () => ({
  Logger: class {
    constructor(_name: string) {}
    debug() {}
    error() {}
    log() {}
    time() {}
    timeLog() {}
    warn(...args: unknown[]) {
      mockLoggerWarn(...args)
    }
  }
}))

class TestCommunicationClient extends CommunicationClient {
  constructor(private readonly sendMessageMock: jest.Mock<Promise<void>, [string, PeerInfoType?]>) {
    super()
  }

  async unsubscribeFromEncryptedMessages(): Promise<void> {}

  async unsubscribeFromEncryptedMessage(_senderPublicKey: string): Promise<void> {}

  sendMessage(message: string, peer?: PeerInfoType): Promise<void> {
    return this.sendMessageMock(message, peer)
  }
}

class TestTransport extends Transport<
  PeerInfo,
  StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP,
  TestCommunicationClient
> {
  async listen(_publicKey: string): Promise<void> {}

  deliver(message: string, context: ConnectionContext): Promise<void> {
    return this.notifyListeners(message, context)
  }
}

class TestClient extends Client {
  constructor(config: ClientOptions, handler: Client['handleResponse']) {
    super(config)
    this.handleResponse = handler
  }

  protected async initSDK(): Promise<void> {}

  register(transport: TestTransport): Promise<void> {
    return this.addListener(transport)
  }
}

describe('Transport', () => {
  beforeEach(() => {
    mockLoggerWarn.mockClear()
  })

  it('continues broadcast sends when one peer rejects', async () => {
    const peers: PeerInfo[] = [
      createPeer('peer-1'),
      createPeer('peer-2'),
      createPeer('peer-3')
    ]
    const rejection = new Error('peer-2 failed')
    const sendMessage = jest.fn((message: string, peer?: PeerInfoType) => {
      if (peer?.publicKey === 'peer-2') {
        return Promise.reject(rejection)
      }

      return Promise.resolve()
    })
    const peerManager = {
      getPeers: jest.fn().mockResolvedValue(peers),
      addPeer: jest.fn(),
      removePeer: jest.fn(),
      removeAllPeers: jest.fn()
    } as unknown as PeerManager<StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP>
    const transport = new TestTransport(
      'test-transport',
      new TestCommunicationClient(sendMessage),
      peerManager
    )

    await expect(transport.send('broadcast-message')).resolves.toBeUndefined()

    expect(sendMessage).toHaveBeenCalledTimes(3)
    expect(mockLoggerWarn).toHaveBeenCalledWith('Transport.send broadcast', rejection)
  })

  it('awaits Client.handleResponse before resolving transport notification delivery', async () => {
    ;(windowRef as any).beaconCreatedClientInstance = false
    const storage = new LocalStorage('client-handle-response-await')
    const peerManager = new PeerManager(storage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
    const transport = new TestTransport(
      'test-transport',
      new TestCommunicationClient(jest.fn().mockResolvedValue(undefined)),
      peerManager
    )
    let releaseHandler!: () => void
    let handlerCompleted = false
    const handler = jest.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseHandler = resolve
      })
      handlerCompleted = true
    })
    const client = new TestClient({ name: 'test', storage }, handler)
    const context: ConnectionContext = { origin: Origin.EXTENSION, id: 'extension' }
    const message = {
      id: 'request',
      version: '2',
      senderId: 'sender',
      type: BeaconMessageType.Disconnect
    }
    const deserializeSpy = jest
      .spyOn(Serializer.prototype, 'deserialize')
      .mockResolvedValue(message)

    try {
      await client.register(transport)
      const deliveryPromise = transport.deliver('serialized-message', context)
      for (let i = 0; i < 10 && !releaseHandler; i++) {
        await Promise.resolve()
      }
      expect(releaseHandler).toBeDefined()
      expect(handlerCompleted).toBe(false)

      releaseHandler()
      await deliveryPromise
      expect(handlerCompleted).toBe(true)
    } finally {
      deserializeSpy.mockRestore()
      ;(windowRef as any).beaconCreatedClientInstance = false
    }
  })
})

function createPeer(publicKey: string): PeerInfo {
  return {
    id: publicKey,
    name: publicKey,
    type: 'test',
    publicKey,
    version: '1'
  }
}
