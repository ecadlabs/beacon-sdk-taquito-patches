import {
  Logger,
  PendingPairingRequests,
  windowRef,
  Serializer,
  getSenderId,
  MessageBasedClient
} from '@ecadlabs/beacon-core'

import {
  openCryptobox,
  secretbox_NONCEBYTES,
  secretbox_MACBYTES,
  KeyPair
} from '@ecadlabs/beacon-utils'
import {
  ExtensionMessage,
  ExtensionMessageTarget,
  Origin,
  ConnectionContext,
  ExtendedPostMessagePairingResponse,
  PostMessagePairingResponse,
  EncryptedExtensionMessage,
  PostMessagePairingRequest
} from '@ecadlabs/beacon-types'

const logger = new Logger('PostMessageClient')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isTrustedWindowMessage = (event: unknown): event is { data: unknown } =>
  isRecord(event) &&
  event.source === windowRef &&
  event.origin === windowRef.location.origin &&
  'data' in event

const hasPageTarget = (message: Record<string, unknown>): boolean =>
  message.target === ExtensionMessageTarget.PAGE &&
  (message.targetId === undefined || typeof message.targetId === 'string')

const isPairingMessage = (message: unknown): message is ExtensionMessage<string> =>
  isRecord(message) && hasPageTarget(message) && typeof message.payload === 'string'

const isEncryptedMessage = (message: unknown): message is EncryptedExtensionMessage =>
  isRecord(message) && hasPageTarget(message) && typeof message.encryptedPayload === 'string'

/**
 * @internalapi
 *
 *
 */
export class PostMessageClient extends MessageBasedClient {
  constructor(
    name: string,
    keyPair: KeyPair,
    private readonly pendingPairings = new PendingPairingRequests()
  ) {
    super(name, keyPair)
  }

  public cancelPairingRequests(): Promise<void> {
    return this.pendingPairings.cancel()
  }

  public async getPairingRequestInfo(): Promise<PostMessagePairingRequest> {
    const generation = this.pendingPairings.generation
    const request = await super.getPairingRequestInfo()
    this.pendingPairings.add(request.id, generation)

    return request
  }

  protected readonly activeListeners: Map<
    string,
    (message: EncryptedExtensionMessage, context: ConnectionContext) => Promise<void>
  > = new Map()

  // The base constructor invokes init before subclass field initialization.
  declare private messageListener: ((event: unknown) => void) | undefined
  private channelOpeningListener?: (event: unknown) => Promise<void>
  private channelOpeningCallback?: (
    response: ExtendedPostMessagePairingResponse,
    isActive: () => boolean
  ) => void | Promise<void>

  public async init(): Promise<void> {
    this.subscribeToMessages()
  }

  public async listenForEncryptedMessage(
    senderPublicKey: string,
    messageCallback: (message: string, context: ConnectionContext) => void | Promise<void>
  ): Promise<void> {
    this.subscribeToMessages()
    if (this.activeListeners.has(senderPublicKey)) {
      return
    }

    const callbackFunction = async (
      message: EncryptedExtensionMessage,
      context: ConnectionContext
    ): Promise<void> => {
      let decryptedMessage: string
      try {
        decryptedMessage = await this.decryptMessage(senderPublicKey, message.encryptedPayload)
        const beaconMessage = (
          decryptedMessage.startsWith('{')
            ? JSON.parse(decryptedMessage)
            : await new Serializer().deserialize(decryptedMessage)
        ) as { senderId?: string }
        if (beaconMessage.senderId !== (await getSenderId(senderPublicKey))) {
          return
        }
      } catch {
        // Some messages are encrypted for other recipients.
        return
      }

      if (this.activeListeners.get(senderPublicKey) === callbackFunction) {
        await messageCallback(decryptedMessage, context)
      }
    }

    this.activeListeners.set(senderPublicKey, callbackFunction)
  }

  public async sendMessage(
    message: string,
    peer: PostMessagePairingRequest | ExtendedPostMessagePairingResponse
  ): Promise<void> {
    const payload = await this.encryptMessage(peer.publicKey, message)

    const targetId = (peer as ExtendedPostMessagePairingResponse)?.extensionId

    // if no targetId, we remove peer
    const msg: EncryptedExtensionMessage = {
      target: ExtensionMessageTarget.EXTENSION,
      encryptedPayload: payload,
      targetId
    }

    windowRef.postMessage(msg, windowRef.location.origin)
  }

  public async listenForChannelOpening(
    messageCallback: (
      pairingResponse: ExtendedPostMessagePairingResponse,
      isActive: () => boolean
    ) => void | Promise<void>
  ): Promise<void> {
    this.channelOpeningCallback = messageCallback
    if (this.channelOpeningListener) {
      return
    }
    const fn = async (event: unknown): Promise<void> => {
      if (!isTrustedWindowMessage(event)) {
        return
      }

      const data = event.data
      if (
        !isRecord(data) ||
        !isPairingMessage(data.message) ||
        !isRecord(data.sender) ||
        typeof data.sender.id !== 'string'
      ) {
        return
      }

      const payloadHex = data.message.payload
      const extensionId = data.sender.id
      if (await this.isChannelOpenMessage(data.message)) {
        if (
          payloadHex.length === 0 ||
          payloadHex.length % 2 !== 0 ||
          !/^[0-9a-f]+$/i.test(payloadHex)
        ) {
          return
        }
        const payload = Buffer.from(payloadHex, 'hex')

        if (payload.length >= secretbox_NONCEBYTES + secretbox_MACBYTES) {
          try {
            const pairingResponse: PostMessagePairingResponse = JSON.parse(
              await openCryptobox(payload, this.keyPair!.publicKey, this.keyPair!.secretKey)
            )

            if (
              !pairingResponse ||
              typeof pairingResponse.publicKey !== 'string' ||
              !/^[a-f0-9]{64}$/i.test(pairingResponse.publicKey) ||
              typeof pairingResponse.name !== 'string' ||
              typeof pairingResponse.version !== 'string'
            ) {
              return
            }
            const senderId = await getSenderId(pairingResponse.publicKey)
            if (this.channelOpeningListener !== fn) {
              return
            }
            await this.pendingPairings
              .accept(pairingResponse.id, async (isActive) => {
                if (this.channelOpeningListener !== fn) {
                  return
                }
                await this.channelOpeningCallback?.(
                  new ExtendedPostMessagePairingResponse(
                    pairingResponse.id,
                    pairingResponse.name,
                    pairingResponse.publicKey,
                    pairingResponse.version,
                    senderId,
                    extensionId
                  ),
                  () => this.channelOpeningListener === fn && isActive()
                )
              })
              .catch((error) => logger.error('listenForChannelOpening', error))
          } catch {
            // Some messages are encrypted for other recipients.
          }
        }
      }
    }

    this.channelOpeningListener = fn
    windowRef.addEventListener('message', fn)
  }

  public async sendPairingRequest(id: string): Promise<void> {
    const message: ExtensionMessage<string> = {
      target: ExtensionMessageTarget.EXTENSION,
      payload: await new Serializer().serialize(await this.getPairingRequestInfo()),
      targetId: id
    }
    windowRef.postMessage(message, windowRef.location.origin)
  }

  public async isChannelOpenMessage(message: unknown): Promise<boolean> {
    return (
      typeof message === 'object' &&
      message !== null &&
      Object.prototype.hasOwnProperty.call(message, 'payload')
    )
  }

  private subscribeToMessages(): void {
    if (this.messageListener) {
      return
    }
    this.messageListener = (event: unknown) => {
      if (!isTrustedWindowMessage(event)) {
        return
      }

      const data = event.data
      if (!isRecord(data) || !isEncryptedMessage(data.message) || !isRecord(data.sender)) {
        return
      }

      const senderId = data.sender.id
      if (senderId !== undefined && typeof senderId !== 'string') {
        return
      }

      const message = data.message
      this.activeListeners.forEach((listener) => {
        listener(message, {
          origin: Origin.EXTENSION,
          id: senderId ?? ''
        }).catch((error) => logger.error('subscribeToMessages', error))
      })
    }
    windowRef.addEventListener('message', this.messageListener)
  }

  public async unsubscribeFromEncryptedMessages(): Promise<void> {
    this.activeListeners.clear()
    if (this.messageListener) {
      windowRef.removeEventListener('message', this.messageListener)
      this.messageListener = undefined
    }
    if (this.channelOpeningListener) {
      windowRef.removeEventListener('message', this.channelOpeningListener)
      this.channelOpeningListener = undefined
    }
    this.channelOpeningCallback = undefined
  }
}
