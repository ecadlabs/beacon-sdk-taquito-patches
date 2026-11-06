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
import { ProposalTypes, SessionTypes, SignClientTypes } from '@walletconnect/types'
import { getSdkError } from '@walletconnect/utils'
import {
  BeaconBaseMessage,
  BeaconErrorType,
  BeaconMessageType,
  BeaconResponseInputMessage,
  ChangeAccountRequest,
  DisconnectMessage,
  ExtendedWalletConnectPairingRequest,
  ExtendedWalletConnectPairingResponse,
  IgnoredResponseInputProperties,
  Network,
  NetworkType,
  OperationRequest,
  OperationResponseInput,
  Optional,
  PermissionRequest,
  PermissionResponseInput,
  PermissionScope,
  SignPayloadRequest,
  SignPayloadResponseInput,
  StorageKey,
  TransportType
} from '@ecadlabs/beacon-types'
import { generateGUID, getAddressFromPublicKey, isPublicKeySC } from '@ecadlabs/beacon-utils'
import {
  ActiveAccountUnspecified,
  ActiveNetworkUnspecified,
  InvalidNetworkOrAccount,
  InvalidReceivedSessionNamespace,
  InvalidSession,
  MissingRequiredScope,
  NotConnected
} from '../error'

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

interface PendingRequest {
  readonly id: string
  readonly topic: string
}

type ChannelOpeningListener = (
  pairingResponse: ExtendedWalletConnectPairingResponse,
  isCurrent: () => boolean
) => void | boolean | Promise<void | boolean>

export class WalletConnectCommunicationClient extends CommunicationClient {
  protected readonly activeListeners: Map<string, (message: string) => void> = new Map()

  protected readonly channelOpeningListeners: Map<string, ChannelOpeningListener> = new Map()
  private pairingGeneration = 0
  private approvalQueue: Promise<void> = Promise.resolve()

  private static instance: WalletConnectCommunicationClient
  public signClient: Client | undefined
  private signClientPromise: Promise<Client | undefined> | undefined
  private pairingRequestPromise: Promise<ExtendedWalletConnectPairingRequest> | undefined
  public storage: WCStorage = new WCStorage()
  private session: SessionTypes.Struct | undefined
  private activeAccountOrPbk: string | undefined
  private activeNetwork: string | undefined
  readonly disconnectionEvents: Set<string> = new Set()
  private pingInterval: NodeJS.Timeout | undefined

  private requestGeneration = 0
  private readonly pendingRequests = new Map<string, PendingRequest>()

  /** Release transport ownership when the public caller settles or times out. */
  public cancelRequest(id: string): void {
    this.pendingRequests.delete(id)
    if (!this.pendingRequests.size) {
      this.stopPing()
    }
  }

  private ownsRequest(request: PendingRequest): boolean {
    return this.pendingRequests.get(request.id) === request
  }

  private clearRequests(keep?: PendingRequest): void {
    this.requestGeneration++
    for (const request of this.pendingRequests.values()) {
      if (request !== keep) {
        this.pendingRequests.delete(request.id)
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
      response = { id, type: BeaconMessageType.Error, errorType: BeaconErrorType.ABORTED_ERROR }
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
    private readonly isLeader: Function
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
    isLeader: Function
  ): WalletConnectCommunicationClient {
    if (!this.instance) {
      this.instance = new WalletConnectCommunicationClient(wcOptions, isLeader)
    }

    return WalletConnectCommunicationClient.instance
  }

  private getTopicFromSession(session: SessionTypes.Struct): string {
    return session.topic
  }

  public async listenForEncryptedMessage(
    senderPublicKey: string,
    messageCallback: (message: string) => void
  ): Promise<void> {
    if (this.activeListeners.has(senderPublicKey)) {
      return
    }

    const callbackFunction = async (message: string): Promise<void> => {
      messageCallback(message)
    }

    this.activeListeners.set(senderPublicKey, callbackFunction)
  }

  public async listenForChannelOpening(messageCallback: ChannelOpeningListener): Promise<void> {
    this.channelOpeningListeners.set('channelOpening', messageCallback)
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
    const generation = this.pairingGeneration
    await this.closeSignClient()
    if (generation !== this.pairingGeneration) {
      return
    }

    const client = (await this.getSignClient())!
    const lastIndex = client.session.keys.length - 1

    if (lastIndex > -1) {
      const restoredSession = client.session.get(client.session.keys[lastIndex])

      // Validate session is not stale
      const valid = await this.isSessionValid(restoredSession)
      if (generation !== this.pairingGeneration || this.signClient !== client) {
        return
      }
      if (valid) {
        this.setSession(restoredSession)
        this.updateStorageWallet(restoredSession)
        this.setDefaultAccountAndNetwork()
      } else {
        logger.warn('Restored session is stale during refresh, cleaning up')
        await this.cleanupStaleSession(restoredSession)
        this.clearState()
      }
    } else {
      this.clearState()
    }
  }

  private clearEvents(signClient?: Client) {
    const client = signClient ?? this.signClient
    client?.removeAllListeners?.('session_event')
    client?.removeAllListeners?.('session_update')
    client?.removeAllListeners?.('session_delete')
    client?.removeAllListeners?.('session_expire')
    client?.removeAllListeners?.('session_extend')
    client?.removeAllListeners?.('proposal_expire')
    client?.core?.pairing?.events?.removeAllListeners?.('pairing_delete')
    client?.core?.pairing?.events?.removeAllListeners?.('pairing_expire')
  }

  private onStorageMessageHandler(type: string) {
    if (!this.isMobileOS()) {
      return
    }

    logger.debug('onStorageMessageHandler', type)

    if (type === 'RESET') {
      this.clearEvents()
      // no need to invoke `closeSignClinet` as the other tab already closed the connection
      this.signClient = undefined
      this.signClientPromise = undefined
      this.pairingRequestPromise = undefined
      this.clearState()

      return
    }

    this.refreshState()
  }

  private onStorageErrorHandler(data: unknown) {
    logger.error('onStorageError', data)
  }

  async unsubscribeFromEncryptedMessages(): Promise<void> {
    this.clearRequests()
    this.cancelPendingPairing()
    this.activeListeners.clear()
    this.channelOpeningListeners.clear()
  }

  public async unsubscribeFromEncryptedMessage(senderPublicKey: string): Promise<void> {
    this.activeListeners.delete(senderPublicKey)
  }

  async closeSignClient() {
    this.clearRequests()
    if (!this.signClient) {
      logger.error('No client active')

      return
    }

    const signClient = this.signClient

    // The timeout only lets cleanup continue; transportClose may still finish later.
    try {
      await this.withTimeout(
        signClient.core.relayer.transportClose(),
        WALLETCONNECT_DISCONNECT_TIMEOUT_MS,
        'WalletConnect relayer transport close timed out.'
      )
    } catch (error: unknown) {
      logger.warn(error instanceof Error ? error.message : String(error))
    }

    try {
      signClient.core.events.removeAllListeners()
      signClient.core.relayer.events.removeAllListeners()
      signClient.core.heartbeat.stop()
      signClient.core.relayer.provider.events.removeAllListeners()
      signClient.core.relayer.subscriber.events.removeAllListeners()
      signClient.core.relayer.provider.connection.events.removeAllListeners()
      this.clearEvents(signClient)
    } finally {
      // A reconnect can swap in a new SignClient while the old relayer is closing.
      if (this.signClient === signClient) {
        this.signClient = undefined
        this.signClientPromise = undefined
        this.pairingRequestPromise = undefined
      }
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

  private async notifyListenersWithPermissionResponse(
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

    const permissionResponse: PermissionResponseInput = {
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
    if (this.session === session) {
      await this.notifyListeners(session.topic, permissionResponse)
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

      return this.notifyListenersWithPermissionResponse(
        this.getSession(),
        message.network,
        message.id,
        request
      )
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
  /**
   * Function used to fix appSwitching with web wallets when pairing through 'Other wallet flow'
   * @param session the newly created session
   */
  private updateStorageWallet(session: SessionTypes.Struct): void {
    const selectedWallet = JSON.parse(localStorage.getItem(StorageKey.LAST_SELECTED_WALLET) ?? '{}')

    if (!selectedWallet.key) {
      return
    }

    if (this.isMobileSesion(session)) {
      selectedWallet.type = 'mobile'
    } else {
      selectedWallet.type = 'web'
    }

    localStorage.setItem(StorageKey.LAST_SELECTED_WALLET, JSON.stringify(selectedWallet))
  }

  public async init(
    forceNewConnection: boolean = false
  ): Promise<{ uri: string; topic: string } | undefined> {
    const generation = ++this.pairingGeneration
    const isCurrent = () => generation === this.pairingGeneration
    logger.warn('init')
    this.disconnectionEvents.size && this.disconnectionEvents.clear()

    if (forceNewConnection) {
      await this.closePairings()
    }

    const signClient = await this.getSignClient()
    if (!isCurrent()) {
      return
    }

    if (!signClient) {
      throw new Error('Failed to connect to the relayer.')
    }

    const lastIndex = signClient.session.keys.length - 1

    if (lastIndex > -1 && !forceNewConnection) {
      const restoredSession = signClient.session.get(signClient.session.keys[lastIndex])

      // Validate session is not stale
      const valid = await this.isSessionValid(restoredSession)
      if (!isCurrent()) {
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
        await this.cleanupStaleSession(restoredSession)
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

    const { uri, approval }: { uri: string; approval: () => Promise<SessionTypes.Struct> } =
      await Promise.race([
        signClient.connect(connectParams),
        new Promise<any>((_, reject) =>
          setTimeout(
            () => reject(new Error('The connection timed out.')),
            WALLETCONNECT_CONNECT_TIMEOUT_MS
          )
        )
      ]).catch((error) => {
        logger.error(`Init error: ${error.message}`)
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(StorageKey.WC_INIT_ERROR, error.message)
        }
        throw new Error(error.message)
      })

    // Extract topic from uri. Format is wc:topic@2...
    const topic = getStringBetween(uri, ':', '@')

    if (!topic) {
      return
    }

    let hasResponse = false

    this.withTimeout(
      signClient.core.pairing.ping({ topic }),
      WALLETCONNECT_PAIRING_PING_TIMEOUT_MS,
      'WalletConnect pairing ping timed out.'
    )
      .then(async () => {
        if (!hasResponse && isCurrent()) {
          // Only show "waiting for acknowledge" message if pong arrives before response
          const fun = this.eventHandlers.get(ClientEvents.WC_ACK_NOTIFICATION)
          fun && fun('pending')
        }
      })
      .catch(() => undefined)

    approval()
      .then((session) => {
        hasResponse = true
        // Finish rollback before another approval can persist the same wallet public key.
        const delivery = this.approvalQueue.then(async () => {
          if (!isCurrent()) {
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
          const ownsSession = () => isCurrent() && this.session?.topic === session.topic
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
              accepted = (await listener(pairingResponse, ownsSession)) !== false
            }
          } finally {
            if (!accepted) {
              if (this.session?.topic === session.topic) {
                this.setSession(previousSession)
              }
              await this.discardApproval(signClient, session)
            }
          }
          if (accepted && this.session?.topic === session.topic) {
            this.updateStorageWallet(session)
          }
        })
        this.approvalQueue = delivery.catch(() => undefined)

        return delivery
      })
      .catch(async (error: any) => {
        hasResponse = true
        if (!isCurrent()) {
          return
        }
        if (
          !error.message ||
          !error.message.length ||
          error.message.toLowerCase().includes('expir')
        ) {
          const fun = this.eventHandlers.get(ClientEvents.CLOSE_ALERT)
          if (fun) {
            fun(TransportType.WALLETCONNECT)
          }

          return
        }

        logger.error('Error happened!', [error.message])

        if (this.activeListeners.size === 0) {
          logger.debug('No active listeners', [])
          const fun = this.eventHandlers.get(ClientEvents.WC_ACK_NOTIFICATION)
          fun && fun('error')
        }
      })
      .then(async () => {
        const isLeader = await this.isLeader()
        if (isCurrent() && !isLeader && !this.isMobileOS()) {
          await this.closeSignClient()
          if (isCurrent()) {
            this.clearState()
          }
        }
      })

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

  public async close() {
    this.clearRequests()
    this.cancelPendingPairing()
    await this.closePairings()
    this.unsubscribeFromEncryptedMessages()
  }

  private subscribeToSessionEvents(signClient: Client): void {
    // JWT validation error
    const baseHandler = (signClient.core.relayer as any).onProviderErrorHandler
    const handler = async (event: Error) => {
      logger.error('subscribeToSessionEvents', event)

      if (event.message?.includes('JWT validation error')) {
        const fun = this.eventHandlers.get(ClientEvents.ON_RELAYER_ERROR)
        fun && fun(TransportType.WALLETCONNECT)
      }

      await this.close()
      this.clearState()
      ;(signClient.core.relayer as any).onProviderErrorHandler = baseHandler
    }

    ;(signClient.core.relayer as any).onProviderErrorHandler = handler

    signClient.on('session_event', () => {
      // Legacy requestAcknowledged events have no required Beacon request ID.
      // Ignore them, including their unrelated outer event IDs. Public request
      // deadlines stay active; correlated ACKs require negotiated wallet support.
    })

    signClient.on('session_update', (event) => {
      if (this.signClient !== signClient || this.session?.topic !== event.topic) {
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

    signClient.on('session_delete', (event) => {
      if (this.signClient !== signClient || this.session?.topic !== event.topic) {
        return
      }
      this.disconnectionEvents.add('session_delete')
      this.disconnect(signClient, { type: 'session', topic: event.topic }).catch(
        (error: unknown) => {
          logger.warn(
            'session_delete handler',
            error instanceof Error ? error.message : String(error)
          )
        }
      )
    })

    signClient.on('session_expire', (event) => {
      if (this.signClient !== signClient || this.session?.topic !== event.topic) {
        return
      }
      this.disconnectionEvents.add('session_expire')
      this.disconnect(signClient, { type: 'session', topic: event.topic }).catch(
        (error: unknown) => {
          logger.warn(
            'session_expire handler',
            error instanceof Error ? error.message : String(error)
          )
        }
      )
    })
    signClient.core.pairing.events.on('pairing_delete', (event) => {
      logger.debug('Pairing deleted', { topic: event.topic })
      // Don't disconnect session - pairings can be deleted while sessions remain active
      // Sessions communicate directly through the relay after initial pairing
    })
    signClient.core.pairing.events.on('pairing_expire', (event) => {
      logger.debug('Pairing expired', { topic: event.topic })
      // Don't disconnect session - pairings expire, but sessions can outlive them. Only disconnect on session_expire/session_delete
    })

    signClient.on('proposal_expire', (event) => {
      logger.debug('Session proposal expired', event.id)
    })

    signClient.on('session_extend', (event) => {
      if (this.signClient !== signClient || this.session?.topic !== event.topic) {
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
    try {
      if (this.session !== session) {
        return
      }
      if (accounts.length) {
        const [_namespace, chainId, addressOrPbk] = accounts[0].split(':', 3)
        let publicKey: string | undefined

        this.activeNetwork = chainId
        this.activeAccountOrPbk = addressOrPbk

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

        if (!publicKey) {
          throw new Error('Public key for the new account not provided')
        }

        const id = await generateGUID()
        if (this.session !== session) {
          return
        }
        await this.notifyListeners(this.getTopicFromSession(session), {
          id,
          type: BeaconMessageType.ChangeAccountRequest,
          publicKey,
          network: { type: chainId as NetworkType },
          scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST],
          walletType: 'implicit'
        })
      } else {
        await this.notifyListenersWithPermissionResponse(
          session,
          {
            type: this.wcOptions.network
          },
          'session_update'
        )
      }
    } catch {}
  }

  private async disconnect(signClient: Client, trigger: { type: 'session'; topic: string }) {
    if (this.signClient !== signClient || this.session?.topic !== trigger.topic) {
      return
    }
    const session = this.session
    this.clearRequests()
    await this.onSessionClosed(signClient, trigger.topic)
    if (this.session !== session || this.signClient !== signClient) {
      return
    }
    const resetPairing = !this.activeAccountOrPbk
    this.clearState()
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

  private async closePairings() {
    if (!this.signClient) {
      return
    }

    const closedSessions = await this.closeSessions()
    const signClient = (await this.getSignClient())!

    const pairings = signClient.pairing.getAll() ?? []
    pairings.length &&
      (await Promise.allSettled(
        pairings.map((pairing) =>
          this.withTimeout(
            signClient.disconnect({
              topic: pairing.topic,
              reason: {
                code: 0, // TODO: Use constants
                message: 'Force new connection'
              }
            }),
            WALLETCONNECT_DISCONNECT_TIMEOUT_MS,
            'WalletConnect pairing disconnect timed out.'
          )
        )
      ))
    if (closedSessions || pairings.length > 0 || this.isMobileOS()) {
      await this.closeSignClient()
      if (this.isMobileOS()) {
        await this.storage.resetState()
        this.storage.notify('RESET')
      }
    }
  }

  private async closeSessions(): Promise<boolean> {
    if (!this.signClient) {
      return false
    }

    const signClient = (await this.getSignClient())!

    const sessions = signClient.session.getAll() ?? []
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

    this.clearState()

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
    } catch (error: any) {
      logger.error(error.message)

      return
    }

    const session = this.getSession()

    const signClient = this.signClient
    this.clearState(keep)
    if (notify) {
      await this.notifyListeners(session.topic, {
        type: BeaconMessageType.Disconnect,
        id: await generateGUID()
      })
    }

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
    listeners: ((message: string) => void)[] = [...this.activeListeners.values()]
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

    listeners.forEach((listener) => {
      listener(serialized)
    })
  }

  public currentSession(): SessionTypes.Struct | undefined {
    return this.session
  }

  private async tryConnectToRelayer() {
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
      try {
        return await this.initSignClientWithTimeout(relayUrl)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        errMessages.add(message)
        logger.warn(`Failed to connect to ${relayUrl}: ${message}`)
      }
    }

    throw new Error(`Failed to connect to relayer: ${Array.from(errMessages).join(',')}`)
  }

  private async initSignClientWithTimeout(relayUrl: string | undefined): Promise<Client> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Client.init({ ...this.wcOptions.opts, relayUrl }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('WalletConnect initialization timed out.')),
            WALLETCONNECT_INIT_TIMEOUT_MS
          )
        })
      ])
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }

  private async getSignClient(): Promise<Client | undefined> {
    if (this.signClient !== undefined) {
      return this.signClient
    }

    if (!this.signClientPromise) {
      this.signClientPromise = this.createSignClient().finally(() => {
        this.signClientPromise = undefined
      })
    }

    return this.signClientPromise
  }

  private async createSignClient(): Promise<Client | undefined> {
    try {
      this.signClient = await this.tryConnectToRelayer()
      this.subscribeToSessionEvents(this.signClient)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(message)
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(StorageKey.WC_INIT_ERROR, message)
      }

      return undefined
    }

    return this.signClient
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
  private async isSessionValid(session: SessionTypes.Struct): Promise<boolean> {
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
      const signClient = await this.getSignClient()
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
  private async cleanupStaleSession(session: SessionTypes.Struct): Promise<void> {
    try {
      const signClient = await this.getSignClient()
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
