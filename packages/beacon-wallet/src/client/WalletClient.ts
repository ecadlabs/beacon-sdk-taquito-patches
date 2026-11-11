import {
  Serializer,
  Client,
  LocalStorage,
  PermissionManager,
  AppMetadataManager,
  getSenderId,
  Logger,
  NOTIFICATION_ORACLE_URL
} from '@ecadlabs/beacon-core'

import { ExposedPromise, toHex } from '@ecadlabs/beacon-utils'

import {
  ConnectionContext,
  BeaconRequestMessage,
  BeaconMessageType,
  AcknowledgeResponseInput,
  ExtendedPeerInfo,
  PeerInfo,
  DisconnectMessage,
  TransportType,
  BeaconRequestOutputMessage,
  BeaconResponseInputMessage,
  AppMetadata,
  PermissionInfo,
  TransportStatus,
  BeaconMessage,
  BeaconMessageWrapper,
  BeaconBaseMessage,
  StorageKey,
  PushToken,
  PostMessagePairingRequest,
  ExtendedPostMessagePairingRequest,
  P2PPairingRequest,
  ExtendedP2PPairingRequest,
  ExtendedWalletConnectPairingRequest
} from '@ecadlabs/beacon-types'
import { WalletP2PTransport } from '../transports/WalletP2PTransport'
import { IncomingRequestInterceptor } from '../interceptors/IncomingRequestInterceptor'
import { OutgoingResponseInterceptor } from '../interceptors/OutgoingResponseInterceptor'
import { WalletClientOptions } from './WalletClientOptions'

const logger = new Logger('WalletClient')

type DisconnectListener = (senderId: string) => void | Promise<void>

/**
 * @publicapi
 *
 * The WalletClient has to be used in the wallet. It handles all the logic related to connecting to beacon-compatible
 * dapps and handling/responding to requests.
 *
 * @category Wallet
 */
export class WalletClient extends Client {
  /**
   * Returns whether or not the transport is connected
   */
  protected readonly _isConnected: ExposedPromise<boolean> = new ExposedPromise()
  public get isConnected(): Promise<boolean> {
    return this._isConnected.promise
  }

  private readonly permissionManager: PermissionManager
  private readonly appMetadataManager: AppMetadataManager
  private connectionAttempt: Promise<void> | undefined
  private deliveryGeneration = Symbol('Wallet connection')
  private destroyed = false

  /**
   * This array stores pending requests, meaning requests we received and have not yet handled / sent a response.
   */
  private pendingRequests: [
    BeaconRequestMessage | BeaconMessageWrapper<BeaconBaseMessage>,
    ConnectionContext
  ][] = []
  private readonly disconnectListeners = new Map<DisconnectListener, () => void>()

  constructor(config: WalletClientOptions) {
    super({
      storage: config && config.storage ? config.storage : new LocalStorage(),
      ...config
    })
    this.permissionManager = new PermissionManager(this.storage)
    this.appMetadataManager = new AppMetadataManager(this.storage)
  }

  public async init(): Promise<TransportType> {
    const keyPair = await this.keyPair // We wait for keypair here so the P2P Transport creation is not delayed and causing issues
    const p2pTransport = new WalletP2PTransport(
      this.name,
      keyPair,
      this.storage,
      this.matrixNodes,
      this.iconUrl,
      this.appUrl
    )

    return super.init(p2pTransport)
  }

  /**
   * This method initiates a connection to the P2P network and registers a callback that will be called
   * whenever a message is received.
   *
   * @param newMessageCallback The callback that will be invoked for every message the transport receives.
   */
  public async connect(
    newMessageCallback: (
      message: BeaconRequestOutputMessage,
      connectionContext: ConnectionContext
    ) => void
  ): Promise<void> {
    const generation = this.deliveryGeneration
    const deliver = (
      message: BeaconRequestOutputMessage,
      connectionContext: ConnectionContext
    ): void => {
      // Metadata enrichment can finish after this wallet's listener has been retired.
      if (this.ownsDelivery(generation)) {
        newMessageCallback(message, connectionContext)
      }
    }
    this.handleResponse = async (
      message: BeaconRequestMessage | BeaconMessageWrapper<BeaconBaseMessage> | DisconnectMessage,
      connectionContext: ConnectionContext
    ): Promise<void> => {
      if (!this.ownsDelivery(generation)) {
        return
      }
      if (message.version === '3') {
        const typedMessage = message as BeaconMessageWrapper<BeaconBaseMessage>
        const disconnectSenderId = this.getDisconnectSenderId(message)

        if (disconnectSenderId) {
          return this.disconnect(disconnectSenderId)
        }

        if (!this.pendingRequests.some((request) => request[0].id === message.id)) {
          this.pendingRequests.push([typedMessage, connectionContext])

          // ACK delivery must not block cold-start replay or application delivery.
          this.sendAcknowledgeResponse(typedMessage, connectionContext).catch((error) =>
            logger.error('sendAcknowledgeResponse', error)
          )

          await IncomingRequestInterceptor.intercept({
            message: typedMessage,
            connectionInfo: connectionContext,
            appMetadataManager: this.appMetadataManager,
            interceptorCallback: deliver
          })
        }
      } else {
        const typedMessage = message as BeaconRequestMessage | DisconnectMessage

        if (typedMessage.type === BeaconMessageType.Disconnect) {
          return this.disconnect(typedMessage.senderId)
        }

        if (!this.pendingRequests.some((request) => request[0].id === message.id)) {
          this.pendingRequests.push([typedMessage, connectionContext])

          if (typedMessage.version !== '1') {
            this.sendAcknowledgeResponse(typedMessage, connectionContext).catch((error) =>
              logger.error('sendAcknowledgeResponse', error)
            )
          }

          await IncomingRequestInterceptor.intercept({
            message: typedMessage,
            connectionInfo: connectionContext,
            appMetadataManager: this.appMetadataManager,
            interceptorCallback: deliver
          })
        }
      }
    }

    return this._connect()
  }

  public override async destroy(): Promise<void> {
    this.destroyed = true
    this.deliveryGeneration = Symbol('Wallet connection')
    await super.destroy()
  }

  private ownsDelivery(generation: symbol): boolean {
    return !this.destroyed && this.deliveryGeneration === generation
  }

  /**
   * Subscribe to inbound disconnects from known peers and return an idempotent cleanup function.
   * Duplicate listener references share one subscription, removable by either cleanup function.
   * Cleanup does not affect a later subscription or listeners already being notified.
   *
   * Listeners are notified after local peer cleanup is attempted. Listener failures are logged and do
   * not prevent other listeners from running.
   */
  public subscribeToDisconnect(listener: DisconnectListener): () => void {
    const existing = this.disconnectListeners.get(listener)
    if (existing) {
      return existing
    }

    const unsubscribe = (): void => {
      // Identity removal and resubscription must invalidate all older cleanup functions.
      if (this.disconnectListeners.get(listener) === unsubscribe) {
        this.disconnectListeners.delete(listener)
      }
    }
    this.disconnectListeners.set(listener, unsubscribe)

    return unsubscribe
  }

  /**
   * Unsubscribe a disconnect listener by identity.
   */
  public unsubscribeFromDisconnect(listener: DisconnectListener): void {
    this.disconnectListeners.delete(listener)
  }

  public async getRegisterPushChallenge(
    backendUrl: string,
    accountPublicKey: string,
    oracleUrl: string = NOTIFICATION_ORACLE_URL
  ) {
    // Check if account is already registered
    const challengeResponse = await fetch(`${oracleUrl}/challenge`)
    if (!challengeResponse.ok) {
      throw new Error(
        `getRegisterPushChallenge failed: ${challengeResponse.status} ${challengeResponse.statusText}`
      )
    }
    const challenge: { id: string; timestamp: string } = await challengeResponse.json()

    const constructedString = [
      'Tezos Signed Message: ',
      challenge.id,
      challenge.timestamp,
      accountPublicKey,
      backendUrl
    ].join(' ')

    const bytes = toHex(constructedString)
    const payloadBytes = `05` + `01${bytes.length.toString(16).padStart(8, '0')}${bytes}`

    return {
      challenge,
      payloadToSign: payloadBytes
    }
  }

  public async registerPush(
    challenge: { id: string; timestamp: string },
    signature: string,
    backendUrl: string,
    accountPublicKey: string,
    protocolIdentifier: string,
    deviceId: string,
    oracleUrl: string = NOTIFICATION_ORACLE_URL
  ): Promise<PushToken> {
    const tokens = await this.storage.get(StorageKey.PUSH_TOKENS)
    const token = tokens.find(
      (el) => el.publicKey === accountPublicKey && el.backendUrl === backendUrl
    )
    if (token) {
      return token
    }

    const registerResponse = await fetch(`${oracleUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: this.name,
        challenge,
        accountPublicKey,
        signature,
        backendUrl,
        protocolIdentifier,
        deviceId
      })
    })
    if (!registerResponse.ok) {
      throw new Error(
        `registerPush failed: ${registerResponse.status} ${registerResponse.statusText}`
      )
    }
    const register: {
      accessToken: string
      managementToken: string
      message: string
      success: boolean
    } = await registerResponse.json()

    const newToken = {
      publicKey: accountPublicKey,
      backendUrl,
      accessToken: register.accessToken,
      managementToken: register.managementToken
    }

    tokens.push(newToken)

    await this.storage.set(StorageKey.PUSH_TOKENS, tokens)

    return newToken
  }

  /**
   * The method will attempt to initiate a connection using the active transport.
   */
  public async _connect(attempts: number = 3): Promise<void> {
    if (this.destroyed || attempts === 0) {
      return
    }
    if (this.connectionAttempt) {
      return this.connectionAttempt
    }
    const generation = this.deliveryGeneration
    const attempt = this.connectTransport(attempts, generation)
    this.connectionAttempt = attempt
    try {
      await attempt
    } catch (error) {
      if (this.ownsDelivery(generation)) {
        this.deliveryGeneration = Symbol('Wallet connection')
      }
      throw error
    } finally {
      if (this.connectionAttempt === attempt) {
        this.connectionAttempt = undefined
      }
    }
  }

  private async connectTransport(attempts: number, generation: symbol): Promise<void> {
    const transport = await this.transport
    if (!this.ownsDelivery(generation)) {
      return
    }
    if (attempts === 0) {
      this.deliveryGeneration = Symbol('Wallet connection')
      await this.cleanup([transport])

      return
    }
    if (transport.connectionStatus !== TransportStatus.NOT_CONNECTED) {
      return
    }

    try {
      await this.addListener(transport)
      if (!this.ownsDelivery(generation)) {
        return
      }
      await transport.connect()
    } catch (error: unknown) {
      if (!this.ownsDelivery(generation)) {
        return
      }
      logger.warn('_connect', error instanceof Error ? error.message : error)
      await transport.disconnect()
      if (this.ownsDelivery(generation)) {
        await this.connectTransport(attempts - 1, generation)
      }

      return
    }

    if (this.ownsDelivery(generation)) {
      this._isConnected.resolve(true)
    }
  }

  /**
   * This method sends a response for a specific request back to the DApp
   *
   * @param message The BeaconResponseMessage that will be sent back to the DApp
   */
  public async respond(message: BeaconResponseInputMessage): Promise<void> {
    logger.log('RESPONSE', message)
    const request = this.pendingRequests.find(
      (pendingRequest) => pendingRequest[0].id === message.id
    )
    if (!request) {
      throw new Error('No matching request found!')
    }

    this.pendingRequests = this.pendingRequests.filter(
      (pendingRequest) => pendingRequest[0].id !== message.id
    )

    await OutgoingResponseInterceptor.intercept({
      senderId: await getSenderId(await this.beaconId),
      request: request[0],
      message,
      ownAppMetadata: await this.getOwnAppMetadata(),
      permissionManager: this.permissionManager,
      appMetadataManager: this.appMetadataManager,
      interceptorCallback: async (response: BeaconMessage): Promise<void> => {
        await this.respondToMessage(response, request[1])
      }
    })
  }

  public async getAppMetadataList(): Promise<AppMetadata[]> {
    return this.appMetadataManager.getAppMetadataList()
  }

  public async getAppMetadata(senderId: string): Promise<AppMetadata | undefined> {
    return this.appMetadataManager.getAppMetadata(senderId)
  }

  public async removeAppMetadata(senderId: string): Promise<void> {
    return this.appMetadataManager.removeAppMetadata(senderId)
  }

  public async removeAllAppMetadata(): Promise<void> {
    return this.appMetadataManager.removeAllAppMetadata()
  }

  public async getPermissions(): Promise<PermissionInfo[]> {
    return this.permissionManager.getPermissions()
  }

  public async getPermission(accountIdentifier: string): Promise<PermissionInfo | undefined> {
    return this.permissionManager.getPermission(accountIdentifier)
  }

  public async removePermission(accountIdentifier: string, senderId: string): Promise<void> {
    return this.permissionManager.removePermission(accountIdentifier, senderId)
  }

  public async removeAllPermissions(): Promise<void> {
    return this.permissionManager.removeAllPermissions()
  }

  private async getPeerInfo(peer: PeerInfo): Promise<ExtendedPeerInfo> {
    const senderId = await getSenderId(peer.publicKey)

    if (peer instanceof PostMessagePairingRequest) {
      return new ExtendedPostMessagePairingRequest(
        peer.id,
        peer.name,
        peer.publicKey,
        peer.version,
        senderId
      )
    } else if (peer instanceof P2PPairingRequest) {
      return new ExtendedP2PPairingRequest(
        peer.id,
        peer.name,
        peer.publicKey,
        peer.version,
        peer.relayServer,
        senderId
      )
    } else if (peer instanceof ExtendedWalletConnectPairingRequest) {
      return new ExtendedWalletConnectPairingRequest(
        peer.id,
        peer.name,
        peer.publicKey,
        peer.version,
        senderId,
        peer.uri
      )
    } else {
      return {
        ...peer,
        senderId
      }
    }
  }

  /**
   * Return all known peers without blocking when no transport is initialized yet
   */
  public override async getPeers(): Promise<ExtendedPeerInfo[]> {
    if (this._transport.isResolved() || this.transport !== this._transport.promise) {
      return (await this.transport).getPeers()
    }

    const [p2pPeers, postMessagePeers] = await Promise.all([
      this.storage.get(StorageKey.TRANSPORT_P2P_PEERS_WALLET),
      this.storage.get(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET)
    ])

    return [...(p2pPeers ?? []), ...(postMessagePeers ?? [])]
  }

  /**
   * Add a new peer to the known peers
   * @param peer The new peer to add
   */
  public async addPeer(peer: PeerInfo, sendPairingResponse: boolean = true): Promise<void> {
    return (await this.transport).addPeer(await this.getPeerInfo(peer), sendPairingResponse)
  }

  public async removePeer(
    peer: PeerInfo,
    sendDisconnectToPeer: boolean = false
  ): Promise<void> {
    const removePeerResult = (await this.transport).removePeer(peer)

    await this.removePermissionsForPeers([peer])

    if (sendDisconnectToPeer) {
      await this.sendDisconnectToPeer(peer)
    }

    return removePeerResult
  }

  public async removeAllPeers(sendDisconnectToPeers: boolean = false): Promise<void> {
    const peers = await (await this.transport).getPeers()
    const removePeerResult = (await this.transport).removeAllPeers()

    await this.removePermissionsForPeers(peers)

    if (sendDisconnectToPeers) {
      const disconnectPromises = peers.map((peer) => this.sendDisconnectToPeer(peer))

      await Promise.all(disconnectPromises)
    }

    return removePeerResult
  }

  private async removePermissionsForPeers(peersToRemove: PeerInfo[]): Promise<void> {
    const permissions = await this.permissionManager.getPermissions()

    const peerIdsToRemove: string[] = []
    for (const peer of peersToRemove) {
      if ('senderId' in peer) {
        const senderId = peer.senderId
        if (typeof senderId === 'string') {
          peerIdsToRemove.push(senderId)
        }
      }
    }
    // Remove all permissions with origin of the specified peer
    const permissionsToRemove = permissions.filter((permission) =>
      peerIdsToRemove.includes(permission.appMetadata.senderId)
    )
    const permissionIdentifiersToRemove = permissionsToRemove.map(
      (permissionInfo) => permissionInfo.accountIdentifier
    )
    await this.permissionManager.removePermissions(permissionIdentifiersToRemove)
  }

  /**
   * Send an acknowledge message back to the sender
   *
   * @param message The message that was received
   */
  private async sendAcknowledgeResponse(
    request: BeaconRequestMessage | BeaconMessageWrapper<BeaconBaseMessage>,
    connectionContext: ConnectionContext
  ): Promise<void> {
    // Acknowledge the message
    const acknowledgeResponse: AcknowledgeResponseInput = {
      id: request.id,
      type: BeaconMessageType.Acknowledge
    }

    await OutgoingResponseInterceptor.intercept({
      senderId: await getSenderId(await this.beaconId),
      request,
      message: acknowledgeResponse,
      ownAppMetadata: await this.getOwnAppMetadata(),
      permissionManager: this.permissionManager,
      appMetadataManager: this.appMetadataManager,
      interceptorCallback: async (response: BeaconMessage): Promise<void> => {
        await this.respondToMessage(response, connectionContext)
      }
    })
  }

  /**
   * An internal method to send a BeaconMessage to the DApp
   *
   * @param response Send a message back to the DApp
   */
  private async respondToMessage(
    response: BeaconMessage,
    connectionContext: ConnectionContext
  ): Promise<void> {
    const serializedMessage: string = await new Serializer().serialize(response)
    if (connectionContext) {
      const peerInfos = await this.getPeers()
      const peer = peerInfos.find((peerInfo) => peerInfo.publicKey === connectionContext.id)
      await (await this.transport).send(serializedMessage, peer)
    } else {
      await (await this.transport).send(serializedMessage)
    }
  }

  private async disconnect(senderId: string) {
    const transport = await this.transport
    const peers = await transport.getPeers()
    const peer = peers.find((peerEl) => {
      if (!('senderId' in peerEl)) {
        return false
      }
      const storedSenderId = peerEl.senderId

      return typeof storedSenderId === 'string' && storedSenderId === senderId
    })

    if (!peer) {
      return
    }

    let removePeerError: unknown
    try {
      await this.removePeer(peer)
    } catch (error) {
      removePeerError = error
    }

    this.notifyDisconnectListeners(senderId)

    if (removePeerError) {
      throw removePeerError
    }
  }

  private notifyDisconnectListeners(senderId: string): void {
    for (const listener of Array.from(this.disconnectListeners.keys())) {
      try {
        Promise.resolve(listener(senderId)).catch((error) => {
          logger.error('disconnect listener', error)
        })
      } catch (error) {
        logger.error('disconnect listener', error)
      }
    }
  }

  private getDisconnectSenderId(
    message: BeaconRequestMessage | BeaconMessageWrapper<BeaconBaseMessage> | DisconnectMessage
  ): string | undefined {
    if (message.version === '3') {
      const wrappedMessage = message as BeaconMessageWrapper<BeaconBaseMessage>
      if (wrappedMessage.message?.type === BeaconMessageType.Disconnect) {
        return wrappedMessage.senderId
      }
    }

    const typedMessage = message as DisconnectMessage

    return typedMessage.type === BeaconMessageType.Disconnect ? typedMessage.senderId : undefined
  }
}
