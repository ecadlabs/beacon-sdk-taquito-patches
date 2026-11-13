import { CommunicationClient, MessageBasedClient } from '../../src'

class TestCommunicationClient extends CommunicationClient {
  public async sendMessage(_message: string): Promise<void> {}
  public async unsubscribeFromEncryptedMessage(_senderPublicKey: string): Promise<void> {}
  public async unsubscribeFromEncryptedMessages(): Promise<void> {}
}

describe('CommunicationClient public key', () => {
  it('rejects when no key pair is available', async () => {
    const client = new TestCommunicationClient()
    await expect(client.getPublicKey()).rejects.toThrow(new TypeError('Missing key pair'))
  })
})

describe('CommunicationClient public key hash', () => {
  it('rejects when no key pair is available', async () => {
    const client = new TestCommunicationClient()
    await expect(client.getPublicKeyHash()).rejects.toThrow(new TypeError('Missing key pair'))
  })
})

class TestMessageBasedClient extends MessageBasedClient {
  protected readonly activeListeners = new Map<string, unknown>()

  public async init(): Promise<void> {}
  public async sendMessage(_message: string): Promise<void> {}

  public clearKeyPair(): void {
    this.keyPair = undefined
  }

  public encryptMessage(recipientPublicKey: string, message: string): Promise<string> {
    return super.encryptMessage(recipientPublicKey, message)
  }

  public decryptMessage(senderPublicKey: string, payload: string): Promise<string> {
    return super.decryptMessage(senderPublicKey, payload)
  }
}

describe('MessageBasedClient without keys', () => {
  it.each(['encryptMessage', 'decryptMessage'] as const)(
    'rejects %s when a subclass has cleared its key pair',
    async (method) => {
      const client = new TestMessageBasedClient('test', {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64)
      })
      client.clearKeyPair()

      await expect(client[method]('11'.repeat(32), 'message')).rejects.toThrow(
        new TypeError('Missing key pair')
      )
    }
  )
})
