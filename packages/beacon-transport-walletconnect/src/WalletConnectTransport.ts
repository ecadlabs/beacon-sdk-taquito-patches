import {
  ConnectionContext,
  ChangeAccountRequest,
  PermissionResponse,
  Origin,
  Storage,
  TransportStatus,
  ExtendedWalletConnectPairingResponse,
  ExtendedWalletConnectPairingRequest,
  PeerInfo,
  StorageKey,
  WalletConnectPairingRequest,
  NetworkType,
  TransportType
} from '@ecadlabs/beacon-types'
import { Transport, PeerManager, Logger, Serializer } from '@ecadlabs/beacon-core'
import { SignClientTypes } from '@walletconnect/types'
import { ExposedPromise, KeyPair } from '@ecadlabs/beacon-utils'
import { WalletConnectCommunicationClient } from './communication-client/WalletConnectCommunicationClient'

const logger = new Logger('WalletConnectTransport')

type SessionUpdateCallback = (
  message: PermissionResponse | ChangeAccountRequest,
  connectionInfo: ConnectionContext,
  isCurrent: () => boolean
) => Promise<void>

/**
 * @internalapi
 *
 *
 */

export class WalletConnectTransport<
  T extends WalletConnectPairingRequest | ExtendedWalletConnectPairingResponse,
  K extends StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP
> extends Transport<T, K, WalletConnectCommunicationClient> {
  public readonly type: TransportType = TransportType.WALLETCONNECT

  protected isReady = new ExposedPromise<boolean>()
  protected released = false
  protected readonly owner: object
  private releasePromise?: Promise<void>
  private connectionAttempt: object | undefined
  private readonly sessionUpdateCallbacks = new WeakMap<object, SessionUpdateCallback>()

  constructor(
    name: string,
    _keyPair: KeyPair,
    storage: Storage,
    storageKey: K,
    wcOptions: { network: NetworkType; opts: SignClientTypes.Options },
    private readonly isLeader: () => boolean | Promise<boolean>
  ) {
    const owner = {}
    super(
      name,
      WalletConnectCommunicationClient.getInstance(wcOptions, isLeader, owner),
      new PeerManager<K>(storage, storageKey)
    )
    this.owner = owner
  }

  public static async isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }

  public async addListener(
    listener: (message: unknown, connectionInfo: ConnectionContext) => void | Promise<void>,
    sessionUpdateCallback?: SessionUpdateCallback
  ): Promise<void> {
    if (this.released) {
      return
    }
    if (sessionUpdateCallback) {
      this.sessionUpdateCallbacks.set(listener, sessionUpdateCallback)
    }
    await super.addListener(listener)
  }

  public async removeListener(
    listener: (message: string, connectionInfo: ConnectionContext) => void
  ): Promise<void> {
    this.sessionUpdateCallbacks.delete(listener)
    await super.removeListener(listener)
  }

  /**
   * Returns a promise that blocks the execution flow when awaited if the transport hasn't resolved yet; otherwise, it returns true.
   */
  waitForResolution(): Promise<boolean> {
    return this.isReady.promise
  }

  public async connect(): Promise<void> {
    if (
      this.released ||
      [TransportStatus.CONNECTED, TransportStatus.CONNECTING].includes(this._isConnected)
    ) {
      return
    }

    this._isConnected = TransportStatus.CONNECTING
    const attempt = {}
    this.connectionAttempt = attempt

    try {
      const isLeader = await this.isLeader()
      if (this.released) {
        return
      }

      if (isLeader) {
        await this.client.init()
      }
      if (this.released) {
        return
      }

      const knownPeers = await this.getPeers()
      if (this.released) {
        return
      }

      if (knownPeers.length > 0) {
        await Promise.all(knownPeers.map((peer) => this.listen(peer.publicKey)))
      }

      await this.startOpenChannelListener()
      if (this.released) {
        return
      }
      await super.connect()
      if (this.released) {
        await super.disconnect()

        return
      }

      if (!isLeader) {
        this._isConnected = TransportStatus.SECONDARY_TAB_CONNECTED
      }

      this.isReady.resolve(true)
    } catch (error: unknown) {
      if (!this.released && this.connectionAttempt === attempt) {
        // Failed restoration must allow a later connection attempt to run.
        this._isConnected = TransportStatus.NOT_CONNECTED
      }
      throw error
    } finally {
      if (this.connectionAttempt === attempt) {
        this.connectionAttempt = undefined
      }
    }
  }

  wasDisconnectedByWallet() {
    return Boolean(this.client.disconnectionEvents.size)
  }

  closeClient() {
    if (!this.released) {
      this.client.closeSignClient().catch((error: unknown) => logger.warn('closeClient', error))
    }
  }

  public async hasPairings() {
    return (await this.client.storage.hasPairings())
      ? true
      : Boolean(this.client.signClient?.pairing.getAll()?.length)
  }

  public async hasSessions() {
    return (await this.client.storage.hasSessions())
      ? true
      : Boolean(this.client.signClient?.session.getAll()?.length)
  }

  /**
   * Forcefully updates any DApps running on the same session
   * Typical use case: localStorage changes to reflect to indexDB
   * @param type the message type
   */
  public forceUpdate(type: string) {
    if (!this.released) {
      this.client.storage.notify(type)
    }
  }

  public async getPeers(): Promise<T[]> {
    if (this.released) {
      return []
    }
    const session = this.client.currentSession()
    if (!session) {
      return []
    }

    return [
      {
        senderId: session.topic,
        extensionId: session.peer.metadata.name,
        id: session.peer.publicKey,
        type: 'walletconnect-pairing-response',
        name: session.peer.metadata.name,
        publicKey: session.peer.publicKey,
        version: 'first'
      } as T
    ]
  }

  public async send(message: string, peer?: PeerInfo): Promise<void> {
    if (this.released) {
      throw new Error('WalletConnect transport has been released.')
    }
    await super.send(message, peer)
  }

  /** @internal Release adapter ownership when a public request finishes or expires. */
  public cancelRequest(id: string): void {
    if (!this.released) {
      this.client.cancelRequest(id)
    }
  }

  public async disconnect(): Promise<void> {
    this.connectionAttempt = undefined
    if (this.released) {
      return
    }
    await this.client.close()

    await super.disconnect()

    this.isReady = new ExposedPromise()
  }

  /** @internal Retire this adapter without closing a session owned by another adapter. */
  public release(closeSession = true): Promise<void> {
    if (!this.releasePromise) {
      this.connectionAttempt = undefined
      this.released = true
      this.newPeerListener = undefined
      this.releasePromise = this.client.releaseOwner(this.owner, closeSession).finally(async () => {
        await super.disconnect()
        this.isReady = new ExposedPromise()
      })
    }

    return this.releasePromise
  }

  public async startOpenChannelListener(): Promise<void> {
    //
  }

  async doClientCleanup() {
    if (!this.released) {
      await this.client.unsubscribeFromEncryptedMessages()
    }
  }

  public async getPairingRequestInfo(): Promise<ExtendedWalletConnectPairingRequest> {
    if (this.released) {
      throw new Error('WalletConnect transport has been released.')
    }
    return this.client.getPairingRequestInfo()
  }

  public async listen(publicKey: string): Promise<void> {
    if (this.released) {
      return
    }
    const connectionContext: ConnectionContext = {
      origin: Origin.WALLETCONNECT,
      id: publicKey
    }
    await this.client
      .listenForEncryptedMessage(
        publicKey,
        async (message) => {
          if (this.released) {
            return
          }
          await this.notifyListeners(message, connectionContext).catch((error) => {
            logger.error('listen', error)
          })
        },
        (message, isCurrent) => this.handleSessionUpdate(message, connectionContext, isCurrent),
        this.owner
      )
      .catch((error) => {
        throw error
      })
  }

  protected async handleSessionUpdate(
    message: PermissionResponse | ChangeAccountRequest,
    connectionInfo: ConnectionContext,
    isCurrent: () => boolean
  ): Promise<void> {
    if (this.released || !isCurrent()) {
      return
    }
    const serialized = await new Serializer().serialize(message)
    if (!this.released && isCurrent()) {
      await this.notifyListeners(serialized, connectionInfo, async (listener) => {
        if (this.released || !isCurrent()) {
          return
        }
        // The base transport owns registration; this metadata selects each delivery path.
        const callback = this.sessionUpdateCallbacks.get(listener)
        if (callback) {
          await callback(message, connectionInfo, isCurrent)
        } else {
          await listener(serialized, connectionInfo)
        }
      })
    }
  }
}
