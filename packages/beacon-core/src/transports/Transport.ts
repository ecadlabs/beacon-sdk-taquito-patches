import {
  TransportType,
  TransportStatus,
  PeerInfo,
  StorageKey,
  StorageKeyReturnType,
  ConnectionContext
} from '@ecadlabs/beacon-types'
import { Logger } from '../utils/Logger'
import { PeerManager } from '../managers/PeerManager'
import { CommunicationClient } from './clients/CommunicationClient'
import { ClientEvents } from './clients/ClientEvents'

type PeerStorageKey =
  | StorageKey.TRANSPORT_P2P_PEERS_DAPP
  | StorageKey.TRANSPORT_P2P_PEERS_WALLET
  | StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP
  | StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET
  | StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP

const logger = new Logger('Transport')

const pairingPeerOwnership = new WeakMap<object, WeakMap<PeerInfo, () => boolean>>()

/** @internal Captures the current acceptance transaction without changing callback signatures. */
export function getPairingPeerOwnership(
  transport: object,
  peer: PeerInfo
): (() => boolean) | undefined {
  return pairingPeerOwnership.get(transport)?.get(peer)
}

/**
 * @internalapi
 *
 *
 */
export abstract class Transport<
  T extends PeerInfo = PeerInfo,
  K extends PeerStorageKey = PeerStorageKey,
  S extends CommunicationClient = CommunicationClient
> {
  /**
   * The type of the transport
   */
  public readonly type: TransportType = TransportType.POST_MESSAGE

  /**
   * The name of the app
   */
  protected readonly name: string

  /**
   * The status of the transport
   */
  protected _isConnected: TransportStatus = TransportStatus.NOT_CONNECTED

  protected readonly peerManager: PeerManager<K>

  /**
   * The client handling the encryption/decryption of messages
   */
  protected client: S

  // Serialize storage mutations without holding the queue across message delivery.
  private peerWrite: Promise<void> = Promise.resolve()

  private readonly pairingPeers = new Map<string, symbol>()

  private pairingAdmissions?: Map<string, Set<symbol>>

  private mutatePeers<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.peerWrite.then(operation, operation)
    this.peerWrite = result.then(
      () => undefined,
      () => undefined
    )

    return result
  }

  /**
   * The listener that will be invoked when a new peer is connected
   */
  protected newPeerListener?: (peer: T) => boolean | Promise<boolean>

  setEventHandler(event: ClientEvents, fun: Function) {
    this.client.eventHandlers.set(event, fun)
  }

  /**
   * The listeners that will be notified when new messages are coming in
   */
  private listeners: ((
    message: unknown,
    connectionInfo: ConnectionContext
  ) => void | Promise<void>)[] = []

  /**
   * Return the status of the connection
   */
  public get connectionStatus(): TransportStatus {
    return this._isConnected
  }

  constructor(name: string, client: S, peerManager: PeerManager<K>) {
    this.name = name
    this.client = client
    this.peerManager = peerManager
  }

  /**
   * Returns a promise that resolves to true if the transport is available, false if it is not
   */
  public static async isAvailable(): Promise<boolean> {
    return Promise.resolve(false)
  }

  /**
   * Connect the transport
   */
  public async connect(): Promise<void> {
    logger.log('connect')
    this._isConnected = TransportStatus.CONNECTED

    return
  }

  /**
   * Disconnect the transport
   */
  public async disconnect(): Promise<void> {
    logger.log('disconnect')
    await this.peerWrite
    this._isConnected = TransportStatus.NOT_CONNECTED

    return
  }

  /**
   * Send a message through the transport
   *
   * @param message The message to send
   * @param recipient The recipient of the message
   */
  public async send(message: string, peer?: PeerInfo): Promise<void> {
    if (peer) {
      return this.client.sendMessage(message, peer)
    } else {
      const knownPeers = await this.getPeers()
      // A broadcast request has to be sent everywhere.
      const results = await Promise.allSettled(
        knownPeers.map((peerEl) => this.client.sendMessage(message, peerEl))
      )
      results.forEach((result) => {
        if (result.status === 'rejected') {
          logger.warn('Transport.send broadcast', result.reason)
        }
      })
    }
  }

  /**
   * Add a listener to be called when a new message is received
   *
   * @param listener The listener that will be registered
   */
  public async addListener(
    listener: (message: unknown, connectionInfo: ConnectionContext) => void | Promise<void>
  ): Promise<void> {
    logger.debug('addListener')

    this.listeners.push(listener)

    return
  }

  /**
   * Remove a listener
   *
   * @param listener
   */
  public async removeListener(
    listener: (message: string, connectionInfo: ConnectionContext) => void
  ): Promise<void> {
    logger.log('removeListener')

    this.listeners = this.listeners.filter((element) => element !== listener)

    return
  }

  public async getPeers(): Promise<StorageKeyReturnType[K]> {
    return this.peerManager.getPeers()
  }

  public addPeer(
    newPeer: T & StorageKeyReturnType[K][number],
    sendPairingResponse?: boolean
  ): Promise<void>
  public async addPeer(newPeer: T & StorageKeyReturnType[K][number]): Promise<void> {
    this.pairingAdmissions?.delete(newPeer.publicKey)
    this.pairingPeers.delete(newPeer.publicKey)
    await this.mutatePeers(async () => {
      logger.log('addPeer', 'adding peer', newPeer)
      await this.peerManager.addPeer(newPeer)
    })
    await this.listen(newPeer.publicKey)
  }

  protected async addPairingPeer(
    peer: T & StorageKeyReturnType[K][number],
    isActive: () => boolean,
    accepted: () => boolean | Promise<boolean>
  ): Promise<boolean> {
    const owner = Symbol('pairing peer')
    const ownsPeer = () => this.pairingPeers.get(peer.publicKey) === owner
    const previousStatus = this._isConnected
    let snapshot: StorageKeyReturnType[K][number] | undefined
    let written = false
    let committed = false
    const pending = (this.pairingAdmissions ??= new Map<string, Set<symbol>>())
    const admissions = pending.get(peer.publicKey) ?? new Set<symbol>()
    admissions.add(owner)
    pending.set(peer.publicKey, admissions)
    try {
      await this.mutatePeers(async () => {
        const previous = await this.peerManager.getPeer(peer.publicKey)
        if (!pending.get(peer.publicKey)?.has(owner) || !isActive()) {
          return
        }
        snapshot = previous ? JSON.parse(JSON.stringify(previous)) : undefined
        this.pairingPeers.set(peer.publicKey, owner)
        written = true
        await this.peerManager.addPeer(peer)
      })
      if (!ownsPeer() || !isActive()) {
        return false
      }
      // Matrix registration can replay a Disconnect that removes this peer.
      await this.listen(peer.publicKey)
      // Confirm admitted writes without retaining the queue during application callbacks.
      await this.peerWrite
      if (!ownsPeer() || !isActive()) {
        return false
      }
      let ownership = pairingPeerOwnership.get(this)
      if (!ownership) {
        ownership = new WeakMap()
        pairingPeerOwnership.set(this, ownership)
      }
      ownership.set(peer, ownsPeer)
      // The winner may retire pairing requests while retaining this peer's ownership.
      committed = (await accepted()) && ownsPeer()

      return committed
    } finally {
      const ownership = pairingPeerOwnership.get(this)
      if (ownership?.get(peer) === ownsPeer) {
        ownership.delete(peer)
      }
      admissions.delete(owner)
      if (admissions.size === 0 && pending.get(peer.publicKey) === admissions) {
        pending.delete(peer.publicKey)
      }
      if (written) {
        await this.mutatePeers(async () => {
          if (ownsPeer()) {
            this.pairingPeers.delete(peer.publicKey)
            if (!committed) {
              if (this._isConnected !== TransportStatus.NOT_CONNECTED) {
                this._isConnected = previousStatus
              }
              if (snapshot) {
                await this.peerManager.addPeer(snapshot)
              } else {
                await this.peerManager.removePeer(peer.publicKey)
                await this.client.unsubscribeFromEncryptedMessage(peer.publicKey)
              }
            }
          } else if (!committed && !(await this.peerManager.getPeer(peer.publicKey))) {
            // Registration may finish after removal; leave replacement peers listening.
            await this.client.unsubscribeFromEncryptedMessage(peer.publicKey)
            if (
              this._isConnected !== TransportStatus.NOT_CONNECTED &&
              (await this.peerManager.getPeers()).length === 0
            ) {
              this._isConnected = previousStatus
            }
          }
        })
      }
    }
  }

  public async removePeer(peerToBeRemoved: T): Promise<void> {
    // Publication stops at removal intent, even while an earlier storage write is pending.
    this.pairingAdmissions?.delete(peerToBeRemoved.publicKey)
    this.pairingPeers.delete(peerToBeRemoved.publicKey)

    return this.mutatePeers(async () => {
      logger.log('removePeer', 'removing peer', peerToBeRemoved)
      await this.peerManager.removePeer(peerToBeRemoved.publicKey)
      if (this.client) {
        await this.client.unsubscribeFromEncryptedMessage(peerToBeRemoved.publicKey)
      }
    })
  }

  public async removeAllPeers(): Promise<void> {
    this.pairingAdmissions?.clear()
    this.pairingPeers.clear()

    return this.mutatePeers(async () => {
      logger.log('removeAllPeers')
      await this.peerManager.removeAllPeers()
      if (this.client) {
        await this.client.unsubscribeFromEncryptedMessages()
      }
    })
  }

  /**
   * Notify the listeners when a new message comes in
   *
   * @param message Message
   * @param connectionInfo Context info about the connection
   */
  protected async notifyListeners(
    message: unknown,
    connectionInfo: ConnectionContext,
    dispatch?: (
      listener: (message: unknown, connectionInfo: ConnectionContext) => void | Promise<void>
    ) => void | Promise<void>
  ): Promise<void> {
    if (this.listeners.length === 0) {
      logger.warn('notifyListeners', '0 listeners notified!', this)
    } else {
      logger.log('notifyListeners', `Notifying ${this.listeners.length} listeners`, this)
    }

    await Promise.all(
      this.listeners.map(async (listener) =>
        dispatch ? dispatch(listener) : listener(message, connectionInfo)
      )
    )
  }

  abstract listen(publicKey: string): Promise<void>
}
