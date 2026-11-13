import {
  PostMessagePairingRequest,
  ExtendedPostMessagePairingResponse,
  Extension,
  isExtension,
  StorageKey,
  TransportType,
  ExtensionMessage,
  ExtensionMessageTarget,
  TransportStatus,
  ConnectionContext,
  Origin,
  Storage
} from '@ecadlabs/beacon-types'
import {
  PendingPairingRequests,
  Transport,
  PeerManager,
  Logger,
  windowRef
} from '@ecadlabs/beacon-core'
import { KeyPair } from '@ecadlabs/beacon-utils'
import { PostMessageClient } from './PostMessageClient'

const logger = new Logger('PostMessageTransport')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

let listeningForExtensions: boolean = false
let extensionsPromise: Promise<Extension[]> | undefined
let extensions: Extension[] | undefined

const addExtension = (extension: Extension): void => {
  if (!extensions) {
    extensions = []
  }

  if (!extensions.some((ext) => ext.id === extension.id)) {
    extensions.push(extension)
    windowRef.postMessage('extensionsUpdated', windowRef.location.origin)
  }
}

/**
 * @internalapi
 *
 *
 */
export class PostMessageTransport<
  T extends PostMessagePairingRequest | ExtendedPostMessagePairingResponse,
  K extends
    StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP | StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET
> extends Transport<T, K, PostMessageClient> {
  protected connectionGeneration = 0

  public readonly type: TransportType = TransportType.POST_MESSAGE

  constructor(
    name: string,
    keyPair: KeyPair,
    storage: Storage,
    storageKey: K,
    pendingPairings?: PendingPairingRequests
  ) {
    super(
      name,
      new PostMessageClient(name, keyPair, pendingPairings),
      new PeerManager<K>(storage, storageKey)
    )
  }

  public static async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const fn = (event: unknown): void => {
        if (!isRecord(event)) {
          return
        }

        const data = event.data
        if (isRecord(data) && data.payload === 'pong') {
          // The timer is created before this listener is registered.
          // eslint-disable-next-line @typescript-eslint/no-use-before-define
          clearTimeout(timeout)
          windowRef.removeEventListener('message', fn)
          resolve(true)
        }
      }

      const timeout = setTimeout(() => {
        windowRef.removeEventListener('message', fn)
        resolve(false)
      }, 500)

      windowRef.addEventListener('message', fn)

      const message: ExtensionMessage<string> = {
        target: ExtensionMessageTarget.EXTENSION,
        payload: 'ping'
      }
      windowRef.postMessage(message, windowRef.location.origin)
    })
  }

  public static async getAvailableExtensions(): Promise<Extension[]> {
    if (extensionsPromise) {
      return extensionsPromise
    }

    if (extensions) {
      return extensions
    }

    extensions = []
    extensionsPromise = new Promise<Extension[]>((resolve) => {
      PostMessageTransport.listenForExtensions()

      setTimeout(() => {
        resolve(extensions ?? [])
      }, 1000)
    }).finally(() => {
      extensionsPromise = undefined
    })

    return extensionsPromise
  }

  private static listenForExtensions(): void {
    if (listeningForExtensions) {
      return
    }

    const fn = (event: unknown): void => {
      if (
        !isRecord(event) ||
        event.source !== windowRef ||
        event.origin !== windowRef.location.origin
      ) {
        // TODO: Add to error handler: console.debug('[Beacon]: Event received from untrusted origin')
        return
      }

      const data = event.data
      if (!isRecord(data) || data.payload !== 'pong' || !isExtension(data.sender)) {
        return
      }

      const sender = data.sender
      logger.log('getAvailableExtensions', `extension "${sender.name}" is available`, sender)
      addExtension(sender)
    }

    windowRef.addEventListener('message', fn)

    const message: ExtensionMessage<string> = {
      target: ExtensionMessageTarget.EXTENSION,
      payload: 'ping'
    }
    windowRef.postMessage(message, windowRef.location.origin)

    listeningForExtensions = true
  }

  public async connect(): Promise<void> {
    logger.log('connect')
    if (this._isConnected !== TransportStatus.NOT_CONNECTED) {
      return
    }

    this._isConnected = TransportStatus.CONNECTING
    const generation = ++this.connectionGeneration

    try {
      await this.client.init()
      const knownPeers = await this.getPeers()
      if (generation !== this.connectionGeneration) {
        return
      }

      if (knownPeers.length > 0) {
        logger.log('connect', `connecting to ${knownPeers.length} peers`)
        const registrations = await Promise.allSettled(
          knownPeers.map((peer) => this.listen(peer.publicKey))
        )
        for (const registration of registrations) {
          if (registration.status === 'rejected') {
            throw registration.reason
          }
        }
      }

      if (generation !== this.connectionGeneration) {
        return
      }
      await this.startOpenChannelListener()
      if (generation === this.connectionGeneration) {
        await super.connect()
      }
    } catch (error) {
      if (generation === this.connectionGeneration) {
        await this.client.unsubscribeFromEncryptedMessages().catch((cleanupError) => {
          logger.error('connect', 'failed to clear extension listeners', cleanupError)
        })
        if (generation === this.connectionGeneration) {
          this._isConnected = TransportStatus.NOT_CONNECTED
        }
      }
      throw error
    }
  }

  public async disconnect(): Promise<void> {
    ++this.connectionGeneration
    this.newPeerListener = undefined
    try {
      // Retire listeners immediately while pending peer writes finish rolling back.
      await Promise.all([
        this.client.cancelPairingRequests(),
        this.client.unsubscribeFromEncryptedMessages()
      ])
    } finally {
      await super.disconnect()
    }
  }

  public async startOpenChannelListener(): Promise<void> {
    //
  }

  public async getPairingRequestInfo(): Promise<PostMessagePairingRequest> {
    return this.client.getPairingRequestInfo()
  }

  public async listen(publicKey: string): Promise<void> {
    logger.log('listen', publicKey)

    await this.client.listenForEncryptedMessage(
      publicKey,
      (message: string, context: ConnectionContext) => {
        const connectionContext: ConnectionContext = {
          origin: Origin.EXTENSION,
          id: context.id
        }

        return this.notifyListeners(message, connectionContext)
      }
    )
  }
}
