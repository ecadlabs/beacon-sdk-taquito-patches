import { Logger, PeerManager, Serializer, Transport, getSenderId } from '@ecadlabs/beacon-core'
import {
  initWalletConnectSignClient,
  serializeBeaconErrorToJsonRpcError
} from '@ecadlabs/beacon-transport-walletconnect'
import {
  AcknowledgeResponse,
  BeaconMessageType,
  ConnectionContext,
  DisconnectMessage,
  ErrorResponse,
  ExtendedWalletConnectPairingRequest,
  NetworkType,
  OperationRequest,
  OperationResponse,
  Origin,
  PermissionRequest,
  PermissionResponse,
  PermissionScope,
  SignPayloadRequest,
  SignPayloadResponse,
  SigningType,
  Storage,
  StorageKey,
  TezosOperation,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { KeyPair, generateGUID, getAddressFromPublicKey } from '@ecadlabs/beacon-utils'
import type { ProposalTypes, SessionTypes, SignClientTypes } from '@walletconnect/types'
import { WalletConnectWalletCommunicationClient } from './WalletConnectWalletCommunicationClient'

const logger = new Logger('WalletWalletConnectTransport')
const TEZOS_NAMESPACE = 'tezos'
const DEFAULT_METHODS = ['tezos_getAccounts', 'tezos_send', 'tezos_sign']
const DEFAULT_EVENTS = ['chainChanged', 'accountsChanged', 'requestAcknowledged']
const WC_USER_DISCONNECTED = { code: 6000, message: 'User disconnected.' }
const MAX_SEEN_SESSION_REQUESTS = 1000

type SignClientInstance = Awaited<ReturnType<typeof initWalletConnectSignClient>>

export interface WalletConnectAccountEntry {
  network: NetworkType
  address: string
  publicKey?: string
}

interface PendingProposal {
  kind: 'proposal'
  approval: { kind: 'pending' } | { kind: 'approved'; topic: string; completion: Promise<void> }
  proposalId: number
  proposerPublicKey: string
  senderId: string
  requiredTezos?: ProposalTypes.BaseRequiredNamespace
  optionalTezos?: ProposalTypes.BaseRequiredNamespace
  hasBeaconSdkVersion: boolean
}

interface PendingSessionRequest {
  kind: 'request'
  wcRequestId: number
  topic: string
  chainId: string
  method: string
  senderId: string
}

type PendingWcEntry = PendingProposal | PendingSessionRequest

interface SessionPeerMetadata {
  topic: string
  peerPublicKey: string
  senderId: string
  hasBeaconSdkVersion: boolean
  methods: string[]
  events: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseNetworkType = (chainId?: string): NetworkType => {
  if (!chainId) {
    return NetworkType.MAINNET
  }
  const parts = chainId.split(':')
  const rawNetwork = parts.length >= 2 ? parts[1] : parts[0]
  const matched = Object.values(NetworkType).find((value) => value === rawNetwork)

  return matched ?? NetworkType.CUSTOM
}

const inferSigningType = (payload: string): SigningType => {
  if (payload.startsWith('05')) {
    return SigningType.MICHELINE
  }
  if (payload.startsWith('03')) {
    return SigningType.OPERATION
  }

  return SigningType.RAW
}

const uniqueStrings = (items: readonly string[]): string[] => [...new Set(items)]

const extractScopesFromMethods = (methods: readonly string[]): PermissionScope[] => {
  const scopes: PermissionScope[] = []
  if (methods.includes('tezos_send')) {
    scopes.push(PermissionScope.OPERATION_REQUEST)
  }
  if (methods.includes('tezos_sign')) {
    scopes.push(PermissionScope.SIGN)
  }

  return scopes.length > 0 ? scopes : [PermissionScope.OPERATION_REQUEST, PermissionScope.SIGN]
}

const formatNamespaceAccounts = (
  accounts: readonly WalletConnectAccountEntry[],
  includePublicKey: boolean
): string[] => {
  const formatted: string[] = []
  for (const account of accounts) {
    const chainPrefix = `${TEZOS_NAMESPACE}:${account.network}`
    formatted.push(`${chainPrefix}:${account.address}`)
    if (includePublicKey && account.publicKey) {
      formatted.push(`${chainPrefix}:${account.publicKey}`)
    }
  }

  return uniqueStrings(formatted)
}

const resolvePermissionAccount = async (
  permResponse: PermissionResponse
): Promise<{ publicKey?: string; address: string }> => {
  const publicKey = 'publicKey' in permResponse ? permResponse.publicKey : undefined
  if ('address' in permResponse && typeof permResponse.address === 'string') {
    return { publicKey, address: permResponse.address }
  }

  return {
    publicKey,
    address: publicKey ? await getAddressFromPublicKey(publicKey) : ''
  }
}

const buildProposalApprovalPayload = async (
  pending: PendingProposal,
  permResponse: PermissionResponse
) => {
  const { publicKey, address } = await resolvePermissionAccount(permResponse)
  const chains = uniqueStrings([
    ...(pending.requiredTezos?.chains ?? []),
    ...(pending.optionalTezos?.chains ?? []),
    `${TEZOS_NAMESPACE}:${permResponse.network.type}`
  ])
  const methods = uniqueStrings([
    ...(pending.requiredTezos?.methods ?? []),
    ...(pending.optionalTezos?.methods ?? []),
    ...DEFAULT_METHODS
  ])
  const events = uniqueStrings([
    ...(pending.requiredTezos?.events ?? []),
    ...(pending.optionalTezos?.events ?? []),
    ...DEFAULT_EVENTS
  ])

  const accountEntries: WalletConnectAccountEntry[] = chains.map((chain) => ({
    network: parseNetworkType(chain),
    address,
    publicKey
  }))
  const accounts = formatNamespaceAccounts(accountEntries, pending.hasBeaconSdkVersion)
  const sessionProperties =
    publicKey && address ? { algo: 'ed25519', address, pubkey: publicKey } : undefined

  return { accounts, methods, events, sessionProperties }
}

export class WalletWalletConnectTransport extends Transport<
  ExtendedWalletConnectPairingRequest,
  StorageKey.TRANSPORT_WALLETCONNECT_PEERS_WALLET,
  WalletConnectWalletCommunicationClient
> {
  public override readonly type: TransportType = TransportType.WALLETCONNECT

  private signClient?: SignClientInstance
  private initPromise?: Promise<SignClientInstance>
  private generation = 0
  private readonly closedTopics = new Set<string>()
  private readonly responsesInFlight = new WeakMap<PendingWcEntry, Promise<void>>()
  private listenersAttached = false
  private readonly serializer = new Serializer()
  private readonly pendingByBeaconId = new Map<string, PendingWcEntry>()
  private readonly seenSessionRequests = new Set<string>()
  private readonly sessionMetaByTopic = new Map<string, SessionPeerMetadata>()
  private readonly topicByPeerPublicKey = new Map<string, string>()

  private readonly onSessionProposalBound = (
    event: SignClientTypes.EventArguments['session_proposal']
  ): Promise<void> =>
    this.handleSessionProposal(event).catch((error: unknown) =>
      logger.error('session_proposal', error)
    )

  private readonly onSessionRequestBound = (
    event: SignClientTypes.EventArguments['session_request']
  ): Promise<void> =>
    this.handleSessionRequest(event).catch((error: unknown) =>
      logger.error('session_request', error)
    )

  private readonly onSessionDeleteBound = (
    event: SignClientTypes.EventArguments['session_delete']
  ): Promise<void> =>
    this.handleSessionClosed(event.topic).catch((error: unknown) =>
      logger.error('session_delete', error)
    )

  private readonly onSessionExpireBound = (
    event: SignClientTypes.EventArguments['session_expire']
  ): Promise<void> =>
    this.handleSessionClosed(event.topic).catch((error: unknown) =>
      logger.error('session_expire', error)
    )

  constructor(
    name: string,
    _keyPair: KeyPair,
    storage: Storage,
    private readonly wcOptions: SignClientTypes.Options,
    private readonly iconUrl?: string,
    private readonly appUrl?: string
  ) {
    super(
      name,
      new WalletConnectWalletCommunicationClient(),
      new PeerManager<StorageKey.TRANSPORT_WALLETCONNECT_PEERS_WALLET>(
        storage,
        StorageKey.TRANSPORT_WALLETCONNECT_PEERS_WALLET
      )
    )
  }

  public static async isAvailable(): Promise<boolean> {
    return true
  }

  public async connect(): Promise<void> {
    if (this._isConnected === TransportStatus.CONNECTED) {
      return
    }
    const generation = this.generation
    this._isConnected = TransportStatus.CONNECTING
    try {
      const signClient = await this.ensureSignClient()
      if (generation !== this.generation) {
        return
      }
      this.attachSignClientListeners(signClient)
      this._isConnected = TransportStatus.CONNECTED
    } catch (error) {
      if (generation === this.generation) {
        this._isConnected = TransportStatus.NOT_CONNECTED
      }
      throw error
    }
  }

  public async disconnect(): Promise<void> {
    this.disconnectClient()
  }

  private disconnectClient(): void {
    this.generation++
    this.pendingByBeaconId.clear()
    if (this.signClient && this.listenersAttached) {
      this.detachSignClientListeners(this.signClient)
    }
    this._isConnected = TransportStatus.NOT_CONNECTED
  }

  public async doClientCleanup(): Promise<void> {
    this.disconnectClient()
    this.pendingByBeaconId.clear()
    this.seenSessionRequests.clear()
    this.sessionMetaByTopic.clear()
    this.topicByPeerPublicKey.clear()
    this.closedTopics.clear()
    this.signClient = undefined
    this.initPromise = undefined
  }

  public override async addPeer(newPeer: ExtendedWalletConnectPairingRequest): Promise<void> {
    const generation = this.generation
    const admitted = await this.addPairingPeer(
      newPeer,
      () => generation === this.generation,
      () => true
    )
    if (!admitted || generation !== this.generation) {
      return
    }
    if (newPeer.uri) {
      const signClient = await this.ensureSignClient()
      if (generation === this.generation) {
        await signClient.pair({ uri: newPeer.uri })
      }
    }
  }

  public override async listen(): Promise<void> {
    const generation = this.generation
    const signClient = await this.ensureSignClient()
    if (generation === this.generation) {
      this.attachSignClientListeners(signClient)
    }
  }

  public override async send(
    serializedMessage: string,
    peer?: ExtendedWalletConnectPairingRequest
  ): Promise<void> {
    const generation = this.generation
    const deserialized = await this.serializer.deserialize(serializedMessage)
    if (
      generation !== this.generation ||
      !isRecord(deserialized) ||
      typeof deserialized.type !== 'string'
    ) {
      return
    }

    const signClient = await this.ensureSignClient()

    if (generation !== this.generation) {
      return
    }

    if (deserialized.type === BeaconMessageType.Disconnect) {
      if (peer) {
        const topic = this.topicByPeerPublicKey.get(peer.publicKey)
        if (topic) {
          this.clearTopic(topic)
          await signClient.disconnect({ topic, reason: WC_USER_DISCONNECTED })
          this.sessionMetaByTopic.delete(topic)
          this.topicByPeerPublicKey.delete(peer.publicKey)
        }
      }

      return
    }

    if (typeof deserialized.id !== 'string') {
      return
    }

    const pending = this.pendingByBeaconId.get(deserialized.id)
    if (!pending) {
      return
    }

    if (deserialized.type === BeaconMessageType.Acknowledge) {
      const ack = deserialized as unknown as AcknowledgeResponse
      if (pending.kind === 'request') {
        await signClient.emit({
          topic: pending.topic,
          event: { name: 'requestAcknowledged', data: { id: ack.id } },
          chainId: pending.chainId
        })
      }

      return
    }

    const existing = this.responsesInFlight.get(pending)
    if (existing) {
      return existing
    }
    const supported =
      deserialized.type === BeaconMessageType.Error ||
      deserialized.type === BeaconMessageType.PermissionResponse ||
      (pending.kind === 'request' &&
        (deserialized.type === BeaconMessageType.OperationResponse ||
          deserialized.type === BeaconMessageType.SignPayloadResponse))
    if (!supported) {
      return
    }
    const beaconId = deserialized.id
    const isCurrent = () =>
      generation === this.generation && this.pendingByBeaconId.get(beaconId) === pending
    const delivery =
      pending.kind === 'proposal'
        ? this.respondToProposal(signClient, pending, deserialized, isCurrent)
        : this.respondToSessionRequest(signClient, pending, deserialized, isCurrent)
    this.responsesInFlight.set(pending, delivery)
    try {
      await delivery
      if (isCurrent()) {
        this.pendingByBeaconId.delete(deserialized.id)
      }
    } finally {
      this.responsesInFlight.delete(pending)
    }
  }

  public async updateSessionAccounts(
    topic: string,
    accounts: readonly WalletConnectAccountEntry[]
  ): Promise<void> {
    const generation = this.generation
    const signClient = await this.ensureSignClient()
    if (generation !== this.generation) {
      return
    }
    const meta = await this.getOrBuildSessionMeta(signClient, topic)
    if (generation !== this.generation || this.closedTopics.has(topic)) {
      return
    }
    const formattedAccounts = formatNamespaceAccounts(accounts, meta.hasBeaconSdkVersion)

    const { acknowledged } = await signClient.update({
      topic,
      namespaces: {
        [TEZOS_NAMESPACE]: {
          accounts: formattedAccounts,
          methods: meta.methods,
          events: meta.events
        }
      }
    })
    await acknowledged()
  }

  private async ensureSignClient(): Promise<SignClientInstance> {
    if (this.signClient) {
      return this.signClient
    }
    if (!this.initPromise) {
      const options: SignClientTypes.Options = {
        ...this.wcOptions,
        metadata: this.wcOptions.metadata ?? {
          name: this.name,
          description: this.name,
          url: this.appUrl ?? '',
          icons: this.iconUrl ? [this.iconUrl] : []
        }
      }
      const initialization = initWalletConnectSignClient(options)
        .then((client) => {
          if (this.initPromise === initialization) {
            this.signClient = client
          }

          return client
        })
        .catch((error: unknown) => {
          if (this.initPromise === initialization) {
            this.initPromise = undefined
          }
          throw error
        })
      this.initPromise = initialization
    }

    return this.initPromise
  }

  private attachSignClientListeners(signClient: SignClientInstance): void {
    if (this.listenersAttached) {
      return
    }
    signClient.on('session_proposal', this.onSessionProposalBound)
    signClient.on('session_request', this.onSessionRequestBound)
    signClient.on('session_delete', this.onSessionDeleteBound)
    signClient.on('session_expire', this.onSessionExpireBound)
    this.listenersAttached = true
  }

  private detachSignClientListeners(signClient: SignClientInstance): void {
    signClient.off('session_proposal', this.onSessionProposalBound)
    signClient.off('session_request', this.onSessionRequestBound)
    signClient.off('session_delete', this.onSessionDeleteBound)
    signClient.off('session_expire', this.onSessionExpireBound)
    this.listenersAttached = false
  }

  private async handleSessionProposal(
    event: SignClientTypes.EventArguments['session_proposal']
  ): Promise<void> {
    const generation = this.generation
    const { id: proposalId, params } = event
    const proposer = params.proposer
    const senderId = await getSenderId(proposer.publicKey)
    if (generation !== this.generation) {
      return
    }
    const beaconId = `wc-proposal-${proposalId}`

    const requiredTezos = params.requiredNamespaces?.[TEZOS_NAMESPACE]
    const optionalTezos = params.optionalNamespaces?.[TEZOS_NAMESPACE]
    const hasBeaconSdkVersion = Boolean(params.sessionProperties?.beacon_sdk_version)

    const pending: PendingProposal = {
      kind: 'proposal',
      approval: { kind: 'pending' },
      proposalId,
      proposerPublicKey: proposer.publicKey,
      senderId,
      requiredTezos,
      optionalTezos,
      hasBeaconSdkVersion
    }
    this.pendingByBeaconId.set(beaconId, pending)

    const admitted = await this.addPairingPeer(
      new ExtendedWalletConnectPairingRequest(
        beaconId,
        proposer.metadata.name,
        proposer.publicKey,
        '2',
        senderId,
        '',
        proposer.metadata.icons?.[0],
        proposer.metadata.url
      ),
      () => generation === this.generation,
      () => true
    )
    if (!admitted) {
      if (this.pendingByBeaconId.get(beaconId) === pending) {
        this.pendingByBeaconId.delete(beaconId)
      }

      return
    }

    const chains = uniqueStrings([
      ...(requiredTezos?.chains ?? []),
      ...(optionalTezos?.chains ?? [])
    ])
    const methods = uniqueStrings([
      ...(requiredTezos?.methods ?? []),
      ...(optionalTezos?.methods ?? [])
    ])
    const networkType = parseNetworkType(chains[0])

    const permissionRequest: PermissionRequest = {
      id: beaconId,
      version: '2',
      senderId,
      type: BeaconMessageType.PermissionRequest,
      appMetadata: {
        senderId,
        name: proposer.metadata.name,
        icon: proposer.metadata.icons?.[0]
      },
      network: { type: networkType },
      scopes: extractScopesFromMethods(methods)
    }

    const context: ConnectionContext = {
      origin: Origin.WALLETCONNECT,
      id: proposer.publicKey
    }
    const serialized = await this.serializer.serialize(permissionRequest)
    if (generation === this.generation && this.pendingByBeaconId.get(beaconId) === pending) {
      await this.notifyListeners(serialized, context)
    }
  }

  private async handleSessionRequest(
    event: SignClientTypes.EventArguments['session_request']
  ): Promise<void> {
    const generation = this.generation
    const { id: wcRequestId, topic, params } = event
    if (this.closedTopics.has(topic)) {
      return
    }
    const dedupeKey = `${topic}:${wcRequestId}`
    if (this.seenSessionRequests.has(dedupeKey)) {
      return
    }
    this.seenSessionRequests.add(dedupeKey)
    if (this.seenSessionRequests.size > MAX_SEEN_SESSION_REQUESTS) {
      const oldest = this.seenSessionRequests.values().next().value
      if (oldest !== undefined) {
        this.seenSessionRequests.delete(oldest)
      }
    }

    const signClient = await this.ensureSignClient()
    if (generation !== this.generation || this.closedTopics.has(topic)) {
      return
    }
    const session = signClient.session.get(topic)
    if (!session) {
      return
    }

    const meta = await this.getOrBuildSessionMeta(signClient, topic, session)
    const method = params.request.method
    const requestParams = isRecord(params.request.params) ? params.request.params : {}
    const networkType = parseNetworkType(params.chainId)
    const beaconId = await generateGUID()

    if (generation !== this.generation || this.closedTopics.has(topic)) {
      return
    }
    this.pendingByBeaconId.set(beaconId, {
      kind: 'request',
      wcRequestId,
      topic,
      chainId: params.chainId,
      method,
      senderId: meta.senderId
    })

    let beaconMessage: PermissionRequest | OperationRequest | SignPayloadRequest | undefined

    if (method === 'tezos_getAccounts') {
      beaconMessage = {
        id: beaconId,
        version: '2',
        senderId: meta.senderId,
        type: BeaconMessageType.PermissionRequest,
        appMetadata: {
          senderId: meta.senderId,
          name: session.peer.metadata.name,
          icon: session.peer.metadata.icons?.[0]
        },
        network: { type: networkType },
        scopes: extractScopesFromMethods(meta.methods)
      }
    } else if (method === 'tezos_send') {
      const sourceAddress = typeof requestParams.account === 'string' ? requestParams.account : ''
      const operationDetails = Array.isArray(requestParams.operations)
        ? (requestParams.operations as TezosOperation[])
        : []
      beaconMessage = {
        id: beaconId,
        version: '2',
        senderId: meta.senderId,
        type: BeaconMessageType.OperationRequest,
        network: { type: networkType },
        operationDetails,
        sourceAddress
      }
    } else if (method === 'tezos_sign') {
      const sourceAddress = typeof requestParams.account === 'string' ? requestParams.account : ''
      const payload = typeof requestParams.payload === 'string' ? requestParams.payload : ''
      beaconMessage = {
        id: beaconId,
        version: '2',
        senderId: meta.senderId,
        type: BeaconMessageType.SignPayloadRequest,
        signingType: inferSigningType(payload),
        payload,
        sourceAddress
      }
    }

    if (!beaconMessage) {
      this.pendingByBeaconId.delete(beaconId)

      return
    }

    const context: ConnectionContext = {
      origin: Origin.WALLETCONNECT,
      id: meta.peerPublicKey
    }
    const serialized = await this.serializer.serialize(beaconMessage)
    if (generation === this.generation && this.pendingByBeaconId.has(beaconId)) {
      await this.notifyListeners(serialized, context)
    }
  }

  private async respondToProposal(
    signClient: SignClientInstance,
    pending: PendingProposal,
    deserialized: Record<string, unknown>,
    isCurrent: () => boolean
  ): Promise<void> {
    if (pending.approval.kind === 'approved') {
      return pending.approval.completion
    }
    if (deserialized.type === BeaconMessageType.Error) {
      const errorResponse = deserialized as unknown as ErrorResponse
      await signClient.reject({
        id: pending.proposalId,
        reason: serializeBeaconErrorToJsonRpcError(errorResponse.errorType, errorResponse.errorData)
      })

      return
    }

    if (deserialized.type !== BeaconMessageType.PermissionResponse) {
      return
    }

    const permResponse = deserialized as unknown as PermissionResponse
    const { accounts, methods, events, sessionProperties } = await buildProposalApprovalPayload(
      pending,
      permResponse
    )

    if (!isCurrent()) {
      return
    }
    const { topic, acknowledged } = await signClient.approve({
      id: pending.proposalId,
      namespaces: {
        [TEZOS_NAMESPACE]: {
          accounts,
          methods,
          events
        }
      },
      ...(sessionProperties ? { sessionProperties } : {})
    })
    const completion = (async () => {
      await acknowledged()
      if (!isCurrent() || this.closedTopics.has(topic)) {
        return
      }
      this.sessionMetaByTopic.set(topic, {
        topic,
        peerPublicKey: pending.proposerPublicKey,
        senderId: pending.senderId,
        hasBeaconSdkVersion: pending.hasBeaconSdkVersion,
        methods,
        events
      })
      this.topicByPeerPublicKey.set(pending.proposerPublicKey, topic)
    })()
    // Approval is committed. An acknowledgement failure must never approve again.
    pending.approval = { kind: 'approved', topic, completion }
    if (this.closedTopics.has(topic)) {
      this.clearTopic(topic)
    }
    await completion
  }

  private async respondToSessionRequest(
    signClient: SignClientInstance,
    pending: PendingSessionRequest,
    deserialized: Record<string, unknown>,
    isCurrent: () => boolean
  ): Promise<void> {
    if (deserialized.type === BeaconMessageType.Error) {
      const errorResponse = deserialized as unknown as ErrorResponse
      await signClient.respond({
        topic: pending.topic,
        response: {
          id: pending.wcRequestId,
          jsonrpc: '2.0',
          error: serializeBeaconErrorToJsonRpcError(
            errorResponse.errorType,
            errorResponse.errorData
          )
        }
      })

      return
    }

    if (deserialized.type === BeaconMessageType.PermissionResponse) {
      const permResponse = deserialized as unknown as PermissionResponse
      const publicKey = 'publicKey' in permResponse ? permResponse.publicKey : undefined
      const address =
        'address' in permResponse && typeof permResponse.address === 'string'
          ? permResponse.address
          : publicKey
            ? await getAddressFromPublicKey(publicKey)
            : ''

      if (!isCurrent()) {
        return
      }
      await signClient.respond({
        topic: pending.topic,
        response: {
          id: pending.wcRequestId,
          jsonrpc: '2.0',
          result: [{ algo: 'ed25519', address, pubkey: publicKey ?? '' }]
        }
      })

      return
    }

    if (deserialized.type === BeaconMessageType.OperationResponse) {
      const opResponse = deserialized as unknown as OperationResponse
      await signClient.respond({
        topic: pending.topic,
        response: {
          id: pending.wcRequestId,
          jsonrpc: '2.0',
          result: { operationHash: opResponse.transactionHash }
        }
      })

      return
    }

    if (deserialized.type === BeaconMessageType.SignPayloadResponse) {
      const signResponse = deserialized as unknown as SignPayloadResponse
      await signClient.respond({
        topic: pending.topic,
        response: {
          id: pending.wcRequestId,
          jsonrpc: '2.0',
          result: { signature: signResponse.signature }
        }
      })
    }
  }

  private clearTopic(topic: string): void {
    this.closedTopics.add(topic)
    for (const [id, pending] of this.pendingByBeaconId) {
      if (
        (pending.kind === 'request' && pending.topic === topic) ||
        (pending.kind === 'proposal' &&
          pending.approval.kind === 'approved' &&
          pending.approval.topic === topic)
      ) {
        this.pendingByBeaconId.delete(id)
      }
    }
  }

  private async handleSessionClosed(topic: string): Promise<void> {
    this.clearTopic(topic)
    const generation = this.generation
    const meta = this.sessionMetaByTopic.get(topic)
    let senderId = meta?.senderId
    let peerPublicKey = meta?.peerPublicKey

    if (!senderId && this.signClient) {
      const session = this.signClient.session.get(topic)
      if (session) {
        peerPublicKey = session.peer.publicKey
        senderId = await getSenderId(session.peer.publicKey)
      }
    }

    if (generation !== this.generation) {
      return
    }
    this.sessionMetaByTopic.delete(topic)
    if (peerPublicKey) {
      this.topicByPeerPublicKey.delete(peerPublicKey)
    }

    if (!senderId) {
      return
    }

    const disconnectMessage: DisconnectMessage = {
      id: await generateGUID(),
      version: '2',
      senderId,
      type: BeaconMessageType.Disconnect
    }

    const serialized = await this.serializer.serialize(disconnectMessage)
    if (generation === this.generation) {
      await this.notifyListeners(serialized, {
        origin: Origin.WALLETCONNECT,
        id: peerPublicKey ?? senderId
      })
    }
  }

  private async getOrBuildSessionMeta(
    signClient: SignClientInstance,
    topic: string,
    sessionOverride?: SessionTypes.Struct
  ): Promise<SessionPeerMetadata> {
    const generation = this.generation
    const existing = this.sessionMetaByTopic.get(topic)
    if (existing) {
      return existing
    }

    const session = sessionOverride ?? signClient.session.get(topic)
    const tezosNamespace = session?.namespaces?.[TEZOS_NAMESPACE]
    const peerPublicKey = session?.peer.publicKey ?? topic
    const senderId = await getSenderId(peerPublicKey)
    const meta: SessionPeerMetadata = {
      topic,
      peerPublicKey,
      senderId,
      hasBeaconSdkVersion: Boolean(session?.sessionProperties?.beacon_sdk_version),
      methods: tezosNamespace?.methods ?? DEFAULT_METHODS,
      events: tezosNamespace?.events ?? DEFAULT_EVENTS
    }
    if (generation === this.generation && !this.closedTopics.has(topic)) {
      this.sessionMetaByTopic.set(topic, meta)
      this.topicByPeerPublicKey.set(peerPublicKey, topic)
    }

    return meta
  }
}
