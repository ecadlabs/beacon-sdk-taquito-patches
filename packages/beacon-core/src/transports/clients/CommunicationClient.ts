import { PeerInfoType } from '@ecadlabs/beacon-types'
import {
  convertPublicKeyToX25519,
  convertSecretKeyToX25519,
  getHexHash,
  KeyPair,
  sealCryptobox,
  toHex
} from '@ecadlabs/beacon-utils'
import { clientSessionKeys, serverSessionKeys, SessionKeys } from '@stablelib/x25519-session'
import { ClientEventHandlerMap } from './ClientEvents'
/**
 * @internalapi
 *
 *
 */
export abstract class CommunicationClient {
  constructor(protected keyPair?: KeyPair) {}

  public eventHandlers = new ClientEventHandlerMap()

  // todo move OS
  protected isMobileOS = (): boolean =>
    /(Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet|Windows Phone|SymbianOS|Kindle)/i.test(
      navigator.userAgent
    )

  /**
   * Get the public key
   */
  public async getPublicKey(): Promise<string> {
    const keyPair = this.keyPair
    if (!keyPair) {
      throw new TypeError('Missing key pair')
    }

    return toHex(keyPair.publicKey)
  }

  /**
   * get the public key hash
   */
  public async getPublicKeyHash(): Promise<string> {
    return getHexHash(this.keyPair!.publicKey)
  }

  /**
   * Create a cryptobox server
   *
   * @param otherPublicKey
   * @param selfKeypair
   */
  protected async createCryptoBoxServer(
    otherPublicKey: string,
    selfKeypair: KeyPair
  ): Promise<SessionKeys> {
    return serverSessionKeys(
      {
        publicKey: convertPublicKeyToX25519(selfKeypair.publicKey),
        secretKey: convertSecretKeyToX25519(selfKeypair.secretKey)
      },
      convertPublicKeyToX25519(Buffer.from(otherPublicKey, 'hex'))
    )
  }

  /**
   * Create a cryptobox client
   *
   * @param otherPublicKey
   * @param selfKeypair
   */
  protected async createCryptoBoxClient(
    otherPublicKey: string,
    selfKeypair: KeyPair
  ): Promise<SessionKeys> {
    return clientSessionKeys(
      {
        publicKey: convertPublicKeyToX25519(selfKeypair.publicKey),
        secretKey: convertSecretKeyToX25519(selfKeypair.secretKey)
      },
      convertPublicKeyToX25519(Buffer.from(otherPublicKey, 'hex'))
    )
  }

  /**
   * Encrypt a message for a specific publicKey (receiver, asymmetric)
   *
   * @param recipientPublicKey
   * @param message
   */
  protected async encryptMessageAsymmetric(
    recipientPublicKey: string,
    message: string
  ): Promise<string> {
    return sealCryptobox(message, Buffer.from(recipientPublicKey, 'hex'))
  }

  abstract unsubscribeFromEncryptedMessages(): Promise<void>
  abstract unsubscribeFromEncryptedMessage(senderPublicKey: string): Promise<void>
  // abstract send(message: string, recipient?: string): Promise<void>
  public abstract sendMessage(message: string, peer?: PeerInfoType): Promise<void>
}
