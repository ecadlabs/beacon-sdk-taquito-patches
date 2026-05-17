import { PeerInfo, PeerInfoType, StorageKey } from '@ecadlabs/beacon-types'
import { PeerManager } from '../../src/managers/PeerManager'
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
