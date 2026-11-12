import {
  BEACON_VERSION,
  CommunicationClient,
  Serializer,
  ClientEvents,
  Logger,
  WCStorage,
  SDK_VERSION
} from '@ecadlabs/beacon-core'
import Client from '@walletconnect/sign-client'
import KeyValueStorage from '@walletconnect/keyvaluestorage'
import { ProposalTypes, SessionTypes, SignClientTypes } from '@walletconnect/types'
import { getSdkError } from '@walletconnect/utils'
import {
  AppMetadata,
  BeaconBaseMessage,
  BeaconErrorType,
  BeaconMessageType,
  BeaconResponseInputMessage,
  ChangeAccountRequest,
  DisconnectMessage,
  ErrorResponseInput,
  ExtendedWalletConnectPairingRequest,
  ExtendedWalletConnectPairingResponse,
  IgnoredResponseInputProperties,
  ImplicitPermissionResponseInput,
  Network,
  NetworkType,
  OperationRequest,
  OperationResponseInput,
  Optional,
  PermissionRequest,
  PermissionResponse,
  PermissionScope,
  SignPayloadRequest,
  SignPayloadResponseInput,
  StorageKey,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { generateGUID, getAddressFromPublicKey, isPublicKeySC } from '@ecadlabs/beacon-utils'
import {
  ActiveAccountUnspecified,
  ActiveNetworkUnspecified,
  InvalidNetworkOrAccount,
  InvalidReceivedSessionNamespace,
  InvalidSession,
  InitializationUnavailable,
  MissingRequiredScope,
  NotConnected
} from '../error'
import { parseJsonRpcErrorToBeaconError } from '../error-wire-mapping'
import { WalletConnectStorageOwner } from './WalletConnectStorageOwner'
import { classifyRequestFailure } from './request-failure'

const TEZOS_PLACEHOLDER = 'tezos'
const BEACON_SDK_VERSION = 'beacon_sdk_version'
const logger = new Logger('WalletConnectCommunicationClient')
const WALLETCONNECT_INIT_TIMEOUT_MS = 15000
const WALLETCONNECT_CONNECT_TIMEOUT_MS = 60000
const WALLETCONNECT_PAIRING_PING_TIMEOUT_MS = 10000
const WALLETCONNECT_SESSION_VALIDATION_TIMEOUT_MS = 5000
const WALLETCONNECT_SESSION_APPROVAL_TIMEOUT_MS = 60000
const WALLETCONNECT_SESSION_EXTEND_TIMEOUT_MS = 10000
const WALLETCONNECT_DISCONNECT_TIMEOUT_MS = 10000

export interface PermissionScopeParam {
  networks: NetworkType[]
  methods: PermissionScopeMethods[]
  events?: PermissionScopeEvents[]
}
export enum PermissionScopeMethods {
  GET_ACCOUNTS = 'tezos_getAccounts',
  OPERATION_REQUEST = 'tezos_send',
  SIGN = 'tezos_sign'
}

export enum PermissionScopeEvents {
  CHAIN_CHANGED = 'chainChanged',
  ACCOUNTS_CHANGED = 'accountsChanged',
  REQUEST_ACKNOWLEDGED = 'requestAcknowledged'
}

type BeaconInputMessage =
  | BeaconResponseInputMessage
  | Optional<DisconnectMessage, IgnoredResponseInputProperties>
  | Optional<ChangeAccountRequest, IgnoredResponseInputProperties>

const getErrorDiagnostic = (error: unknown): unknown => {
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    try {
      if ('message' in error) {
        return error.message
      }
    } catch {
      // Diagnostic extraction must not interrupt recovery.
    }
  }

  return error
}

function getStringBetween(str: string | undefined, startChar: string, endChar: string): string {
  if (!str || !startChar || !endChar) {
    return ''
  }

  const startIndex = str.indexOf(startChar)
  const endIndex = str.indexOf(endChar, startIndex + 1)

  if (startIndex === -1 || endIndex === -1) {
    throw new Error('String not found')
  }

  return str.substring(startIndex + 1, endIndex)
}

interface ExposedProposal {
  readonly proposal: ProposalTypes.Struct
  readonly completion: Promise<void>
  readonly complete: () => void
  delivered: boolean
  timer?: ReturnType<typeof setTimeout>
}

interface ProposalRetirement {
  readonly proposals: readonly ExposedProposal[]
  readonly pairingTopics: Set<string>
  readonly sessions: readonly SessionTypes.Struct[]
  closeSessions: boolean
  disconnecting: Promise<boolean>
}

/**
 * Sign-client's request expiry passed and the wallet sent nothing. The adapter made this error,
 * so it marks it as local; DAppClient trusts marks on messages this adapter delivers.
 */
const expiredResponse = (id: string): ErrorResponseInput & { errorOrigin: 'local' } => ({
  id,
  type: BeaconMessageType.Error,
  errorType: BeaconErrorType.PEER_UNREACHABLE,
  errorOrigin: 'local'
})

interface PendingRequest {
  readonly id: string
  readonly topic: string
  // Set when the request is handed to signClient.request. Before that, nothing reached the
  // wallet, so a caller that gives up can still stop the request from being sent.
  sent?: boolean
}

type ChannelOpeningListener = (
  pairingResponse: ExtendedWalletConnectPairingResponse,
  isCurrent: () => boolean
) => boolean | Promise<boolean>

type SessionUpdateMessage = PermissionResponse | ChangeAccountRequest
type SessionUpdateListener = (
  message: SessionUpdateMessage,
  isCurrent: () => boolean
) => void | Promise<void>
type MessageListener = (
  message: string,
  update?: { message: SessionUpdateMessage; isCurrent: () => boolean }
) => void | Promise<void>

export class WalletConnectCommunicationClient extends CommunicationClient {
  protected readonly activeListeners: Map<string, MessageListener> = new Map()

  protected readonly channelOpeningListeners: Map<string, ChannelOpeningListener> = new Map()
  private pairingGeneration = 0
  private approvalQueue: Promise<void> = Promise.resolve()

  private static storageReset: Promise<void> | undefined
  private static readonly coreOwners = new WeakMap<Client['core'], object>()
  private static instance: WalletConnectCommunicationClient | undefined
  private readonly owners = new Set<object>()
  private readonly ownerListeners = new Map<object, Map<string, () => void>>()
  private retired = false
  private clientGeneration = 0
  private startup:
    | {
        promise: Promise<{ uri: string; topic: string } | undefined>
        cancel: () => void
      }
    | undefined
  private closing: Promise<void> | undefined
  private readonly storageOwners = new WeakMap<Client, WalletConnectStorageOwner>()
  private readonly initializingStorageOwners = new Set<WalletConnectStorageOwner>()
  private readonly suppliedCoreClaims = new WeakMap<Client, object>()
  private readonly proposalRetirements = new WeakMap<Client, ProposalRetirement>()
  private readonly exposedProposals = new WeakMap<Client, Set<ExposedProposal>>()
  private readonly clientDisposals = new WeakMap<Client, Promise<void>>()
  private readonly eventDisposers = new WeakMap<Client, (() => void)[]>()
  private closingSession: SessionTypes.Struct | undefined
  private closingClient: Client | undefined
  private closingSessionCleanup: Promise<void> | undefined
  public signClient: Client | undefined
  private signClientPromise: Promise<Client | undefined> | undefined
  private pairingRequestPromise: Promise<ExtendedWalletConnectPairingRequest> | undefined
  public storage: WCStorage = new WCStorage()
  private session: SessionTypes.Struct | undefined
  private activeAccountOrPbk: string | undefined
  private activeNetwork: string | undefined
  private accountUpdateGeneration: number = 0
  readonly disconnectionEvents: Set<string> = new Set()
  private pingInterval: NodeJS.Timeout | undefined

  private requestGeneration = 0
  private readonly pendingRequests = new Map<string, PendingRequest>()
  // Requests whose public caller already timed out. A real wallet reply is still delivered so
  // the dApp can report it; session teardown drops them without a synthetic error.
  private readonly detachedRequests = new Set<string>()

  /** Release transport ownership when the public caller settles or times out. */
  public cancelRequest(id: string): void {
    this.pendingRequests.delete(id)
    this.detachedRequests.delete(id)
    if (!this.pendingRequests.size) {
      this.stopPing()
    }
  }

  /**
   * Keep a timed-out request open for its late reply without settling it again on teardown.
   * A request not yet handed to sign-client is released instead, so the checks before sending
   * stop it: its caller was told the wallet did not respond.
   */
  public detachRequest(id: string): void {
    const request = this.pendingRequests.get(id)
    if (!request) {
      return
    }
    if (!request.sent) {
      this.cancelRequest(id)

      return
    }
    this.detachedRequests.add(id)
  }

  private ownsRequest(request: PendingRequest): boolean {
    return this.pendingRequests.get(request.id) === request
  }

  private clearRequests(keep?: PendingRequest): void {
    this.requestGeneration++
    for (const request of this.pendingRequests.values()) {
      if (request !== keep) {
        this.pendingRequests.delete(request.id)
        // A detached request's caller already settled; teardown is not a wallet answer.
        if (this.detachedRequests.delete(request.id)) {
          continue
        }
        // Adapter revocation must settle public callers even when their deadline
        // is disabled. Public timeout cancellation remains silent in cancelRequest.
        this.notifyListeners(request.topic, {
          id: request.id,
          type: BeaconMessageType.Error,
          errorType: BeaconErrorType.ABORTED_ERROR
        }).catch((error: unknown) => logger.warn('request revoked', getErrorDiagnostic(error)))
      }
    }
    this.stopPing()
  }

  private setSession(session: SessionTypes.Struct | undefined, keep?: PendingRequest): void {
    if (this.session?.topic !== session?.topic) {
      this.clearRequests(keep)
    }
    this.session = session
    if (this.closingSession?.topic !== session?.topic) {
      this.closingSession = undefined
    }
  }

  private async runRequest(
    id: string,
    execute: (pending: PendingRequest) => Promise<BeaconResponseInputMessage>
  ): Promise<void> {
    if (this.pendingRequests.has(id)) {
      return
    }
    const request: PendingRequest = { id, topic: this.session?.topic ?? '' }
    this.pendingRequests.set(id, request)
    let response: BeaconResponseInputMessage
    try {
      response = await execute(request)
    } catch (error: unknown) {
      logger.debug('request failed', getErrorDiagnostic(error))
      const failure = classifyRequestFailure(error)
      if (failure !== 'wallet' && this.detachedRequests.has(id)) {
        // The caller already timed out. Only a wallet answer is reported as a late response.
        if (this.ownsRequest(request)) {
          this.cancelRequest(id)
        }

        return
      }
      if (failure === 'expired') {
        response = expiredResponse(id)
      } else if (failure === 'wallet') {
        const parsed = parseJsonRpcErrorToBeaconError(error)
        response = {
          id,
          type: BeaconMessageType.Error,
          errorType: parsed.errorType,
          ...(parsed.errorData !== undefined ? { errorData: parsed.errorData } : {})
        }
      } else {
        response = { id, type: BeaconMessageType.Error, errorType: BeaconErrorType.ABORTED_ERROR }
      }
    }
    if (!this.ownsRequest(request)) {
      return
    }
    this.cancelRequest(id)
    await this.notifyListeners(this.session?.topic ?? request.topic, response)
  }

  /**
   * Tracks the last time session extension was attempted (Unix timestamp in seconds)
   * Used to prevent duplicate re-extension attempts that can cause relay conflicts
   */
  private lastExtensionAttempt: number = 0

  constructor(
    private readonly wcOptions: { network: NetworkType; opts: SignClientTypes.Options },
    private readonly isLeader: () => boolean | Promise<boolean>
  ) {
    super()
    this.storage.onMessageHandler = this.onStorageMessageHandler.bind(this)
    this.storage.onErrorHandler = this.onStorageErrorHandler.bind(this)
  }

  static getInstance(
    wcOptions: {
      network: NetworkType
      opts: SignClientTypes.Options
    },
    isLeader: () => boolean | Promise<boolean>,
    owner?: object
  ): WalletConnectCommunicationClient {
    if (!this.instance) {
      this.instance = new WalletConnectCommunicationClient(wcOptions, isLeader)
    }

    if (owner) {
      this.instance.owners.add(owner)
    }

    return this.instance
  }

  public async releaseOwner(owner: object, closeSession = true): Promise<void> {
    if (!this.owners.delete(owner) || this.retired) {
      return
    }
    for (const dispose of this.ownerListeners.get(owner)?.values() ?? []) {
      dispose()
    }
    this.ownerListeners.delete(owner)
    if (this.owners.size > 0) {
      return
    }
    this.retired = true
    if (WalletConnectCommunicationClient.instance === this) {
      WalletConnectCommunicationClient.instance = undefined
    }
    try {
      await (closeSession ? this.close() : this.closeSignClient())
    } finally {
      this.clearMessageListeners()
      this.storage.close()
      this.channelOpeningListeners.clear()
      this.eventHandlers.clear()
    }
  }

  private getTopicFromSession(session: SessionTypes.Struct): string {
    return session.topic
  }

  public async listenForEncryptedMessage(
    senderPublicKey: string,
    messageCallback: (message: string) => void | Promise<void>,
    sessionUpdateCallback?: SessionUpdateListener,
    owner?: object
  ): Promise<void> {
    if (this.activeListeners.has(senderPublicKey)) {
      return
    }

    const callbackFunction: MessageListener = async (message, update) => {
      if (update) {
        if (!update.isCurrent()) {
          return
        }
        if (sessionUpdateCallback) {
          await sessionUpdateCallback(update.message, update.isCurrent)

          return
        }
      }
      await messageCallback(message)
    }

    this.activeListeners.set(senderPublicKey, callbackFunction)
    if (owner) {
      this.addOwnerListener(owner, `message:${senderPublicKey}`, () => {
        if (this.activeListeners.get(senderPublicKey) === callbackFunction) {
          this.activeListeners.delete(senderPublicKey)
        }
      })
    }
  }

  public async listenForChannelOpening(
    messageCallback: ChannelOpeningListener,
    owner?: object
  ): Promise<void> {
    this.channelOpeningListeners.set('channelOpening', messageCallback)
    if (owner) {
      this.addOwnerListener(owner, 'channel', () => {
        if (this.channelOpeningListeners.get('channelOpening') === messageCallback) {
          this.channelOpeningListeners.delete('channelOpening')
        }
      })
    }
  }

  private addOwnerListener(owner: object, key: string, dispose: () => void): void {
    const listeners = this.ownerListeners.get(owner) ?? new Map<string, () => void>()
    listeners.set(key, dispose)
    this.ownerListeners.set(owner, listeners)
  }

  private clearMessageListeners(): void {
    this.activeListeners.clear()
    for (const listeners of this.ownerListeners.values()) {
      for (const key of listeners.keys()) {
        if (key.startsWith('message:')) {
          listeners.delete(key)
        }
      }
    }
  }

  public cancelPendingPairing(): void {
    this.pairingGeneration++
    this.pairingRequestPromise = undefined
  }

  /**
   * WC Sign client doesn't sync between intances, meaning that a dApp signClient instance state may
   * differ from a wallet state
   */
  private async refreshState() {
    const closing = this.closeSignClient()
    const generation = this.pairingGeneration
    await closing
    if (generation !== this.pairingGeneration) {
      return
    }

    const client = await this.getSignClient()
    if (!client || generation !== this.pairingGeneration || this.retired) {
      return
    }
    const lastIndex = client.session.keys.length - 1

    if (lastIndex > -1) {
      const restoredSession = client.session.get(client.session.keys[lastIndex])

      // Validate session is not stale
      const valid = await this.isSessionValid(restoredSession, client)
      if (generation !== this.pairingGeneration || this.signClient !== client) {
        return
      }
      if (valid) {
        this.setSession(restoredSession)
        this.updateStorageWallet(restoredSession)
        this.setDefaultAccountAndNetwork()
      } else {
        logger.warn('Restored session is stale during refresh, cleaning up')
        await this.cleanupStaleSession(restoredSession, client)
        if (generation === this.pairingGeneration && this.signClient === client) {
          this.clearState()
        }
      }
    } else {
      this.clearState()
    }
  }

  private clearEvents(signClient?: Client): void {
    const client = signClient ?? this.signClient
    if (!client) {
      return
    }
    const disposers = this.eventDisposers.get(client) ?? []
    this.eventDisposers.delete(client)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error: unknown) {
        logger.warn('listener cleanup', getErrorDiagnostic(error))
      }
    }
  }

  private onStorageMessageHandler(type: string) {
    if (this.retired || !this.isMobileOS()) {
      return
    }

    logger.debug('onStorageMessageHandler', type)

    if (type === 'RESET') {
      this.closeSignClient().catch((error: unknown) =>
        logger.warn('storage reset', getErrorDiagnostic(error))
      )

      return
    }

    this.refreshState()
  }

  private onStorageErrorHandler(data: unknown) {
    if (!this.retired) {
      logger.error('onStorageError', data)
    }
  }

  async unsubscribeFromEncryptedMessages(): Promise<void> {
    this.clearRequests()
    this.cancelPendingPairing()
    this.clearMessageListeners()
  }

  public async unsubscribeFromEncryptedMessage(senderPublicKey: string): Promise<void> {
    this.activeListeners.delete(senderPublicKey)
    for (const listeners of this.ownerListeners.values()) {
      listeners.delete(`message:${senderPublicKey}`)
    }
  }

  private revokeStartup(): void {
    this.cancelPendingPairing()
    this.startup?.cancel()
    this.startup = undefined
    this.clientGeneration++
    this.signClientPromise = undefined
    for (const owner of this.initializingStorageOwners) {
      owner
        .retire([])
        .catch((error: unknown) =>
          logger.warn('initialization storage cleanup', getErrorDiagnostic(error))
        )
    }
  }

  public closeSignClient(): Promise<void> {
    return this.stop(false)
  }

  private stop(closeSessions: boolean): Promise<void> {
    if (this.closing) {
      if (closeSessions && this.closingClient && !this.closingSessionCleanup) {
        this.closingSessionCleanup = this.closePairings(this.closingClient)

        return this.trackClosing(
          Promise.all([this.closing, this.closingSessionCleanup]).then(() => undefined)
        )
      }

      return this.closing
    }
    // Revoke admission before awaiting cleanup of the captured client.
    this.revokeStartup()
    this.clearRequests()
    const client = this.signClient
    this.signClient = undefined
    this.clearState()
    this.closingClient = client
    if (client && this.pendingProposals(client).length > 0) {
      return this.trackClosing(this.retireProposals(client, closeSessions))
    }
    this.closingSessionCleanup = client && closeSessions ? this.closePairings(client) : undefined
    const cleanup = async () => {
      try {
        await this.closingSessionCleanup
      } finally {
        if (client) {
          await this.disposeSignClient(client)
        }
      }
    }

    return this.trackClosing(cleanup())
  }

  private trackClosing(cleanup: Promise<void>): Promise<void> {
    const closing = cleanup.finally(() => {
      if (this.closing === closing) {
        this.closing = undefined
        this.closingClient = undefined
        this.closingSessionCleanup = undefined
      }
    })
    this.closing = closing

    return closing
  }

  private pendingProposals(client: Client): ExposedProposal[] {
    return [...(this.exposedProposals.get(client) ?? [])].filter((entry) => !entry.delivered)
  }

  private trackProposal(client: Client, topic: string): ExposedProposal | undefined {
    const proposal = client.proposal?.getAll().find((candidate) => candidate.pairingTopic === topic)
    if (!proposal) {
      return undefined
    }
    this.storageOwners.get(client)?.trackProposal(proposal)
    let complete: () => void = () => undefined
    const completion = new Promise<void>((resolve) => {
      complete = resolve
    })
    const entry: ExposedProposal = { proposal, completion, complete, delivered: false }
    const proposals = this.exposedProposals.get(client) ?? new Set<ExposedProposal>()
    proposals.add(entry)
    this.exposedProposals.set(client, proposals)

    return entry
  }

  private completeProposal(client: Client, entry?: ExposedProposal): void {
    if (!entry) {
      return
    }
    clearTimeout(entry.timer)
    this.exposedProposals.get(client)?.delete(entry)
    this.storageOwners.get(client)?.forgetProposal(entry.proposal.id)
    entry.complete()
  }

  private retireProposals(client: Client, closeSessions: boolean): Promise<void> {
    const existing = this.clientDisposals.get(client)
    if (existing) {
      const priorRetirement = this.proposalRetirements.get(client)
      if (closeSessions && priorRetirement && !priorRetirement.closeSessions) {
        priorRetirement.closeSessions = true
        this.storageOwners
          .get(client)
          ?.retire(
            priorRetirement.proposals.map((entry) => entry.proposal),
            [],
            priorRetirement.sessions.map((session) => session.topic)
          )
          .catch((error: unknown) =>
            logger.warn('proposal storage cleanup', getErrorDiagnostic(error))
          )
        priorRetirement.disconnecting = this.disconnectStoredTopics(
          client,
          priorRetirement.pairingTopics
        )

        return priorRetirement.disconnecting.then(() => undefined)
      }

      return existing
    }
    const proposals = this.pendingProposals(client)
    const pairingTopics = new Set(proposals.map((entry) => entry.proposal.pairingTopic))
    const sessions = client.session
      .getAll()
      .filter((session) => !pairingTopics.has(session.pairingTopic))
    const retirement = this.storageOwners.get(client)?.retire(
      proposals.map((entry) => entry.proposal),
      closeSessions ? [] : sessions,
      closeSessions ? sessions.map((session) => session.topic) : []
    )
    retirement?.catch((error: unknown) =>
      logger.warn('proposal storage cleanup', getErrorDiagnostic(error))
    )
    this.clearEvents(client)
    if (this.signClient === client) {
      this.signClient = undefined
      this.signClientPromise = undefined
      this.clientGeneration++
    }
    // Public ownership ends now; only the captured proposal intake remains until expiry.
    const released = Promise.resolve()
    this.clientDisposals.set(client, released)
    for (const entry of proposals) {
      entry.timer = setTimeout(
        () => this.completeProposal(client, entry),
        Math.max(0, entry.proposal.expiryTimestamp * 1000 - Date.now())
      )
    }
    const retirementState: ProposalRetirement = {
      proposals,
      pairingTopics,
      sessions,
      closeSessions,
      disconnecting: closeSessions
        ? this.disconnectStoredTopics(client, pairingTopics)
        : Promise.resolve(false)
    }
    this.proposalRetirements.set(client, retirementState)
    retirementState.disconnecting.catch((error: unknown) =>
      logger.warn('retiring session cleanup', getErrorDiagnostic(error))
    )
    Promise.all(proposals.map((entry) => entry.completion))
      .then(async () => {
        try {
          await retirementState.disconnecting
        } finally {
          await this.closeClientResources(client)
        }
      })
      .catch((error: unknown) => logger.warn('proposal relay cleanup', getErrorDiagnostic(error)))

    return released
  }

  private disposeSignClient(signClient: Client): Promise<void> {
    const pending = this.clientDisposals.get(signClient)
    if (pending) {
      return pending
    }
    if (this.pendingProposals(signClient).length > 0) {
      return this.retireProposals(signClient, false)
    }
    this.storageOwners
      .get(signClient)
      ?.retire([])
      .catch((error: unknown) => logger.warn('client storage cleanup', getErrorDiagnostic(error)))
    const disposal = this.closeClientResources(signClient)
    this.clientDisposals.set(signClient, disposal)

    return disposal
  }

  private async closeClientResources(signClient: Client): Promise<void> {
    try {
      await this.withTimeout(
        signClient.core.relayer.transportClose(),
        WALLETCONNECT_DISCONNECT_TIMEOUT_MS,
        'WalletConnect relayer transport close timed out.'
      )
    } catch (error: unknown) {
      logger.warn('relayer cleanup', getErrorDiagnostic(error))
    }
    const cleanup = [
      () => this.clearEvents(signClient),
      () => signClient.core.events.removeAllListeners(),
      () => signClient.core.relayer.events.removeAllListeners(),
      () => signClient.core.heartbeat.stop(),
      () => signClient.core.relayer.provider.events.removeAllListeners(),
      () => signClient.core.relayer.subscriber.events.removeAllListeners(),
      () => signClient.core.relayer.provider.connection.events.removeAllListeners()
    ]
    for (const dispose of cleanup) {
      try {
        dispose()
      } catch (error: unknown) {
        logger.warn('client cleanup', getErrorDiagnostic(error))
      }
    }
    const claim = this.suppliedCoreClaims.get(signClient)
    if (claim && WalletConnectCommunicationClient.coreOwners.get(signClient.core) === claim) {
      WalletConnectCommunicationClient.coreOwners.delete(signClient.core)
    }
  }

  private stopPing(): void {
    clearInterval(this.pingInterval)
    this.pingInterval = undefined
  }

  private async ping(): Promise<void> {
    const session = this.session
    const interval = this.pingInterval
    if (!session) {
      return
    }
    const client = await this.getSignClient()
    if (!client || this.session !== session || this.pingInterval !== interval) {
      return
    }
    try {
      await client.ping({ topic: session.topic })
    } catch (error: unknown) {
      if (this.session === session) {
        logger.debug('ping', getErrorDiagnostic(error))
      }
    } finally {
      // Reachability is not acknowledgement of any request. Old work cannot
      // stop the replacement session's readiness check.
      if (this.session === session && this.pingInterval === interval) {
        this.stopPing()
      }
    }
  }

  private checkWalletReadiness(): void {
    if (this.isMobileOS() || this.pingInterval) {
      return
    }
    this.pingInterval = setInterval(() => {
      this.ping().catch((error: unknown) => logger.debug('ping', getErrorDiagnostic(error)))
    }, 30000)
    this.ping().catch((error: unknown) => logger.debug('ping', getErrorDiagnostic(error)))
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async sendMessage(encoded: string, _peer?: unknown): Promise<void> {
    const generation = this.requestGeneration
    const topic = this.session?.topic ?? ''
    const listeners = [...this.activeListeners.values()]
    const decoded: unknown = await new Serializer().deserialize(encoded)
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      !('id' in decoded) ||
      typeof decoded.id !== 'string' ||
      !('type' in decoded) ||
      (decoded.type !== BeaconMessageType.PermissionRequest &&
        decoded.type !== BeaconMessageType.OperationRequest &&
        decoded.type !== BeaconMessageType.SignPayloadRequest)
    ) {
      return
    }
    if (generation !== this.requestGeneration) {
      await this.notifyListeners(
        topic,
        {
          id: decoded.id,
          type: BeaconMessageType.Error,
          errorType: BeaconErrorType.ABORTED_ERROR
        },
        listeners
      )

      return
    }
    // Serializer is the existing Beacon wire boundary. Dispatch only request types;
    // Disconnect and other notifications never acquire request ownership.
    const message = decoded as PermissionRequest | OperationRequest | SignPayloadRequest
    let delivery: Promise<void>
    switch (message.type) {
      case BeaconMessageType.PermissionRequest:
        delivery = this.requestPermissions(message)
        break
      case BeaconMessageType.OperationRequest:
        delivery = this.sendOperations(message)
        break
      case BeaconMessageType.SignPayloadRequest:
        delivery = this.signPayload(message)
        break
      default:
        return
    }
    delivery.catch((error: unknown) => logger.warn('sendMessage', getErrorDiagnostic(error)))
  }

  private async fetchAccounts(topic: string, chainId: string) {
    const signClient = await this.getSignClient()
    if (!signClient) {
      return
    }

    return signClient.request<
      [
        {
          algo: 'ed25519'
          address: string
          pubkey: string
        }
      ]
    >({
      topic,
      chainId,
      request: {
        method: PermissionScopeMethods.GET_ACCOUNTS,
        params: {}
      }
    })
  }

  private async getPermissionResponse(
    session: SessionTypes.Struct,
    network: Network,
    sessionEventId: string,
    request?: PendingRequest
  ) {
    let publicKey: string | undefined
    if (
      session.sessionProperties?.pubkey &&
      session.sessionProperties?.algo &&
      session.sessionProperties?.address
    ) {
      publicKey = session.sessionProperties?.pubkey
      logger.log(
        '[requestPermissions]: Have pubkey in sessionProperties, skipping "get_accounts" call',
        session.sessionProperties
      )
    } else {
      const accounts = this.getTezosNamespace(session.namespaces).accounts
      const addressOrPbk = accounts[0].split(':', 3)[2]

      if (isPublicKeySC(addressOrPbk)) {
        publicKey = addressOrPbk
      } else {
        if (network.type !== this.wcOptions.network) {
          throw new Error('Network in permission request is not the same as preferred network!')
        }

        const result = await this.fetchAccounts(
          session.topic,
          `${TEZOS_PLACEHOLDER}:${network.type}`
        )

        if (!result || result.length < 1) {
          throw new Error('No account shared by wallet')
        }

        if (result.some((account) => !account.pubkey)) {
          throw new Error('Public Key in `tezos_getAccounts` is empty!')
        }

        publicKey = result[0]?.pubkey
      }
    }

    if (!publicKey) {
      throw new Error('Public Key in `tezos_getAccounts` is empty!')
    }

    const permissionResponse: ImplicitPermissionResponseInput & {
      appMetadata: AppMetadata
      walletType: 'implicit'
    } = {
      type: BeaconMessageType.PermissionResponse,
      appMetadata: {
        senderId: this.getTopicFromSession(session),
        name: session.peer.metadata.name,
        icon: session.peer.metadata.icons[0]
      },
      publicKey,
      network,
      scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST],
      id: sessionEventId,
      walletType: 'implicit'
    }

    if (request) {
      if (!this.ownsRequest(request)) {
        throw new Error('Request no longer pending')
      }

      return permissionResponse
    }

    return permissionResponse
  }

  public async requestPermissions(message: PermissionRequest): Promise<void> {
    return this.runRequest(message.id, async (request) => {
      if (!this.getPermittedMethods().includes(PermissionScopeMethods.GET_ACCOUNTS)) {
        throw new MissingRequiredScope(PermissionScopeMethods.GET_ACCOUNTS)
      }
      if (this.activeAccountOrPbk) {
        await this.openSession(request)
      }
      if (!this.ownsRequest(request)) {
        throw new Error('Request no longer pending')
      }
      this.setDefaultAccountAndNetwork()

      return this.getPermissionResponse(this.getSession(), message.network, message.id, request)
    })
  }

  private async prepareRequest(request: PendingRequest, method: PermissionScopeMethods) {
    const session = this.getSession()
    const signClient = await this.getSignClient()
    if (!signClient) {
      throw new NotConnected()
    }
    if (!this.getPermittedMethods().includes(method)) {
      throw new MissingRequiredScope(method)
    }
    await this.checkAndExtendSession()
    const network = this.getActiveNetwork()
    const account = await this.getAccountOrPK()
    this.validateNetworkAndAccount(network, account)
    const address = isPublicKeySC(account) ? await getAddressFromPublicKey(account) : account
    if (!this.ownsRequest(request)) {
      throw new Error('Request no longer pending')
    }
    this.checkWalletReadiness()

    return { signClient, topic: session.topic, chainId: `${TEZOS_PLACEHOLDER}:${network}`, address }
  }

  public async signPayload(message: SignPayloadRequest): Promise<void> {
    return this.runRequest(message.id, async (request) => {
      const { signClient, topic, chainId, address } = await this.prepareRequest(
        request,
        PermissionScopeMethods.SIGN
      )
      if (!this.ownsRequest(request)) {
        throw new Error('Request no longer pending')
      }
      request.sent = true
      const response = await signClient.request<{ signature: string }>({
        topic,
        chainId,
        request: {
          method: PermissionScopeMethods.SIGN,
          params: { account: address, payload: message.payload }
        }
      })
      const result: SignPayloadResponseInput = {
        id: message.id,
        type: BeaconMessageType.SignPayloadResponse,
        signingType: message.signingType,
        signature: response.signature
      }

      return result
    })
  }

  public async sendOperations(message: OperationRequest): Promise<void> {
    return this.runRequest(message.id, async (request) => {
      const { signClient, topic, chainId, address } = await this.prepareRequest(
        request,
        PermissionScopeMethods.OPERATION_REQUEST
      )
      if (!this.ownsRequest(request)) {
        throw new Error('Request no longer pending')
      }
      request.sent = true
      const response = await signClient.request<{
        operationHash?: string
        transactionHash?: string
        hash?: string
      }>({
        topic,
        chainId,
        request: {
          method: PermissionScopeMethods.OPERATION_REQUEST,
          params: { account: address, operations: message.operationDetails }
        }
      })
      const result: OperationResponseInput = {
        id: message.id,
        type: BeaconMessageType.OperationResponse,
        transactionHash: response.operationHash ?? response.transactionHash ?? response.hash ?? ''
      }

      return result
    })
  }

  private isMobileSesion(session: SessionTypes.Struct): boolean {
    const redirect = session.peer.metadata.redirect
    if (!redirect?.native) {
      return false
    }

    return !redirect.native.includes('http') && !redirect.native.includes('ws')
  }
  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  private readLastSelectedWallet(): Record<string, unknown> | undefined {
    try {
      const raw = localStorage.getItem(StorageKey.LAST_SELECTED_WALLET)
      if (!raw) {
        return undefined
      }
      const parsed: unknown = JSON.parse(raw)

      return this.isRecord(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Function used to fix appSwitching with web wallets when pairing through 'Other wallet flow'
   * @param session the newly created session
   */
  private updateStorageWallet(session: SessionTypes.Struct): void {
    const selectedWallet = this.readLastSelectedWallet()

    if (!selectedWallet || typeof selectedWallet.key !== 'string' || !selectedWallet.key) {
      return
    }

    if (this.isMobileSesion(session)) {
      selectedWallet.type = 'mobile'
    } else {
      selectedWallet.type = 'web'
    }

    localStorage.setItem(StorageKey.LAST_SELECTED_WALLET, JSON.stringify(selectedWallet))
  }

  public init(forceNewConnection = false): Promise<{ uri: string; topic: string } | undefined> {
    if (this.retired) {
      return Promise.resolve(undefined)
    }
    if (this.startup && !forceNewConnection) {
      return this.startup.promise
    }
    this.startup?.cancel()
    const generation = ++this.pairingGeneration
    let cancel: () => void = () => undefined
    const cancelled = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined)
    })
    const promise = Promise.race([this.start(forceNewConnection, generation), cancelled]).finally(
      () => {
        if (this.startup?.promise === promise) {
          this.startup = undefined
        }
      }
    )
    this.startup = { promise, cancel }

    return promise
  }

  private async start(
    forceNewConnection: boolean,
    generation: number
  ): Promise<{ uri: string; topic: string } | undefined> {
    const isCurrent = () => !this.retired && generation === this.pairingGeneration
    if (this.closing) {
      await this.closing
    }
    if (!isCurrent()) {
      return
    }
    logger.warn('init')
    this.disconnectionEvents.size && this.disconnectionEvents.clear()

    if (forceNewConnection) {
      await this.closePairings()
      if (!isCurrent()) {
        return
      }
    }

    const signClient = await this.getSignClient()
    if (!isCurrent()) {
      return
    }

    if (!signClient) {
      throw new Error('Failed to connect to the relayer.')
    }
    const ownsClient = () => isCurrent() && this.signClient === signClient

    const lastIndex = signClient.session.keys.length - 1

    if (lastIndex > -1 && !forceNewConnection) {
      const restoredSession = signClient.session.get(signClient.session.keys[lastIndex])

      // Validate session is not stale
      const valid = await this.isSessionValid(restoredSession, signClient)
      if (!ownsClient()) {
        return
      }
      if (valid) {
        this.setSession(restoredSession)
        this.updateStorageWallet(restoredSession)
        this.setDefaultAccountAndNetwork()

        // Check if session needs extension (within 24 hours of expiry)
        await this.checkAndExtendSession()

        return undefined
      } else {
        logger.warn('Restored session is stale, cleaning up and creating new connection')
        await this.cleanupStaleSession(restoredSession, signClient)
        if (!ownsClient()) {
          return
        }
        // Fall through to create new connection below
      }
    }

    logger.warn('before create')

    const permissionScopeParams = this.getRequiredPermissionScopeParams()
    const optionalPermissionScopeParams = this.getOptionalPermissionScopeParams()

    const connectParams = {
      requiredNamespaces: {
        [TEZOS_PLACEHOLDER]: this.permissionScopeParamsToNamespaces(permissionScopeParams)
      },
      optionalNamespaces: {
        [TEZOS_PLACEHOLDER]: this.permissionScopeParamsToNamespaces(optionalPermissionScopeParams)
      },
      sessionProperties: {
        [BEACON_SDK_VERSION]: SDK_VERSION
      }
    }

    const proposal = signClient.connect(connectParams)
    let waiting = true
    let discarded = false
    const discardProposal = (candidate: Awaited<ReturnType<Client['connect']>>) => {
      if (discarded) {
        return
      }
      discarded = true
      candidate
        .approval()
        .then((session) => this.discardApproval(signClient, session))
        .catch(() => undefined)
    }
    proposal.then(
      (candidate) => {
        if (!waiting || !ownsClient()) {
          discardProposal(candidate)
        }
      },
      () => undefined
    )
    let connection: Awaited<ReturnType<Client['connect']>>
    try {
      connection = await this.withTimeout(
        proposal,
        WALLETCONNECT_CONNECT_TIMEOUT_MS,
        'The connection timed out.'
      )
    } catch (error: unknown) {
      waiting = false
      if (!ownsClient()) {
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`Init error: ${message}`)
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(StorageKey.WC_INIT_ERROR, message)
      }
      throw new Error(message)
    }
    if (!ownsClient()) {
      discardProposal(connection)

      return
    }
    const { uri, approval } = connection

    // Extract topic from uri. Format is wc:topic@2...
    const topic = getStringBetween(uri, ':', '@')

    if (!topic) {
      return
    }

    const exposed = this.trackProposal(signClient, topic)
    let hasResponse = false

    this.withTimeout(
      signClient.core.pairing.ping({ topic }),
      WALLETCONNECT_PAIRING_PING_TIMEOUT_MS,
      'WalletConnect pairing ping timed out.'
    )
      .then(async () => {
        if (!hasResponse && ownsClient()) {
          // Only show "waiting for acknowledge" message if pong arrives before response
          const fun = this.eventHandlers.get(ClientEvents.WC_ACK_NOTIFICATION)
          fun && fun('pending')
        }
      })
      .catch(() => undefined)

    const handledApproval = approval()
      .then(async (session) => {
        hasResponse = true
        if (exposed) {
          exposed.delivered = true
          clearTimeout(exposed.timer)
        }
        if (!ownsClient()) {
          await this.discardApproval(signClient, session)

          return undefined
        }
        // Finish rollback before another approval can persist the same wallet public key.
        const delivery = this.approvalQueue.then(async () => {
          if (!ownsClient()) {
            await this.discardApproval(signClient, session)

            return
          }

          try {
            this.validateReceivedNamespace(permissionScopeParams, session.namespaces)
          } catch (error: unknown) {
            if (this.session?.topic !== session.topic) {
              await this.discardApproval(signClient, session)
            }
            throw error
          }
          const previousSession = this.session
          this.setSession(session)
          const ownsSession = () => ownsClient() && this.session?.topic === session.topic
          const pairingResponse = new ExtendedWalletConnectPairingResponse(
            session.topic,
            session.peer.metadata.name,
            session.peer.publicKey,
            '3',
            session.topic,
            session.peer.metadata.name
          )

          let accepted = false
          try {
            for (const listener of this.channelOpeningListeners.values()) {
              if (!ownsSession()) {
                break
              }
              accepted = await listener(pairingResponse, ownsSession)
            }
          } finally {
            if (!accepted) {
              if (this.session?.topic === session.topic) {
                this.setSession(previousSession)
              }
              if (this.session?.topic !== session.topic) {
                await this.discardApproval(signClient, session)
              }
            }
          }
          if (accepted && this.session?.topic === session.topic) {
            this.updateStorageWallet(session)
          }

          return accepted
        })
        this.approvalQueue = delivery.then(
          () => undefined,
          () => undefined
        )

        return delivery
      })
      .catch(async (error: unknown) => {
        hasResponse = true
        if (!ownsClient()) {
          return
        }
        const diagnostic = getErrorDiagnostic(error)
        const message = typeof diagnostic === 'string' ? diagnostic : undefined
        if (!message || message.toLowerCase().includes('expir')) {
          const fun = this.eventHandlers.get(ClientEvents.CLOSE_ALERT)
          if (fun) {
            fun(TransportType.WALLETCONNECT)
          }

          return
        }

        logger.error('Error happened!', [diagnostic])

        if (this.activeListeners.size === 0) {
          logger.debug('No active listeners', [])
          const fun = this.eventHandlers.get(ClientEvents.WC_ACK_NOTIFICATION)
          fun && fun('error')
        }
      })
      .finally(() => this.completeProposal(signClient, exposed))
    handledApproval
      .then(async (accepted) => {
        // A declined proposal restored the previous session; it still owns its connection.
        if (!accepted) {
          return
        }
        const isLeader = await this.isLeader()
        if (ownsClient() && !isLeader && !this.isMobileOS()) {
          await this.closeSignClient()
          if (ownsClient()) {
            this.clearState()
          }
        }
      })
      .catch((error: unknown) => logger.warn('approval completion', getErrorDiagnostic(error)))

    logger.warn('return uri and topic')

    return { uri: uri ?? '', topic }
  }

  private async discardApproval(signClient: Client, session: SessionTypes.Struct): Promise<void> {
    try {
      await this.withTimeout(
        signClient.disconnect({ topic: session.topic, reason: getSdkError('USER_DISCONNECTED') }),
        WALLETCONNECT_DISCONNECT_TIMEOUT_MS,
        'WalletConnect discarded approval disconnect timed out.'
      )
    } catch (error) {
      logger.warn('discardApproval', getErrorDiagnostic(error))
    }
  }

  public close(): Promise<void> {
    if (this.signClient && this.pendingProposals(this.signClient).length > 0) {
      const stopping = this.stop(true)
      this.clearMessageListeners()

      return stopping
    }
    // An idle desktop proposal can reuse its relay connection for the next URI.
    if (
      !this.retired &&
      !this.startup &&
      !this.closing &&
      this.signClient &&
      this.signClient.session.getAll().length === 0 &&
      this.signClient.pairing.getAll().length === 0 &&
      !this.isMobileOS()
    ) {
      this.cancelPendingPairing()
      this.clearState()
      this.clearMessageListeners()

      return Promise.resolve()
    }
    const closing = this.stop(true)
    this.clearMessageListeners()

    return closing
  }

  private subscribeToSessionEvents(signClient: Client): void {
    const generation = this.clientGeneration
    const isCurrent = () =>
      !this.retired && this.clientGeneration === generation && this.signClient === signClient
    const disposers: (() => void)[] = []
    this.eventDisposers.set(signClient, disposers)
    const on = <E extends SignClientTypes.Event>(
      event: E,
      callback: (args: SignClientTypes.EventArguments[E]) => void
    ) => {
      signClient.on(event, callback)
      disposers.push(() => signClient.off?.(event, callback))
    }
    const onPairing = (event: string, callback: (args: { topic: string }) => void) => {
      signClient.core.pairing.events.on(event, callback)
      disposers.push(() => signClient.core.pairing.events.off?.(event, callback))
    }
    const relayer = signClient.core.relayer
    const reportRelayerCallbackError = (error: unknown): void =>
      logger.warn('relayer error callback', getErrorDiagnostic(error))
    const onRelayerError = (event: unknown): void => {
      if (!isCurrent()) {
        return
      }
      try {
        logger.error('subscribeToSessionEvents', event)
        const diagnostic = getErrorDiagnostic(event)
        if (typeof diagnostic === 'string' && diagnostic.includes('JWT validation error')) {
          const notify = this.eventHandlers.get(ClientEvents.ON_RELAYER_ERROR)
          const notification: unknown = notify?.(TransportType.WALLETCONNECT)
          Promise.resolve(notification).catch(reportRelayerCallbackError)
        }
      } catch (error: unknown) {
        reportRelayerCallbackError(error)
      } finally {
        // Application callbacks may synchronously retire this client.
        if (isCurrent()) {
          this.close().catch((error: unknown) =>
            logger.warn('relayer error cleanup', getErrorDiagnostic(error))
          )
        }
      }
    }
    // WalletConnect retains its own fatal-provider handling and transport cleanup.
    relayer.on('relayer_error', onRelayerError)
    disposers.push(() => relayer.off('relayer_error', onRelayerError))

    on('session_event', () => {
      // Legacy requestAcknowledged events have no required Beacon request ID.
      // Ignore them, including their unrelated outer event IDs. Public request
      // deadlines stay active; correlated ACKs require negotiated wallet support.
    })

    on('session_update', (event) => {
      if (
        !isCurrent() ||
        this.session?.topic !== event.topic ||
        this.closingSession?.topic === event.topic
      ) {
        return
      }
      const session = signClient.session.get(event.topic)

      if (!session) {
        logger.warn('session_update', 'topic does not exist')

        return
      }

      this.setSession(session)

      this.updateActiveAccount(this.getTezosNamespace(event.params.namespaces).accounts, session)
    })

    on('session_delete', (event) => {
      if (
        !isCurrent() ||
        this.session?.topic !== event.topic ||
        this.closingSession?.topic === event.topic
      ) {
        return
      }
      this.disconnectionEvents.add('session_delete')
      this.disconnect(signClient, {
        type: 'session',
        topic: event.topic,
        reason: 'session_deleted'
      }).catch(
        (error: unknown) => {
          logger.warn(
            'session_delete handler',
            error instanceof Error ? error.message : String(error)
          )
        }
      )
    })

    on('session_expire', (event) => {
      if (
        !isCurrent() ||
        this.session?.topic !== event.topic ||
        this.closingSession?.topic === event.topic
      ) {
        return
      }
      this.disconnectionEvents.add('session_expire')
      this.disconnect(signClient, {
        type: 'session',
        topic: event.topic,
        reason: 'session_expired'
      }).catch(
        (error: unknown) => {
          logger.warn(
            'session_expire handler',
            error instanceof Error ? error.message : String(error)
          )
        }
      )
    })
    onPairing('pairing_delete', (event) => {
      logger.debug('Pairing deleted', { topic: event.topic })
      // Don't disconnect session - pairings can be deleted while sessions remain active
      // Sessions communicate directly through the relay after initial pairing
    })
    onPairing('pairing_expire', (event) => {
      logger.debug('Pairing expired', { topic: event.topic })
      // Don't disconnect session - pairings expire, but sessions can outlive them. Only disconnect on session_expire/session_delete
    })

    on('proposal_expire', (event) => {
      logger.debug('Session proposal expired', event.id)
    })

    on('session_extend', (event) => {
      if (
        !isCurrent() ||
        this.session?.topic !== event.topic ||
        this.closingSession?.topic === event.topic
      ) {
        return
      }
      logger.debug('Session extended', event.topic)
      // Session was extended by 7 days
      // Update our session reference if it matches
      if (this.session && this.session.topic === event.topic) {
        const updatedSession = signClient.session.get(event.topic)
        if (updatedSession) {
          this.setSession(updatedSession)
          logger.log('Active session extended, new expiry:', new Date(updatedSession.expiry * 1000))
        }
      }
    })
  }

  private async updateActiveAccount(accounts: string[], session: SessionTypes.Struct) {
    const generation = ++this.accountUpdateGeneration
    const signClient = this.signClient
    const sessionGeneration = this.requestGeneration
    const isCurrent = () =>
      this.signClient === signClient &&
      this.session === session &&
      this.requestGeneration === sessionGeneration &&
      this.accountUpdateGeneration === generation
    try {
      if (!isCurrent()) {
        return
      }
      if (accounts.length) {
        const [_namespace, chainId, addressOrPbk] = accounts[0].split(':', 3)
        let publicKey: string | undefined

        if (!isPublicKeySC(addressOrPbk)) {
          const token = accounts[1] ? accounts[1].split(':', 3)[2] : ''
          if (isPublicKeySC(token)) {
            publicKey = token
          } else {
            const result = await this.fetchAccounts(
              session.topic,
              `${TEZOS_PLACEHOLDER}:${chainId}`
            )
            publicKey = result?.find(({ address: _address }) => addressOrPbk === _address)?.pubkey
          }
        } else {
          publicKey = addressOrPbk
        }

        if (!isCurrent()) {
          return
        }

        if (!publicKey) {
          throw new Error('Public key for the new account not provided')
        }

        const id = await generateGUID()
        if (!isCurrent()) {
          return
        }
        this.activeNetwork = chainId
        this.activeAccountOrPbk = addressOrPbk

        await this.notifySessionUpdate(
          session,
          {
            id,
            type: BeaconMessageType.ChangeAccountRequest,
            publicKey,
            network: { type: chainId as NetworkType },
            scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST],
            walletType: 'implicit'
          },
          isCurrent
        )
      } else {
        const response = await this.getPermissionResponse(
          session,
          {
            type: this.wcOptions.network
          },
          'session_update'
        )
        await this.notifySessionUpdate(session, response, isCurrent)
      }
    } catch {}
  }

  private async disconnect(
    signClient: Client,
    trigger: { type: 'session'; topic: string; reason?: 'session_deleted' | 'session_expired' }
  ) {
    if (this.signClient !== signClient || this.session?.topic !== trigger.topic) {
      return
    }
    if (this.closingSession?.topic === trigger.topic) {
      return
    }
    const session = this.session
    this.closingSession = session
    this.clearRequests()
    await this.onSessionClosed(signClient, trigger.topic)
    if (this.session !== session || this.signClient !== signClient) {
      return
    }
    const resetPairing = !this.activeAccountOrPbk
    this.clearState()
    if (trigger.reason) {
      const onTransportStatus = this.eventHandlers.get(ClientEvents.TRANSPORT_STATUS)
      if (onTransportStatus) {
        await onTransportStatus({
          status: TransportStatus.NOT_CONNECTED,
          reason: trigger.reason
        })
      }
    }
    if (resetPairing) {
      const reset = this.eventHandlers.get(ClientEvents.RESET_STATE)
      if (reset) {
        reset(TransportType.WALLETCONNECT)
      }
    }
    await this.notifyListeners(session.topic, {
      id: await generateGUID(),
      type: BeaconMessageType.Disconnect
    })
  }

  private async onSessionClosed(
    signClient: Client,
    sessionTopic: string
  ): Promise<SessionTypes.Struct | undefined> {
    if (!this.session || this.session.topic !== sessionTopic) {
      return undefined
    }

    const session = this.session
    const pairingTopic = session.pairingTopic ?? signClient.core.pairing.getPairings()[0]?.topic

    if (pairingTopic) {
      // eslint-disable-next-line no-void
      void this.withTimeout(
        signClient.core.pairing.disconnect({ topic: pairingTopic }),
        WALLETCONNECT_DISCONNECT_TIMEOUT_MS,
        'WalletConnect pairing disconnect on session close timed out.'
      ).catch((error: unknown) => {
        logger.warn(error instanceof Error ? error.message : String(error))
      })
    }

    return session
  }

  public async getPairingRequestInfo(): Promise<ExtendedWalletConnectPairingRequest> {
    if (!this.pairingRequestPromise) {
      const request = this.createPairingRequestInfo().finally(() => {
        if (this.pairingRequestPromise === request) {
          this.pairingRequestPromise = undefined
        }
      })
      this.pairingRequestPromise = request
    }

    return this.pairingRequestPromise
  }

  private async createPairingRequestInfo(): Promise<ExtendedWalletConnectPairingRequest> {
    let _uri = ''
    let _topic = ''
    try {
      logger.warn('getPairingRequestInfo')
      const { uri, topic } = (await this.init(true)) ?? { uri: '', topic: '' }
      _uri = uri
      _topic = topic
    } catch (error: unknown) {
      logger.warn(error instanceof Error ? error.message : String(error))
    }

    return new ExtendedWalletConnectPairingRequest(
      _topic,
      'WalletConnect',
      await generateGUID(),
      BEACON_VERSION,
      await generateGUID(),
      _uri
    )
  }

  private async disconnectStoredTopics(
    client: Client,
    excludedPairings = new Set<string>()
  ): Promise<boolean> {
    const closedSessions = await this.closeSessions(client, excludedPairings)
    const pairings = (client.pairing.getAll() ?? []).filter(
      (pairing) => !excludedPairings.has(pairing.topic)
    )
    await Promise.allSettled(
      pairings.map((pairing) =>
        this.withTimeout(
          client.disconnect({
            topic: pairing.topic,
            reason: { code: 0, message: 'Force new connection' }
          }),
          WALLETCONNECT_DISCONNECT_TIMEOUT_MS,
          'WalletConnect pairing disconnect timed out.'
        )
      )
    )

    return closedSessions || pairings.length > 0
  }

  private async closePairings(client = this.signClient) {
    if (!client) {
      return
    }
    if (this.pendingProposals(client).length > 0) {
      await this.retireProposals(client, true)

      return
    }
    const pairingGeneration = this.pairingGeneration
    const closedTopics = await this.disconnectStoredTopics(client)
    if (closedTopics || this.isMobileOS()) {
      const ownsCleanup = this.signClient === client || this.closingClient === client
      if (this.signClient === client) {
        this.clientGeneration++
        this.signClient = undefined
        this.signClientPromise = undefined
      }
      const generation = this.clientGeneration
      const isCurrent = () =>
        ownsCleanup &&
        !this.retired &&
        !this.signClient &&
        generation === this.clientGeneration &&
        pairingGeneration === this.pairingGeneration
      await this.disposeSignClient(client)
      if (this.isMobileOS() && isCurrent()) {
        const reset = this.storage.resetState()
        WalletConnectCommunicationClient.storageReset = reset
        try {
          await reset
        } finally {
          if (WalletConnectCommunicationClient.storageReset === reset) {
            WalletConnectCommunicationClient.storageReset = undefined
          }
        }
        if (isCurrent()) {
          this.storage.notify('RESET')
        }
      }
    }
  }

  private async closeSessions(
    signClient = this.signClient,
    excludedPairings = new Set<string>()
  ): Promise<boolean> {
    if (!signClient) {
      return false
    }

    const sessions = (signClient.session.getAll() ?? []).filter(
      (session) => !excludedPairings.has(session.pairingTopic)
    )
    if (sessions.length) {
      await Promise.allSettled(
        sessions.map((session) =>
          this.withTimeout(
            signClient.disconnect({
              topic: session.topic,
              reason: {
                code: 0, // TODO: Use constants
                message: 'Force new connection'
              }
            }),
            WALLETCONNECT_DISCONNECT_TIMEOUT_MS,
            'WalletConnect session disconnect timed out.'
          )
        )
      )
    }

    if (this.signClient === signClient) {
      this.clearState()
    }

    return sessions.length > 0
  }

  private async openSession(request?: PendingRequest): Promise<SessionTypes.Struct> {
    const signClient = await this.getSignClient()
    if (!signClient) {
      throw new NotConnected()
    }
    const generation = this.pairingGeneration
    const isCurrent = () =>
      this.signClient === signClient &&
      generation === this.pairingGeneration &&
      (!request || this.ownsRequest(request))
    if (!isCurrent()) {
      throw new Error('Permission request no longer pending')
    }
    const required = this.getRequiredPermissionScopeParams()
    const optional = this.getOptionalPermissionScopeParams()
    const pairingTopic = signClient.core.pairing.getPairings()[0]?.topic
    this.checkWalletReadiness()
    const { approval } = await this.withTimeout(
      signClient.connect({
        requiredNamespaces: {
          [TEZOS_PLACEHOLDER]: this.permissionScopeParamsToNamespaces(required)
        },
        optionalNamespaces: {
          [TEZOS_PLACEHOLDER]: this.permissionScopeParamsToNamespaces(optional)
        },
        sessionProperties: { [BEACON_SDK_VERSION]: SDK_VERSION },
        pairingTopic
      }),
      WALLETCONNECT_CONNECT_TIMEOUT_MS,
      'WalletConnect connection timed out.'
    )
    let approved: SessionTypes.Struct | undefined
    try {
      approved = await this.withTimeout<SessionTypes.Struct>(
        approval().then(async (session) => {
          // Keep observing approval after the deadline so an abandoned remote
          // session is deleted. Never delete an already-active refresh session.
          if (!isCurrent()) {
            if (this.session?.topic !== session.topic) {
              await this.discardApproval(signClient, session)
            }
            throw new Error('Permission request no longer pending')
          }

          return session
        }),
        WALLETCONNECT_SESSION_APPROVAL_TIMEOUT_MS,
        'WalletConnect session approval timed out.'
      )
      if (!isCurrent()) {
        throw new Error('Permission request no longer pending')
      }
      this.validateReceivedNamespace(required, approved.namespaces)
      if (this.session?.topic !== approved.topic && this.activeAccountOrPbk) {
        try {
          await this.closeActiveSession(this.activeAccountOrPbk, false, request)
        } catch (error: unknown) {
          // Local ownership was already cleared. A stale remote close must not
          // discard a separately validated approval for the replacement session.
          logger.warn('closing previous permission session', getErrorDiagnostic(error))
        }
      }
      if (!isCurrent()) {
        throw new Error('Permission request no longer pending')
      }
      this.setSession(approved, request)

      return approved
    } catch (error: unknown) {
      if (approved && this.session?.topic !== approved.topic) {
        await this.discardApproval(signClient, approved)
      }
      throw error
    }
  }

  private getRequiredPermissionScopeParams(): PermissionScopeParam {
    return {
      networks: [this.wcOptions.network],
      events: [],
      methods: [
        PermissionScopeMethods.GET_ACCOUNTS,
        PermissionScopeMethods.OPERATION_REQUEST,
        PermissionScopeMethods.SIGN
      ]
    }
  }

  private getOptionalPermissionScopeParams(): PermissionScopeParam {
    return {
      networks: [this.wcOptions.network],
      events: [PermissionScopeEvents.REQUEST_ACKNOWLEDGED],
      methods: []
    }
  }

  private permissionScopeParamsToNamespaces(
    permissionScopeParams: PermissionScopeParam
  ): ProposalTypes.BaseRequiredNamespace {
    return {
      chains: permissionScopeParams.networks.map((network) => `${TEZOS_PLACEHOLDER}:${network}`),
      methods: permissionScopeParams.methods,
      events: permissionScopeParams.events ?? []
    }
  }

  private validateReceivedNamespace(
    scope: PermissionScopeParam,
    receivedNamespaces: Record<string, SessionTypes.Namespace>
  ) {
    if (receivedNamespaces[TEZOS_PLACEHOLDER]) {
      this.validateMethods(scope.methods, receivedNamespaces[TEZOS_PLACEHOLDER].methods)
      if (scope.events) {
        this.validateEvents(scope.events, receivedNamespaces.tezos.events)
      }
      this.validateAccounts(scope.networks, receivedNamespaces[TEZOS_PLACEHOLDER].accounts)
    } else {
      throw new InvalidReceivedSessionNamespace(
        'All namespaces must be approved',
        getSdkError('USER_REJECTED').code,
        'incomplete',
        'tezos'
      )
    }
  }

  private validateMethods(requiredMethods: string[], receivedMethods: string[]) {
    const missingMethods: string[] = []
    requiredMethods.forEach((method) => {
      if (!receivedMethods.includes(method)) {
        missingMethods.push(method)
      }
    })
    if (missingMethods.length > 0) {
      throw new InvalidReceivedSessionNamespace(
        'All methods must be approved',
        getSdkError('USER_REJECTED_METHODS').code,
        'incomplete',
        missingMethods
      )
    }
  }

  private validateEvents(requiredEvents: string[], receivedEvents: string[]) {
    const missingEvents: string[] = []
    requiredEvents.forEach((method) => {
      if (!receivedEvents.includes(method)) {
        missingEvents.push(method)
      }
    })
    if (missingEvents.length > 0) {
      throw new InvalidReceivedSessionNamespace(
        'All events must be approved',
        getSdkError('USER_REJECTED_EVENTS').code,
        'incomplete',
        missingEvents
      )
    }
  }

  private validateAccounts(requiredNetwork: string[], receivedAccounts: string[]) {
    if (receivedAccounts.length === 0) {
      throw new InvalidReceivedSessionNamespace(
        'Accounts must not be empty',
        getSdkError('USER_REJECTED_CHAINS').code,
        'incomplete'
      )
    }
    const receivedChains: string[] = []
    const invalidChains: string[] = []
    const missingChains: string[] = []
    const invalidChainsNamespace: string[] = []

    receivedAccounts.forEach((chain) => {
      const accountId = chain.split(':')
      if (accountId.length !== 3) {
        invalidChains.push(chain)
      }
      if (accountId[0] !== TEZOS_PLACEHOLDER) {
        invalidChainsNamespace.push(chain)
      }
      const network = accountId[1]
      if (!receivedChains.includes(network)) {
        receivedChains.push(network)
      }
    })

    if (invalidChains.length > 0) {
      throw new InvalidReceivedSessionNamespace(
        'Accounts must be CAIP-10 compliant',
        getSdkError('USER_REJECTED_CHAINS').code,
        'invalid',
        invalidChains
      )
    }

    if (invalidChainsNamespace.length > 0) {
      throw new InvalidReceivedSessionNamespace(
        'Accounts must be defined in matching namespace',
        getSdkError('UNSUPPORTED_ACCOUNTS').code,
        'invalid',
        invalidChainsNamespace
      )
    }
    requiredNetwork.forEach((network) => {
      if (!receivedChains.includes(network)) {
        missingChains.push(network)
      }
    })
    if (missingChains.length > 0) {
      throw new InvalidReceivedSessionNamespace(
        'All chains must have at least one account',
        getSdkError('USER_REJECTED_CHAINS').code,
        'incomplete',
        missingChains
      )
    }
  }

  public async closeActiveSession(account: string, notify: boolean = true, keep?: PendingRequest) {
    try {
      this.validateNetworkAndAccount(this.getActiveNetwork(), account)
    } catch (error: unknown) {
      logger.error('closeActiveSession', getErrorDiagnostic(error))

      return
    }

    const session = this.getSession()

    const signClient = this.signClient
    this.clearState(keep)
    let notificationFailure: { error: unknown } | undefined
    try {
      if (notify) {
        await this.notifyListeners(session.topic, {
          type: BeaconMessageType.Disconnect,
          id: await generateGUID()
        })
      }
    } catch (error: unknown) {
      notificationFailure = { error }
    }

    try {
      if (signClient) {
        await this.withTimeout(
          signClient.disconnect({
            topic: session.topic,
            reason: {
              code: 0, // TODO: Use constants
              message: 'Force new connection'
            }
          }),
          WALLETCONNECT_DISCONNECT_TIMEOUT_MS,
          'WalletConnect active session disconnect timed out.'
        )
      }
    } catch (error: unknown) {
      if (!notificationFailure) {
        throw error
      }
      // Preserve the original notification rejection without hiding cleanup failure.
      logger.warn('closeActiveSession cleanup', getErrorDiagnostic(error))
    }
    if (notificationFailure) {
      throw notificationFailure.error
    }
  }

  private validateNetworkAndAccount(network: string, account: string) {
    if (!this.getTezosNamespace().accounts.includes(`${TEZOS_PLACEHOLDER}:${network}:${account}`)) {
      throw new InvalidNetworkOrAccount(network, account)
    }
  }
  /**
   * @description Access the active network
   * @error ActiveNetworkUnspecified thorwn when there are multiple Tezos networks in the session and none is set as the active one
   */
  getActiveNetwork() {
    if (!this.activeNetwork) {
      this.getSession()
      throw new ActiveNetworkUnspecified()
    }

    return this.activeNetwork
  }

  private setDefaultAccountAndNetwork() {
    const activeAccount = this.getAccounts()
    if (activeAccount.length) {
      this.activeAccountOrPbk = activeAccount[0]
    }
    const activeNetwork = this.getNetworks()
    if (activeNetwork.length) {
      this.activeNetwork = activeNetwork[0]
    }
  }

  /**
   * @description Return all connected accounts from the active session
   * @error NotConnected if no active session
   */
  getAccounts() {
    return this.getTezosNamespace().accounts.map((account) => account.split(':')[2])
  }

  /**
   * @description Return all networks from the namespace of the active session
   * @error NotConnected if no active session
   */
  getNetworks() {
    return this.getPermittedNetwork()
  }
  private getTezosNamespace(namespaces: SessionTypes.Namespaces = this.getSession().namespaces): {
    accounts: string[]
    methods: string[]
    events: string[]
  } {
    if (TEZOS_PLACEHOLDER in namespaces) {
      return namespaces[TEZOS_PLACEHOLDER]
    } else {
      throw new InvalidSession('Tezos not found in namespaces')
    }
  }
  private getPermittedMethods() {
    return this.getTezosRequiredNamespace().methods
  }

  private getPermittedNetwork() {
    return this.getTezosRequiredNamespace().chains.map((chain) => chain.split(':')[1])
  }

  private getTezosRequiredNamespace(): {
    chains: string[]
    methods: string[]
    events: string[]
  } {
    return {
      chains: [`${TEZOS_PLACEHOLDER}:${this.wcOptions.network}`],
      events: [],
      methods: ['tezos_getAccounts', 'tezos_send', 'tezos_sign']
    }
    // if (TEZOS_PLACEHOLDER in this.getSession().requiredNamespaces) {
    //   return this.getSession().requiredNamespaces[TEZOS_PLACEHOLDER] as {
    //     chains: string[]
    //     methods: string[]
    //     events: string[]
    //   }
    // } else {
    //   throw new InvalidSession('Tezos not found in requiredNamespaces')
    // }
  }

  private async notifyListeners(
    topic: string,
    partialResponse: BeaconInputMessage,
    listeners: MessageListener[] = [...this.activeListeners.values()]
  ) {
    const response: BeaconBaseMessage = {
      ...partialResponse,
      version: '2',
      senderId: topic
    }
    // Capture recipients before yielding: teardown may remove these listeners,
    // and a replacement session must not receive the old session's delivery.
    const serializer = new Serializer()
    const serialized = await serializer.serialize(response)

    await Promise.all(listeners.map(async (listener) => listener(serialized)))
  }

  private async notifySessionUpdate(
    session: SessionTypes.Struct,
    partialMessage:
      | Omit<PermissionResponse, IgnoredResponseInputProperties>
      | Omit<ChangeAccountRequest, IgnoredResponseInputProperties>,
    isCurrent: () => boolean
  ): Promise<void> {
    if (!isCurrent()) {
      return
    }
    const message: SessionUpdateMessage = {
      ...partialMessage,
      version: '2',
      senderId: session.topic
    }
    const listeners = [...this.activeListeners.values()]
    const serialized = await new Serializer().serialize(message)
    if (!isCurrent()) {
      return
    }
    // Existing observers retain the wire envelope; the dApp receives an owned update.
    await Promise.all(
      listeners.map(async (listener) => listener(serialized, { message, isCurrent }))
    )
  }

  public currentSession(): SessionTypes.Struct | undefined {
    return this.session
  }

  private async tryConnectToRelayer(generation = this.clientGeneration) {
    const core = this.wcOptions.opts.core
    if (core) {
      if (WalletConnectCommunicationClient.coreOwners.has(core)) {
        throw new InitializationUnavailable(
          'WalletConnect Core is still owned by another client lifetime.'
        )
      }
      const claim = {}
      WalletConnectCommunicationClient.coreOwners.set(core, claim)

      return this.initSignClientWithTimeout(this.wcOptions.opts.relayUrl, generation, claim)
    }
    const urls = new Set([
      this.wcOptions.opts.relayUrl,
      undefined,
      'wss://relay.walletconnect.com',
      'wss://relay.walletconnect.org',
      'wss://us-east-1.relay.walletconnect.com',
      'wss://eu-central-1.relay.walletconnect.com',
      'wss://ap-southeast-1.relay.walletconnect.com'
    ])
    const errMessages = new Set<string>()

    for (const relayUrl of urls) {
      if (generation !== this.clientGeneration || this.retired) {
        return undefined
      }
      try {
        return await this.initSignClientWithTimeout(relayUrl, generation)
      } catch (error: unknown) {
        if (error instanceof InitializationUnavailable) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        errMessages.add(message)
        logger.warn(`Failed to connect to ${relayUrl}: ${message}`)
      }
    }

    throw new Error(`Failed to connect to relayer: ${Array.from(errMessages).join(',')}`)
  }

  private createStorageOwner(): WalletConnectStorageOwner {
    const core = this.wcOptions.opts.core
    const backing =
      core?.storage ??
      this.wcOptions.opts.storage ??
      new KeyValueStorage({ database: ':memory:', ...this.wcOptions.opts.storageOptions })
    const prefix =
      core?.customStoragePrefix ??
      (this.wcOptions.opts.customStoragePrefix ? `:${this.wcOptions.opts.customStoragePrefix}` : '')
    const domain = core || this.wcOptions.opts.storage ? undefined : 'walletconnect-default-storage'

    return new WalletConnectStorageOwner(backing, prefix, domain)
  }

  private async initSignClientWithTimeout(
    relayUrl: string | undefined,
    generation: number,
    claim?: object
  ): Promise<Client> {
    const core = this.wcOptions.opts.core
    const originalStorage = core?.storage
    let installedOwner: WalletConnectStorageOwner | undefined
    let owner: WalletConnectStorageOwner
    let initialization: Promise<Client>
    try {
      owner = this.createStorageOwner()
      const handoff = WalletConnectStorageOwner.pendingHandoff(owner)
      if (handoff) {
        try {
          await handoff
        } catch (error: unknown) {
          logger.warn('storage handoff', getErrorDiagnostic(error))
          throw new InitializationUnavailable(
            'WalletConnect storage cleanup must complete before initialization.'
          )
        }
      }
      if (generation !== this.clientGeneration || this.retired) {
        throw new Error('WalletConnect initialization was stopped.')
      }
      if (core) {
        core.storage = owner
        installedOwner = owner
      }
      this.initializingStorageOwners.add(owner)
      initialization = Client.init({ ...this.wcOptions.opts, relayUrl, storage: owner })
    } catch (error: unknown) {
      if (core && installedOwner && core.storage === installedOwner && originalStorage) {
        core.storage = originalStorage
        this.initializingStorageOwners.delete(installedOwner)
      }
      if (core && WalletConnectCommunicationClient.coreOwners.get(core) === claim) {
        WalletConnectCommunicationClient.coreOwners.delete(core)
      }
      throw error
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    let expired = false
    initialization.then(
      (client) => {
        this.initializingStorageOwners.delete(owner)
        this.storageOwners.set(client, owner)
        if (claim) {
          this.suppliedCoreClaims.set(client, claim)
        }
        if (expired || generation !== this.clientGeneration || this.retired) {
          this.disposeSignClient(client).catch((error: unknown) =>
            logger.warn('late client cleanup', getErrorDiagnostic(error))
          )
        }
      },
      () => {
        this.initializingStorageOwners.delete(owner)
        owner
          .retire([])
          .catch((error: unknown) =>
            logger.warn('initialization storage cleanup', getErrorDiagnostic(error))
          )
        if (core && WalletConnectCommunicationClient.coreOwners.get(core) === claim) {
          WalletConnectCommunicationClient.coreOwners.delete(core)
        }
      }
    )
    try {
      return await Promise.race([
        initialization,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            expired = true
            owner
              .retire([])
              .catch((error: unknown) =>
                logger.warn('initialization storage cleanup', getErrorDiagnostic(error))
              )
            reject(new Error('WalletConnect initialization timed out.'))
          }, WALLETCONNECT_INIT_TIMEOUT_MS)
        })
      ])
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }

  private async getSignClient(): Promise<Client | undefined> {
    const generation = this.clientGeneration
    if (this.closing) {
      await this.closing
    }
    const reset = WalletConnectCommunicationClient.storageReset
    if (reset) {
      await reset.catch((error: unknown) =>
        logger.warn('storage cleanup', getErrorDiagnostic(error))
      )
    }
    if (this.retired || generation !== this.clientGeneration) {
      return undefined
    }
    if (this.signClient !== undefined) {
      return this.signClient
    }
    if (!this.signClientPromise) {
      const promise = this.createSignClient(++this.clientGeneration).finally(() => {
        if (this.signClientPromise === promise) {
          this.signClientPromise = undefined
        }
      })
      this.signClientPromise = promise
    }

    return this.signClientPromise
  }

  private async createSignClient(generation: number): Promise<Client | undefined> {
    try {
      const client = await this.tryConnectToRelayer(generation)
      if (generation !== this.clientGeneration || this.retired || !client) {
        if (client) {
          await this.disposeSignClient(client)
        }

        return undefined
      }
      this.signClient = client
      this.subscribeToSessionEvents(client)

      return client
    } catch (error: unknown) {
      if (error instanceof InitializationUnavailable) {
        throw error
      }
      if (generation !== this.clientGeneration || this.retired) {
        return undefined
      }
      const message = error instanceof Error ? error.message : String(error)
      logger.error(message)
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(StorageKey.WC_INIT_ERROR, message)
      }

      return undefined
    }
  }

  private getSession() {
    if (!this.session) {
      throw new NotConnected()
    }

    return this.session
  }

  /**
   * @description Access the public key hash (or public key) of the active account
   * @error ActiveAccountUnspecified thrown when there are multiple Tezos account in the session and none is set as the active one
   */
  async getAccountOrPK() {
    if (!this.activeAccountOrPbk) {
      this.getSession()
      throw new ActiveAccountUnspecified()
    }

    return this.activeAccountOrPbk
  }

  private clearState(keep?: PendingRequest) {
    this.clearRequests(keep)
    this.setSession(undefined, keep)
    this.activeAccountOrPbk = undefined
    this.activeNetwork = undefined
    this.lastExtensionAttempt = 0
  }

  /**
   * @description Checks if session is close to expiry and extends it if needed
   * Extends session by 7 days if it will expire within 24 hours
   * Uses defensive error handling to prevent relay message conflicts (TrustWallet issue)
   */
  private async checkAndExtendSession(): Promise<void> {
    try {
      const session = this.session
      if (!session) {
        return
      }

      const signClient = await this.getSignClient()
      if (!signClient || this.session !== session) {
        return
      }

      const ONE_HOUR_IN_SECONDS = 3600
      const ONE_DAY_IN_SECONDS = 86400
      const now = Math.floor(Date.now() / 1000)
      const timeUntilExpiry = session.expiry - now
      const timeSinceLastExtension = now - this.lastExtensionAttempt

      // Skip if we recently attempted extension (within last hour)
      if (timeSinceLastExtension < ONE_HOUR_IN_SECONDS && this.lastExtensionAttempt > 0) {
        logger.debug('Skipping session extension - recently attempted', {
          minutesSinceLastAttempt: (timeSinceLastExtension / 60).toFixed(1)
        })

        return
      }

      // If session expires in the next 24 hours, extend it
      if (timeUntilExpiry < ONE_DAY_IN_SECONDS && timeUntilExpiry > 0) {
        logger.log('Session expires soon, extending...', {
          topic: session.topic,
          currentExpiry: new Date(session.expiry * 1000),
          hoursRemaining: (timeUntilExpiry / 3600).toFixed(1)
        })

        // Update attempt timestamp before calling extend
        this.lastExtensionAttempt = now

        try {
          await this.withTimeout(
            signClient.extend({ topic: session.topic }),
            WALLETCONNECT_SESSION_EXTEND_TIMEOUT_MS,
            'WalletConnect session extension timed out.'
          )

          if (this.session !== session || this.signClient !== signClient) {
            return
          }
          // Update our session reference with new expiry
          const updatedSession = signClient.session.get(session.topic)
          if (updatedSession) {
            this.setSession(updatedSession)
            logger.log('Session extended successfully', {
              newExpiry: new Date(updatedSession.expiry * 1000)
            })
          }
        } catch (extendErr: unknown) {
          // Log but don't throw - session might still be valid for a while
          // This error may be harmless (e.g., "No matching key" from duplicate relay messages)
          logger.warn('Session extension failed, continuing anyway', {
            error: getErrorDiagnostic(extendErr),
            remainingHours: (timeUntilExpiry / 3600).toFixed(1)
          })
        }
      }
    } catch (err: unknown) {
      // Catch any unexpected errors to ensure extension never blocks operations
      logger.error('Unexpected error in checkAndExtendSession', getErrorDiagnostic(err))
    }
  }

  /**
   * @description Validates if a restored session is still valid and usable
   * @param session The session to validate
   * @returns true if session is valid, false if stale/expired
   */
  private async isSessionValid(session: SessionTypes.Struct, client?: Client): Promise<boolean> {
    // Check if Session is expired
    const now = Math.floor(Date.now() / 1000)
    if (session.expiry <= now) {
      logger.warn('Session validation failed: session expired', {
        expiry: session.expiry,
        now
      })

      return false
    }

    // Check if Wallet is still responsive
    try {
      const signClient = client ?? (await this.getSignClient())
      if (!signClient) {
        logger.warn('Session validation failed: no sign client available')

        return false
      }

      await this.withTimeout(
        signClient.ping({ topic: session.topic }),
        WALLETCONNECT_SESSION_VALIDATION_TIMEOUT_MS,
        'WalletConnect session validation ping timed out.'
      )
      logger.debug('Session validation passed: session is valid')

      return true
    } catch (err: unknown) {
      logger.warn('Session validation failed: ping failed', getErrorDiagnostic(err))

      return false
    }
  }

  /**
   * @description Cleans up a stale session by disconnecting and removing it
   * @param session The stale session to cleanup
   */
  private async cleanupStaleSession(session: SessionTypes.Struct, client?: Client): Promise<void> {
    try {
      const signClient = client ?? (await this.getSignClient())
      if (signClient) {
        await this.withTimeout(
          signClient.disconnect({
            topic: session.topic,
            reason: getSdkError('USER_DISCONNECTED')
          }),
          WALLETCONNECT_DISCONNECT_TIMEOUT_MS,
          'WalletConnect stale session disconnect timed out.'
        )
      }
      logger.debug('Stale session cleaned up successfully', session.topic)
    } catch (err: unknown) {
      logger.warn('Error cleaning up stale session', getErrorDiagnostic(err))
      // Continue even if cleanup fails - session is stale
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
        })
      ])
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }
}
