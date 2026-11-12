import {
  Serializer,
  Client,
  LocalStorage,
  PermissionManager,
  AppMetadataManager,
  getAccountIdentifier,
  getSenderId,
  Logger,
  NOTIFICATION_ORACLE_URL,
  ClientTransport
} from '@ecadlabs/beacon-core'

import {
  CONTRACT_PREFIX,
  ExposedPromise,
  generateGUID,
  getAddressFromPublicKey,
  isValidAddress,
  toHex
} from '@ecadlabs/beacon-utils'

import {
  ConnectionContext,
  BeaconRequestMessage,
  BeaconRequestOutputMessage,
  BeaconMessageType,
  AcknowledgeResponseInput,
  ExtendedPeerInfo,
  PeerInfo,
  DisconnectMessage,
  TransportType,
  AppMetadata,
  PermissionInfo,
  TransportStatus,
  BeaconMessageEnvelopeV3,
  StorageKey,
  PushToken,
  PostMessagePairingRequest,
  ExtendedPostMessagePairingRequest,
  P2PPairingRequest,
  ExtendedP2PPairingRequest,
  ExtendedWalletConnectPairingRequest,
  ResponseInputForRequest,
  PermissionRequestOutput,
  OperationRequestOutput,
  SignPayloadRequestOutput,
  BroadcastRequestOutput,
  SigningType,
  BeaconErrorType,
  WalletPendingRequestInfo,
  WalletPendingRequestEvent,
  WalletPeerEvent,
  ChangeAccountInput,
  ChangeAccountRequest,
  ConnectionInfo,
  TransportStatusChangedInfo,
  Origin
} from '@ecadlabs/beacon-types'
import type { SignClientTypes } from '@walletconnect/types'
import {
  buildPermissionResponse,
  buildOperationResponse,
  buildSignPayloadResponse,
  buildBroadcastResponse,
  buildErrorResponse,
  type PermissionResponseBuilderOptions
} from '../interceptors/buildResponseInput'
import { WalletP2PTransport } from '../transports/WalletP2PTransport'
import { WalletWalletConnectTransport } from '../transports/WalletWalletConnectTransport'
import { IncomingRequestInterceptor } from '../interceptors/IncomingRequestInterceptor'
import { OutgoingResponseInterceptor } from '../interceptors/OutgoingResponseInterceptor'
import { WalletClientOptions } from './WalletClientOptions'

import type { WalletRequestOutputMessage } from '../types/WalletRequestOutputMessage'
import type {
  WalletResponseInputMessage,
  WalletResponseOutputMessage
} from '../types/WalletResponseMessage'
import { isBeaconMessageType, isV3Envelope } from '../utils/message-guards'

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
  private readonly walletConnectOptions?: SignClientTypes.Options
  private connectionAttempt: Promise<void> | undefined
  private deliveryGeneration = Symbol('Wallet connection')
  private destroyed = false

  /**
   * This array stores pending requests, meaning requests we received and have not yet handled / sent a response.
   */
  private pendingRequests: [BeaconRequestMessage | BeaconMessageEnvelopeV3, ConnectionContext][] = []
  private walletPendingRequests: WalletPendingRequestInfo[] = []
  private readonly pendingRequestListeners = new Map<
    (event: WalletPendingRequestEvent) => void,
    () => void
  >()
  private readonly transportStatusListeners = new Map<
    (info: TransportStatusChangedInfo) => void | Promise<void>,
    () => void
  >()
  private transportStatusUnsub: (() => void) | undefined
  private activeObservedTransport: ClientTransport | undefined
  private readonly peerListeners = new Map<(event: WalletPeerEvent) => void, () => void>()
  private readonly knownPeerPublicKeys = new Set<string>()
  private readonly knownPeersByPublicKey = new Map<string, ExtendedPeerInfo>()
  private readonly peersSeeded: Promise<void>
  private readonly disconnectListeners = new Map<DisconnectListener, () => void>()

  constructor(config: WalletClientOptions) {
    super({
      storage: config && config.storage ? config.storage : new LocalStorage(),
      ...config
    })
    this.walletConnectOptions = config.walletConnectOptions
    this.permissionManager = new PermissionManager(this.storage)
    this.appMetadataManager = new AppMetadataManager(this.storage)
    this.peersSeeded = this.seedKnownPeers()
    this.initStorageSync()
  }

  private async seedKnownPeers(): Promise<void> {
    try {
      const [p2pPeers, postMessagePeers] = await Promise.all([
        this.storage.get(StorageKey.TRANSPORT_P2P_PEERS_WALLET),
        this.storage.get(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET)
      ])
      if (this.destroyed) {
        return
      }
      const allPeers = [...(p2pPeers ?? []), ...(postMessagePeers ?? [])]
      for (const peer of allPeers) {
        if (peer && peer.publicKey) {
          this.knownPeerPublicKeys.add(peer.publicKey)
          const extended = await this.getPeerInfo(peer)
          if (this.destroyed) {
            return
          }
          this.knownPeersByPublicKey.set(peer.publicKey, extended)
        }
      }
    } catch (error) {
      logger.error('seedKnownPeers', error)
    }
  }

  public async init(): Promise<TransportType> {
    const keyPair = await this.keyPair // We wait for keypair here so the P2P Transport creation is not delayed and causing issues
    if (this.walletConnectOptions) {
      const wcTransport = new WalletWalletConnectTransport(
        this.name,
        keyPair,
        this.storage,
        this.walletConnectOptions,
        this.iconUrl,
        this.appUrl
      )

      return super.init(wcTransport)
    }

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
      message: WalletRequestOutputMessage,
      connectionContext: ConnectionContext
    ) => void
  ): Promise<void> {
    const generation = this.deliveryGeneration
    const deliver = (
      message: WalletRequestOutputMessage,
      connectionContext: ConnectionContext
    ): void => {
      // Metadata enrichment can finish after this wallet's listener has been retired.
      if (this.ownsDelivery(generation)) {
        newMessageCallback(message, connectionContext)
      }
    }
    this.handleResponse = async (
      message: BeaconRequestMessage | BeaconMessageEnvelopeV3 | DisconnectMessage,
      connectionContext: ConnectionContext
    ): Promise<void> => {
      if (!this.ownsDelivery(generation)) {
        return
      }
      if (message.version === '3') {
        const disconnectSenderId = this.getDisconnectSenderId(message)

        if (disconnectSenderId) {
          return this.disconnect(disconnectSenderId)
        }

        if (!isV3Envelope(message)) {
          throw new Error('Invalid V3 request envelope')
        }
        const typedMessage = message
        const rawType = typedMessage.message.type
        const messageType: BeaconMessageType = isBeaconMessageType(rawType)
          ? rawType
          : BeaconMessageType.BlockchainRequest

        if (!this.pendingRequests.some((request) => request[0].id === message.id)) {
          this.pendingRequests.push([typedMessage, connectionContext])

          const requestInfo: WalletPendingRequestInfo = Object.freeze({
            id: typedMessage.id,
            type: messageType,
            version: typedMessage.version,
            transport: this.mapOriginToTransportType(connectionContext.origin),
            senderId: typedMessage.senderId,
            receivedAt: Date.now(),
            connectionContext,
            request: typedMessage
          })
          this.walletPendingRequests.push(requestInfo)
          this.emitPendingRequestEvent({
            type: 'request_received',
            request: requestInfo
          })

          // ACK delivery must not block cold-start replay or application delivery.
          this.sendAcknowledgeResponse(typedMessage, connectionContext).catch((error) =>
            logger.error('sendAcknowledgeResponse', error)
          )

          try {
            await IncomingRequestInterceptor.intercept({
              message: typedMessage,
              connectionInfo: connectionContext,
              appMetadataManager: this.appMetadataManager,
              interceptorCallback: deliver
            })
          } catch (error) {
            logger.error('IncomingRequestInterceptor.intercept', error)
          }
        }
      } else {
        const typedMessage = message as BeaconRequestMessage | DisconnectMessage

        if (typedMessage.type === BeaconMessageType.Disconnect) {
          return this.disconnect(typedMessage.senderId)
        }

        if (!this.pendingRequests.some((request) => request[0].id === message.id)) {
          this.pendingRequests.push([typedMessage, connectionContext])

          const requestInfo: WalletPendingRequestInfo = Object.freeze({
            id: typedMessage.id,
            type: typedMessage.type,
            version: typedMessage.version,
            transport: this.mapOriginToTransportType(connectionContext.origin),
            senderId: typedMessage.senderId,
            receivedAt: Date.now(),
            connectionContext,
            request: typedMessage
          })
          this.walletPendingRequests.push(requestInfo)
          this.emitPendingRequestEvent({
            type: 'request_received',
            request: requestInfo
          })

          if (typedMessage.version !== '1') {
            this.sendAcknowledgeResponse(typedMessage, connectionContext).catch((error) =>
              logger.error('sendAcknowledgeResponse', error)
            )
          }

          try {
            await IncomingRequestInterceptor.intercept({
              message: typedMessage,
              connectionInfo: connectionContext,
              appMetadataManager: this.appMetadataManager,
              interceptorCallback: deliver
            })
          } catch (error) {
            logger.error('IncomingRequestInterceptor.intercept', error)
          }
        }
      }
    }

    return this._connect()
  }

  public override async destroy(): Promise<void> {
    this.destroyed = true
    this.deliveryGeneration = Symbol('Wallet connection')
    if (this.transportStatusUnsub) {
      this.transportStatusUnsub()
      this.transportStatusUnsub = undefined
    }
    this.activeObservedTransport = undefined
    this.transportStatusListeners.clear()
    this.pendingRequestListeners.clear()
    this.peerListeners.clear()
    this.disconnectListeners.clear()
    this.pendingRequests = []
    this.walletPendingRequests = []
    this.knownPeerPublicKeys.clear()
    this.knownPeersByPublicKey.clear()
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
   * @param message The response value to send back to the DApp
   * @param request Optional request to correlate and validate against
   */
  public async respond<T extends BeaconRequestOutputMessage>(
    message: ResponseInputForRequest<T>,
    request?: T
  ): Promise<void>
  public async respond(message: WalletResponseInputMessage): Promise<void>
  public async respond(
    message: WalletResponseInputMessage,
    request?: BeaconRequestOutputMessage
  ): Promise<void> {
    if (request && message.id !== request.id) {
      throw new Error('Response ID does not match request ID')
    }
    logger.log('RESPONSE', message)
    const matchedRequest = this.pendingRequests.find(
      (pendingRequest) => pendingRequest[0].id === message.id
    )
    if (!matchedRequest) {
      throw new Error('No matching request found!')
    }

    await OutgoingResponseInterceptor.intercept({
      senderId: await getSenderId(await this.beaconId),
      request: matchedRequest[0],
      message,
      ownAppMetadata: await this.getOwnAppMetadata(),
      permissionManager: this.permissionManager,
      appMetadataManager: this.appMetadataManager,
      interceptorCallback: async (response: WalletResponseOutputMessage): Promise<void> => {
        await this.respondToMessage(response, matchedRequest[1])
      }
    })

    this.pendingRequests = this.pendingRequests.filter(
      (pendingRequest) => pendingRequest[0].id !== message.id
    )

    const pendingIndex = this.walletPendingRequests.findIndex((req) => req.id === message.id)
    if (pendingIndex >= 0) {
      const [removed] = this.walletPendingRequests.splice(pendingIndex, 1)
      if (removed) {
        this.emitPendingRequestEvent({
          type: 'request_removed',
          request: removed,
          reason: 'responded'
        })
      }
    }
  }

  public async respondPermission(
    request: Pick<PermissionRequestOutput, 'id' | 'network' | 'scopes'>,
    options: PermissionResponseBuilderOptions
  ): Promise<void> {
    return this.respond(buildPermissionResponse(request, options))
  }

  public async respondOperation(
    request: Pick<OperationRequestOutput, 'id'>,
    transactionHash: string
  ): Promise<void> {
    return this.respond(buildOperationResponse(request, transactionHash))
  }

  public async respondSignPayload(
    request: Pick<SignPayloadRequestOutput, 'id' | 'signingType'>,
    signature: string,
    signingType?: SigningType
  ): Promise<void> {
    return this.respond(buildSignPayloadResponse(request, signature, signingType))
  }

  public async respondBroadcast(
    request: Pick<BroadcastRequestOutput, 'id'>,
    transactionHash: string
  ): Promise<void> {
    return this.respond(buildBroadcastResponse(request, transactionHash))
  }

  public async respondError(
    request: { id: string } | string,
    errorType: BeaconErrorType,
    errorData?: unknown
  ): Promise<void> {
    return this.respond(buildErrorResponse(request, errorType, errorData))
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
    const senderId =
      'senderId' in peer && typeof peer.senderId === 'string' && peer.senderId.length > 0
        ? peer.senderId
        : await getSenderId(peer.publicKey)

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

    const [p2pPeers, postMessagePeers, walletConnectPeers] = await Promise.all([
      this.storage.get(StorageKey.TRANSPORT_P2P_PEERS_WALLET),
      this.storage.get(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET),
      this.storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_WALLET)
    ])

    return [...(p2pPeers ?? []), ...(postMessagePeers ?? []), ...(walletConnectPeers ?? [])]
  }

  /**
   * Add a new peer to the known peers
   * @param peer The new peer to add
   */
  public async addPeer(peer: PeerInfo, sendPairingResponse: boolean = true): Promise<void> {
    const extendedPeer = await this.getPeerInfo(peer)
    await (await this.transport).addPeer(extendedPeer, sendPairingResponse)
    this.knownPeerPublicKeys.add(peer.publicKey)
    this.knownPeersByPublicKey.set(peer.publicKey, extendedPeer)
    this.emitPeerEvent({
      type: 'peer_added',
      peer: extendedPeer,
      source: 'local'
    })
  }

  public async removePeer(
    peer: PeerInfo,
    sendDisconnectToPeer: boolean = false
  ): Promise<void> {
    const extendedPeer =
      this.knownPeersByPublicKey.get(peer.publicKey) ?? (await this.getPeerInfo(peer))
    await (await this.transport).removePeer(peer)

    this.knownPeerPublicKeys.delete(peer.publicKey)
    this.knownPeersByPublicKey.delete(peer.publicKey)
    this.evictPendingRequestsForPeer(extendedPeer)

    await this.removePermissionsForPeers([peer])

    if (sendDisconnectToPeer) {
      await this.sendDisconnectToPeer(peer)
    }

    this.emitPeerEvent({
      type: 'peer_removed',
      peer: extendedPeer,
      source: 'local'
    })
  }

  public async removeAllPeers(sendDisconnectToPeers: boolean = false): Promise<void> {
    const peers = await (await this.transport).getPeers()
    await (await this.transport).removeAllPeers()

    for (const peer of peers) {
      this.knownPeerPublicKeys.delete(peer.publicKey)
      this.knownPeersByPublicKey.delete(peer.publicKey)
      this.evictPendingRequestsForPeer(peer)
    }

    while (this.walletPendingRequests.length > 0) {
      const remainingReq = this.walletPendingRequests.shift()
      if (!remainingReq) {
        break
      }
      this.pendingRequests = this.pendingRequests.filter((p) => p[0].id !== remainingReq.id)
      this.emitPendingRequestEvent({
        type: 'request_removed',
        request: remainingReq,
        reason: 'peer_disconnected'
      })
    }

    await this.removePermissionsForPeers(peers)

    if (sendDisconnectToPeers) {
      const disconnectPromises = peers.map((peer) => this.sendDisconnectToPeer(peer))

      await Promise.all(disconnectPromises)
    }

    for (const peer of peers) {
      this.emitPeerEvent({
        type: 'peer_removed',
        peer,
        source: 'local'
      })
    }
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
    request: BeaconRequestMessage | BeaconMessageEnvelopeV3,
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
      interceptorCallback: async (response: WalletResponseOutputMessage): Promise<void> => {
        await this.respondToMessage(response, connectionContext)
      }
    })
  }

  /**
   * An internal method to send a response value to the DApp
   *
   * @param response Send a message back to the DApp
   */
  private async respondToMessage(
    response: WalletResponseOutputMessage,
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
      this.evictPendingRequestsForPeer({ senderId })
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
    message: BeaconRequestMessage | BeaconMessageEnvelopeV3 | DisconnectMessage
  ): string | undefined {
    if (message.version === '3') {
      if (isV3Envelope(message) && message.message.type === BeaconMessageType.Disconnect) {
        return message.senderId
      }
    }

    return 'type' in message && message.type === BeaconMessageType.Disconnect
      ? message.senderId
      : undefined
  }

  public getPendingRequests(): readonly WalletPendingRequestInfo[] {
    return Object.freeze([...this.walletPendingRequests])
  }

  public dismissPendingRequest(id: string): boolean {
    const index = this.walletPendingRequests.findIndex((req) => req.id === id)
    if (index === -1) {
      return false
    }
    const [removed] = this.walletPendingRequests.splice(index, 1)
    this.pendingRequests = this.pendingRequests.filter((req) => req[0].id !== id)
    if (removed) {
      this.emitPendingRequestEvent({
        type: 'request_removed',
        request: removed,
        reason: 'dismissed'
      })
    }

    return true
  }

  public subscribeToPendingRequests(
    listener: (event: WalletPendingRequestEvent) => void
  ): () => void {
    const existing = this.pendingRequestListeners.get(listener)
    if (existing) {
      return existing
    }

    const unsubscribe = (): void => {
      if (this.pendingRequestListeners.get(listener) === unsubscribe) {
        this.pendingRequestListeners.delete(listener)
      }
    }
    this.pendingRequestListeners.set(listener, unsubscribe)

    return unsubscribe
  }

  private emitPendingRequestEvent(event: WalletPendingRequestEvent): void {
    if (this.destroyed) {
      return
    }
    for (const listener of Array.from(this.pendingRequestListeners.keys())) {
      try {
        listener(event)
      } catch (error) {
        logger.error('pending request listener', error)
      }
    }
  }

  private evictPendingRequestsForPeer(peer: {
    senderId?: string
    publicKey?: string
    id?: string
  }): void {
    const toRemove: WalletPendingRequestInfo[] = []
    this.walletPendingRequests = this.walletPendingRequests.filter((req) => {
      const matchSenderId = Boolean(peer.senderId && req.senderId === peer.senderId)
      const matchPublicKey = Boolean(peer.publicKey && req.connectionContext?.id === peer.publicKey)
      const matchId = Boolean(peer.id && req.connectionContext?.id === peer.id)
      if (matchSenderId || matchPublicKey || matchId) {
        toRemove.push(req)

        return false
      }

      return true
    })

    if (toRemove.length > 0) {
      const removedIds = new Set(toRemove.map((r) => r.id))
      this.pendingRequests = this.pendingRequests.filter((req) => !removedIds.has(req[0].id))
      for (const req of toRemove) {
        this.emitPendingRequestEvent({
          type: 'request_removed',
          request: req,
          reason: 'peer_disconnected'
        })
      }
    }
  }

  public async getConnectionInfo(): Promise<ConnectionInfo> {
    if (!this._transport.isResolved() && this.transport === this._transport.promise) {
      return {
        status: TransportStatus.NOT_CONNECTED,
        health: 'ok'
      }
    }
    const transport = await this.transport

    return {
      transport: transport.type,
      status: transport.connectionStatus,
      health: transport.health ?? 'ok',
      ...(transport.relayServer ? { relayServer: transport.relayServer } : {})
    }
  }

  public async getSelectedMatrixNode(): Promise<string | undefined> {
    if (this._transport.isResolved() || this.transport !== this._transport.promise) {
      const transport = await this.transport
      if (transport.relayServer) {
        return transport.relayServer
      }
    }

    const storedNode = await this.storage.get(StorageKey.MATRIX_SELECTED_NODE)
    if (!storedNode) {
      return undefined
    }

    if (this.matrixNodes && typeof this.matrixNodes === 'object') {
      const configuredServers = Object.values(this.matrixNodes).flatMap((servers) => servers ?? [])
      if (configuredServers.length > 0) {
        return configuredServers.includes(storedNode) ? storedNode : undefined
      }
    }

    return storedNode
  }

  public subscribeToTransportStatus(
    listener: (info: TransportStatusChangedInfo) => void | Promise<void>
  ): () => void {
    const existing = this.transportStatusListeners.get(listener)
    if (existing) {
      return existing
    }

    if (this._transport.isResolved() || this.transport !== this._transport.promise) {
      this.transport
        .then((transport) => {
          if (!this.destroyed && transport) {
            this.observeTransportStatus(transport)
          }
        })
        .catch(() => {
          // ignore error if transport rejection handled elsewhere
        })
    }

    const unsubscribe = (): void => {
      if (this.transportStatusListeners.get(listener) === unsubscribe) {
        this.transportStatusListeners.delete(listener)
      }
    }
    this.transportStatusListeners.set(listener, unsubscribe)

    return unsubscribe
  }

  protected override async setTransport(transport?: ClientTransport): Promise<void> {
    await super.setTransport(transport)
    if (transport) {
      this.observeTransportStatus(transport)
    }
  }

  private observeTransportStatus(transport: ClientTransport): void {
    if (this.activeObservedTransport === transport) {
      return
    }
    if (this.transportStatusUnsub) {
      this.transportStatusUnsub()
      this.transportStatusUnsub = undefined
    }
    this.activeObservedTransport = transport
    if (typeof transport.addStatusListener === 'function') {
      this.transportStatusUnsub = transport.addStatusListener((info) => {
        if (this.destroyed) {
          return
        }
        for (const listener of Array.from(this.transportStatusListeners.keys())) {
          try {
            Promise.resolve(listener(info)).catch((error) => {
              logger.error('transport status listener', error)
            })
          } catch (error) {
            logger.error('transport status listener', error)
          }
        }
      })
    }
  }

  public async changeAccount(peerSenderId: string, account: ChangeAccountInput): Promise<void> {
    if (!account.address && !account.publicKey) {
      throw new Error('Address or PublicKey must be defined')
    }

    const walletType = account.walletType ?? 'implicit'
    let address = account.address

    if (!address && account.publicKey) {
      address = await getAddressFromPublicKey(account.publicKey)
    }

    if (!address || !isValidAddress(address)) {
      throw new Error(`Invalid address: "${address}"`)
    }

    if (
      walletType === 'abstracted_account' &&
      address.substring(0, 3) !== CONTRACT_PREFIX
    ) {
      throw new Error(
        `Invalid abstracted account address "${address}", it should be a ${CONTRACT_PREFIX} address`
      )
    }

    const peers = await this.getPeers()
    const peer = peers.find((p) => 'senderId' in p && p.senderId === peerSenderId)
    if (!peer) {
      throw new Error(`Unknown peer senderId: "${peerSenderId}"`)
    }

    const appMetadata = await this.appMetadataManager.getAppMetadata(peerSenderId)
    if (appMetadata) {
      const permissions = await this.permissionManager.getPermissions()
      const existingForSender = permissions.filter(
        (p) => p.senderId === peerSenderId || p.appMetadata.senderId === peerSenderId
      )
      if (existingForSender.length > 0) {
        await this.permissionManager.removePermissions(
          existingForSender.map((p) => p.accountIdentifier)
        )
      }

      const permission: PermissionInfo = {
        accountIdentifier: await getAccountIdentifier(address, account.network),
        senderId: peerSenderId,
        appMetadata,
        website: '',
        address,
        ...(account.publicKey ? { publicKey: account.publicKey } : {}),
        network: account.network,
        scopes: account.scopes,
        connectedAt: Date.now(),
        walletType,
        ...(account.threshold ? { threshold: account.threshold } : {}),
        ...(account.verificationType ? { verificationType: account.verificationType } : {})
      }
      await this.permissionManager.addPermission(permission)
    }

    const requestMessage: ChangeAccountRequest = {
      id: await generateGUID(),
      version: '2',
      senderId: await getSenderId(await this.beaconId),
      type: BeaconMessageType.ChangeAccountRequest,
      walletType,
      address,
      ...(account.publicKey ? { publicKey: account.publicKey } : {}),
      network: account.network,
      scopes: account.scopes,
      ...(account.threshold ? { threshold: account.threshold } : {}),
      ...(account.verificationType ? { verificationType: account.verificationType } : {}),
      ...(account.notification ? { notification: account.notification } : {})
    }

    const serialized = await new Serializer().serialize(requestMessage)
    const transport = await this.transport
    await transport.send(serialized, peer)
  }

  public subscribeToPeers(listener: (event: WalletPeerEvent) => void): () => void {
    const existing = this.peerListeners.get(listener)
    if (existing) {
      return existing
    }

    const unsubscribe = (): void => {
      if (this.peerListeners.get(listener) === unsubscribe) {
        this.peerListeners.delete(listener)
      }
    }
    this.peerListeners.set(listener, unsubscribe)

    return unsubscribe
  }

  private emitPeerEvent(event: WalletPeerEvent): void {
    if (this.destroyed) {
      return
    }
    for (const listener of Array.from(this.peerListeners.keys())) {
      try {
        listener(event)
      } catch (error) {
        logger.error('peer listener', error)
      }
    }
  }

  private mapOriginToTransportType(origin: Origin): TransportType {
    switch (origin) {
      case Origin.P2P:
        return TransportType.P2P
      case Origin.EXTENSION:
      case Origin.WEBSITE:
        return TransportType.POST_MESSAGE
      case Origin.WALLETCONNECT:
        return TransportType.WALLETCONNECT
      default:
        return TransportType.P2P
    }
  }

  private handleStorageCleared(): void {
    const removedPeers = Array.from(this.knownPeersByPublicKey.values())
    this.knownPeerPublicKeys.clear()
    this.knownPeersByPublicKey.clear()

    while (this.walletPendingRequests.length > 0) {
      const remainingReq = this.walletPendingRequests.shift()
      if (!remainingReq) {
        break
      }
      this.pendingRequests = this.pendingRequests.filter((p) => p[0].id !== remainingReq.id)
      this.emitPendingRequestEvent({
        type: 'request_removed',
        request: remainingReq,
        reason: 'peer_disconnected'
      })
    }

    for (const peer of removedPeers) {
      this.emitPeerEvent({
        type: 'peer_removed',
        peer,
        source: 'storage'
      })
    }
  }

  private parsePeersFromStorage(raw: string | null): ExtendedPeerInfo[] {
    if (!raw) {
      return []
    }
    try {
      const parsed = JSON.parse(raw)

      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private async handleStoragePeersAdded(
    newPeers: ExtendedPeerInfo[],
    isP2P: boolean
  ): Promise<void> {
    for (const peer of newPeers) {
      if (!this.knownPeerPublicKeys.has(peer.publicKey)) {
        this.knownPeerPublicKeys.add(peer.publicKey)
        const extendedPeer = await this.getPeerInfo(peer)
        if (this.destroyed) {
          return
        }
        this.knownPeersByPublicKey.set(peer.publicKey, extendedPeer)
        if (
          isP2P &&
          (this._transport.isResolved() || this.transport !== this._transport.promise)
        ) {
          try {
            const transport = await this.transport
            if (this.destroyed) {
              return
            }
            await transport.addPeer(extendedPeer, false)
          } catch (error) {
            logger.error('initStorageSync reconcile addPeer', error)
          }
        }
        if (this.destroyed) {
          return
        }
        this.emitPeerEvent({
          type: 'peer_added',
          peer: extendedPeer,
          source: 'storage'
        })
      }
    }
  }

  private async handleStoragePeersRemoved(
    oldPeers: ExtendedPeerInfo[],
    newPeers: ExtendedPeerInfo[]
  ): Promise<void> {
    const newPks = new Set(newPeers.map((p) => p.publicKey))
    for (const peer of oldPeers) {
      if (!newPks.has(peer.publicKey) && this.knownPeerPublicKeys.has(peer.publicKey)) {
        this.knownPeerPublicKeys.delete(peer.publicKey)
        const extendedPeer =
          this.knownPeersByPublicKey.get(peer.publicKey) ?? (await this.getPeerInfo(peer))
        this.knownPeersByPublicKey.delete(peer.publicKey)
        if (this.destroyed) {
          return
        }
        this.evictPendingRequestsForPeer(extendedPeer)
        this.emitPeerEvent({
          type: 'peer_removed',
          peer: extendedPeer,
          source: 'storage'
        })
      }
    }
  }

  private initStorageSync(): void {
    if (typeof this.storage.subscribeToStorageChanged !== 'function') {
      return
    }
    this.storage
      .subscribeToStorageChanged(async (event) => {
        await this.peersSeeded
        if (this.destroyed) {
          return
        }

        if (event.eventType === 'storageCleared') {
          this.handleStorageCleared()

          return
        }

        const p2pKey = this.storage.getPrefixedKey(StorageKey.TRANSPORT_P2P_PEERS_WALLET)
        const postMessageKey = this.storage.getPrefixedKey(
          StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET
        )

        if (event.key !== p2pKey && event.key !== postMessageKey) {
          return
        }

        const isP2P = event.key === p2pKey
        const oldPeers = this.parsePeersFromStorage(event.oldValue)
        const newPeers = this.parsePeersFromStorage(event.newValue)

        await this.handleStoragePeersAdded(newPeers, isP2P)
        if (this.destroyed) {
          return
        }
        await this.handleStoragePeersRemoved(oldPeers, newPeers)
      })
      .catch((error) => {
        logger.error('subscribeToStorageChanged', error)
      })
  }
}
