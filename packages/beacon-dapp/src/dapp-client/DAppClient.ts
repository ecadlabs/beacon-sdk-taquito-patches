import { PendingPairingRequests } from '@ecadlabs/beacon-core'
import bs58check from 'bs58check'
import {
  ConnectionContext,
  AccountInfo,
  TransportType,
  StorageKey,
  BeaconMessageType,
  PermissionScope,
  PermissionResponse,
  NetworkType,
  SignPayloadResponse,
  SignPayloadRequest,
  OperationResponse,
  OperationRequest,
  BroadcastResponse,
  BroadcastRequest,
  ErrorResponse,
  BeaconMessage,
  RequestPermissionInput,
  RequestSignPayloadInput,
  RequestOperationInput,
  RequestBroadcastInput,
  PermissionRequest,
  PermissionResponseOutput,
  PermissionRequestInput,
  SignPayloadResponseOutput,
  SignPayloadRequestInput,
  OperationResponseOutput,
  OperationRequestInput,
  BroadcastResponseOutput,
  BroadcastRequestInput,
  BeaconRequestInputMessage,
  Network,
  Origin,
  PeerInfo,
  BeaconErrorType,
  AppMetadata,
  ExtendedP2PPairingResponse,
  ExtendedPostMessagePairingResponse,
  SigningType,
  ExtendedPeerInfo,
  Optional,
  ColorMode,
  IgnoredRequestInputProperties,
  WalletInfo,
  BeaconMessageWrapper,
  Blockchain,
  BlockchainMessage,
  BlockchainRequestV3,
  BlockchainResponseV3,
  PermissionRequestV3,
  PermissionResponseV3,
  BeaconBaseMessage,
  AcknowledgeResponse,
  ExtendedWalletConnectPairingResponse,
  ProofOfEventChallengeRequest,
  ProofOfEventChallengeResponse,
  ProofOfEventChallengeRequestInput,
  RequestProofOfEventChallengeInput,
  ChangeAccountRequest,
  DisconnectMessage,
  PeerInfoType,
  App,
  AppBase,
  DesktopApp,
  ExtensionApp,
  WebApp,
  SimulatedProofOfEventChallengeRequestInput,
  SimulatedProofOfEventChallengeRequest,
  SimulatedProofOfEventChallengeResponse,
  RequestSimulatedProofOfEventChallengeInput,
  TransportStatus,
  Storage
  // PermissionRequestV3
  // RequestEncryptPayloadInput,
  // EncryptPayloadResponseOutput,
  // EncryptPayloadResponse,
  // EncryptPayloadRequest
} from '@ecadlabs/beacon-types'
import {
  Client,
  Transport,
  AppMetadataManager,
  Serializer,
  LocalStorage,
  getAccountIdentifier,
  getSenderId,
  Logger,
  ClientEvents,
  StorageValidator,
  MultiTabChannel,
  getError
} from '@ecadlabs/beacon-core'
import {
  getAddressFromPublicKey,
  ExposedPromise,
  generateGUID,
  toHex,
  signMessage,
  CONTRACT_PREFIX,
  prefixPublicKey,
  isValidAddress,
  getKeypairFromSeed
} from '@ecadlabs/beacon-utils'

import { PostMessageTransport } from '@ecadlabs/beacon-transport-postmessage'
import {
  AlertButton,
  closeToast,
  getColorMode,
  setColorMode,
  setDesktopList,
  setExtensionList,
  setWebList,
  setiOSList,
  getiOSList,
  getDesktopList,
  getExtensionList,
  getWebList,
  isBrowser,
  isDesktop,
  isMobileOS,
  isIOS
} from '@ecadlabs/beacon-ui'
import { WalletConnectTransport } from '@ecadlabs/beacon-transport-walletconnect'
import { DappPostMessageTransport } from '../transports/DappPostMessageTransport'
import { DappP2PTransport } from '../transports/DappP2PTransport'
import { DappWalletConnectTransport } from '../transports/DappWalletConnectTransport'
import { TzktBlockExplorer } from '../utils/tzkt-blockexplorer'
import { BlockExplorer } from '../utils/block-explorer'
import { messageEvents } from '../beacon-message-events'
import {
  BeaconEvent,
  BeaconEventHandler,
  BeaconEventHandlerFunction,
  BeaconEventType,
  InvalidAccountDeactivatedReason
} from '../events'
import { InitializationAttempt } from './InitializationAttempt'
import { InitializationLifecycle } from './InitializationLifecycle'
import { DAppClientOptions } from './DAppClientOptions'
import { RequestTracker, RequestKey, RequestRoute } from './RequestTracker'
import { PermissionRequestOwner } from './PermissionRequestOwner'

interface RequestResponse {
  message: BeaconMessage | BeaconMessageWrapper<BeaconBaseMessage | BlockchainMessage>
  connectionInfo: ConnectionContext
}
interface RequestHandle {
  key: RequestKey
  promise: Promise<RequestResponse>
}

const logger = new Logger('DAppClient')
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

const createLazyPromise = <T>(factory: () => Promise<T>): PromiseLike<T> => {
  let promise: Promise<T> | undefined

  const getPromise = (): Promise<T> => {
    if (!promise) {
      promise = factory()
    }

    return promise
  }

  const lazyPromise: PromiseLike<T> & {
    catch: <TResult = never>(
      onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
    ) => Promise<T | TResult>
    finally: (onfinally?: (() => void) | null) => Promise<T>
  } = {
    then: <TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> => getPromise().then(onfulfilled, onrejected),
    catch: <TResult = never>(
      onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
    ): Promise<T | TResult> => getPromise().catch(onrejected),
    finally: (onfinally?: (() => void) | null): Promise<T> =>
      getPromise().finally(onfinally ?? undefined)
  }

  return lazyPromise
}

export interface DAppClientDisconnectOptions {
  /**
   * Send Beacon disconnect messages to stored wallet peers before tearing down the transport.
   *
   * Defaults to true because DAppClient.disconnect is the user-facing wallet logout path.
   */
  notifyPeers?: boolean
}

export interface DAppClientRemoveAllPeersOptions {
  /**
   * Continue removing local peer/account state even if notifying one peer fails.
   */
  ignoreDisconnectErrors?: boolean
}

type DAppInternalTransport =
  DappPostMessageTransport | DappP2PTransport | DappWalletConnectTransport

interface TransportWithClientCleanup {
  doClientCleanup: () => Promise<void>
}

interface PeersForTransport {
  transport: DAppInternalTransport
  peers: ExtendedPeerInfo[]
}

interface PeerNotification {
  transport: DAppInternalTransport
  peer: ExtendedPeerInfo
}

type AccountRemovalSelection =
  | { kind: 'clear'; transition: AbortSignal }
  | { kind: 'previous'; transition: AbortSignal; identifier: string }

type PreparedAccountSelection =
  | { kind: 'superseded' }
  | {
      kind: 'ready'
      transport: DAppInternalTransport | undefined
      peer: PeerInfoType | undefined
    }

/**
 * @publicapi
 *
 * The DAppClient has to be used in decentralized applications. It handles all the logic related to connecting to beacon-compatible
 * wallets and sending requests.
 *
 * @category DApp
 */
export class DAppClient extends Client {
  /**
   * The description of the app
   */
  public readonly description?: string

  /**
   * The block explorer used by the SDK
   */
  public readonly blockExplorer: BlockExplorer

  /**
   * Automatically switch between apps on Mobile Devices (Enabled by Default)
   */
  private readonly enableAppSwitching: boolean

  public network: Network

  protected readonly events: BeaconEventHandler = new BeaconEventHandler()

  protected postMessageTransport: DappPostMessageTransport | undefined
  protected p2pTransport: DappP2PTransport | undefined
  protected walletConnectTransport: DappWalletConnectTransport | undefined

  protected wcProjectId?: string
  protected wcRelayUrl?: string

  private isGetActiveAccountHandled: boolean = false

  private readonly requestTracker = new RequestTracker<RequestResponse, unknown>({
    onError: (error) => logger.error('requestTracker', error)
  })

  private readonly requestTimeoutMs: number

  /**
   * The currently active account. For all requests that are associated to a specific request (operation request, signing request),
   * the active account is used to determine the network and destination wallet
   */
  private _activeAccount: ExposedPromise<AccountInfo | undefined> = new ExposedPromise()

  private activeAccountNotificationPending = false

  /**
   * The currently active peer. This is used to address a peer in case the active account is not set. (Eg. for permission requests)
   */
  private _activePeer: ExposedPromise<PeerInfoType | undefined> = new ExposedPromise()

  private _accountChangeGeneration: number = 0

  private initializationOwner: InitializationLifecycle | undefined

  private get initialization(): InitializationLifecycle {
    return (this.initializationOwner ??= new InitializationLifecycle(() =>
      this.createAbortedError()
    ))
  }

  private get _initPromise(): Promise<TransportType> | undefined {
    return this.initialization.completion
  }

  private set _initPromise(value: Promise<TransportType> | undefined) {
    this.initialization.completion = value
  }

  private get _initReject(): ((reason: ErrorResponse) => void) | undefined {
    return this.initialization.reject
  }

  private set _initReject(value: ((reason: ErrorResponse) => void) | undefined) {
    this.initialization.reject = value
  }

  private _requestPermissionsPromise: Promise<PermissionResponseOutput> | undefined

  private _requestPermissionsKey: string | undefined

  private _sdkSecretSeedPromise: Promise<string> | undefined

  private destroyed = false

  private readonly permissionRequests = new Set<PermissionRequestOwner>()

  private accountTransition = new AbortController()

  private readonly startupTransition = this.accountTransition.signal

  private pendingAccountSelection:
    | {
        readonly transition: AbortSignal
        readonly account: Pick<AccountInfo, 'accountIdentifier' | 'senderId'>
      }
    | undefined

  // Keep account writes and their rollback ordered with removals.
  private accountWrite: Promise<void> = Promise.resolve()

  private mutateAccounts<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.accountWrite.then(operation, operation)
    this.accountWrite = result.then(
      () => undefined,
      () => undefined
    )

    return result
  }

  private activeAccountWrite: Promise<void> = Promise.resolve()

  private pendingActiveAccountWrites = 0

  private beginAccountTransition(owner?: PermissionRequestOwner): AbortSignal {
    owner?.assertCurrent()
    this._accountChangeGeneration++
    const previous = this.accountTransition
    this.accountTransition = new AbortController()
    const transition = this.accountTransition.signal
    this.pendingAccountSelection = undefined
    // A request may select its own account without revoking its public result.
    owner?.follow(transition)
    previous.abort()

    return transition
  }

  private isCurrentAccountTransition(transition: AbortSignal): boolean {
    return !this.destroyed && !transition.aborted && transition === this.accountTransition.signal
  }

  private readonly activeAccountLoaded: Promise<AccountInfo | undefined>

  private readonly storageValidated: Promise<void>

  private readonly appMetadataManager: AppMetadataManager

  private readonly disclaimerText?: string

  private readonly errorMessages: Record<string, Record<string | number, string>>

  private readonly featuredWallets: string[] | undefined

  private readonly storageValidator: StorageValidator

  private debounceSetActiveAccount: boolean = false

  // Constructor-time invalid storage recovery can race through multiple async paths.
  // Keep this guard scoped to those startup paths.
  private hasEmittedInvalidAccountDeactivated: boolean = false

  private get _disconnectPromise(): Promise<void> | undefined {
    return this.initialization.disconnectCompletion
  }
  private _disconnectNotifyPeers: boolean = false

  private readonly multiTabChannel = new MultiTabChannel(
    'beacon-sdk-channel',
    this.onBCMessageHandler.bind(this),
    this.onElectedLeaderhandler.bind(this)
  )

  constructor(config: DAppClientOptions) {
    super({
      storage: config && config.storage ? config.storage : new LocalStorage(),
      ...config
    })
    this.description = config.description
    this.wcProjectId = config.walletConnectOptions?.projectId || '24469fd0a06df227b6e5f7dc7de0ff4f'
    this.wcRelayUrl = config.walletConnectOptions?.relayUrl

    this.featuredWallets = config.featuredWallets

    this.events = new BeaconEventHandler(config.eventHandlers, config.disableDefaultEvents ?? false)
    this.blockExplorer = config.blockExplorer ?? new TzktBlockExplorer()
    this.network = config.network ?? { type: config.preferredNetwork ?? NetworkType.MAINNET }
    setColorMode(config.colorMode ?? ColorMode.LIGHT)

    this.disclaimerText = config.disclaimerText

    this.errorMessages = config.errorMessages ?? {}

    this.appMetadataManager = new AppMetadataManager(this.storage)
    this.storageValidator = new StorageValidator(this.storage)

    this.enableAppSwitching =
      config.enableAppSwitching === undefined ? true : Boolean(config.enableAppSwitching)
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

    // Subscribe to storage changes and update the active account if it changes on other tabs
    this.storage
      .subscribeToStorageChanged((event) =>
        this.onStorageChanged(event).catch((error: unknown) =>
          logger.error('storageChanged', error)
        )
      )
      .catch((error: unknown) => logger.error('subscribeToStorageChanged', error))

    const startupTransition = this.startupTransition
    this.activeAccountLoaded = this.storage
      .get(StorageKey.ACTIVE_ACCOUNT)
      .then(async (activeAccountIdentifier) => {
        const accounts = await this.accountManager.getAccounts()
        if (!this.isCurrentAccountTransition(startupTransition)) {
          return undefined
        }

        if (activeAccountIdentifier === 'undefined') {
          // Non-normalizing storage backends can still surface legacy sentinel strings directly.
          await this.deactivateInvalidAccountState('missing_active_account')

          return undefined
        }

        if (activeAccountIdentifier) {
          const account = accounts.find(
            (storedAccount) => storedAccount.accountIdentifier === activeAccountIdentifier
          )

          if (!account) {
            await this.deactivateInvalidAccountState('missing_active_account')

            return undefined
          }

          const restored = await this.applyActiveAccount(account, startupTransition, 'storage')

          return restored ? account : undefined
        }

        if (accounts.length > 0 && this.hasStoredActiveAccountPointer()) {
          await this.deactivateInvalidAccountState('missing_active_account')

          return undefined
        }

        await this.applyActiveAccount(undefined, startupTransition, 'storage')

        return undefined
      })
      .catch(async (storageError) => {
        logger.error(storageError)
        if (this.isCurrentAccountTransition(startupTransition)) {
          await this.deactivateInvalidAccountState('invalid_active_account_storage')
        }

        return undefined
      })

    this.handleResponse = async (
      message: BeaconMessage | BeaconMessageWrapper<BeaconBaseMessage>,
      connectionInfo: ConnectionContext
    ): Promise<void> => {
      const isV3WrappedMessage = message.version === '3' && 'message' in message

      const typedMessage = isV3WrappedMessage ? message.message : (message as BeaconMessage)

      if (
        typedMessage.type === BeaconMessageType.ChangeAccountRequest ||
        typedMessage.type === BeaconMessageType.Disconnect
      ) {
        await this.handleNotification(
          {
            ...typedMessage,
            id: message.id,
            version: message.version,
            senderId: message.senderId
          } as ChangeAccountRequest | DisconnectMessage,
          connectionInfo
        )

        return
      }

      // Capture arrival identity without changing the deadline during V3 enrichment.
      const request = this.requestTracker.get(message.id)
      const preparing =
        request &&
        request.route !== 'LeaderProxy' &&
        typedMessage.type === BeaconMessageType.PermissionResponse
      if (preparing && !this.requestTracker.beginPreparation(request.key)) {
        return
      }

      let appMetadata: AppMetadata | undefined = isV3WrappedMessage
        ? (typedMessage as unknown as PermissionResponseV3).blockchainData?.appMetadata
        : (typedMessage as PermissionResponse).appMetadata

      if (!appMetadata && isV3WrappedMessage) {
        const storedMetadata = await Promise.all([
          this.storage.get(StorageKey.TRANSPORT_P2P_PEERS_DAPP),
          this.storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP),
          this.storage.get(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
        ])

        for (const peers of storedMetadata) {
          const peer = peers.find(
            (candidate) => 'senderId' in candidate && candidate.senderId === message.senderId
          )
          if (!peer) {
            continue
          }

          const wallet = await this.getWalletInfo()

          appMetadata = {
            name: peer.name,
            senderId: message.senderId,
            icon: wallet.icon
          }

          break
        }
      }

      if (!request || !this.requestTracker.isCurrent(request.key)) {
        logger.warn('handleResponse', 'received response for unknown or closed request', {
          id: message.id,
          type: typedMessage.type,
          connectionInfo
        })

        return
      }

      if (request.route === 'LeaderProxy') {
        if (typedMessage.type === BeaconMessageType.Acknowledge) {
          if (this.requestTracker.acknowledge(request.key)) {
            this.multiTabChannel.postMessage({
              type: 'RESPONSE',
              id: message.id,
              data: { message, connectionInfo }
            })
          }
        } else {
          this.requestTracker.resolve(request.key, { message, connectionInfo })
        }

        return
      }

      if (typedMessage.type === BeaconMessageType.Acknowledge) {
        if (!this.requestTracker.acknowledge(request.key)) {
          return
        }
        this.analytics.track('event', 'DAppClient', 'Acknowledge received from Wallet')
        const walletInfo = await this.getWalletInfo()
        if (!this.requestTracker.isCurrent(request.key)) {
          return
        }
        this.events
          .emit(BeaconEvent.ACKNOWLEDGE_RECEIVED, {
            message: typedMessage as AcknowledgeResponse,
            extraInfo: {},
            walletInfo
          })
          .catch((emitError) => logger.error('handleResponse', emitError))

        return
      }

      if (preparing) {
        if (appMetadata) {
          try {
            await this.appMetadataManager.addAppMetadata(appMetadata)
          } catch {
            this.requestTracker.preparationFailed(request.key, {
              id: message.id,
              type: BeaconMessageType.Error,
              errorType: BeaconErrorType.UNKNOWN_ERROR,
              senderId: '',
              version: '2'
            })

            return
          }
        }
        this.requestTracker.prepared(request.key, { message, connectionInfo })
      } else if (typedMessage.type === BeaconMessageType.Error) {
        this.requestTracker.reject(request.key, typedMessage)
      } else {
        this.requestTracker.resolve(request.key, { message, connectionInfo })
      }
    }

    this.storageValidated = this.storageValidator
      .validate()
      .then(async (isValid) => {
        const account = await this.activeAccountLoaded
        if (!this.isCurrentAccountTransition(startupTransition)) {
          return
        }

        if (!isValid) {
          const info = await this.getWalletInfo(undefined, account, false)
          info.type =
            info.type === 'extension' && account?.origin.type === Origin.P2P ? 'mobile' : info.type
          if (!this.isCurrentAccountTransition(startupTransition)) {
            return
          }
          await this.storage.set(StorageKey.LAST_SELECTED_WALLET, {
            icon: info.icon ?? '',
            key: info.name,
            type: info.type ?? 'web',
            name: info.name,
            url: info.deeplink
          })

          const nowValid = await this.storageValidator.validate()
          if (!this.isCurrentAccountTransition(startupTransition)) {
            return
          }

          if (!nowValid && account) {
            await this.deactivateInvalidAccountState('storage_validation_failed')
          } else if (!nowValid) {
            await this.resetInvalidState(false)
          }
        }

        if (account && account.origin.type !== 'p2p') {
          // Fire-and-forget eager init for stored sessions. init() can now
          // reject (e.g. when an abort path settles _initPromise), so swallow
          // here; downstream callers of init() handle rejection on their own.
          this.init().catch((initError) =>
            logger.error('eager init failed', (initError as Error)?.message ?? initError)
          )
        }
      })
      .catch((err) => logger.error(err.message))
    this.retainStorageValidationPromise()
  }

  private async checkIfBCLeaderExists() {
    // broadcast channel does not work on mobile
    if (isMobileOS(window)) {
      return true
    }

    const hasLeader = await this.multiTabChannel.hasLeader()

    if (hasLeader) {
      return this.multiTabChannel.isLeader()
    }

    await this.multiTabChannel.getLeadership()

    return this.multiTabChannel.isLeader()
  }

  private async onElectedLeaderhandler() {
    if (!this._transport.isResolved()) {
      return
    }

    const tranport = await this.transport

    if (tranport.type !== TransportType.WALLETCONNECT) {
      return
    }

    if (tranport.connectionStatus === TransportStatus.CONNECTED) {
      return
    }

    await tranport.connect()
  }

  private async onBCMessageHandler(message: any) {
    switch (message.type) {
      case BeaconMessageType.PermissionRequest:
      case BeaconMessageType.OperationRequest:
      case BeaconMessageType.SignPayloadRequest:
      case BeaconMessageType.BroadcastRequest:
      case BeaconMessageType.ProofOfEventChallengeRequest:
      case BeaconMessageType.SimulatedProofOfEventChallengeRequest:
        this.prepareRequest(message)
        break
      case BeaconMessageType.BlockchainRequest:
        this.prepareRequest(message, true)
        break
      case 'RESPONSE':
        this.handleResponse(message.data.message, message.data.connectionInfo)
        break
      case 'DISCONNECT':
        await this.disconnect()
        break
      default:
        logger.error('onBCMessageHandler', 'message type not recognized', message)
    }
  }

  protected async registerTransportListener(
    transport: Transport,
    listener: Parameters<Transport['addListener']>[0]
  ): Promise<void> {
    if (transport instanceof WalletConnectTransport) {
      await transport.addListener(listener, (message, connectionInfo, isCurrent) =>
        this.handleWalletConnectSessionUpdate(message, connectionInfo, isCurrent)
      )
    } else {
      await super.registerTransportListener(transport, listener)
    }
  }

  private async handleWalletConnectSessionUpdate(
    message: PermissionResponse | ChangeAccountRequest,
    connectionInfo: ConnectionContext,
    isCurrent: () => boolean
  ): Promise<void> {
    if (
      !isCurrent() ||
      !(await this.isAuthorizedChangeAccountSender(message.senderId, connectionInfo)) ||
      !isCurrent()
    ) {
      return
    }

    if (message.type === BeaconMessageType.ChangeAccountRequest) {
      await this.handleNotification(message, connectionInfo, isCurrent)
    } else {
      await this.appMetadataManager.addAppMetadata(message.appMetadata)
    }
  }

  private async handleNotification(
    message: ChangeAccountRequest | DisconnectMessage,
    connectionInfo: ConnectionContext,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    const handleDisconnect = async (): Promise<void> => {
      this.analytics.track('event', 'DAppClient', 'Disconnect received from Wallet')

      const relevantTransport =
        connectionInfo.origin === Origin.P2P
          ? this.p2pTransport
          : connectionInfo.origin === Origin.WALLETCONNECT
            ? this.walletConnectTransport
            : (this.postMessageTransport ?? (await this.transport))

      if (relevantTransport) {
        const peers: ExtendedPeerInfo[] = [
          ...(await relevantTransport.getPeers()),
          ...((connectionInfo.origin === Origin.WALLETCONNECT
            ? await this.storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)
            : undefined) ?? [])
        ]
        const peer: ExtendedPeerInfo | undefined = peers.find(
          (peerEl) => peerEl.senderId === message.senderId
        )

        if (peer) {
          await relevantTransport.removePeer(peer)
        }
      }

      await this.removeAccountsForPeerIds([message.senderId])
      await this.events.emit(BeaconEvent.CHANNEL_CLOSED)
    }
    if (message.type === BeaconMessageType.ChangeAccountRequest) {
      if (!(await this.isAuthorizedChangeAccountSender(message.senderId, connectionInfo))) {
        return
      }
    } else if (message.type === BeaconMessageType.Disconnect) {
      const activePeer = this._activePeer.isResolved() ? await this._activePeer.promise : undefined
      if (connectionInfo.origin === Origin.P2P) {
        if (!(await this.matchesP2PDisconnect(message, connectionInfo, activePeer))) {
          return
        }
      } else if (connectionInfo.origin === Origin.EXTENSION) {
        if (!(await this.matchesExtensionDisconnect(message, connectionInfo, activePeer))) {
          return
        }
      } else if (connectionInfo.origin === Origin.WALLETCONNECT) {
        if (!(await this.matchesWalletConnectDisconnect(message, connectionInfo, activePeer))) {
          return
        }
      }
    }
    if (message.type === BeaconMessageType.Disconnect) {
      await handleDisconnect()
    } else if (message.type === BeaconMessageType.ChangeAccountRequest) {
      if (!isCurrent()) {
        return
      }
      const changeGeneration = ++this._accountChangeGeneration
      await this.onNewAccount(message, connectionInfo, changeGeneration, isCurrent)
    }
  }

  private async matchesP2PDisconnect(
    message: DisconnectMessage,
    connectionInfo: ConnectionContext,
    activePeer: PeerInfo | undefined
  ): Promise<boolean> {
    const peers = [
      ...(activePeer ? [activePeer] : []),
      ...((await this.p2pTransport?.getPeers()) ?? [])
    ]
    for (const candidate of peers) {
      if (
        (candidate.type === 'p2p-pairing-response' || candidate.type === 'p2p-pairing-request') &&
        candidate.publicKey === connectionInfo.id &&
        message.senderId === (await getSenderId(candidate.publicKey))
      ) {
        return true
      }
    }

    return false
  }

  private async matchesExtensionDisconnect(
    message: DisconnectMessage,
    connectionInfo: ConnectionContext,
    activePeer: PeerInfo | undefined
  ): Promise<boolean> {
    const relevantTransport =
      this.postMessageTransport ?? (this._transport.isResolved() ? await this.transport : undefined)
    const peers = [
      ...(activePeer ? [activePeer] : []),
      ...((await relevantTransport?.getPeers()) ?? [])
    ]
    for (const candidate of peers) {
      if (
        (candidate.type === 'postmessage-pairing-response' ||
          candidate.type === 'postmessage-pairing-request') &&
        (candidate as ExtendedPostMessagePairingResponse).extensionId === connectionInfo.id &&
        message.senderId === (await getSenderId(candidate.publicKey))
      ) {
        return true
      }
    }

    return false
  }

  private async matchesWalletConnectDisconnect(
    message: DisconnectMessage,
    connectionInfo: ConnectionContext,
    activePeer: PeerInfo | undefined
  ): Promise<boolean> {
    const storedPeers =
      (await this.storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)) ?? []
    const peers = [
      ...(activePeer &&
      (activePeer.type === 'walletconnect-pairing-response' ||
        activePeer.type === 'walletconnect-pairing-request')
        ? [activePeer]
        : []),
      ...((await this.walletConnectTransport?.getPeers()) ?? []),
      ...storedPeers
    ]
    const matchedPeer = peers.some(
      (candidate) =>
        (candidate.type === 'walletconnect-pairing-response' ||
          candidate.type === 'walletconnect-pairing-request') &&
        candidate.publicKey === connectionInfo.id &&
        'senderId' in candidate &&
        candidate.senderId === message.senderId
    )
    const storedAccounts = await this.accountManager.getAccounts()
    const matchedAccount = storedAccounts.some(
      (account) =>
        account.origin.type === Origin.WALLETCONNECT &&
        account.origin.id === connectionInfo.id &&
        account.senderId === message.senderId
    )

    return matchedPeer || matchedAccount
  }

  private async prepareRequest(
    message: { id: string; data: BeaconRequestInputMessage | BlockchainMessage },
    isV3 = false
  ): Promise<void> {
    if (!this.multiTabChannel.isLeader()) {
      return
    }
    const request = this.createRequest(message.id, 'LeaderProxy')
    if (!request) {
      return
    }
    // Admission owns early revocation; the deadline starts at dispatch readiness.
    request.promise.catch(() => undefined)
    try {
      const transport = await this._transport.promise
      if (!this.requestTracker.isCurrent(request.key)) {
        return
      }
      if (transport instanceof WalletConnectTransport) {
        await transport.waitForResolution()
      }
      if (!this.requestTracker.isCurrent(request.key)) {
        return
      }
      if (isV3) {
        await this.makeRequestV3(message.data as BlockchainMessage, message.id)
      } else {
        await this.makeRequest<BeaconRequestInputMessage, BeaconMessage>(
          message.data as BeaconRequestInputMessage,
          false,
          message.id
        )
      }
    } catch (error) {
      this.requestTracker.reject(request.key, error)
    }
  }

  private buildDelegatedRequestError(id: string, error: unknown): ErrorResponse {
    if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      'errorType' in error &&
      error.type === BeaconMessageType.Error
    ) {
      return {
        ...(error as ErrorResponse),
        id
      }
    }

    return {
      id,
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.UNKNOWN_ERROR,
      senderId: '',
      version: '2'
    }
  }

  private async onStorageChanged(
    event: Parameters<Parameters<Storage['subscribeToStorageChanged']>[0]>[0]
  ): Promise<void> {
    if (event.eventType === 'storageCleared') {
      await this.applyActiveAccount(undefined, this.beginAccountTransition(), 'storage')

      return
    }
    if (event.oldValue === event.newValue) {
      return
    }
    if (event.eventType === 'entryModified') {
      if (event.key === this.storage.getPrefixedKey(StorageKey.ACTIVE_ACCOUNT)) {
        const transition = this.beginAccountTransition()
        const accountIdentifier = event.newValue
        if (!accountIdentifier || accountIdentifier === 'undefined') {
          await this.applyActiveAccount(undefined, transition, 'storage')
        } else {
          await this.runAccountTransition(
            transition,
            async () => {
              const account = await this.getAccount(accountIdentifier)
              await this.commitActiveAccount(account, transition, 'storage')
            },
            undefined
          )
        }

        return
      }
      if (event.key === this.storage.getPrefixedKey(StorageKey.ACCOUNTS)) {
        await this.recoverActiveAccountFromAccountsChange()

        return
      }
      if (event.key === this.storage.getPrefixedKey(StorageKey.BEACON_SDK_SECRET_SEED)) {
        this._keyPair = new ExposedPromise()
        this._beaconId = new ExposedPromise()
        await this.initSDK()

        return
      }
    }
  }

  public async initInternalTransports(): Promise<void> {
    const transition = this.accountTransition.signal
    const seed = await this.getOrCreateSDKSecretSeed()
    const keyPair = await getKeypairFromSeed(seed)

    if (
      !this.isCurrentAccountTransition(transition) ||
      this.postMessageTransport ||
      this.p2pTransport ||
      this.walletConnectTransport
    ) {
      return
    }

    const pendingPairings = new PendingPairingRequests()
    this.postMessageTransport = new DappPostMessageTransport(
      this.name,
      keyPair,
      this.storage,
      pendingPairings
    )

    this.p2pTransport = new DappP2PTransport(
      this.name,
      keyPair,
      this.storage,
      this.matrixNodes,
      this.iconUrl,
      this.appUrl,
      pendingPairings
    )

    const wcOptions = {
      projectId: this.wcProjectId,
      relayUrl: this.wcRelayUrl,
      metadata: {
        name: this.name,
        description: this.description ?? '',
        url: this.appUrl ?? '',
        icons: this.iconUrl ? [this.iconUrl] : []
      }
    }

    this.walletConnectTransport = new DappWalletConnectTransport(
      this.name,
      keyPair,
      this.storage,
      {
        network: this.network.type,
        opts: wcOptions
      },
      this.checkIfBCLeaderExists.bind(this)
    )

    this.initEvents()

    await Promise.all([
      this.addListener(this.postMessageTransport),
      this.addListener(this.p2pTransport),
      this.addListener(this.walletConnectTransport)
    ])
  }

  private async getOrCreateSDKSecretSeed(): Promise<string> {
    if (this._sdkSecretSeedPromise) {
      return this._sdkSecretSeedPromise
    }

    this._sdkSecretSeedPromise = this.loadOrCreateSDKSecretSeed()
      .finally(() => {
        this._sdkSecretSeedPromise = undefined
      })
      .catch((error) => {
        throw error
      })

    return this._sdkSecretSeedPromise
  }

  private async loadOrCreateSDKSecretSeed(): Promise<string> {
    const existingSeed = await this.storage.get(StorageKey.BEACON_SDK_SECRET_SEED)
    if (this.isValidSDKSecretSeed(existingSeed)) {
      return existingSeed
    }

    await this.storage.delete(StorageKey.BEACON_SDK_SECRET_SEED)
    this._keyPair = new ExposedPromise()
    this._beaconId = new ExposedPromise()
    await this.initSDK()

    const restoredSeed = await this.storage.get(StorageKey.BEACON_SDK_SECRET_SEED)
    if (this.isValidSDKSecretSeed(restoredSeed)) {
      return restoredSeed
    }

    throw new Error('Secret seed not found')
  }

  private isValidSDKSecretSeed(seed: unknown): seed is string {
    return typeof seed === 'string' && seed !== '' && seed !== 'undefined' && seed !== 'null'
  }

  private initEvents() {
    if (!this.walletConnectTransport) {
      return
    }

    this.walletConnectTransport.setEventHandler(
      ClientEvents.CLOSE_ALERT,
      this.hideUI.bind(this, ['alert', 'toast'])
    )
    this.walletConnectTransport.setEventHandler(
      ClientEvents.RESET_STATE,
      this.channelClosedHandler.bind(this)
    )
    this.walletConnectTransport.setEventHandler(
      ClientEvents.WC_ACK_NOTIFICATION,
      this.wcToastHandler.bind(this)
    )
    this.walletConnectTransport.setEventHandler(
      ClientEvents.ON_RELAYER_ERROR,
      this.onRelayerError.bind(this)
    )
  }

  private async onRelayerError() {
    await this.resetInvalidState(false)

    this.events.emit(BeaconEvent.RELAYER_ERROR)
  }

  private async wcToastHandler(status: string) {
    const walletInfo = await (async (): Promise<WalletInfo> => {
      try {
        return await this.getWalletInfo()
      } catch {
        return { name: 'wallet' }
      }
    })()

    await this.events.emit(BeaconEvent.HIDE_UI, ['alert'])
    if (status === 'pending') {
      this.events.emit(BeaconEvent.ACKNOWLEDGE_RECEIVED, {
        message: {} as any,
        extraInfo: {} as any,
        walletInfo
      })
    } else {
      // The WC transport reports session-proposal rejection through this event
      // when there are no active listeners yet (no peer paired). Reject the
      // in-flight init promise so `await dapp.requestPermissions()` unwinds
      // through requestPermissions' catch -> handleRequestError, which both
      // emits PERMISSION_REQUEST_ERROR and resets transport state. Without
      // this, the dapp wedges with a pending `_initPromise`.
      this._initReject?.(this.createAbortedError())
    }
  }
  private async channelClosedHandler(type: TransportType) {
    if (!this._transport.isResolved()) {
      await this.events.emit(BeaconEvent.CHANNEL_CLOSED)

      return
    }

    const transport = await this.transport

    if (transport.type !== type) {
      return
    }

    await this.events.emit(BeaconEvent.CHANNEL_CLOSED)
    await this.disconnect({ notifyPeers: false })
  }

  /**
   * Destroy the instance.
   *
   * WARNING: Call `destroy` whenever you no longer need dAppClient
   * as it frees internal subscriptions to the transport and therefore the instance may no longer work properly.
   * If you wish to disconnect your dApp, use `disconnect` instead.
   */
  public async destroy(): Promise<void> {
    this.beginAccountTransition()
    if (!this._activeAccount.isSettled()) {
      this._activeAccount.resolve(undefined)
    }
    this.destroyed = true
    this.initialization.destroy()

    await this.initialization.cleanup(async () => {
      try {
        await this.accountWrite
        await this.activeAccountWrite
      } finally {
        await this.destroyInternalTransports()
        await super.destroy()
      }
    })
  }

  private async destroyInternalTransports(): Promise<void> {
    this.abortPendingInit()

    const transports: (DappPostMessageTransport | DappP2PTransport | DappWalletConnectTransport)[] =
      []
    if (this.postMessageTransport) {
      transports.push(this.postMessageTransport)
    }
    if (this.p2pTransport) {
      transports.push(this.p2pTransport)
    }
    if (this.walletConnectTransport) {
      transports.push(this.walletConnectTransport)
    }

    if (transports.length > 0) {
      await this.cleanup(transports)

      await Promise.all(
        transports.map(async (transport) => {
          if (transport instanceof DappWalletConnectTransport) {
            await transport.release()

            return
          }
          await transport.disconnect()

          if (this.hasClientCleanup(transport)) {
            await transport.doClientCleanup()
          }
        })
      )

      this.postMessageTransport = this.p2pTransport = this.walletConnectTransport = undefined
      await this.setTransport(undefined)
    }
    await this.multiTabChannel.close()
  }

  private abortPendingInit(): void {
    this.initialization.abort()
    this._requestPermissionsPromise = undefined
    this._requestPermissionsKey = undefined
  }

  private createAbortedError(id: string = ''): ErrorResponse {
    return {
      type: BeaconMessageType.Error,
      id,
      senderId: '',
      version: '2',
      errorType: BeaconErrorType.ABORTED_ERROR
    }
  }

  /**
   * @internal
   */
  public isDestroyed(): boolean {
    return this.destroyed
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error('DAppClient has been destroyed and cannot be used again.')
    }
  }

  public async init(transport?: Transport<PeerInfoType>): Promise<TransportType> {
    this.assertNotDestroyed()
    if (this.initialization.tearingDown) {
      await this.initialization.waitForTeardown()
      this.assertNotDestroyed()
    }
    if (this._initPromise) {
      return this._initPromise
    }

    const transition = this.accountTransition.signal
    if (!this.startupTransition.aborted) {
      await this.waitForAccountRestoration(transition)
    }
    await this.initialization.waitForSelection(transition)
    this.assertNotDestroyed()
    if (!this.isCurrentAccountTransition(transition)) {
      throw this.createAbortedError()
    }

    return this.initialization.start(
      transition,
      () => {
        this.walletConnectTransport
          ?.stopListeningForNewPeers()
          .catch((error: unknown) => logger.error('stopListeningForNewPeers', error))
      },
      (attempt) => this.initializeTransport(transport, transition, attempt)
    )
  }

  private async initializeTransport(
    transport: Transport<PeerInfoType> | undefined,
    transition: AbortSignal,
    attempt: InitializationAttempt
  ): Promise<void> {
    const resolve = (type: TransportType) => attempt.resolve(type)
    const reject = (error: unknown) => attempt.reject(error)
    if (transport) {
      await this.addListener(transport)
      if (!attempt.isCurrent()) {
        return
      }
      resolve(await super.init(transport))
    } else if (this._transport.isSettled()) {
      const selectedTransport = await this.transport
      if (!attempt.isCurrent()) {
        return
      }
      await selectedTransport.connect()
      if (!attempt.isCurrent()) {
        return
      }
      resolve(await super.init(selectedTransport))
    } else {
      const activeAccount = await this.getActiveAccount()
      if (!attempt.isCurrent()) {
        return
      }

      await this.initInternalTransports()
      if (!attempt.isCurrent()) {
        return
      }
      if (!this.postMessageTransport || !this.p2pTransport || !this.walletConnectTransport) {
        // Bare return here used to strand the promise forever -- no UI is
        // emitted, no peer ever pairs, no abort path fires. Reject explicitly
        // so callers see a deterministic error.
        const noTransportError: ErrorResponse = {
          type: BeaconMessageType.Error,
          id: '',
          senderId: '',
          version: '2',
          errorType: BeaconErrorType.UNKNOWN_ERROR
        }
        reject(noTransportError)

        return
      }

      const p2pTransport = this.p2pTransport
      const postMessageTransport = this.postMessageTransport
      const walletConnectTransport = this.walletConnectTransport
      const stopListening = () => {
        const onError = (err: unknown) => logger.error('stopListeningForNewPeers', err)
        postMessageTransport.stopListeningForNewPeers().catch(onError)
        p2pTransport.stopListeningForNewPeers().catch(onError)
        walletConnectTransport.stopListeningForNewPeers().catch(onError)
      }

      postMessageTransport
        .connect()
        .then()
        .catch((err) => logger.error('init', 'postmessage connect', err))

      if (activeAccount && activeAccount.origin) {
        const origin = activeAccount.origin.type
        // Select the transport that matches the active account
        if (origin === Origin.EXTENSION) {
          resolve(await super.init(postMessageTransport))
        } else if (origin === Origin.P2P) {
          resolve(await super.init(p2pTransport))
        } else if (origin === Origin.WALLETCONNECT) {
          resolve(await super.init(walletConnectTransport))
        }
      } else {
        let pairingCancelled = false
        let pairingFinished = false

        postMessageTransport
          .listenForNewPeer(async (peer) => {
            if (pairingCancelled || pairingFinished || !attempt.isCurrent()) {
              return false
            }
            pairingFinished = true
            stopListening()
            logger.log('init', 'postmessage transport peer connected', peer)
            this.analytics.track('event', 'DAppClient', 'Extension connected', {
              peerName: peer.name
            })

            try {
              await this.setActivePeer(peer, transition)
              if (!attempt.isCurrent()) {
                return false
              }
              await this.setTransport(postMessageTransport)
            } catch (error) {
              if (!attempt.isCurrent()) {
                return false
              }
              pairingCancelled = true
              await this.setActivePeer(undefined, transition).catch((err) =>
                logger.error('init', err)
              )
              if (!attempt.isCurrent()) {
                return false
              }
              await this.setTransport(undefined).catch((err) => logger.error('init', err))
              reject(error)
              throw error
            }
            if (pairingCancelled || !attempt.isCurrent()) {
              return false
            }
            this.events
              .emit(BeaconEvent.PAIR_SUCCESS, peer)
              .catch((err) => logger.error('init', err))
            resolve(TransportType.POST_MESSAGE)

            return true
          })
          .catch((err) => logger.error('init', err))

        p2pTransport
          .listenForNewPeer(async (peer) => {
            if (pairingCancelled || pairingFinished || !attempt.isCurrent()) {
              return false
            }
            pairingFinished = true
            stopListening()
            logger.log('init', 'p2p transport peer connected', peer)
            this.analytics.track('event', 'DAppClient', 'Beacon Wallet connected', {
              peerName: peer.name
            })

            try {
              await this.setActivePeer(peer, transition)
              if (!attempt.isCurrent()) {
                return false
              }
              await this.setTransport(p2pTransport)
            } catch (error) {
              if (!attempt.isCurrent()) {
                return false
              }
              pairingCancelled = true
              await this.setActivePeer(undefined, transition).catch((err) =>
                logger.error('init', err)
              )
              if (!attempt.isCurrent()) {
                return false
              }
              await this.setTransport(undefined).catch((err) => logger.error('init', err))
              reject(error)
              throw error
            }
            if (pairingCancelled || !attempt.isCurrent()) {
              return false
            }
            this.events
              .emit(BeaconEvent.PAIR_SUCCESS, peer)
              .catch((err) => logger.error('init', err))
            resolve(TransportType.P2P)

            return true
          })
          .catch((err) => logger.error('init', err))

        walletConnectTransport
          .listenForNewPeer(async (peer) => {
            if (pairingCancelled || pairingFinished || !attempt.isCurrent()) {
              return false
            }
            pairingFinished = true
            stopListening()
            logger.log('init', 'walletconnect transport peer connected', peer)
            this.analytics.track('event', 'DAppClient', 'WalletConnect Wallet connected', {
              peerName: peer.name
            })

            try {
              await this.setActivePeer(peer, transition)
              if (!attempt.isCurrent()) {
                return false
              }
              await this.setTransport(walletConnectTransport)
            } catch (error) {
              if (!attempt.isCurrent()) {
                return false
              }
              pairingCancelled = true
              await this.setActivePeer(undefined, transition).catch((err) =>
                logger.error('init', err)
              )
              if (!attempt.isCurrent()) {
                return false
              }
              await this.setTransport(undefined).catch((err) => logger.error('init', err))
              reject(error)

              return false
            }
            if (pairingCancelled || !attempt.isCurrent()) {
              return false
            }
            this.events
              .emit(BeaconEvent.PAIR_SUCCESS, peer)
              .catch((err) => logger.error('init', err))
            resolve(TransportType.WALLETCONNECT)

            return true
          })
          .catch((err) => logger.error('init', err))

        PostMessageTransport.getAvailableExtensions()
          .then(async (extensions) => {
            this.analytics.track('event', 'DAppClient', 'Extensions detected', { extensions })
          })
          .catch((error) => {
            if (!attempt.isCurrent()) {
              return
            }
            logger.error('init', 'getAvailableExtensions', error)
          })

        const abortHandler = async (): Promise<AbortSignal | undefined> => {
          if (pairingCancelled || pairingFinished || !attempt.isCurrent()) {
            return undefined
          }
          pairingCancelled = true

          return this.initialization.cleanup(async () => {
            reject(this.createAbortedError())
            const cleanupTransition = this.beginAccountTransition()
            this._requestPermissionsPromise = undefined
            this._requestPermissionsKey = undefined
            let failure: unknown
            try {
              await Promise.all([
                p2pTransport.stopListeningForNewPeers(),
                postMessageTransport.stopListeningForNewPeers()
              ])
            } catch (error) {
              failure = error
              logger.error('init', 'pairing rollback failed', error)
            }
            const stopped = await Promise.allSettled([
              postMessageTransport.disconnect(),
              p2pTransport.disconnect(),
              walletConnectTransport
                .disconnect()
                .finally(() => this.releaseWalletConnectTransport(walletConnectTransport))
            ])
            for (const result of stopped) {
              if (result.status === 'rejected') {
                failure ??= result.reason
                logger.error('init', 'transport shutdown failed', result.reason)
              }
            }
            // Disposal owns captured adapters even when a newer account choice is waiting.
            if (this.postMessageTransport === postMessageTransport) {
              this.postMessageTransport = undefined
            }
            if (this.p2pTransport === p2pTransport) {
              this.p2pTransport = undefined
            }
            if (this.walletConnectTransport === walletConnectTransport) {
              this.walletConnectTransport = undefined
            }
            if (!this.isCurrentAccountTransition(cleanupTransition)) {
              if (failure) {
                throw failure
              }

              return undefined
            }
            await this.applyActiveAccount(undefined, cleanupTransition, 'local')
            if (failure) {
              throw failure
            }

            return this.isCurrentAccountTransition(cleanupTransition)
              ? cleanupTransition
              : undefined
          })
        }

        const serializer = new Serializer()
        const p2pPeerInfo = attempt.information(async () => {
          try {
            await p2pTransport.connect()
            if (pairingCancelled || pairingFinished || !attempt.isCurrent()) {
              return ''
            }
          } catch (err: unknown) {
            if (pairingCancelled || pairingFinished || !attempt.isCurrent()) {
              return ''
            }
            const message = err instanceof Error ? err.message : String(err)
            logger.error('init', err)
            await this.hideUI(['alert'])
            const errorTransition = await abortHandler().catch((abortErr) => {
              logger.warn('init', 'abortHandler', abortErr)

              return undefined
            })
            if (errorTransition) {
              setTimeout(() => {
                if (this.isCurrentAccountTransition(errorTransition)) {
                  this.events
                    .emit(BeaconEvent.GENERIC_ERROR, message)
                    .catch((emitErr) => logger.warn('init', 'GENERIC_ERROR emit', emitErr))
                }
              }, 1000)
            }

            return ''
          }
          try {
            return serializer.serialize(await p2pTransport.getPairingRequestInfo())
          } catch (error) {
            if (pairingCancelled || pairingFinished) {
              return ''
            } else {
              throw error
            }
          }
        })

        const walletConnectPeerInfo = createLazyPromise(() =>
          attempt.information(() =>
            walletConnectTransport
              .getPairingRequestInfo()
              .then((pairingRequestInfo) => pairingRequestInfo.uri)
              .catch((error) => {
                logger.warn('init', 'walletconnect pairing request failed', error)

                return ''
              })
          )
        )

        const postmessagePeerInfo = attempt.information(async (): Promise<string> => {
          if (pairingCancelled || pairingFinished) {
            return ''
          }
          try {
            return await serializer.serialize(await postMessageTransport.getPairingRequestInfo())
          } catch (error) {
            if (pairingCancelled || pairingFinished) {
              return ''
            }
            throw error
          }
        })

        if (!attempt.isCurrent()) {
          return
        }
        this.events
          .emit(BeaconEvent.PAIR_INIT, {
            p2pPeerInfo,
            postmessagePeerInfo,
            walletConnectPeerInfo,
            networkType: this.network.type,
            abortedHandler: async () => {
              await abortHandler()
            },
            disclaimerText: this.disclaimerText,
            analytics: this.analytics,
            featuredWallets: this.featuredWallets
          })
          .catch((emitError) => logger.warn('init', emitError))
      }
    }
  }

  /**
   * Returns the active account
   */
  public async getActiveAccount(): Promise<AccountInfo | undefined> {
    this.assertNotDestroyed()

    return this._activeAccount.promise
  }

  private resolveActiveAccount(account: AccountInfo | undefined): void {
    if (this._activeAccount.isSettled()) {
      this._activeAccount = ExposedPromise.resolve<AccountInfo | undefined>(account)
    } else {
      this._activeAccount.resolve(account)
    }
  }

  private waitForAccountRestoration(transition: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(this.createAbortedError())
      if (transition.aborted) {
        abort()

        return
      }
      transition.addEventListener('abort', abort, { once: true })
      this.activeAccountLoaded.then(
        () => {
          transition.removeEventListener('abort', abort)
          resolve()
        },
        (error: unknown) => {
          transition.removeEventListener('abort', abort)
          reject(error)
        }
      )
    })
  }

  private retainStorageValidationPromise(): void {
    // Constructor validation is intentionally fire-and-forget, but retaining
    // the promise gives tests a deterministic hook without changing public API.
    this.storageValidated.catch((err) => logger.error(err.message))
  }

  private async deactivateInvalidAccountState(
    reason: InvalidAccountDeactivatedReason,
    transition: AbortSignal = this.accountTransition.signal
  ): Promise<void> {
    if (!this.isCurrentAccountTransition(transition) || this.hasEmittedInvalidAccountDeactivated) {
      return
    }

    this.hasEmittedInvalidAccountDeactivated = true
    logger.log('deactivateInvalidAccountState', reason)
    if (reason === 'missing_active_account') {
      await this.repairMissingActiveAccount(transition)
    } else {
      await this.resetInvalidState(false, transition)
    }
    if (this.isCurrentAccountTransition(transition)) {
      await this.events.emit(BeaconEvent.INVALID_ACCOUNT_DEACTIVATED, { reason })
    }
  }

  private async repairMissingActiveAccount(
    transition: AbortSignal = this.beginAccountTransition()
  ): Promise<void> {
    const identifier = await this.storage.get(StorageKey.ACTIVE_ACCOUNT)
    if (!this.isCurrentAccountTransition(transition)) {
      return
    }
    this.resolveActiveAccount(undefined)
    await this.persistActiveAccount(undefined, transition, identifier)
    await this.setActivePeer(undefined, transition)
  }

  private hasStoredActiveAccountPointer(): boolean {
    // LocalStorage-specific repair: that backend is where literal sentinel strings were produced.
    if (typeof localStorage === 'undefined') {
      return false
    }

    try {
      return localStorage.getItem(this.storage.getPrefixedKey(StorageKey.ACTIVE_ACCOUNT)) !== null
    } catch {
      return false
    }
  }

  private async resetInvalidState(
    emit: boolean = true,
    transition: AbortSignal = this.beginAccountTransition()
  ) {
    if (!this.isCurrentAccountTransition(transition)) {
      return
    }
    await this.mutateAccounts(() => this.accountManager.removeAllAccounts())
    if (!this.isCurrentAccountTransition(transition)) {
      return
    }
    this.resolveActiveAccount(undefined)
    await this.persistActiveAccount(undefined, transition)
    if (!this.isCurrentAccountTransition(transition)) {
      return
    }
    if (emit) {
      await this.events.emit(BeaconEvent.INVALID_ACTIVE_ACCOUNT_STATE)
    } else {
      await this.hideUI(['alert'])
    }
    if (!this.isCurrentAccountTransition(transition)) {
      return
    }
    const postMessageTransport = this.postMessageTransport
    const p2pTransport = this.p2pTransport
    const walletConnectTransport = this.walletConnectTransport
    this.postMessageTransport = this.p2pTransport = this.walletConnectTransport = undefined
    await Promise.all([
      postMessageTransport?.disconnect(),
      p2pTransport?.disconnect(),
      walletConnectTransport
        ?.disconnect()
        .finally(() => this.releaseWalletConnectTransport(walletConnectTransport))
    ])
    if (!this.isCurrentAccountTransition(transition)) {
      return
    }
    await this.setActivePeer(undefined, transition)
    if (!this.isCurrentAccountTransition(transition)) {
      return
    }
    await this.setTransport(undefined)
  }

  /**
   * Sets the active account
   *
   * @param account The account that will be set as the active account
   */
  public async setActiveAccount(account?: AccountInfo): Promise<void> {
    await this.selectActiveAccount(account)
  }

  private async selectActiveAccount(
    account?: AccountInfo,
    owner?: PermissionRequestOwner
  ): Promise<void> {
    const transition = this.beginAccountTransition(owner)
    await this.applyActiveAccount(account, transition, 'local')
  }

  private applyActiveAccount(
    account: AccountInfo | undefined,
    transition: AbortSignal,
    source: 'local' | 'storage'
  ): Promise<boolean> {
    return this.runAccountTransition(
      transition,
      () => this.commitActiveAccount(account, transition, source),
      false
    )
  }

  private async runAccountTransition<T>(
    transition: AbortSignal,
    operation: () => Promise<T>,
    cancelled: T
  ): Promise<T> {
    return this.initialization.select(
      transition,
      async () => {
        try {
          return await operation()
        } catch (error: unknown) {
          if (this.isCurrentAccountTransition(transition) && !this._activeAccount.isSettled()) {
            this._activeAccount.resolve(undefined)
            this.resolveActivePeer(undefined)
          }
          await this.notifyActiveAccount(transition).catch((notificationError: unknown) =>
            logger.error('ACTIVE_ACCOUNT_SET', notificationError)
          )
          throw error
        } finally {
          if (this.pendingAccountSelection?.transition === transition) {
            this.pendingAccountSelection = undefined
          }
        }
      },
      cancelled
    )
  }

  private async commitActiveAccount(
    account: AccountInfo | undefined,
    transition: AbortSignal,
    source: 'local' | 'storage'
  ): Promise<boolean> {
    if (!this.isCurrentAccountTransition(transition)) {
      return false
    }
    if (account) {
      if (source === 'local' && this._disconnectPromise) {
        await this._disconnectPromise
      }
      await this.initialization.waitForTeardown()
    }
    if (!this.isCurrentAccountTransition(transition)) {
      return false
    }
    this.pendingAccountSelection = account
      ? {
          transition,
          account: { accountIdentifier: account.accountIdentifier, senderId: account.senderId }
        }
      : undefined
    const hasPendingAccountWrite = this.pendingActiveAccountWrites > 0
    const activeAccountAlreadyCleared = !account && (await this.isActiveAccountAlreadyCleared())
    if (!this.isCurrentAccountTransition(transition)) {
      return false
    }

    if (!activeAccountAlreadyCleared && !this.isGetActiveAccountHandled) {
      console.warn(
        `An active account has been received, but no active subscription was found for BeaconEvent.ACTIVE_ACCOUNT_SET.
        For more information, visit: https://docs.walletbeacon.io/guides/migration-guide`
      )
    }

    if (!account) {
      await this.clearWalletConnectSelection(transition)
    }
    if (!this.isCurrentAccountTransition(transition)) {
      return false
    }
    if (await this.resetDisconnectedWalletConnectSelection(transition)) {
      return false
    }
    const prepared = await this.prepareAccountSelection(account, transition, source)
    if (prepared.kind === 'superseded' || !this.isCurrentAccountTransition(transition)) {
      return false
    }
    if (source === 'local' && (!activeAccountAlreadyCleared || hasPendingAccountWrite)) {
      await this.persistActiveAccount(account, transition)
    }
    if (!this.isCurrentAccountTransition(transition)) {
      return false
    }
    if (!activeAccountAlreadyCleared) {
      this.resolveActiveAccount(account)
      this.activeAccountNotificationPending = true
    }
    this.resolveActivePeer(prepared.peer)
    await this.setTransport(prepared.transport)
    if (!this.isCurrentAccountTransition(transition)) {
      return false
    }
    if (account?.origin.type === Origin.WALLETCONNECT) {
      this.walletConnectTransport?.forceUpdate('INIT')
    }
    await this.notifyActiveAccount(transition)

    return this.isCurrentAccountTransition(transition)
  }

  private async notifyActiveAccount(transition: AbortSignal): Promise<void> {
    if (!this.isCurrentAccountTransition(transition) || !this.activeAccountNotificationPending) {
      return
    }
    const account = await this._activeAccount.promise
    if (!this.isCurrentAccountTransition(transition)) {
      return
    }
    this.activeAccountNotificationPending = false
    await this.events.emit(BeaconEvent.ACTIVE_ACCOUNT_SET, account)
  }

  private async clearWalletConnectSelection(transition: AbortSignal): Promise<void> {
    if (!this._activeAccount.isResolved() || !(await this.getActiveAccount())) {
      return
    }
    const transport = this._transport.isResolved() ? await this.transport : undefined
    if (
      !this.isCurrentAccountTransition(transition) ||
      this.debounceSetActiveAccount ||
      !(transport instanceof WalletConnectTransport)
    ) {
      return
    }
    this.debounceSetActiveAccount = true
    this._initPromise = undefined
    const secondaryTransports = this.getInitializedTransports().filter(
      (candidate) => candidate !== transport
    )
    const walletConnectTransport = this.walletConnectTransport
    this.postMessageTransport = this.p2pTransport = this.walletConnectTransport = undefined
    try {
      const disconnects = secondaryTransports.map((secondary) => secondary.disconnect())
      if (this.multiTabChannel.isLeader() || isMobileOS(window)) {
        disconnects.push(transport.disconnect())
      } else {
        this.multiTabChannel.postMessage({ type: 'DISCONNECT' })
      }
      await Promise.all(disconnects)
      if (this.isCurrentAccountTransition(transition)) {
        this.abortOpenRequests()
      }
    } finally {
      this.debounceSetActiveAccount = false
      // A secondary tab delegates session logout to its leader.
      await this.releaseWalletConnectTransport(walletConnectTransport, false)
    }
  }

  private async resetDisconnectedWalletConnectSelection(transition: AbortSignal): Promise<boolean> {
    if (this.isGetActiveAccountHandled || !this._transport.isResolved()) {
      return false
    }
    const transport = await this.transport
    if (
      this.isCurrentAccountTransition(transition) &&
      transport instanceof WalletConnectTransport &&
      transport.wasDisconnectedByWallet()
    ) {
      await this.resetInvalidState(true, transition)

      return true
    }

    return false
  }

  private selectAccountTransport(account: AccountInfo): DAppInternalTransport | undefined {
    switch (account.origin.type) {
      case Origin.EXTENSION:
        return this.postMessageTransport
      case Origin.P2P:
        return this.p2pTransport
      case Origin.WALLETCONNECT:
        return this.walletConnectTransport
      default:
        return undefined
    }
  }

  private async prepareAccountSelection(
    account: AccountInfo | undefined,
    transition: AbortSignal,
    source: 'local' | 'storage'
  ): Promise<PreparedAccountSelection> {
    if (!account) {
      return { kind: 'ready', peer: undefined, transport: undefined }
    }
    await this.initInternalTransports()
    if (!this.isCurrentAccountTransition(transition)) {
      return { kind: 'superseded' }
    }
    const transport = this.selectAccountTransport(account)
    let peer = await this.getPeer(account)
    if (!this.isCurrentAccountTransition(transition)) {
      return { kind: 'superseded' }
    }
    if (peer && !this._activePeer.isSettled()) {
      this.resolveActivePeer(peer)
    }
    if (transport?.connectionStatus === TransportStatus.NOT_CONNECTED) {
      await transport.connect()
      if (!this.isCurrentAccountTransition(transition)) {
        return { kind: 'superseded' }
      }
      if (!peer) {
        peer = await this.getPeer(account)
        if (!this.isCurrentAccountTransition(transition)) {
          return { kind: 'superseded' }
        }
      }
    }
    if (source === 'storage' && !(await this.isStoredAccountCurrent(account))) {
      await this.applyActiveAccount(undefined, transition, 'storage')

      return { kind: 'superseded' }
    }

    return { kind: 'ready', peer, transport }
  }

  private async isStoredAccountCurrent(account: AccountInfo): Promise<boolean> {
    const [identifier, accounts] = await Promise.all([
      this.storage.get(StorageKey.ACTIVE_ACCOUNT),
      this.accountManager.getAccounts()
    ])

    return (
      identifier === account.accountIdentifier &&
      accounts.some((stored) => stored.accountIdentifier === account.accountIdentifier)
    )
  }

  private persistActiveAccount(
    account: AccountInfo | undefined,
    transition: AbortSignal,
    expectedIdentifier?: string
  ): Promise<void> {
    const commit = async (): Promise<void> => {
      if (!this.isCurrentAccountTransition(transition)) {
        return
      }
      if (expectedIdentifier !== undefined) {
        const identifier = await this.storage.get(StorageKey.ACTIVE_ACCOUNT)
        if (!this.isCurrentAccountTransition(transition) || identifier !== expectedIdentifier) {
          return
        }
      }
      if (account) {
        await this.storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
      } else {
        await this.storage.delete(StorageKey.ACTIVE_ACCOUNT)
      }
    }
    // Only storage commits are ordered. Disconnect never waits behind transport initialization.
    this.pendingActiveAccountWrites++
    this.activeAccountWrite = this.activeAccountWrite.then(commit, commit).finally(() => {
      this.pendingActiveAccountWrites--
    })

    return this.activeAccountWrite
  }

  private async isActiveAccountAlreadyCleared(): Promise<boolean> {
    return (
      this._activeAccount.isResolved() &&
      !(await this.getActiveAccount()) &&
      !this.activeAccountNotificationPending
    )
  }

  private async recoverActiveAccountFromAccountsChange(): Promise<void> {
    const transition = this.beginAccountTransition()
    await this.runAccountTransition(
      transition,
      async () => {
        const activeAccountIdentifier = await this.storage.get(StorageKey.ACTIVE_ACCOUNT)
        const account = activeAccountIdentifier
          ? await this.getAccount(activeAccountIdentifier)
          : undefined
        if (!this.isCurrentAccountTransition(transition)) {
          return
        }
        if (!account && activeAccountIdentifier) {
          const activeAccount = this._activeAccount.isResolved()
            ? await this.getActiveAccount()
            : undefined
          if (activeAccount || this.activeAccountNotificationPending) {
            await this.commitActiveAccount(undefined, transition, 'local')
          } else {
            await this.repairMissingActiveAccount(transition)
          }

          return
        }
        if (this._activeAccount.isResolved()) {
          const activeAccount = await this.getActiveAccount()
          if (activeAccount?.accountIdentifier === account?.accountIdentifier) {
            await this.notifyActiveAccount(transition)

            return
          }
        }
        await this.commitActiveAccount(account, transition, 'storage')
      },
      undefined
    )
  }

  /**
   * Clear the active account
   */
  public clearActiveAccount(): Promise<void> {
    return this.setActiveAccount()
  }

  public async setColorMode(colorMode: ColorMode): Promise<void> {
    return setColorMode(colorMode)
  }

  public async getColorMode(): Promise<ColorMode> {
    return getColorMode()
  }

  /**
   * @deprecated
   *
   * Use getOwnAppMetadata instead
   */
  public async getAppMetadata(): Promise<AppMetadata> {
    return this.getOwnAppMetadata()
  }

  public async showPrepare(): Promise<void> {
    const walletInfo = await (async () => {
      try {
        return await this.getWalletInfo()
      } catch {
        return undefined
      }
    })()
    await this.events.emit(BeaconEvent.SHOW_PREPARE, { walletInfo })
  }

  public async hideUI(elements: ('alert' | 'toast')[]): Promise<void> {
    await this.events.emit(BeaconEvent.HIDE_UI, elements)
  }

  private async tryToAppSwitch(isCurrent: () => boolean = () => true) {
    if (!isMobileOS(window) || !this.enableAppSwitching) {
      return
    }

    const wallet = await this.getWalletInfo()

    if (!isCurrent() || wallet.type !== 'mobile' || !wallet.deeplink) {
      return
    }

    const link = isIOS(window) ? wallet.deeplink : `${wallet.deeplink}wc?uri=`

    if (!link?.length) {
      return
    }

    window.location.href = link
  }

  private async checkMakeRequest() {
    const isResolved = this._transport.isResolved()
    const isWCInstance = isResolved && (await this.transport) instanceof WalletConnectTransport
    await this.multiTabChannel.init()
    const isLeader = this.multiTabChannel.isLeader()

    return !isResolved || !isWCInstance || isLeader || isMobileOS(window)
  }

  /**
   * Will remove the account from the local storage and set a new active account if necessary.
   *
   * @param accountIdentifier ID of the account
   */
  public async removeAccount(accountIdentifier: string): Promise<void> {
    this._accountChangeGeneration++
    const transition = await this.mutateAccounts(async () => {
      const removal = await this.beginAccountRemoval(this.accountTransition.signal, {
        accountIdentifiers: [accountIdentifier],
        senderIds: []
      })
      await super.removeAccount(accountIdentifier)

      return removal
    })
    await this.completeAccountRemoval(transition)
  }

  private async beginAccountRemoval(
    observedTransition: AbortSignal,
    removed: { accountIdentifiers: readonly string[]; senderIds: readonly string[] }
  ): Promise<AccountRemovalSelection | undefined> {
    const pending = this.pendingAccountSelection
    const storedIdentifier = await this.storage.get(StorageKey.ACTIVE_ACCOUNT)
    if (!this.isCurrentAccountTransition(observedTransition)) {
      return undefined
    }
    const activeAccount = this._activeAccount.isResolved()
      ? await this.getActiveAccount()
      : undefined
    if (!this.isCurrentAccountTransition(observedTransition)) {
      return undefined
    }
    const matches = (account: Pick<AccountInfo, 'accountIdentifier' | 'senderId'> | undefined) =>
      account !== undefined &&
      (removed.accountIdentifiers.includes(account.accountIdentifier) ||
        removed.senderIds.includes(account.senderId))
    const previousIdentifier =
      storedIdentifier !== undefined && removed.accountIdentifiers.includes(storedIdentifier)
        ? storedIdentifier
        : matches(activeAccount)
          ? activeAccount?.accountIdentifier
          : undefined
    const ownsPending = pending?.transition === observedTransition
    const removesPending = ownsPending && matches(pending.account)
    if (ownsPending && !removesPending) {
      return previousIdentifier === undefined
        ? undefined
        : { kind: 'previous', transition: observedTransition, identifier: previousIdentifier }
    }
    if (removesPending || previousIdentifier !== undefined) {
      const transition = this.beginAccountTransition()
      // Canceling an uncommitted replacement must not clear a different active account.

      return previousIdentifier === undefined && activeAccount
        ? undefined
        : { kind: 'clear', transition }
    }

    return undefined
  }

  private async completeAccountRemoval(
    removal: AccountRemovalSelection | undefined
  ): Promise<void> {
    if (!removal) {
      return
    }
    if (removal.kind === 'clear') {
      await this.applyActiveAccount(undefined, removal.transition, 'local')

      return
    }
    await this.persistActiveAccount(undefined, removal.transition, removal.identifier)
    if (!this.isCurrentAccountTransition(removal.transition)) {
      return
    }
    const account = this._activeAccount.isResolved() ? this._activeAccount.promiseResult : undefined
    if (account?.accountIdentifier !== removal.identifier) {
      return
    }
    this.resolveActiveAccount(undefined)
    this.resolveActivePeer(undefined)
    this.activeAccountNotificationPending = false
    await this.events.emit(BeaconEvent.ACTIVE_ACCOUNT_SET, undefined)
  }

  /**
   * Remove all accounts and set active account to undefined
   */
  public async removeAllAccounts(): Promise<void> {
    this.abortPermissionRequests()
    this._accountChangeGeneration++
    const transition = await this.mutateAccounts(async () => {
      const removal = this.beginAccountTransition()
      await super.removeAllAccounts()

      return removal
    })
    await this.applyActiveAccount(undefined, transition, 'local')
  }

  /**
   * Removes a peer and all the accounts that have been connected through that peer
   *
   * @param peer Peer to be removed
   */
  public async removePeer(
    peer: ExtendedPeerInfo,
    sendDisconnectToPeer: boolean = false
  ): Promise<void> {
    const transport = await this.transport

    const removePeerResult = transport.removePeer(peer)

    await this.removeAccountsForPeers([peer])

    if (sendDisconnectToPeer) {
      await this.sendDisconnectToPeer(peer, transport)
    }

    return removePeerResult
  }

  /**
   * Remove all peers and all accounts that have been connected through those peers
   */
  public async removeAllPeers(
    sendDisconnectToPeers: boolean = false,
    options: DAppClientRemoveAllPeersOptions = {}
  ): Promise<void> {
    const transport = (await this.transport) as DAppInternalTransport

    const peers: ExtendedPeerInfo[] = await transport.getPeers()
    const removePeerResult = await transport.removeAllPeers()

    await this.removeAccountsForPeers(peers)

    if (sendDisconnectToPeers) {
      const disconnectPromises = peers.map((peer) => this.sendDisconnectToPeer(peer, transport))

      if (options.ignoreDisconnectErrors) {
        await Promise.allSettled(disconnectPromises)
      } else {
        await Promise.all(disconnectPromises)
      }
    }

    return removePeerResult
  }

  /**
   * Allows the user to subscribe to specific events that are fired in the SDK
   *
   * @param internalEvent The event to subscribe to
   * @param eventCallback The callback that will be called when the event occurs
   */
  public async subscribeToEvent<K extends BeaconEvent>(
    internalEvent: K,
    eventCallback: BeaconEventHandlerFunction<BeaconEventType[K]>
  ): Promise<void> {
    if (internalEvent === BeaconEvent.ACTIVE_ACCOUNT_SET) {
      this.isGetActiveAccountHandled = true
    }

    await this.events.on(internalEvent, eventCallback)
  }

  /**
   * Check if we have permissions to send the specific message type to the active account.
   * If no active account is set, only permission requests are allowed.
   *
   * @param type The type of the message
   */
  public async checkPermissions(type: BeaconMessageType): Promise<boolean> {
    if (
      [
        BeaconMessageType.PermissionRequest,
        BeaconMessageType.ProofOfEventChallengeRequest,
        BeaconMessageType.SimulatedProofOfEventChallengeRequest
      ].includes(type)
    ) {
      return true
    }

    const activeAccount: AccountInfo | undefined = await this.getActiveAccount()

    if (!activeAccount) {
      throw await this.sendInternalError('No active account set!')
    }

    const permissions = activeAccount.scopes

    switch (type) {
      case BeaconMessageType.OperationRequest:
        return permissions.includes(PermissionScope.OPERATION_REQUEST)
      case BeaconMessageType.SignPayloadRequest:
        return permissions.includes(PermissionScope.SIGN)
      // TODO: ENCRYPTION
      // case BeaconMessageType.EncryptPayloadRequest:
      //   return permissions.includes(PermissionScope.ENCRYPT)
      case BeaconMessageType.BroadcastRequest:
        return true
      default:
        return false
    }
  }

  public async sendNotification(
    title: string,
    message: string,
    payload: string,
    protocolIdentifier: string
  ): Promise<string> {
    const activeAccount = await this.getActiveAccount()

    if (
      !activeAccount ||
      (activeAccount &&
        !activeAccount.scopes.includes(PermissionScope.NOTIFICATION) &&
        !activeAccount.notification)
    ) {
      throw new Error('notification permissions not given')
    }

    if (!activeAccount.notification?.token) {
      throw new Error('No AccessToken')
    }

    const url = activeAccount.notification?.apiUrl

    if (!url) {
      throw new Error('No Push URL set')
    }

    return this.sendNotificationWithAccessToken({
      url,
      recipient: activeAccount.address,
      title,
      body: message,
      payload,
      protocolIdentifier,
      accessToken: activeAccount.notification?.token
    })
  }

  private readonly blockchains: Map<string, Blockchain> = new Map()

  addBlockchain(chain: Blockchain) {
    this.blockchains.set(chain.identifier, chain)
    chain.getWalletLists().then((walletLists) => {
      setDesktopList(walletLists.desktopList)
      setExtensionList(walletLists.extensionList)
      setWebList(walletLists.webList)
      setiOSList(walletLists.iOSList)
    })
  }

  removeBlockchain(chainIdentifier: string) {
    this.blockchains.delete(chainIdentifier)
  }

  public async permissionRequest(input: PermissionRequestV3): Promise<PermissionResponseV3> {
    logger.log('permissionRequest', input)
    const blockchain = this.blockchains.get(input.blockchainIdentifier)
    if (!blockchain) {
      throw new Error(`Blockchain "${input.blockchainIdentifier}" not supported by dAppClient`)
    }

    const request: PermissionRequestV3 = {
      ...input,
      type: BeaconMessageType.PermissionRequest,
      blockchainData: {
        ...input.blockchainData,
        appMetadata: await this.getOwnAppMetadata()
      }
    }

    logger.log('REQUESTION PERMIMISSION V3', 'xxx', request)

    const logId = `makeRequestV3 ${Date.now()}`
    logger.time(true, logId)

    return this.runPermissionRequest(request, logId, async (owner) => {
      const { message: response, connectionInfo } = await this.makeRequestV3<
        PermissionRequestV3,
        BeaconMessageWrapper<PermissionResponseV3>
      >(request, undefined, owner)
      owner.assertCurrent()

      const partialAccountInfos = await blockchain.getAccountInfosFromPermissionResponse(
        response.message
      )
      owner.assertCurrent()
      // V3 retains its chain-specific account shape at the legacy account-store boundary.
      const accountInfo = {
        accountIdentifier: partialAccountInfos[0].accountId,
        senderId: response.senderId,
        origin: { type: connectionInfo.origin, id: connectionInfo.id },
        address: partialAccountInfos[0].address,
        publicKey: partialAccountInfos[0].publicKey,
        scopes: response.message.blockchainData.scopes,
        connectedAt: new Date().getTime(),
        chainData: response.message.blockchainData
      } as unknown as AccountInfo

      await this.persistPermissionAccount(accountInfo, owner)
      owner.assertCurrent()
      await this.selectActiveAccount(accountInfo, owner)
      owner.assertCurrent()
      const callbackWalletInfo = await this.getWalletInfo()
      owner.assertCurrent()
      await blockchain.handleResponse({
        request,
        account: accountInfo,
        output: response,
        blockExplorer: this.blockExplorer,
        connectionContext: connectionInfo,
        walletInfo: callbackWalletInfo
      })
      owner.assertCurrent()
      const walletInfo = await this.getWalletInfo()
      owner.complete()
      await this.notifySuccess(request as unknown as PermissionRequestInput, {
        account: accountInfo,
        output: {
          address: partialAccountInfos[0].address,
          network: { type: input.blockchainIdentifier },
          scopes: []
        } as unknown as PermissionResponseOutput,
        blockExplorer: this.blockExplorer,
        connectionContext: connectionInfo,
        walletInfo
      })

      return response.message
    })
  }

  public async request(input: BlockchainRequestV3): Promise<BlockchainResponseV3> {
    logger.log('request', input)
    const blockchain = this.blockchains.get(input.blockchainIdentifier)
    if (!blockchain) {
      throw new Error(`Blockchain "${blockchain}" not supported by dAppClient`)
    }

    await blockchain.validateRequest(input)

    const activeAccount: AccountInfo | undefined = await this.getActiveAccount()
    if (!activeAccount) {
      throw await this.sendInternalError('No active account!')
    }

    const request: BlockchainRequestV3 = {
      ...input,
      type: BeaconMessageType.BlockchainRequest,
      accountId: activeAccount.accountIdentifier
    }

    const logId = `makeRequestV3 ${Date.now()}`
    logger.time(true, logId)
    const res = (await this.checkMakeRequest())
      ? this.makeRequestV3<BlockchainRequestV3, BeaconMessageWrapper<BlockchainResponseV3>>(request)
      : this.makeRequestBC<any, any>(request)

    let resolved
    try {
      resolved = await res
    } catch (requestError) {
      await this.runRequestErrorSideEffects(request, requestError, logId)
      throw requestError
    }
    if (!resolved) {
      throw new Error('Internal error: makeRequest returned no result')
    }
    const { message: response, connectionInfo } = resolved

    logger.time(false, logId)

    await blockchain.handleResponse({
      request,
      account: activeAccount,
      output: response,
      blockExplorer: this.blockExplorer,
      connectionContext: connectionInfo,
      walletInfo: await this.getWalletInfo()
    })

    await this.notifySuccess(
      request as any,
      {
        walletInfo: await this.getWalletInfo()
      } as any
    )

    return response.message
  }

  /**
   * Send a permission request to the DApp. This should be done as the first step. The wallet will respond
   * with an publicKey and permissions that were given. The account returned will be set as the "activeAccount"
   * and will be used for the following requests.
   *
   * @param input The message details we need to prepare the PermissionRequest message.
   */
  public async requestPermissions(
    input?: RequestPermissionInput
  ): Promise<PermissionResponseOutput> {
    this.assertNotDestroyed()

    const scopes = this.getPermissionRequestScopes(input)
    const requestPermissionsKey = this.getPermissionRequestKey(scopes)

    if (this._requestPermissionsPromise) {
      if (this._requestPermissionsKey !== requestPermissionsKey) {
        throw new Error(
          'Cannot start a permission request with different scopes while another permission request is pending'
        )
      }

      return this._requestPermissionsPromise
    }

    const requestPermissionsPromise = this.requestPermissionsInternal(scopes)
    this._requestPermissionsPromise = requestPermissionsPromise
    this._requestPermissionsKey = requestPermissionsKey

    try {
      return await requestPermissionsPromise
    } finally {
      if (this._requestPermissionsPromise === requestPermissionsPromise) {
        this._requestPermissionsPromise = undefined
        this._requestPermissionsKey = undefined
      }
    }
  }

  private async requestPermissionsInternal(
    scopes: PermissionScope[]
  ): Promise<PermissionResponseOutput> {
    const request: PermissionRequestInput = {
      appMetadata: await this.getOwnAppMetadata(),
      type: BeaconMessageType.PermissionRequest,
      network: this.network,
      scopes
    }

    this.analytics.track('event', 'DAppClient', 'Permission requested')

    const logId = `makeRequest ${Date.now()}`
    logger.time(true, logId)

    return this.runPermissionRequest(request, logId, async (owner) => {
      const resolved =
        (await this.checkMakeRequest()) || !(await this.getActiveAccount())
          ? await this.makeRequest<PermissionRequest, PermissionResponse>(
              request,
              undefined,
              undefined,
              owner
            )
          : await this.makeRequestBC<PermissionRequest, PermissionResponse>(request, owner)
      owner.assertCurrent()
      if (!resolved) {
        throw new Error('Internal error: makeRequest returned no result')
      }
      const { message, connectionInfo } = resolved
      const accountInfo = await this.onNewAccount(
        message,
        connectionInfo,
        undefined,
        () => owner.isCurrent(),
        owner
      )
      owner.assertCurrent()
      const output: PermissionResponseOutput = {
        ...message,
        walletKey: accountInfo.walletKey,
        address: accountInfo.address,
        accountInfo
      }
      const walletInfo = await this.getWalletInfo()
      owner.complete()
      await this.notifySuccess(request, {
        account: accountInfo,
        output,
        blockExplorer: this.blockExplorer,
        connectionContext: connectionInfo,
        walletInfo
      })
      this.analytics.track('event', 'DAppClient', 'Permission received', {
        address: accountInfo.address
      })

      return output
    })
  }

  private getPermissionRequestScopes(input?: RequestPermissionInput): PermissionScope[] {
    if (input && 'network' in input) {
      throw new Error(
        '[BEACON] the "network" property is no longer accepted in input. Please provide it when instantiating DAppClient.'
      )
    }

    return input && input.scopes
      ? input.scopes
      : [PermissionScope.OPERATION_REQUEST, PermissionScope.SIGN]
  }

  private getPermissionRequestKey(scopes: PermissionScope[]): string {
    return [...scopes].sort().join('|')
  }

  /**
   * Send a proof of event request to the wallet. The wallet will either accept or decline the challenge.
   * If it is accepted, the challenge will be stored, meaning that even if the user refresh the page, the DAppClient will keep checking if the challenge has been fulfilled.
   * Once the challenge is stored, a challenge stored message will be sent to the wallet.
   * It's **highly recommended** to run a proof of event challenge to check the identity of an abstracted account
   *
   * @param input The message details we need to prepare the ProofOfEventChallenge message.
   */
  public async requestProofOfEventChallenge(input: RequestProofOfEventChallengeInput) {
    const activeAccount = await this.getActiveAccount()

    if (!activeAccount) {
      throw new Error('Please request permissions before doing a proof of event challenge')
    }
    if (
      activeAccount.walletType !== 'abstracted_account' &&
      activeAccount.verificationType !== 'proof_of_event'
    ) {
      throw new Error(
        'This wallet is not an abstracted account and thus cannot perform proof of event'
      )
    }

    const request: ProofOfEventChallengeRequestInput = {
      type: BeaconMessageType.ProofOfEventChallengeRequest,
      contractAddress: activeAccount.address,
      payload: input.payload
    }
    const logId = `makeRequest ${Date.now()}`
    logger.time(true, logId)
    const res = (await this.checkMakeRequest())
      ? this.makeRequest<ProofOfEventChallengeRequest, ProofOfEventChallengeResponse>(request)
      : this.makeRequestBC<ProofOfEventChallengeRequest, ProofOfEventChallengeResponse>(request)

    let resolved
    try {
      resolved = await res
    } catch (requestError) {
      await this.runRequestErrorSideEffects(request, requestError, logId)
      throw requestError
    }
    if (!resolved) {
      throw new Error('Internal error: makeRequest returned no result')
    }
    const { message, connectionInfo } = resolved

    logger.time(false, logId)

    this.analytics.track(
      'event',
      'DAppClient',
      `Proof of event challenge ${message.isAccepted ? 'accepted' : 'refused'}`,
      { address: activeAccount.address }
    )

    await this.notifySuccess(request, {
      account: activeAccount,
      output: message,
      blockExplorer: this.blockExplorer,
      connectionContext: connectionInfo,
      walletInfo: await this.getWalletInfo()
    })

    return message
  }

  /**
   * Send a simulated proof of event request to the wallet. The wallet will either accept or decline the challenge.
   * It's the same than `requestProofOfEventChallenge` but rather than executing operations on the blockchain to prove the identity,
   * The wallet will return a list of operations that you'll be able to run on your side to verify the identity of the abstracted account
   * It's **highly recommended** to run a proof of event challenge to check the identity of an abstracted account
   *
   * @param input The message details we need to prepare the SimulatedProofOfEventChallenge message.
   */
  public async requestSimulatedProofOfEventChallenge(
    input: RequestSimulatedProofOfEventChallengeInput
  ) {
    const activeAccount = await this.getActiveAccount()

    if (!activeAccount) {
      throw new Error('Please request permissions before doing a proof of event challenge')
    }
    if (
      activeAccount.walletType !== 'abstracted_account' &&
      activeAccount.verificationType !== 'proof_of_event'
    ) {
      throw new Error(
        'This wallet is not an abstracted account and thus cannot perform a simulated proof of event'
      )
    }

    const request: SimulatedProofOfEventChallengeRequestInput = {
      type: BeaconMessageType.SimulatedProofOfEventChallengeRequest,
      contractAddress: activeAccount.address,
      ...input
    }
    const logId = `makeRequest ${Date.now()}`
    logger.time(true, logId)

    const res = (await this.checkMakeRequest())
      ? this.makeRequest<
          SimulatedProofOfEventChallengeRequest,
          SimulatedProofOfEventChallengeResponse
        >(request)
      : this.makeRequestBC<
          SimulatedProofOfEventChallengeRequest,
          SimulatedProofOfEventChallengeResponse
        >(request)

    let resolved
    try {
      resolved = await res
    } catch (requestError) {
      await this.runRequestErrorSideEffects(request, requestError, logId)
      throw requestError
    }
    if (!resolved) {
      throw new Error('Internal error: makeRequest returned no result')
    }
    const { message, connectionInfo } = resolved

    logger.time(false, logId)
    this.analytics.track(
      'event',
      'DAppClient',
      `Simulated proof of event challenge ${!message.errorMessage ? 'accepted' : 'refused'}`,
      { address: activeAccount.address }
    )

    await this.notifySuccess(request, {
      account: activeAccount,
      output: message,
      blockExplorer: this.blockExplorer,
      connectionContext: connectionInfo,
      walletInfo: await this.getWalletInfo()
    })

    return message
  }

  /**
   * This method will send a "SignPayloadRequest" to the wallet. This method is meant to be used to sign
   * arbitrary data (eg. a string). It will return the signature in the format of "edsig..."
   *
   * @param input The message details we need to prepare the SignPayloadRequest message.
   */
  public async requestSignPayload(
    input: RequestSignPayloadInput
  ): Promise<SignPayloadResponseOutput> {
    if (!input.payload) {
      throw await this.sendInternalError('Payload must be provided')
    }
    const activeAccount: AccountInfo | undefined = await this.getActiveAccount()
    if (!activeAccount) {
      throw await this.sendInternalError('No active account!')
    }

    const payload = input.payload

    if (typeof payload !== 'string') {
      throw new Error('Payload must be a string')
    }

    const signingType = ((): SigningType => {
      switch (input.signingType) {
        case SigningType.OPERATION:
          if (!payload.startsWith('03')) {
            throw new Error(
              'When using signing type "OPERATION", the payload must start with prefix "03"'
            )
          }

          return SigningType.OPERATION

        case SigningType.MICHELINE:
          if (!payload.startsWith('05')) {
            throw new Error(
              'When using signing type "MICHELINE", the payload must start with prefix "05"'
            )
          }

          return SigningType.MICHELINE

        case SigningType.RAW:
        default:
          return SigningType.RAW
      }
    })()

    this.analytics.track('event', 'DAppClient', 'Signature requested')

    const request: SignPayloadRequestInput = {
      type: BeaconMessageType.SignPayloadRequest,
      signingType,
      payload,
      sourceAddress: input.sourceAddress || activeAccount.address
    }
    const logId = `makeRequest ${Date.now()}`
    logger.time(true, logId)
    const res = (await this.checkMakeRequest())
      ? this.makeRequest<SignPayloadRequest, SignPayloadResponse>(request)
      : this.makeRequestBC<SignPayloadRequest, SignPayloadResponse>(request)

    let resolved
    try {
      resolved = await res
    } catch (requestError) {
      await this.runRequestErrorSideEffects(request, requestError, logId)
      throw requestError
    }
    if (!resolved) {
      throw new Error('Internal error: makeRequest returned no result')
    }
    const { message, connectionInfo } = resolved

    logger.time(false, logId)

    await this.notifySuccess(request, {
      account: activeAccount,
      output: message,
      connectionContext: connectionInfo,
      walletInfo: await this.getWalletInfo()
    })

    this.analytics.track('event', 'DAppClient', 'Signature response')

    return message
  }

  /**
   * This method will send an "EncryptPayloadRequest" to the wallet. This method is meant to be used to encrypt or decrypt
   * arbitrary data (eg. a string). It will return the encrypted or decrypted payload
   *
   * @param input The message details we need to prepare the EncryptPayloadRequest message.
   */
  // TODO: ENCRYPTION
  // public async requestEncryptPayload(
  //   input: RequestEncryptPayloadInput
  // ): Promise<EncryptPayloadResponseOutput> {
  //   if (!input.payload) {
  //     throw await this.sendInternalError('Payload must be provided')
  //   }
  //   const activeAccount: AccountInfo | undefined = await this.getActiveAccount()
  //   if (!activeAccount) {
  //     throw await this.sendInternalError('No active account!')
  //   }

  //   const payload = input.payload

  //   if (typeof payload !== 'string') {
  //     throw new Error('Payload must be a string')
  //   }

  //   if (typeof input.encryptionCryptoOperation === 'undefined') {
  //     throw new Error('encryptionCryptoOperation must be defined')
  //   }

  //   if (typeof input.encryptionType === 'undefined') {
  //     throw new Error('encryptionType must be defined')
  //   }

  //   const request: EncryptPayloadRequestInput = {
  //     type: BeaconMessageType.EncryptPayloadRequest,
  //     cryptoOperation: input.encryptionCryptoOperation,
  //     encryptionType: input.encryptionType,
  //     payload,
  //     sourceAddress: input.sourceAddress || activeAccount.address
  //   }

  //   const { message, connectionInfo } = await this.makeRequest<
  //     EncryptPayloadRequest,
  //     EncryptPayloadResponse
  //   >(request).catch(async (requestError: ErrorResponse) => {
  //     throw await this.handleRequestError(request, requestError)
  //   })

  //   await this.notifySuccess(request, {
  //     account: activeAccount,
  //     output: message,
  //     connectionContext: connectionInfo,
  //     walletInfo: await this.getWalletInfo()
  //   })

  //   return message
  // }

  /**
   * This method sends an OperationRequest to the wallet. This method should be used for all kinds of operations,
   * eg. transaction or delegation. Not all properties have to be provided. Data like "counter" and fees will be
   * fetched and calculated by the wallet (but they can still be provided if required).
   *
   * @param input The message details we need to prepare the OperationRequest message.
   */
  public async requestOperation(input: RequestOperationInput): Promise<OperationResponseOutput> {
    if (!input.operationDetails) {
      throw await this.sendInternalError('Operation details must be provided')
    }
    const activeAccount: AccountInfo | undefined = await this.getActiveAccount()

    if (!activeAccount) {
      throw await this.sendInternalError('No active account!')
    }

    const request: OperationRequestInput = {
      type: BeaconMessageType.OperationRequest,
      network: activeAccount.network || this.network,
      operationDetails: input.operationDetails,
      sourceAddress: activeAccount.address || ''
    }

    this.analytics.track('event', 'DAppClient', 'Operation requested')
    const logId = `makeRequest ${Date.now()}`
    logger.time(true, logId)

    const res = (await this.checkMakeRequest())
      ? this.makeRequest<OperationRequest, OperationResponse>(request)
      : this.makeRequestBC<OperationRequest, OperationResponse>(request)

    let resolved
    try {
      resolved = await res
    } catch (requestError) {
      await this.runRequestErrorSideEffects(request, requestError, logId)
      throw requestError
    }
    if (!resolved) {
      throw new Error('Internal error: makeRequest returned no result')
    }
    const { message, connectionInfo } = resolved

    logger.time(false, logId)

    await this.notifySuccess(request, {
      account: activeAccount,
      output: message,
      blockExplorer: this.blockExplorer,
      connectionContext: connectionInfo,
      walletInfo: await this.getWalletInfo()
    })

    this.analytics.track('event', 'DAppClient', 'Operation response')

    return message
  }

  /**
   * Sends a "BroadcastRequest" to the wallet. This method can be used to inject an already signed transaction
   * to the network.
   *
   * @param input The message details we need to prepare the BroadcastRequest message.
   */
  public async requestBroadcast(input: RequestBroadcastInput): Promise<BroadcastResponseOutput> {
    if (!input.signedTransaction) {
      throw await this.sendInternalError('Signed transaction must be provided')
    }

    // Add error message for deprecation of network
    // TODO: Remove when we remove deprecated preferredNetwork
    if (input.network !== undefined && this.network.type !== input.network?.type) {
      console.error(
        '[BEACON] The network specified in the DAppClient constructor does not match the network set in the broadcast request. Please set the network in the constructor. Setting it during the Broadcast Request is deprecated.'
      )
    }

    const request: BroadcastRequestInput = {
      type: BeaconMessageType.BroadcastRequest,
      network: this.network,
      signedTransaction: input.signedTransaction
    }

    this.analytics.track('event', 'DAppClient', 'Broadcast requested')
    const logId = `makeRequest ${Date.now()}`
    logger.time(true, logId)
    const res = (await this.checkMakeRequest())
      ? this.makeRequest<BroadcastRequest, BroadcastResponse>(request)
      : this.makeRequestBC<BroadcastRequest, BroadcastResponse>(request)

    let resolved
    try {
      resolved = await res
    } catch (requestError) {
      await this.runRequestErrorSideEffects(request, requestError, logId)
      throw requestError
    }
    if (!resolved) {
      throw new Error('Internal error: makeRequest returned no result')
    }
    const { message, connectionInfo } = resolved

    logger.time(false, logId)

    await this.notifySuccess(request, {
      network: this.network,
      output: message,
      blockExplorer: this.blockExplorer,
      connectionContext: connectionInfo,
      walletInfo: await this.getWalletInfo()
    })

    this.analytics.track('event', 'DAppClient', 'Broadcast response')

    return message
  }

  protected async setActivePeer(
    peer?: PeerInfoType,
    transition: AbortSignal = this.accountTransition.signal
  ): Promise<void> {
    this._accountChangeGeneration++
    if (!this.isCurrentAccountTransition(transition)) {
      return
    }
    if (peer) {
      await this.initInternalTransports()
      if (!this.isCurrentAccountTransition(transition)) {
        return
      }
    }
    this.resolveActivePeer(peer)

    if (!peer) {
      return
    }

    if (peer.type === 'postmessage-pairing-response') {
      await this.setTransport(this.postMessageTransport)
    } else if (peer.type === 'p2p-pairing-response') {
      await this.setTransport(this.p2pTransport)
    } else if (peer.type === 'walletconnect-pairing-response') {
      await this.setTransport(this.walletConnectTransport)
    }
  }

  private resolveActivePeer(peer?: PeerInfoType): void {
    if (this._activePeer.isSettled()) {
      // If the promise has already been resolved we need to create a new one.
      this._activePeer = ExposedPromise.resolve(peer)
    } else {
      this._activePeer.resolve(peer)
    }
  }

  /**
   * A "setter" for when the transport needs to be changed.
   */
  protected async setTransport(transport?: Transport<any>): Promise<void> {
    if (!transport) {
      this._initPromise = undefined
    }

    const result = super.setTransport(transport)

    const event = transport ? { ...(transport as any) } : undefined

    // remove keyPair, to prevent dApps from accidentaly leaking the privateKey
    if (event) {
      event.client = {
        ...event.client,
        keyPair: undefined
      }
    }

    await this.events.emit(BeaconEvent.ACTIVE_TRANSPORT_SET, event)

    return result
  }

  /**
   * This method will emit an internal error message.
   *
   * @param errorMessage The error message to send.
   */
  private async sendInternalError(errorMessage: string): Promise<void> {
    await this.events.emit(BeaconEvent.INTERNAL_ERROR, { text: errorMessage })
    throw new Error(errorMessage)
  }

  /**
   * This method will remove all accounts associated with a specific peer.
   *
   * @param peersToRemove An array of peers for which accounts should be removed
   */
  private async removeAccountsForPeers(peersToRemove: ExtendedPeerInfo[]): Promise<void> {
    if (peersToRemove.length === 0) {
      return
    }

    const peerIdsToRemove = peersToRemove.map((peer) => peer.senderId)

    return this.removeAccountsForPeerIds(peerIdsToRemove)
  }

  private async removeAccountsForPeerIds(peerIds: string[]): Promise<void> {
    this._accountChangeGeneration++
    const transition = await this.mutateAccounts(async () => {
      const observedTransition = this.accountTransition.signal
      const accounts = (await this.accountManager.getAccounts()) ?? []
      const accountIdentifiersToRemove = accounts
        .filter((account) => peerIds.includes(account.senderId))
        .map((account) => account.accountIdentifier)
      const removal = await this.beginAccountRemoval(observedTransition, {
        accountIdentifiers: accountIdentifiersToRemove,
        senderIds: peerIds
      })
      await this.accountManager.removeAccounts(accountIdentifiersToRemove)

      return removal
    })
    await this.completeAccountRemoval(transition)
  }

  /**
   * Run the standard request-error side effects (abort/error metric,
   * timer stop, {@link handleRequestError}) on a single awaited control
   * flow so callers can re-throw the original {@link ErrorResponse} without
   * leaking an UnhandledPromiseRejection.
   *
   * Why this exists: every request method historically used a fire-and-
   * forget `res.catch(handler)` whose handler did `throw await
   * this.handleRequestError(...)`. The catch returned a detached promise
   * nobody awaited; `handleRequestError`'s thrown wrapped error became an
   * unhandled rejection. The bug rarely surfaced before the dapp-init
   * promise was made rejectable, because pre-pairing rejection paths used
   * to hang instead of routing through these handlers. Once init started
   * rejecting reliably, the unhandled rejection started firing on every
   * WC session-proposal rejection. We swallow the wrapped throw here so
   * callers can re-throw the original `ErrorResponse`, matching the
   * post-pairing rejection contract at the openRequest path.
   *
   * @param request The request we sent
   * @param requestError The error we received
   * @param logId The {@link logger.time} label opened for this request
   */
  private async runRequestErrorSideEffects(
    request: unknown,
    rawError: unknown,
    logId: string,
    resetPermissionState = true
  ): Promise<void> {
    // V3 request shapes (PermissionRequestV3, BlockchainRequestV3) flow through
    // here too. They aren't part of BeaconRequestInputMessage, but
    // handleRequestError only inspects `.type` plus optional fields it already
    // guards on. Catch params are `unknown` under strict TS, same story.
    const typedRequest = request as BeaconRequestInputMessage
    const requestError = rawError as ErrorResponse
    logger.time(false, logId)
    await this.handleRequestError(typedRequest, requestError, resetPermissionState).catch(
      () => undefined
    )
  }

  /**
   * This message handles errors that we receive from the wallet.
   *
   * @param request The request we sent
   * @param beaconError The error we received
   */
  private async handleRequestError(
    request: BeaconRequestInputMessage,
    beaconError: ErrorResponse,
    resetPermissionState = true
  ): Promise<void> {
    logger.error('handleRequestError', 'error response', beaconError)
    if (beaconError.errorType) {
      const buttons: AlertButton[] = []
      if (beaconError.errorType === BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR) {
        const actionCallback = async (): Promise<void> => {
          const operationRequest: OperationRequestInput = request as OperationRequestInput
          // if the account we requested is not available, we remove it locally
          let accountInfo: AccountInfo | undefined
          if (operationRequest.sourceAddress && operationRequest.network) {
            const accountIdentifier = await getAccountIdentifier(
              operationRequest.sourceAddress,
              operationRequest.network
            )
            accountInfo = await this.getAccount(accountIdentifier)

            if (accountInfo) {
              await this.removeAccount(accountInfo.accountIdentifier)
            }
          }
        }

        buttons.push({ text: 'Remove account', actionCallback })
      }

      const peer = this.destroyed ? this._activePeer.promiseResult : await this.getPeer()
      const activeAccount = this.destroyed
        ? this._activeAccount.promiseResult
        : await this.getActiveAccount()

      // If we sent a permission request, received an error and there is no active account, we need to reset the DAppClient.
      // This most likely means that the user rejected the first permission request after pairing a wallet, so we "forget" the paired wallet to allow the user to pair again.
      if (
        resetPermissionState &&
        !this.destroyed &&
        request.type === BeaconMessageType.PermissionRequest &&
        (await this.getActiveAccount()) === undefined
      ) {
        this._initPromise = undefined
        const walletConnectTransport = this.walletConnectTransport
        this.postMessageTransport = undefined
        this.p2pTransport = undefined
        this.walletConnectTransport = undefined
        // Retire ownership before selection observers can initialize another client.
        await Promise.all([
          this.releaseWalletConnectTransport(walletConnectTransport, false),
          (async () => {
            await this.setTransport()
            await this.setActivePeer()
          })()
        ])
      }

      this.events
        .emit(
          messageEvents[request.type].error,
          {
            errorResponse: beaconError,
            walletInfo: this.destroyed
              ? { name: peer?.name ?? '' }
              : await this.getWalletInfo(peer, activeAccount),
            errorMessages: this.errorMessages
          },
          buttons
        )
        .catch((emitError) => logger.error('handleRequestError', emitError))

      throw getError(beaconError.errorType, beaconError.errorData)
    }

    throw beaconError
  }

  /**
   * This message will send an event when we receive a successful response to one of the requests we sent.
   *
   * @param request The request we sent
   * @param response The response we received
   */
  private async notifySuccess(
    request: BeaconRequestInputMessage,
    response:
      | {
          account: AccountInfo
          output: PermissionResponseOutput
          blockExplorer: BlockExplorer
          connectionContext: ConnectionContext
          walletInfo: WalletInfo
        }
      | {
          account: AccountInfo
          output: ProofOfEventChallengeResponse
          blockExplorer: BlockExplorer
          connectionContext: ConnectionContext
          walletInfo: WalletInfo
        }
      | {
          account: AccountInfo
          output: SimulatedProofOfEventChallengeResponse
          blockExplorer: BlockExplorer
          connectionContext: ConnectionContext
          walletInfo: WalletInfo
        }
      | {
          account: AccountInfo
          output: OperationResponseOutput
          blockExplorer: BlockExplorer
          connectionContext: ConnectionContext
          walletInfo: WalletInfo
        }
      | {
          output: SignPayloadResponseOutput
          connectionContext: ConnectionContext
          walletInfo: WalletInfo
        }
      // | {
      //     output: EncryptPayloadResponseOutput
      //     connectionContext: ConnectionContext
      //     walletInfo: WalletInfo
      // }
      | {
          network: Network
          output: BroadcastResponseOutput
          blockExplorer: BlockExplorer
          connectionContext: ConnectionContext
          walletInfo: WalletInfo
        }
  ): Promise<void> {
    this.events
      .emit(messageEvents[request.type].success, response)
      .catch((emitError) => console.warn(emitError))
  }

  private async getWalletInfoFromStorage() {
    return await this.storage.get(StorageKey.LAST_SELECTED_WALLET)
  }

  private async updateStorageWallet(walletInfo: WalletInfo) {
    const wallet = await this.storage.get(StorageKey.LAST_SELECTED_WALLET)

    if (!wallet) {
      return
    }

    wallet.name = walletInfo.name
    wallet.icon = walletInfo.icon ?? wallet.icon
    this.storage.set(StorageKey.LAST_SELECTED_WALLET, wallet)
  }

  private async getWalletInfo(
    peer?: PeerInfo,
    account?: AccountInfo,
    readFromStorage: boolean = true
  ): Promise<WalletInfo> {
    const selectedAccount = account ? account : await this.getActiveAccount()

    const selectedPeer = peer ? peer : await this.getPeer(selectedAccount)

    let walletInfo: WalletInfo | undefined
    if (selectedAccount) {
      walletInfo = await this.appMetadataManager.getAppMetadata(selectedAccount.senderId)
    }

    let storageWallet

    if (readFromStorage) {
      storageWallet = await this.getWalletInfoFromStorage()
    }

    if (!walletInfo) {
      walletInfo = {
        name: selectedPeer?.name ?? storageWallet?.key ?? '',
        icon: selectedPeer?.icon ?? storageWallet?.icon,
        type: storageWallet?.type
      }

      this.updateStorageWallet(walletInfo)
    }

    const lowerCaseCompare = (str1?: string, str2?: string): boolean => {
      if (str1 && str2) {
        return str1.toLowerCase() === str2.toLowerCase()
      }

      return false
    }

    const getOrgName = (name: string) => name.split(/[_\s]+/)[0]

    const apps: AppBase[] = [
      ...getiOSList(),
      ...getWebList(),
      ...getDesktopList(),
      ...getExtensionList()
    ].filter((app: AppBase) =>
      lowerCaseCompare(getOrgName(app.key), getOrgName(walletInfo?.name ?? 'wallet'))
    )

    // TODO: Remove once all wallets send the icon?
    const mobile = (apps as App[]).find(
      (app) => app.universalLink || app.key.includes('ios') || app.key.includes('mobile')
    )
    const browser = (apps as WebApp[]).find((app) => app.links)
    const desktop = (apps as DesktopApp[]).find((app) => app.downloadLink)
    const extension = (apps as ExtensionApp[]).find((app) => app.id)

    const appTypeMap = {
      extension: { app: extension, type: 'extension' },
      desktop: { app: desktop, type: 'desktop' },
      mobile: { app: mobile, type: 'mobile' },
      web: { app: browser, type: 'web' }
    }

    const defaultType = (): {
      app: AppBase | undefined
      type: 'extension' | 'mobile' | 'web' | 'desktop' | undefined
    } => {
      if (isBrowser(window) && browser) {
        return { app: browser, type: 'web' }
      }
      if (isDesktop(window) && desktop) {
        return { app: desktop, type: 'desktop' }
      }
      if (isBrowser(window) && extension) {
        return { app: extension, type: 'extension' }
      }
      if (mobile) {
        return { app: mobile, type: 'mobile' }
      }

      return { app: undefined, type: undefined }
    }

    const { app, type } = storageWallet ? appTypeMap[storageWallet.type] : defaultType()

    if (app) {
      let deeplink: string | undefined
      if (app.hasOwnProperty('links')) {
        deeplink = (app as WebApp).links[selectedAccount?.network.type ?? this.network.type]
      } else if (app.hasOwnProperty('deepLink')) {
        deeplink = (app as App).deepLink
      }

      return {
        name: app?.name ?? walletInfo.name,
        icon: app?.logo ?? walletInfo.icon,
        deeplink,
        type: type as any
      }
    }

    return walletInfo
  }

  private async getPeer(account?: AccountInfo): Promise<PeerInfo | undefined> {
    let peer: PeerInfo | undefined

    if (account) {
      logger.log('getPeer', 'We have an account', account)
      const postMessagePeers: ExtendedPostMessagePairingResponse[] =
        (await this.postMessageTransport?.getPeers()) ?? []
      const p2pPeers: ExtendedP2PPairingResponse[] = (await this.p2pTransport?.getPeers()) ?? []
      const walletConnectPeers: ExtendedWalletConnectPairingResponse[] =
        (await this.walletConnectTransport?.getPeers()) ?? []
      const peers = [...postMessagePeers, ...p2pPeers, ...walletConnectPeers]

      logger.log('getPeer', 'Found peers', peers, account)

      peer = peers.find((peerEl) => peerEl.senderId === account.senderId)
      if (!peer) {
        // We could not find an exact match for a sender, so we most likely received it over a relay
        peer = peers.find((peerEl) => (peerEl as any).id === account.origin.id)
      }
    } else {
      peer = await this._activePeer.promise
      logger.log('getPeer', 'Active peer', peer)
    }

    return peer
  }

  /**
   * This method handles sending of requests to the DApp. It makes sure that the DAppClient is initialized and connected
   * to the transport. After that rate limits and permissions will be checked, an ID is attached and the request is sent
   * to the DApp over the transport.
   *
   * @param requestInput The BeaconMessage to be sent to the wallet
   * @param account The account that the message will be sent to
   * @param skipResponse If true, the function return as soon as the message is sent
   */

  private makeRequest<T extends BeaconRequestInputMessage, U extends BeaconMessage>(
    requestInput: Optional<T, IgnoredRequestInputProperties>,
    skipResponse?: undefined | false,
    otherTabMessageId?: string,
    permissionOwner?: PermissionRequestOwner
  ): Promise<{
    message: U
    connectionInfo: ConnectionContext
  }>
  private makeRequest<T extends BeaconRequestInputMessage, U extends BeaconMessage>(
    requestInput: Optional<T, IgnoredRequestInputProperties>,
    skipResponse: true,
    otherTabMessageId?: string,
    permissionOwner?: PermissionRequestOwner
  ): Promise<undefined>
  private async makeRequest<T extends BeaconRequestInputMessage, U extends BeaconMessage>(
    requestInput: Optional<T, IgnoredRequestInputProperties>,
    skipResponse?: boolean,
    otherTabMessageId?: string,
    permissionOwner?: PermissionRequestOwner
  ): Promise<{ message: U; connectionInfo: ConnectionContext } | undefined> {
    const delegated = otherTabMessageId ? this.getRequest(otherTabMessageId) : undefined
    if (otherTabMessageId && !delegated) {
      throw this.createAbortedError(otherTabMessageId)
    }

    const delegatedCompletion = delegated?.promise
    const prepare = async (): Promise<RequestResponse | undefined> => {
      const messageId = otherTabMessageId ?? (await generateGUID())
      const stillAdmitted = () => !delegated || this.requestTracker.isCurrent(delegated.key)

      await this.init()
      if (!stillAdmitted()) {
        return delegatedCompletion
      }

      const rateLimited = await this.addRequestAndCheckIfRateLimited()
      if (!stillAdmitted()) {
        return delegatedCompletion
      }
      if (rateLimited) {
        this.events
          .emit(BeaconEvent.LOCAL_RATE_LIMIT_REACHED)
          .catch((emitError) => logger.warn('requestDispatch', emitError))
        throw new Error('rate limit reached')
      }

      const permitted = await this.checkPermissions(requestInput.type)
      if (!stillAdmitted()) {
        return delegatedCompletion
      }
      if (!permitted) {
        this.events
          .emit(BeaconEvent.NO_PERMISSIONS)
          .catch((emitError) => logger.warn('requestDispatch', emitError))
        throw new Error('No permissions to send this request to wallet!')
      }
      if (!this.beaconId) {
        throw await this.sendInternalError('BeaconID not defined')
      }
      const beaconId = await this.beaconId
      if (!stillAdmitted()) {
        return delegatedCompletion
      }
      const senderId = await getSenderId(beaconId)
      if (!stillAdmitted()) {
        return delegatedCompletion
      }
      const request = { id: messageId, version: '2', senderId, ...requestInput }
      const owned = skipResponse ? undefined : (delegated ?? this.createRequest(request.id))
      if (!skipResponse && !owned) {
        throw this.createAbortedError(request.id)
      }
      if (owned) {
        this.admitPermissionRequest(permissionOwner, owned.key)
        this.armRequestDeadline(owned.key)
      }

      const canDispatch = () =>
        !owned ||
        (this.requestTracker.isCurrent(owned.key) &&
          this.requestTracker.get(owned.key.id)?.state !== 'ResponsePreparing')
      const dispatch = async (): Promise<void> => {
        try {
          const payload = await new Serializer().serialize(request)
          if (!canDispatch()) {
            return
          }
          const account = await this.getActiveAccount()
          if (!canDispatch()) {
            return
          }
          const peer = await this.getPeer(account)
          if (!canDispatch()) {
            return
          }
          const walletInfo = await this.getWalletInfo(peer, account)
          if (!canDispatch()) {
            return
          }
          const transport = await this.transport
          if (!canDispatch()) {
            return
          }
          try {
            await transport.send(payload, peer)
          } finally {
            if (owned && transport instanceof WalletConnectTransport) {
              this.requestTracker.attachCleanup(owned.key, () =>
                transport.cancelRequest(request.id)
              )
            }
          }
          if (!canDispatch()) {
            return
          }
          const shouldSwitch =
            request.type !== BeaconMessageType.PermissionRequest ||
            (this._activeAccount.isResolved() && (await this._activeAccount.promise))
          if (!canDispatch()) {
            return
          }
          if (shouldSwitch) {
            this.tryToAppSwitch(canDispatch).catch((error) => logger.warn('tryToAppSwitch', error))
          }
          if (!otherTabMessageId && canDispatch()) {
            this.events
              .emit(messageEvents[requestInput.type].sent, {
                walletInfo: { ...walletInfo, name: walletInfo.name ?? 'Wallet' },
                extraInfo: { resetCallback: async () => this.disconnect() }
              })
              .catch((emitError) => logger.warn('makeRequest', emitError))
          }
        } catch (sendError) {
          if (owned && !this.requestTracker.reject(owned.key, sendError)) {
            return
          }
          this.events
            .emit(BeaconEvent.INTERNAL_ERROR, {
              text: 'Unable to send message. If this problem persists, please reset the connection and pair your wallet again.',
              buttons: [
                {
                  text: 'Reset Connection',
                  actionCallback: async () => {
                    closeToast()
                    await this.disconnect()
                  }
                }
              ]
            })
            .catch((emitError) => logger.warn('makeRequest', emitError))
          if (!owned) {
            throw sendError
          }
        }
      }
      if (!owned) {
        await dispatch()

        return undefined
      }
      dispatch().catch((dispatchError) => logger.warn('makeRequest', dispatchError))

      return owned.promise
    }

    if (delegated) {
      prepare().catch((error: unknown) => this.requestTracker.reject(delegated.key, error))

      return delegated.promise as Promise<{ message: U; connectionInfo: ConnectionContext }>
    }

    return prepare() as Promise<{ message: U; connectionInfo: ConnectionContext } | undefined>
  }

  private async makeRequestV3<
    T extends BlockchainMessage,
    U extends BeaconMessageWrapper<BlockchainMessage>
  >(
    requestInput: T,
    otherTabMessageId?: string,
    permissionOwner?: PermissionRequestOwner
  ): Promise<{ message: U; connectionInfo: ConnectionContext }> {
    const delegated = otherTabMessageId ? this.getRequest(otherTabMessageId) : undefined
    if (otherTabMessageId && !delegated) {
      throw this.createAbortedError(otherTabMessageId)
    }

    const prepare = async (): Promise<RequestResponse> => {
      const messageId = otherTabMessageId ?? (await generateGUID())
      const stillAdmitted = () => !delegated || this.requestTracker.isCurrent(delegated.key)
      await this.init()
      if (delegated && !stillAdmitted()) {
        return delegated.promise
      }
      const rateLimited = await this.addRequestAndCheckIfRateLimited()
      if (delegated && !stillAdmitted()) {
        return delegated.promise
      }
      if (rateLimited) {
        this.events
          .emit(BeaconEvent.LOCAL_RATE_LIMIT_REACHED)
          .catch((emitError) => logger.warn('requestDispatch', emitError))
        throw new Error('rate limit reached')
      }
      if (!this.beaconId) {
        throw await this.sendInternalError('BeaconID not defined')
      }
      const beaconId = await this.beaconId
      if (delegated && !stillAdmitted()) {
        return delegated.promise
      }
      const senderId = await getSenderId(beaconId)
      if (delegated && !stillAdmitted()) {
        return delegated.promise
      }
      const request: BeaconMessageWrapper<BlockchainMessage> = {
        id: messageId,
        version: '3',
        senderId,
        message: requestInput
      }
      const owned = delegated ?? this.createRequest(request.id)
      if (!owned) {
        throw this.createAbortedError(request.id)
      }
      this.admitPermissionRequest(permissionOwner, owned.key)
      this.armRequestDeadline(owned.key)

      const canDispatch = () =>
        this.requestTracker.isCurrent(owned.key) &&
        this.requestTracker.get(owned.key.id)?.state !== 'ResponsePreparing'
      const dispatch = async (): Promise<void> => {
        try {
          const payload = await new Serializer().serialize(request)
          if (!canDispatch()) {
            return
          }
          const account = await this.getActiveAccount()
          if (!canDispatch()) {
            return
          }
          const peer = await this.getPeer(account)
          if (!canDispatch()) {
            return
          }
          const walletInfo = await this.getWalletInfo(peer, account)
          if (!canDispatch()) {
            return
          }
          const transport = await this.transport
          if (!canDispatch()) {
            return
          }
          try {
            await transport.send(payload, peer)
          } finally {
            if (transport instanceof WalletConnectTransport) {
              this.requestTracker.attachCleanup(owned.key, () =>
                transport.cancelRequest(request.id)
              )
            }
          }
          if (!canDispatch()) {
            return
          }
          const shouldSwitch =
            request.message.type !== BeaconMessageType.PermissionRequest ||
            (this._activeAccount.isResolved() && (await this._activeAccount.promise))
          if (!canDispatch()) {
            return
          }
          if (shouldSwitch) {
            this.tryToAppSwitch(canDispatch).catch((error) => logger.warn('tryToAppSwitch', error))
          }
          if (!otherTabMessageId && canDispatch()) {
            const index = requestInput.type as BeaconMessageType
            this.events
              .emit(messageEvents[index].sent, {
                walletInfo: { ...walletInfo, name: walletInfo.name ?? 'Wallet' },
                extraInfo: { resetCallback: async () => this.disconnect() }
              })
              .catch((emitError) => logger.warn('makeRequestV3', emitError))
          }
        } catch (sendError) {
          if (!this.requestTracker.reject(owned.key, sendError)) {
            return
          }
          this.events
            .emit(BeaconEvent.INTERNAL_ERROR, {
              text: 'Unable to send message. If this problem persists, please reset the connection and pair your wallet again.',
              buttons: [
                {
                  text: 'Reset Connection',
                  actionCallback: async () => {
                    closeToast()
                    await this.disconnect()
                  }
                }
              ]
            })
            .catch((emitError) => logger.warn('makeRequestV3', emitError))
        }
      }
      dispatch().catch((dispatchError) => logger.warn('makeRequestV3', dispatchError))

      return owned.promise
    }

    if (delegated) {
      prepare().catch((error: unknown) => this.requestTracker.reject(delegated.key, error))

      return delegated.promise as Promise<{ message: U; connectionInfo: ConnectionContext }>
    }

    return prepare() as Promise<{ message: U; connectionInfo: ConnectionContext }>
  }

  private async makeRequestBC<T extends BeaconRequestInputMessage, U extends BeaconMessage>(
    request: Optional<T, IgnoredRequestInputProperties>,
    permissionOwner?: PermissionRequestOwner
  ): Promise<{ message: U; connectionInfo: ConnectionContext } | undefined> {
    if (!this._transport.isResolved()) {
      return undefined
    }
    const transport = await this.transport
    if (transport.type !== TransportType.WALLETCONNECT) {
      return undefined
    }
    if (await this.addRequestAndCheckIfRateLimited()) {
      this.events
        .emit(BeaconEvent.LOCAL_RATE_LIMIT_REACHED)
        .catch((emitError) => logger.warn('requestDispatch', emitError))
      throw new Error('rate limit reached')
    }
    const id = await generateGUID()
    const owned = this.createRequest(id, 'Follower')
    if (!owned) {
      throw this.createAbortedError(id)
    }
    this.admitPermissionRequest(permissionOwner, owned.key)
    const canDispatch = () =>
      this.requestTracker.isCurrent(owned.key) &&
      this.requestTracker.get(owned.key.id)?.state !== 'ResponsePreparing'
    const dispatch = async (): Promise<void> => {
      try {
        this.multiTabChannel.postMessage({ type: request.type, data: request, id })
        if (!canDispatch()) {
          return
        }
        const shouldSwitch =
          request.type !== BeaconMessageType.PermissionRequest ||
          (this._activeAccount.isResolved() && (await this._activeAccount.promise))
        if (!canDispatch()) {
          return
        }
        if (shouldSwitch) {
          this.tryToAppSwitch(canDispatch).catch((error) => logger.warn('tryToAppSwitch', error))
        }
        const walletInfo = await this.getWalletInfo()
        if (!canDispatch()) {
          return
        }
        this.events
          .emit(messageEvents[request.type].sent, {
            walletInfo,
            extraInfo: { resetCallback: () => this.disconnect() }
          })
          .catch((emitError) => logger.warn('requestDispatch', emitError))
        this.armRequestDeadline(owned.key)
      } catch (error: unknown) {
        this.requestTracker.reject(owned.key, error)
      }
    }
    dispatch().catch((error: unknown) => logger.warn('makeRequestBC', error))

    return owned.promise as Promise<{ message: U; connectionInfo: ConnectionContext }>
  }

  /**
   * Disconnects all resolved transports (postMessage, P2P, WalletConnect), removes their peers,
   * and clears active account state. After calling, the DAppClient remains usable for a new
   * requestPermissions().
   */
  public async disconnect(options: DAppClientDisconnectOptions = {}) {
    const { notifyPeers = true } = options

    if (!this._disconnectPromise) {
      this.beginAccountTransition()
      this._disconnectNotifyPeers = false
    }

    this._disconnectNotifyPeers = this._disconnectNotifyPeers || notifyPeers
    if (this._disconnectPromise) {
      return this._disconnectPromise
    }

    return this.initialization.disconnect(async () => {
      try {
        await this.disconnectInternal()
      } finally {
        this._disconnectNotifyPeers = false
      }
    })
  }

  private async disconnectInternal(): Promise<void> {
    this.abortPendingInit()

    if (!this._transport.isResolved()) {
      const initializedTransports = this.getInitializedTransports()
      this.abortOpenRequests()
      await this.removeAllPeersFromTransports(initializedTransports)
      await this.clearActiveAccount()
      await this.disconnectResolvedTransports(initializedTransports)
      this.clearInternalTransportReferences()

      return
    }

    const transport = (await this.transport) as DAppInternalTransport

    if (transport.connectionStatus === TransportStatus.NOT_CONNECTED) {
      await this.clearActiveAccount()
      this.abortOpenRequests()

      return
    }
    this.abortOpenRequests()
    const transports = this.getResolvedTransports(transport)
    await this.removeAllPeersFromTransports(transports)
    await this.clearActiveAccount()
    await this.disconnectResolvedTransports(transports)
    this.clearInternalTransportReferences()
  }

  private getInitializedTransports(): DAppInternalTransport[] {
    const transports: DAppInternalTransport[] = []

    const addTransport = (transport?: DAppInternalTransport): void => {
      if (transport && !transports.includes(transport)) {
        transports.push(transport)
      }
    }

    addTransport(this.postMessageTransport)
    addTransport(this.p2pTransport)
    addTransport(this.walletConnectTransport)

    return transports
  }

  private getResolvedTransports(selectedTransport: DAppInternalTransport): DAppInternalTransport[] {
    const transports = this.getInitializedTransports()

    const addTransport = (transport?: DAppInternalTransport): void => {
      if (transport && !transports.includes(transport)) {
        transports.push(transport)
      }
    }

    addTransport(this.postMessageTransport)
    addTransport(this.p2pTransport)
    addTransport(this.walletConnectTransport)
    addTransport(selectedTransport)

    return transports
  }

  private clearInternalTransportReferences(): void {
    this.postMessageTransport = undefined
    this.p2pTransport = undefined
    this.walletConnectTransport = undefined
  }

  private async removeAllPeersFromTransports(transports: DAppInternalTransport[]): Promise<void> {
    const peersByTransport: PeersForTransport[] = await Promise.all(
      transports.map(async (transport): Promise<PeersForTransport> => {
        const transportPeers: ExtendedPeerInfo[] = await transport.getPeers()

        return {
          transport,
          peers: transportPeers
        }
      })
    )

    await Promise.all(peersByTransport.map(({ transport }) => transport.removeAllPeers()))

    const peersToRemove = peersByTransport.flatMap(({ peers: transportPeers }) => transportPeers)
    await this.removeAccountsForPeers(peersToRemove)

    // If cleanup already removed peers, a late notify upgrade has nothing left to notify.
    const sendDisconnectToPeers = this._disconnectNotifyPeers

    if (!sendDisconnectToPeers) {
      return
    }

    await Promise.allSettled(
      this.getUniquePeerNotifications(peersByTransport).map(({ transport, peer }) =>
        this.sendDisconnectToPeer(peer, transport)
      )
    )
  }

  private getUniquePeerNotifications(peersByTransport: PeersForTransport[]): PeerNotification[] {
    const notifications: PeerNotification[] = []
    const seen = new Set<string>()

    peersByTransport.forEach(({ transport, peers: transportPeers }) => {
      transportPeers.forEach((peer) => {
        const key = this.getPeerNotificationKey(transport, peer)
        if (seen.has(key)) {
          return
        }

        seen.add(key)
        notifications.push({ transport, peer })
      })
    })

    return notifications
  }

  private getPeerNotificationKey(transport: DAppInternalTransport, peer: ExtendedPeerInfo): string {
    return [transport.type, peer.publicKey, peer.senderId, peer.id].filter(Boolean).join(':')
  }

  private async disconnectResolvedTransports(transports: DAppInternalTransport[]): Promise<void> {
    const results = await Promise.allSettled(
      transports.map(async (transport) => {
        try {
          if (this.isTransportConnected(transport)) {
            await transport.disconnect()
          }

          if (this.hasClientCleanup(transport)) {
            await transport.doClientCleanup()
          }
        } finally {
          if (transport instanceof DappWalletConnectTransport) {
            await transport.release()
          }
        }
      })
    )

    results.forEach((result) => {
      if (result.status === 'rejected') {
        logger.warn('disconnectResolvedTransports', result.reason)
      }
    })
  }

  private async releaseWalletConnectTransport(
    transport?: DappWalletConnectTransport,
    closeSession = true
  ): Promise<void> {
    if (transport instanceof DappWalletConnectTransport) {
      await transport.release(closeSession)
    }
  }

  private hasClientCleanup(
    transport: DAppInternalTransport
  ): transport is DAppInternalTransport & TransportWithClientCleanup {
    const transportWithClientCleanup = transport as Partial<TransportWithClientCleanup>

    return typeof transportWithClientCleanup.doClientCleanup === 'function'
  }

  private isTransportConnected(transport: DAppInternalTransport): boolean {
    return transport.connectionStatus !== TransportStatus.NOT_CONNECTED
  }

  private async runPermissionRequest<T>(
    request: PermissionRequestInput | PermissionRequestV3,
    logId: string,
    operation: (owner: PermissionRequestOwner) => Promise<T>
  ): Promise<T> {
    const owner = new PermissionRequestOwner((id) => this.createAbortedError(id))
    this.permissionRequests.add(owner)
    try {
      try {
        const result = await owner.run(() => operation(owner))
        logger.time(false, logId)

        return result
      } finally {
        this.permissionRequests.delete(owner)
      }
    } catch (error: unknown) {
      // Local revocation leaves selection cleanup to the transition that replaced this owner.
      await this.runRequestErrorSideEffects(request, error, logId, !owner.wasRevoked())
      throw error
    }
  }

  private admitPermissionRequest(owner: PermissionRequestOwner | undefined, key: RequestKey): void {
    if (!owner) {
      return
    }
    owner.admit(key.id, this.accountTransition.signal, () => {
      this.requestTracker.abort(key, this.createAbortedError(key.id))
    })
    if (this.destroyed) {
      owner.abort()
    }
    owner.assertCurrent()
  }

  private persistPermissionAccount(
    account: AccountInfo,
    owner: PermissionRequestOwner
  ): Promise<void> {
    return this.mutateAccounts(async () => {
      owner.assertCurrent()
      const previous = await this.accountManager.getAccount(account.accountIdentifier)
      owner.assertCurrent()
      await this.accountManager.addAccount(account)
      if (!owner.isCurrent()) {
        // Restore the prior value before a queued removal or replacement can run.
        if (previous) {
          await this.accountManager.addAccount(previous)
        } else {
          await this.accountManager.removeAccount(account.accountIdentifier)
        }
        owner.assertCurrent()
      }
    })
  }

  private createRequest(id: string, route: RequestRoute = 'Direct'): RequestHandle | undefined {
    const key = this.requestTracker.admit(id, route, (result) => {
      try {
        if (route === 'LeaderProxy') {
          const response =
            result.tag === 'Resolved'
              ? result.response
              : {
                  message: this.buildDelegatedRequestError(id, result.error),
                  connectionInfo: { origin: Origin.WALLETCONNECT, id: '' }
                }
          this.multiTabChannel.postMessage({ type: 'RESPONSE', id, data: response })
        }
      } finally {
        if (result.tag === 'TimedOut') {
          this.events.emit(BeaconEvent.CHANNEL_CLOSED).catch((error) => {
            logger.error('requestDeadline', error)
          })
        }
      }
    })

    return key ? this.getRequest(id) : undefined
  }

  private getRequest(id: string): RequestHandle | undefined {
    const request = this.requestTracker.get(id)
    if (!request) {
      return undefined
    }
    const promise = request.completion.then((result) => {
      if (result.tag === 'Resolved') {
        return result.response
      }
      throw result.error
    })
    // Proxy admission precedes readiness, so observe failure before dispatch attaches.
    promise.catch(() => undefined)

    return { key: request.key, promise }
  }

  private armRequestDeadline(key: RequestKey): void {
    this.requestTracker.armDeadline(key, this.requestTimeoutMs, {
      id: key.id,
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.PEER_UNREACHABLE,
      senderId: '',
      version: '2'
    })
  }

  private abortPermissionRequests(): void {
    for (const owner of Array.from(this.permissionRequests)) {
      owner.abort()
    }
  }

  private abortOpenRequests(): void {
    this.abortPermissionRequests()
    this.requestTracker.abortAll((key) => this.createAbortedError(key.id))
  }

  private async sendNotificationWithAccessToken(notification: {
    url: string
    recipient: string
    title: string
    body: string
    payload: string
    protocolIdentifier: string
    accessToken: string
  }): Promise<string> {
    const { url, recipient, title, body, payload, protocolIdentifier, accessToken } = notification
    const timestamp = new Date().toISOString()

    const keypair = await this.keyPair

    const rawPublicKey = keypair.publicKey

    const prefix = Buffer.from(new Uint8Array([13, 15, 37, 217]))

    const publicKey = bs58check.encode(Buffer.concat([prefix, Buffer.from(rawPublicKey)]))

    const constructedString = [
      'Tezos Signed Message: ',
      recipient,
      title,
      body,
      timestamp,
      payload
    ].join(' ')

    const bytes = toHex(constructedString)
    const payloadBytes = `05` + `01${bytes.length.toString(16).padStart(8, '0')}${bytes}`

    const signature = await signMessage(payloadBytes, {
      secretKey: Buffer.from(keypair.secretKey)
    })

    const notificationResponse = await fetch(`${url}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient,
        title,
        body,
        timestamp,
        payload,
        accessToken,
        protocolIdentifier,
        sender: {
          name: this.name,
          publicKey,
          signature
        }
      })
    })

    if (!notificationResponse.ok) {
      throw new Error(
        `sendNotification failed: ${notificationResponse.status} ${notificationResponse.statusText}`
      )
    }

    return notificationResponse.json()
  }

  private async onNewAccount(
    message: PermissionResponse | ChangeAccountRequest,
    connectionInfo: ConnectionContext,
    changeGeneration: number | undefined = undefined,
    isCurrent: () => boolean = () => true,
    owner?: PermissionRequestOwner
  ): Promise<AccountInfo> {
    owner?.assertCurrent()
    const generation = changeGeneration ?? ++this._accountChangeGeneration
    // TODO: Migration code. Remove sometime after 1.0.0 release.
    const tempPK: string | undefined =
      message.publicKey || (message as any).pubkey || (message as any).pubKey

    const publicKey = tempPK ? prefixPublicKey(tempPK) : undefined

    if (!publicKey && !message.address) {
      throw new Error('PublicKey or Address must be defined')
    }

    const derivedAddress =
      publicKey && message.walletType !== 'abstracted_account'
        ? await getAddressFromPublicKey(publicKey)
        : undefined

    if (derivedAddress && message.address && message.address !== derivedAddress) {
      throw new Error(`Address "${message.address}" does not match publicKey "${publicKey}"`)
    }

    const address =
      derivedAddress ??
      message.address ??
      (publicKey ? await getAddressFromPublicKey(publicKey) : '')

    if (!isValidAddress(address)) {
      throw new Error(`Invalid address: "${address}"`)
    }

    if (
      message.walletType === 'abstracted_account' &&
      address.substring(0, 3) !== CONTRACT_PREFIX
    ) {
      throw new Error(
        `Invalid abstracted account address "${address}", it should be a ${CONTRACT_PREFIX} address`
      )
    }

    logger.log('######## MESSAGE #######')
    logger.log('onNewAccount', message)

    const walletKey = (await this.storage.get(StorageKey.LAST_SELECTED_WALLET))?.key

    const accountInfo: AccountInfo = {
      accountIdentifier: await getAccountIdentifier(address, message.network),
      senderId: message.senderId,
      origin: {
        type: connectionInfo.origin,
        id: connectionInfo.id
      },
      walletKey,
      address,
      publicKey,
      network: message.network,
      scopes: message.scopes,
      threshold: message.threshold,
      notification: message.notification,
      connectedAt: new Date().getTime(),
      walletType: message.walletType ?? 'implicit',
      verificationType: message.verificationType,
      ...(message.verificationType === 'proof_of_event' ? { hasVerifiedChallenge: false } : {})
    }

    logger.log('accountInfo', '######## ACCOUNT INFO #######')

    logger.log('accountInfo', accountInfo)

    const isAuthorized = async (): Promise<boolean> => {
      if (
        message.type === BeaconMessageType.ChangeAccountRequest &&
        !(await this.isAuthorizedChangeAccountSender(message.senderId, connectionInfo))
      ) {
        return false
      }

      return (
        isCurrent() &&
        generation === this._accountChangeGeneration &&
        !this._disconnectPromise &&
        !this.destroyed
      )
    }
    const persisted = await this.mutateAccounts(async () => {
      const previous = await this.accountManager.getAccount(accountInfo.accountIdentifier)
      if (!(await isAuthorized())) {
        return false
      }
      await this.accountManager.addAccount(accountInfo)
      if (!(await isAuthorized())) {
        // Roll back before queued removals or newer account writes can run.
        if (previous) {
          await this.accountManager.addAccount(previous)
        } else {
          await this.accountManager.removeAccount(accountInfo.accountIdentifier)
        }

        return false
      }

      return true
    })
    if (!persisted || !(await isAuthorized())) {
      owner?.abort()
      owner?.assertCurrent()

      return accountInfo
    }
    if (owner) {
      owner.assertCurrent()
      await this.selectActiveAccount(accountInfo, owner)
    } else {
      await this.setActiveAccount(accountInfo)
    }

    return accountInfo
  }

  private async isAuthorizedChangeAccountSender(
    senderId: string,
    connectionInfo: ConnectionContext
  ): Promise<boolean> {
    const peer = this._activePeer.isResolved() ? await this._activePeer.promise : undefined
    if (connectionInfo.origin === Origin.P2P || connectionInfo.origin === Origin.EXTENSION) {
      if (!peer) {
        return false
      }
      const expectedOrigin =
        peer.type === 'p2p-pairing-response' || peer.type === 'p2p-pairing-request'
          ? Origin.P2P
          : Origin.EXTENSION
      const expectedConnection =
        expectedOrigin === Origin.P2P
          ? peer.publicKey
          : (peer as ExtendedPostMessagePairingResponse).extensionId
      const expectedSenderId = await getSenderId(peer.publicKey)
      const currentPeer = this._activePeer.isResolved() ? await this._activePeer.promise : undefined

      return Boolean(
        currentPeer === peer &&
        senderId === expectedSenderId &&
        connectionInfo.origin === expectedOrigin &&
        connectionInfo.id === expectedConnection
      )
    }
    if (connectionInfo.origin === Origin.WALLETCONNECT) {
      return this.isAuthorizedWalletConnectChangeAccountSender(senderId, connectionInfo, peer)
    }

    return false
  }

  private async isAuthorizedWalletConnectChangeAccountSender(
    senderId: string,
    connectionInfo: ConnectionContext,
    peer: PeerInfo | undefined
  ): Promise<boolean> {
    const activeAccount = this._activeAccount.isResolved()
      ? await this._activeAccount.promise
      : undefined
    const matchesActivePeer =
      peer?.type === 'walletconnect-pairing-response' &&
      peer.publicKey === connectionInfo.id &&
      'senderId' in peer &&
      peer.senderId === senderId
    const matchesActiveAccount =
      !peer &&
      activeAccount?.origin.type === Origin.WALLETCONNECT &&
      activeAccount.origin.id === connectionInfo.id &&
      activeAccount.senderId === senderId

    return Boolean(matchesActivePeer || matchesActiveAccount)
  }
}
