import type { Mock } from 'vitest'
import { Origin, PeerInfo, PeerInfoType, StorageKey } from '@ecadlabs/beacon-types'
import { PeerManager } from '../../src/managers/PeerManager'
import { Transport } from '../../src/transports/Transport'
import { CommunicationClient } from '../../src/transports/clients/CommunicationClient'

const mockLoggerWarn = vi.fn()

vi.mock('../../src/utils/Logger', () => ({
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
  constructor(
    private readonly sendMessageMock: Mock<(...args: [string, PeerInfoType?]) => Promise<void>>
  ) {
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

  public notify(message: string): Promise<void> {
    return this.notifyListeners(message, { origin: Origin.P2P, id: 'peer' })
  }
}

describe('Transport', () => {
  beforeEach(() => {
    mockLoggerWarn.mockClear()
  })

  it('continues broadcast sends when one peer rejects', async () => {
    const peers: PeerInfo[] = [createPeer('peer-1'), createPeer('peer-2'), createPeer('peer-3')]
    const rejection = new Error('peer-2 failed')
    const sendMessage = vi.fn((message: string, peer?: PeerInfoType) => {
      if (peer?.publicKey === 'peer-2') {
        return Promise.reject(rejection)
      }

      return Promise.resolve()
    })
    const peerManager = {
      getPeers: vi.fn().mockResolvedValue(peers),
      addPeer: vi.fn(),
      removePeer: vi.fn(),
      removeAllPeers: vi.fn()
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
  it('waits for asynchronous message listeners before completing notification', async () => {
    let finish!: () => void
    const processing = new Promise<void>((resolve) => {
      finish = resolve
    })
    const transport = new TestTransport(
      'test-transport',
      new TestCommunicationClient(vi.fn().mockResolvedValue(undefined)),
      {} as PeerManager<StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP>
    )
    await transport.addListener(() => processing)

    const notification = transport.notify('message')
    let completed = false
    notification.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)

    finish()
    await expect(notification).resolves.toBeUndefined()
    expect(completed).toBe(true)
  })

  it('rejects failed notifications without skipping other listeners', async () => {
    const failure = new Error('handler failed')
    const nextListener = vi.fn()
    const transport = new TestTransport(
      'test-transport',
      new TestCommunicationClient(vi.fn().mockResolvedValue(undefined)),
      {} as PeerManager<StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP>
    )
    await transport.addListener(async () => {
      throw failure
    })
    await transport.addListener(nextListener)

    await expect(transport.notify('message')).rejects.toBe(failure)
    expect(nextListener).toHaveBeenCalledTimes(1)
  })

  it('also dispatches remaining listeners when the first throws synchronously', async () => {
    const failure = new Error('handler threw')
    const nextListener = vi.fn()
    const transport = new TestTransport(
      'test-transport',
      new TestCommunicationClient(vi.fn().mockResolvedValue(undefined)),
      {} as PeerManager<StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP>
    )
    await transport.addListener(() => {
      throw failure
    })
    await transport.addListener(nextListener)

    await expect(transport.notify('message')).rejects.toBe(failure)
    expect(nextListener).toHaveBeenCalledTimes(1)
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
