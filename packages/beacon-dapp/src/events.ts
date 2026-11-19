import {
  closeAlert,
  openAlert,
  AlertButton,
  AlertConfig,
  closeToast,
  openToast,
  ToastAction,
  isMobile,
  isMobileOS
} from '@ecadlabs/beacon-ui'
import {
  BeaconErrorType,
  ExtendedPostMessagePairingResponse,
  ExtendedP2PPairingResponse,
  AccountInfo,
  BlockchainAccountInfo,
  StoredAccountInfo,
  BeaconMessageWrapper,
  PermissionResponseV3,
  PermissionResponseOutput,
  OperationResponseOutput,
  BroadcastResponseOutput,
  SignPayloadResponseOutput,
  Network,
  ConnectionContext,
  NetworkType,
  AcknowledgeResponse,
  WalletInfo,
  ExtendedWalletConnectPairingResponse,
  AnalyticsInterface,
  ProofOfEventChallengeResponseOutput,
  SimulatedProofOfEventChallengeResponseOutput,
  BeaconMessageType,
  TransportType,
  TransportStatus,
  TransportHealth,
  TransportStatusChangeReason,
  TransportStatusChangedInfo,
  WaitingForWalletAckInfo,
  WalletConnectPairingResult,
  getBeaconMessages,
  interpolateBeaconMessage
} from '@ecadlabs/beacon-types'
import {
  UnknownBeaconError,
  type ClientTransport,
  Logger,
  getError
  // EncryptPayloadResponseOutput,
  // EncryptionOperation
} from '@ecadlabs/beacon-core'
import type { DAppClientOptions } from './dapp-client/DAppClientOptions'
import { BlockExplorer } from './utils/block-explorer'
import { shortenString } from './utils/shorten-string'
import { LateResponseInfo, RequestErrorResponse } from './dapp-client/request-error'

const logger = new Logger('BeaconEvents')

const SUCCESS_TIMER: number = 5 * 1000

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const getContractErrorMessage = (
  errorData: unknown,
  errorMessages?: Record<string, Record<string | number, string>>
): string | undefined => {
  if (!Array.isArray(errorData)) {
    return undefined
  }

  const errors: unknown[] = errorData
  const contractError = errors[0]
  const detailError = errors[1]
  if (!isObject(contractError) || !isObject(detailError)) {
    return undefined
  }

  const contractHandle = contractError.contract_handle
  if (typeof contractHandle !== 'string' || contractHandle === '') {
    return undefined
  }

  const detail = detailError.with
  if (!isObject(detail)) {
    return undefined
  }

  const code = detail.int ?? detail.string
  if ((typeof code !== 'string' && typeof code !== 'number') || code === '') {
    return undefined
  }

  const message = errorMessages?.[contractHandle]?.[code]

  return typeof message === 'string' ? message : undefined
}
/**
 * The different events that can be emitted by the beacon-sdk
 */
export enum BeaconEvent {
  PERMISSION_REQUEST_SENT = 'PERMISSION_REQUEST_SENT',
  PERMISSION_REQUEST_SUCCESS = 'PERMISSION_REQUEST_SUCCESS',
  PERMISSION_REQUEST_ERROR = 'PERMISSION_REQUEST_ERROR',
  PROOF_OF_EVENT_CHALLENGE_REQUEST_SENT = 'PROOF_OF_EVENT_CHALLENGE_REQUEST_SENT',
  PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS = 'PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS',
  PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR = 'PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR',
  SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SENT = 'SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SENT',
  SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS = 'SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS',
  SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR = 'SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR',
  OPERATION_REQUEST_SENT = 'OPERATION_REQUEST_SENT',
  OPERATION_REQUEST_SUCCESS = 'OPERATION_REQUEST_SUCCESS',
  OPERATION_REQUEST_ERROR = 'OPERATION_REQUEST_ERROR',
  SIGN_REQUEST_SENT = 'SIGN_REQUEST_SENT',
  SIGN_REQUEST_SUCCESS = 'SIGN_REQUEST_SUCCESS',
  SIGN_REQUEST_ERROR = 'SIGN_REQUEST_ERROR',
  BLOCKCHAIN_REQUEST_SUCCESS = 'BLOCKCHAIN_REQUEST_SUCCESS',
  // TODO: ENCRYPTION
  // ENCRYPT_REQUEST_SENT = 'ENCRYPT_REQUEST_SENT',
  // ENCRYPT_REQUEST_SUCCESS = 'ENCRYPT_REQUEST_SUCCESS',
  // ENCRYPT_REQUEST_ERROR = 'ENCRYPT_REQUEST_ERROR',
  BROADCAST_REQUEST_SENT = 'BROADCAST_REQUEST_SENT',
  BROADCAST_REQUEST_SUCCESS = 'BROADCAST_REQUEST_SUCCESS',
  BROADCAST_REQUEST_ERROR = 'BROADCAST_REQUEST_ERROR',
  ACKNOWLEDGE_RECEIVED = 'ACKNOWLEDGE_RECEIVED',
  WAITING_FOR_WALLET_ACK = 'WAITING_FOR_WALLET_ACK',
  /** A wallet answered a request after its deadline fired and the caller got PEER_UNREACHABLE. */
  LATE_RESPONSE_RECEIVED = 'LATE_RESPONSE_RECEIVED',

  LOCAL_RATE_LIMIT_REACHED = 'LOCAL_RATE_LIMIT_REACHED',

  NO_PERMISSIONS = 'NO_PERMISSIONS',

  ACTIVE_ACCOUNT_SET = 'ACTIVE_ACCOUNT_SET',

  ACTIVE_TRANSPORT_SET = 'ACTIVE_TRANSPORT_SET',

  TRANSPORT_STATUS_CHANGED = 'TRANSPORT_STATUS_CHANGED',

  SHOW_PREPARE = 'SHOW_PREPARE',
  HIDE_UI = 'HIDE_UI',
  INVALID_ACTIVE_ACCOUNT_STATE = 'INVALID_ACTIVE_ACCOUNT_STATE',
  INVALID_ACCOUNT_DEACTIVATED = 'INVALID_ACCOUNT_DEACTIVATED',
  PAIR_INIT = 'PAIR_INIT',
  PAIR_SUCCESS = 'PAIR_SUCCESS',
  CHANNEL_CLOSED = 'CHANNEL_CLOSED',
  GENERIC_ERROR = 'GENERIC_ERROR',
  RELAYER_ERROR = 'RELAYER_ERROR',

  INTERNAL_ERROR = 'INTERNAL_ERROR',
  UNKNOWN = 'UNKNOWN'
}

export interface ExtraInfo {
  resetCallback?(): Promise<void>
}

/**
 * Reason Beacon deactivated invalid persisted active-account state during dApp
 * startup.
 *
 * - `missing_active_account`: `beacon:active-account` pointed at an account
 *   identifier that was not present in Beacon's persisted account list.
 * - `invalid_active_account_storage`: Beacon could not read or parse the
 *   persisted active-account/account storage needed to restore the account.
 * - `storage_validation_failed`: Beacon restored an active account, but a later
 *   storage validation pass still found invalid persisted session state.
 */
export type InvalidAccountDeactivatedReason =
  'missing_active_account' | 'invalid_active_account_storage' | 'storage_validation_failed'

/**
 * Payload emitted with {@link BeaconEvent.INVALID_ACCOUNT_DEACTIVATED}.
 *
 * Beacon emits this object when it deactivates invalid active-account state.
 * The event type also accepts `undefined` so listeners and direct emitters
 * written against earlier Beacon versions remain source-compatible.
 */
export interface InvalidAccountDeactivatedEvent {
  /**
   * Machine-readable reason for the deactivation.
   */
  reason: InvalidAccountDeactivatedReason
}

/** Metadata shared by transport dispatch and inter-tab forwarding notifications. */
interface RequestDispatchInfo {
  requestId: string
  requestType: BeaconMessageType
  /** Actual transport for dispatch, intended wallet transport for forwarding. */
  transport: TransportType
  /** Target wallet peer, when known. */
  senderId?: string
  extraInfo: ExtraInfo
  walletInfo: WalletInfo
}

/** SENT is emitted after dispatch completes; timestamps mark the start of dispatch. */
export type RequestSentInfo = RequestDispatchInfo &
  (
    | { dispatchStage: 'transport'; sentAt: number }
    | { dispatchStage: 'forwarded'; forwardedAt: number }
  )

/** Correlation metadata for terminal request events. Times are epoch milliseconds. */
export interface RequestResponseInfo {
  requestId: string
  /** Response arrival at this client, or settlement time for a locally generated error. */
  receivedAt: number
}

/** WalletConnect pairing status is not a correlated protocol acknowledgement. */
export type AcknowledgeInfo = {
  receivedAt: number
  walletInfo: WalletInfo
  extraInfo: ExtraInfo
} & ({ correlated: true; requestId: string; message: AcknowledgeResponse } | { correlated: false })

/**
 * The type of the payload of the different BeaconEvents
 */
export type ActiveTransportInfo = Readonly<Pick<ClientTransport, 'type' | 'connectionStatus'>>

export type PermissionResponseInfo = {
  blockExplorer: BlockExplorer
  connectionContext: ConnectionContext
  walletInfo: WalletInfo
} & (
  | { protocolVersion?: '2'; account: AccountInfo; output: PermissionResponseOutput }
  | {
      protocolVersion: '3'
      account: BlockchainAccountInfo
      output: BeaconMessageWrapper<PermissionResponseV3>
    }
)

export type {
  TransportHealth,
  TransportStatus,
  TransportStatusChangeReason,
  TransportStatusChangedInfo,
  WaitingForWalletAckInfo
}

/**
 * The payload types emitted by each BeaconEvent.
 *
 * While DAppClient request methods reject with BeaconError instances (isBeaconError(err) === true),
 * *_REQUEST_ERROR events emit { errorResponse } as a plain RequestErrorResponse object
 * (isRequestErrorResponse(data.errorResponse) === true) for backward compatibility with existing event handlers.
 * Event subscribers can call toBeaconError(data.errorResponse) when they want a BeaconError instance.
 */
export interface BeaconEventType {
  [BeaconEvent.PERMISSION_REQUEST_SENT]: RequestSentInfo
  [BeaconEvent.PERMISSION_REQUEST_SUCCESS]: RequestResponseInfo & PermissionResponseInfo
  /**
   * Emitted when a permission request fails.
   * The errorResponse is a plain RequestErrorResponse (isRequestErrorResponse(data.errorResponse) === true).
   * Call toBeaconError(data.errorResponse) if a BeaconError instance is needed.
   */
  [BeaconEvent.PERMISSION_REQUEST_ERROR]: RequestResponseInfo & {
    errorResponse: RequestErrorResponse
    walletInfo: WalletInfo
  }
  [BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_SENT]: RequestSentInfo
  [BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS]: RequestResponseInfo & {
    account: AccountInfo
    output: ProofOfEventChallengeResponseOutput
    blockExplorer: BlockExplorer
    connectionContext: ConnectionContext
    walletInfo: WalletInfo
  }
  /**
   * Emitted when a proof of event challenge request fails.
   * The errorResponse is a plain RequestErrorResponse (isRequestErrorResponse(data.errorResponse) === true).
   * Call toBeaconError(data.errorResponse) if a BeaconError instance is needed.
   */
  [BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR]: RequestResponseInfo & {
    errorResponse: RequestErrorResponse
    walletInfo: WalletInfo
  }
  [BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SENT]: RequestSentInfo
  [BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS]: RequestResponseInfo & {
    account: AccountInfo
    output: SimulatedProofOfEventChallengeResponseOutput
    blockExplorer: BlockExplorer
    connectionContext: ConnectionContext
    walletInfo: WalletInfo
  }
  /**
   * Emitted when a simulated proof of event challenge request fails.
   * The errorResponse is a plain RequestErrorResponse (isRequestErrorResponse(data.errorResponse) === true).
   * Call toBeaconError(data.errorResponse) if a BeaconError instance is needed.
   */
  [BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR]: RequestResponseInfo & {
    errorResponse: RequestErrorResponse
    walletInfo: WalletInfo
  }
  [BeaconEvent.OPERATION_REQUEST_SENT]: RequestSentInfo
  [BeaconEvent.OPERATION_REQUEST_SUCCESS]: RequestResponseInfo & {
    account: AccountInfo
    output: OperationResponseOutput
    blockExplorer: BlockExplorer
    connectionContext: ConnectionContext
    walletInfo: WalletInfo
  }
  /**
   * Emitted when an operation request fails.
   * The errorResponse is a plain RequestErrorResponse (isRequestErrorResponse(data.errorResponse) === true).
   * Call toBeaconError(data.errorResponse) if a BeaconError instance is needed.
   */
  [BeaconEvent.OPERATION_REQUEST_ERROR]: RequestResponseInfo & {
    errorResponse: RequestErrorResponse
    walletInfo: WalletInfo
    errorMessages: Record<string, Record<string | number, string>>
  }
  [BeaconEvent.SIGN_REQUEST_SENT]: RequestSentInfo
  [BeaconEvent.SIGN_REQUEST_SUCCESS]: RequestResponseInfo & {
    output: SignPayloadResponseOutput
    connectionContext: ConnectionContext
    walletInfo: WalletInfo
  }
  /**
   * Emitted when a sign payload request fails.
   * The errorResponse is a plain RequestErrorResponse (isRequestErrorResponse(data.errorResponse) === true).
   * Call toBeaconError(data.errorResponse) if a BeaconError instance is needed.
   */
  [BeaconEvent.SIGN_REQUEST_ERROR]: RequestResponseInfo & {
    errorResponse: RequestErrorResponse
    walletInfo: WalletInfo
  }
  // TODO: ENCRYPTION
  // [BeaconEvent.ENCRYPT_REQUEST_SENT]: RequestSentInfo
  // [BeaconEvent.ENCRYPT_REQUEST_SUCCESS]: {
  //   output: EncryptPayloadResponseOutput
  //   connectionContext: ConnectionContext
  //   walletInfo: WalletInfo
  // }
  // [BeaconEvent.ENCRYPT_REQUEST_ERROR]: { errorResponse: RequestErrorResponse; walletInfo: WalletInfo }
  [BeaconEvent.BLOCKCHAIN_REQUEST_SUCCESS]: RequestResponseInfo & { walletInfo: WalletInfo }
  [BeaconEvent.BROADCAST_REQUEST_SENT]: RequestSentInfo
  [BeaconEvent.BROADCAST_REQUEST_SUCCESS]: RequestResponseInfo & {
    network: Network
    output: BroadcastResponseOutput
    blockExplorer: BlockExplorer
    connectionContext: ConnectionContext
    walletInfo: WalletInfo
  }
  /**
   * Emitted when a broadcast request fails.
   * The errorResponse is a plain RequestErrorResponse (isRequestErrorResponse(data.errorResponse) === true).
   * Call toBeaconError(data.errorResponse) if a BeaconError instance is needed.
   */
  [BeaconEvent.BROADCAST_REQUEST_ERROR]: RequestResponseInfo & {
    errorResponse: RequestErrorResponse
    walletInfo: WalletInfo
  }
  [BeaconEvent.ACKNOWLEDGE_RECEIVED]: AcknowledgeInfo
  [BeaconEvent.WAITING_FOR_WALLET_ACK]: WaitingForWalletAckInfo
  [BeaconEvent.LOCAL_RATE_LIMIT_REACHED]: undefined
  [BeaconEvent.NO_PERMISSIONS]: undefined
  [BeaconEvent.ACTIVE_ACCOUNT_SET]: StoredAccountInfo | undefined
  [BeaconEvent.ACTIVE_TRANSPORT_SET]: ActiveTransportInfo | undefined
  [BeaconEvent.TRANSPORT_STATUS_CHANGED]: TransportStatusChangedInfo

  [BeaconEvent.INVALID_ACTIVE_ACCOUNT_STATE]: undefined
  [BeaconEvent.GENERIC_ERROR]: string
  [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: InvalidAccountDeactivatedEvent | undefined
  [BeaconEvent.SHOW_PREPARE]: { walletInfo?: WalletInfo }
  [BeaconEvent.HIDE_UI]: ('alert' | 'toast')[] | undefined
  [BeaconEvent.PAIR_INIT]: {
    p2pPeerInfo: Promise<string>
    postmessagePeerInfo: Promise<string>
    walletConnectPeerInfo: PromiseLike<WalletConnectPairingResult>
    networkType: NetworkType
    abortedHandler?(): void
    disclaimerText?: string
    analytics: AnalyticsInterface
    featuredWallets?: string[]
  }
  [BeaconEvent.PAIR_SUCCESS]:
    | ExtendedPostMessagePairingResponse
    | ExtendedP2PPairingResponse
    | ExtendedWalletConnectPairingResponse
  [BeaconEvent.CHANNEL_CLOSED]: string | undefined
  [BeaconEvent.LATE_RESPONSE_RECEIVED]: LateResponseInfo

  [BeaconEvent.INTERNAL_ERROR]: { text: string; buttons?: AlertButton[] }
  [BeaconEvent.RELAYER_ERROR]: undefined
  [BeaconEvent.UNKNOWN]: undefined
}

/**
 * Show a "Request sent" toast
 */
const showSentToast = async (data: RequestSentInfo): Promise<void> => {
  let openWalletAction
  const actions: ToastAction[] = []
  if (data.walletInfo.deeplink) {
    if (
      data.walletInfo.type === 'web' ||
      (data.walletInfo.type === 'mobile' && isMobile(window)) ||
      (data.walletInfo.type === 'desktop' && !isMobile(window))
    ) {
      const link = data.walletInfo.deeplink
      openWalletAction = async (): Promise<void> => {
        const a = document.createElement('a')
        a.setAttribute('rel', 'noopener')
        a.setAttribute('href', link)
        a.setAttribute('target', '_blank')
        a.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }))
      }
    }
  }
  actions.push({
    get text() {
      return getBeaconMessages().dapp.noAnswerFromWallet
    },
    isBold: true
  })
  actions.push({
    get text() {
      return getBeaconMessages().dapp.walletNotReceivingRequest
    },
    get actionText() {
      return getBeaconMessages().dapp.resetConnection
    },
    actionCallback: async (): Promise<void> => {
      closeToast()
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const resetCallback = data.extraInfo.resetCallback
      if (resetCallback) {
        logger.log('showSentToast', 'resetCallback invoked')
        await resetCallback()
      }
    }
  })

  openToast({
    get body() {
      return getBeaconMessages().dapp.requestSent
    },
    walletInfo: data.walletInfo,
    state: 'loading',
    timer: isMobileOS(window) ? SUCCESS_TIMER : 0,
    actions,
    openWalletAction
  })
}

const showAcknowledgedToast = async (data: AcknowledgeInfo): Promise<void> => {
  openToast({
    get body() {
      return getBeaconMessages().dapp.awaitingConfirmation
    },
    state: 'acknowledge',
    walletInfo: data.walletInfo
  })
}

const showPrepare = async (data: { walletInfo?: WalletInfo }): Promise<void> => {
  openToast({
    get body() {
      const { dapp } = getBeaconMessages()

      return data.walletInfo ? dapp.preparingRequestForWallet : dapp.preparingRequest
    },
    state: 'prepare',
    walletInfo: data.walletInfo
  })
}

const hideUI = (elements?: ('alert' | 'toast')[]) => {
  if (elements?.includes('alert')) {
    closeAlert()
  }

  if (elements?.includes('toast') || !elements) {
    closeToast()
  }
}

/**
 * Show a "No Permission" alert
 */
const showNoPermissionAlert = async (): Promise<void> => {
  openAlert({
    get title() {
      return getBeaconMessages().dapp.noPermissionTitle
    },
    get body() {
      return getBeaconMessages().dapp.noPermissionBody
    }
  })
}

/**
 * Show an "Invalid state" alert
 */
const showInvalidActiveAccountState = async (): Promise<void> => {
  openAlert({
    get title() {
      return getBeaconMessages().dapp.invalidStateTitle
    },
    get body() {
      return getBeaconMessages().dapp.invalidStateBody
    }
  })
}

/**
 * Show an "account deactivated" error alert
 */
const showInvalidAccountDeactivated = async (
  data?: InvalidAccountDeactivatedEvent
): Promise<void> => {
  logger.log('showInvalidAccountDeactivated', data?.reason ?? 'unknown')

  if (data?.reason === 'missing_active_account') {
    return
  }

  openAlert({
    get title() {
      return getBeaconMessages().dapp.errorTitle
    },
    get body() {
      return getBeaconMessages().dapp.sessionExpiredBody
    }
  })
}

/**
 * Show an "Invalid state" alert
 */
const showGenericErrorAlert = async (errorMessage: string): Promise<void> => {
  openAlert({
    title: `${errorMessage}`,
    get body() {
      return getBeaconMessages().dapp.pleaseTryAgain
    }
  })
}

/**
 * An error the dApp produced itself (timeout, abort) did not come from the wallet, so the
 * toast must not say the wallet returned it.
 */
const errorToastBody = (errorType: BeaconErrorType, local: boolean): string => {
  const { dapp } = getBeaconMessages()
  if (!local) {
    return dapp.walletReturnedError
  }
  switch (errorType) {
    case BeaconErrorType.PEER_UNREACHABLE:
      return dapp.walletDidNotRespond
    case BeaconErrorType.ABORTED_ERROR:
      return dapp.walletRequestCancelled
    default:
      return dapp.walletRequestFailed
  }
}

/**
 * Show an error toast
 *
 * @param beaconError The beacon error
 */
const showErrorToast = async (
  response: {
    errorResponse: RequestErrorResponse
    walletInfo: WalletInfo
    errorMessages?: Record<string, Record<string | number, string>>
  },
  buttons?: AlertButton[]
): Promise<void> => {
  const resolveError = () =>
    response.errorResponse.errorType
      ? getError(response.errorResponse.errorType, response.errorResponse.errorData)
      : new UnknownBeaconError()
  const local = response.errorResponse.errorOrigin === 'local'

  const actions: ToastAction[] = [
    {
      get text() {
        return resolveError().title
      },
      isBold: true
    }
  ]

  // A local timeout is not an answer: the wallet may still approve the request, so the user
  // needs the explanation before deciding whether to retry.
  if (local && response.errorResponse.errorType === BeaconErrorType.PEER_UNREACHABLE) {
    actions.push({
      get text() {
        return resolveError().description
      }
    })
  }

  if (
    response.errorResponse.errorType === BeaconErrorType.TRANSACTION_INVALID_ERROR &&
    response.errorResponse.errorData
  ) {
    const contractMessage = getContractErrorMessage(
      response.errorResponse.errorData,
      response.errorMessages
    )
    actions.push(
      contractMessage
        ? { text: contractMessage, isBold: true }
        : {
            get text() {
              return resolveError().description
            }
          }
    )

    actions.push({
      text: '',
      get actionText() {
        return getBeaconMessages().dapp.showDetails
      },
      actionCallback: async (): Promise<void> => {
        closeToast()
        openAlert({
          get title() {
            return resolveError().title
          },
          get body() {
            return resolveError().fullDescription.description
          },
          get data() {
            return resolveError().fullDescription.data
          },
          buttons
        })
      }
    })
  }

  openToast({
    get body() {
      return errorToastBody(response.errorResponse.errorType, local)
    },
    timer:
      response.errorResponse.errorType === BeaconErrorType.ABORTED_ERROR
        ? SUCCESS_TIMER
        : undefined,
    state: 'finished',
    walletInfo: response.walletInfo,
    actions
  })
}

/**
 * Show a rate limit reached toast
 */
const showRateLimitReached = async (): Promise<void> => {
  openAlert({
    get title() {
      return getBeaconMessages().dapp.errorTitle
    },
    get body() {
      return getBeaconMessages().dapp.rateLimitReachedBody
    },
    buttons: [
      {
        get text() {
          return getBeaconMessages().dapp.done
        },
        style: 'outline'
      }
    ],
    timer: 3000
  })
}

/**
 * Show a "connection successful" alert for 1.5 seconds
 */
const showExtensionConnectedAlert = () => {
  closeAlert()
}

const showRelayerErrorAlert = async (): Promise<void> => {
  openAlert({
    get title() {
      return getBeaconMessages().dapp.errorTitle
    },
    get body() {
      return getBeaconMessages().dapp.relayerErrorBody
    },
    buttons: [
      {
        get text() {
          return getBeaconMessages().dapp.done
        },
        style: 'outline'
      }
    ],
    timer: 1500
  })
}

/**
 * Show a "channel closed" alert for 1.5 seconds
 */
const showLateResponseToast = async (data: LateResponseInfo): Promise<void> => {
  if (data.kind !== 'success' || !data.transactionHash) {
    return
  }
  const hash = data.transactionHash
  const broadcast = data.requestType === BeaconMessageType.BroadcastRequest

  openToast({
    get body() {
      const { dapp } = getBeaconMessages()

      return broadcast ? dapp.lateBroadcastToast : dapp.lateOperationToast
    },
    state: 'finished',
    walletInfo: data.walletInfo,
    actions: [
      {
        text: shortenString(hash),
        isBold: true,
        get actionText() {
          return getBeaconMessages().dapp.copyToClipboard
        },
        actionCallback: async (): Promise<void> => {
          navigator.clipboard.writeText(hash).then(
            () => logger.log('showLateResponseToast', 'Copying to clipboard was successful!'),
            (err) =>
              logger.error('showLateResponseToast', 'Could not copy text to clipboard: ', err)
          )
          closeToast()
        }
      }
    ]
  })
}

const showChannelClosedAlert = async (): Promise<void> => {
  // openAlert({
  //   title: 'Channel closed',
  //   body: `Your peer has closed the connection.`,
  //   buttons: [{ text: 'Done', style: 'outline' }],
  //   timer: 1500
  // })
}

const showInternalErrorAlert = async (
  data: BeaconEventType[BeaconEvent.INTERNAL_ERROR]
): Promise<void> => {
  const buttons: AlertButton[] = [...(data.buttons ?? [])]

  buttons.push({
    get text() {
      return getBeaconMessages().dapp.done
    },
    style: 'outline'
  })

  const alertConfig: AlertConfig = {
    get title() {
      return getBeaconMessages().dapp.internalErrorTitle
    },
    get body() {
      return data.text
    },
    buttons
  }
  openAlert(alertConfig)
}

/**
 * Show a connect alert with QR code
 *
 * @param data The data that is emitted by the PAIR_INIT event
 */
const showPairAlert = async (data: BeaconEventType[BeaconEvent.PAIR_INIT]): Promise<void> => {
  logger.log('showPairAlert')
  const alertConfig: AlertConfig = {
    get title() {
      return getBeaconMessages().dapp.choosePreferredWallet
    },
    body: `<p></p>`,
    pairingPayload: {
      p2pSyncCode: data.p2pPeerInfo,
      walletConnectSyncCode: data.walletConnectPeerInfo,
      postmessageSyncCode: data.postmessagePeerInfo,
      networkType: data.networkType
    },
    // eslint-disable-next-line @typescript-eslint/unbound-method
    closeButtonCallback: data.abortedHandler,
    disclaimerText: data.disclaimerText,
    analytics: data.analytics,
    featuredWallets: data.featuredWallets
  }
  openAlert(alertConfig)
}

/**
 * Show a "Permission Granted" alert
 *
 * @param data The data that is emitted by the PERMISSION_REQUEST_SUCCESS event
 */
const showPermissionSuccessAlert = async (
  data: BeaconEventType[BeaconEvent.PERMISSION_REQUEST_SUCCESS]
): Promise<void> => {
  const address = data.protocolVersion === '3' ? data.account.address : data.output.address
  const actions: ToastAction[] = [
    {
      get text() {
        return getBeaconMessages().dapp.addressLabel
      },
      actionText: shortenString(address),
      isBold: true
    }
  ]

  // V3 accounts carry chain-specific permissions rather than the Tezos network/scope schema.
  if (data.protocolVersion !== '3') {
    const { output } = data
    actions.push({
      get text() {
        return getBeaconMessages().dapp.networkLabel
      },
      actionText: `${output.network.type}`
    })
    actions.push({
      get text() {
        return getBeaconMessages().dapp.permissionsLabel
      },
      actionText: output.scopes.join(', ')
    })
  }

  openToast({
    get body() {
      return getBeaconMessages().dapp.permissionGrantedToast
    },
    timer: SUCCESS_TIMER,
    walletInfo: data.walletInfo,
    state: 'finished',
    actions
  })
}

const showProofOfEventChallengeSuccessAlert = async (
  data: BeaconEventType[BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS]
): Promise<void> => {
  const { output } = data

  openToast({
    get body() {
      const { dapp } = getBeaconMessages()

      return output.isAccepted ? dapp.challengeAcceptedToast : dapp.challengeRefusedToast
    },
    timer: SUCCESS_TIMER,
    walletInfo: data.walletInfo,
    state: 'finished',
    actions: output.isAccepted
      ? [
          {
            get text() {
              return interpolateBeaconMessage(getBeaconMessages().dapp.payloadHashLabel, {
                payloadHash: output.payloadHash
              })
            },
            get actionText() {
              return getBeaconMessages().dapp.copyToClipboard
            },
            actionCallback: async (): Promise<void> => {
              navigator.clipboard.writeText(output.payloadHash).then(
                () => {
                  logger.log('showSignSuccessAlert', 'Copying to clipboard was successful!')
                },
                (err) => {
                  logger.error('showSignSuccessAlert', 'Could not copy text to clipboard: ', err)
                }
              )
              closeToast()
            }
          }
        ]
      : []
  })
}

const showSimulatedProofOfEventChallengeSuccessAlert = async (
  data: BeaconEventType[BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS]
): Promise<void> => {
  const { output } = data

  openToast({
    get body() {
      const { dapp } = getBeaconMessages()

      return !output.errorMessage ? dapp.operationListReturnedToast : dapp.walletReturnedError
    },
    timer: SUCCESS_TIMER,
    walletInfo: data.walletInfo,
    state: 'finished',
    actions: !output.errorMessage
      ? [
          {
            get text() {
              return getBeaconMessages().dapp.operationListLabel
            },
            get actionText() {
              return getBeaconMessages().dapp.copyToClipboard
            },
            actionCallback: async (): Promise<void> => {
              navigator.clipboard.writeText(output.operationsList).then(
                () => {
                  logger.log('showSignSuccessAlert', 'Copying to clipboard was successful!')
                },
                (err) => {
                  logger.error('showSignSuccessAlert', 'Could not copy text to clipboard: ', err)
                }
              )
              closeToast()
            }
          }
        ]
      : [
          {
            get text() {
              return getBeaconMessages().dapp.errorMessageLabel
            },
            actionText: output.errorMessage
          }
        ]
  })
}

/**
 * Show an "Operation Broadcasted" alert
 *
 * @param data The data that is emitted by the OPERATION_REQUEST_SUCCESS event
 */
const showOperationSuccessAlert = async (
  data: BeaconEventType[BeaconEvent.OPERATION_REQUEST_SUCCESS]
): Promise<void> => {
  const { account, output, blockExplorer } = data

  openToast({
    get body() {
      return getBeaconMessages().dapp.operationSubmittedToast
    },
    timer: SUCCESS_TIMER,
    state: 'finished',
    walletInfo: data.walletInfo,
    actions: [
      {
        text: shortenString(output.transactionHash),
        isBold: true,
        get actionText() {
          return getBeaconMessages().dapp.openBlockexplorer
        },
        actionLogo: 'external',
        actionCallback: async (): Promise<void> => {
          const link: string = await blockExplorer.getTransactionLink(
            output.transactionHash,
            account.network
          )
          window.open(link, '_blank', 'noopener')
          closeToast()
        }
      }
    ]
  })
}

/**
 * Show a "Transaction Signed" alert
 *
 * @param data The data that is emitted by the SIGN_REQUEST_SUCCESS event
 */
const showSignSuccessAlert = async (
  data: BeaconEventType[BeaconEvent.SIGN_REQUEST_SUCCESS]
): Promise<void> => {
  const output = data.output
  openToast({
    get body() {
      return getBeaconMessages().dapp.payloadSignedToast
    },
    timer: SUCCESS_TIMER,
    state: 'finished',
    walletInfo: data.walletInfo,
    actions: [
      {
        get text() {
          return interpolateBeaconMessage(getBeaconMessages().dapp.signatureLabel, {
            signature: shortenString(output.signature)
          })
        },
        get actionText() {
          return getBeaconMessages().dapp.copyToClipboard
        },
        actionCallback: async (): Promise<void> => {
          navigator.clipboard.writeText(output.signature).then(
            () => {
              logger.log('showSignSuccessAlert', 'Copying to clipboard was successful!')
            },
            (err) => {
              logger.error('showSignSuccessAlert', 'Could not copy text to clipboard: ', err)
            }
          )
          closeToast()
        }
      }
    ]
  })
}

/**
 * Show a "Transaction Signed" alert
 *
 * @param data The data that is emitted by the ENCRYPT_REQUEST_SUCCESS event
 */
// TODO: ENCRYPTION
// const showEncryptSuccessAlert = async (
//   data: BeaconEventType[BeaconEvent.ENCRYPT_REQUEST_SUCCESS]
// ): Promise<void> => {
//   const output = data.output
//   openToast({
//     body: `{{wallet}}\u00A0 successfully ${
//       data.output.cryptoOperation === EncryptionOperation.ENCRYPT ? 'encrypted' : 'decrypted'
//     } payload`,
//     timer: SUCCESS_TIMER,
//     state: 'finished',
//     walletInfo: data.walletInfo,
//     actions: [
//       {
//         text: `Payload: <strong>${shortenString(output.payload)}</strong>`,
//         actionText: 'Copy to clipboard',
//         actionCallback: async (): Promise<void> => {
//           navigator.clipboard.writeText(output.payload).then(
//             () => {
//               logger.log('showSignSuccessAlert', 'Copying to clipboard was successful!')
//             },
//             (err) => {
//               logger.error('showSignSuccessAlert', 'Could not copy text to clipboard: ', err)
//             }
//           )
//           closeToast()
//         }
//       }
//     ]
//   })
// }

const showBlockchainRequestSuccessToast = async (
  data: BeaconEventType[BeaconEvent.BLOCKCHAIN_REQUEST_SUCCESS]
): Promise<void> => {
  openToast({
    get body() {
      return getBeaconMessages().dapp.blockchainRequestExecutedToast
    },
    timer: SUCCESS_TIMER,
    state: 'finished',
    walletInfo: data.walletInfo
  })
}

/**
 * Show a "Broadcasted" alert
 *
 * @param data The data that is emitted by the BROADCAST_REQUEST_SUCCESS event
 */
const showBroadcastSuccessAlert = async (
  data: BeaconEventType[BeaconEvent.BROADCAST_REQUEST_SUCCESS]
): Promise<void> => {
  const { network, output, blockExplorer } = data

  openToast({
    get body() {
      return getBeaconMessages().dapp.operationInjectedToast
    },
    timer: SUCCESS_TIMER,
    state: 'finished',
    walletInfo: data.walletInfo,
    actions: [
      {
        text: shortenString(output.transactionHash),
        isBold: true,
        get actionText() {
          return getBeaconMessages().dapp.openBlockexplorer
        },
        actionLogo: 'external',
        actionCallback: async (): Promise<void> => {
          const link: string = await blockExplorer.getTransactionLink(
            output.transactionHash,
            network
          )
          window.open(link, '_blank', 'noopener')
          closeToast()
        }
      }
    ]
  })
}

const emptyHandler = (): BeaconEventHandlerFunction => async (): Promise<void> => {
  //
}

export type BeaconEventHandlerFunction<T = unknown> = (
  data: T,
  eventCallback?: AlertButton[]
) => void | Promise<void>

/**
 * The default event handlers
 */
export const defaultEventCallbacks: {
  [key in BeaconEvent]: BeaconEventHandlerFunction<BeaconEventType[key]>
} = {
  [BeaconEvent.PERMISSION_REQUEST_SENT]: showSentToast,
  [BeaconEvent.PERMISSION_REQUEST_SUCCESS]: showPermissionSuccessAlert,
  [BeaconEvent.PERMISSION_REQUEST_ERROR]: showErrorToast,
  [BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_SENT]: showSentToast,
  [BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS]: showProofOfEventChallengeSuccessAlert,
  [BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR]: showErrorToast,
  [BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SENT]: showSentToast,
  [BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS]:
    showSimulatedProofOfEventChallengeSuccessAlert,
  [BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR]: showErrorToast,
  [BeaconEvent.OPERATION_REQUEST_SENT]: showSentToast,
  [BeaconEvent.OPERATION_REQUEST_SUCCESS]: showOperationSuccessAlert,
  [BeaconEvent.OPERATION_REQUEST_ERROR]: showErrorToast,
  [BeaconEvent.SIGN_REQUEST_SENT]: showSentToast,
  [BeaconEvent.SIGN_REQUEST_SUCCESS]: showSignSuccessAlert,
  [BeaconEvent.SIGN_REQUEST_ERROR]: showErrorToast,
  // TODO: ENCRYPTION
  // [BeaconEvent.ENCRYPT_REQUEST_SENT]: showSentToast,
  // [BeaconEvent.ENCRYPT_REQUEST_SUCCESS]: showEncryptSuccessAlert,
  // [BeaconEvent.ENCRYPT_REQUEST_ERROR]: showErrorToast,
  [BeaconEvent.BROADCAST_REQUEST_SENT]: showSentToast,
  [BeaconEvent.BROADCAST_REQUEST_SUCCESS]: showBroadcastSuccessAlert,
  [BeaconEvent.BROADCAST_REQUEST_ERROR]: showErrorToast,
  [BeaconEvent.ACKNOWLEDGE_RECEIVED]: showAcknowledgedToast,
  [BeaconEvent.WAITING_FOR_WALLET_ACK]: emptyHandler(),
  [BeaconEvent.LATE_RESPONSE_RECEIVED]: showLateResponseToast,
  [BeaconEvent.LOCAL_RATE_LIMIT_REACHED]: showRateLimitReached,
  [BeaconEvent.NO_PERMISSIONS]: showNoPermissionAlert,
  [BeaconEvent.ACTIVE_ACCOUNT_SET]: emptyHandler(),
  [BeaconEvent.ACTIVE_TRANSPORT_SET]: emptyHandler(),
  [BeaconEvent.TRANSPORT_STATUS_CHANGED]: emptyHandler(),
  [BeaconEvent.INVALID_ACTIVE_ACCOUNT_STATE]: showInvalidActiveAccountState,
  [BeaconEvent.GENERIC_ERROR]: showGenericErrorAlert,
  [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: showInvalidAccountDeactivated,
  [BeaconEvent.SHOW_PREPARE]: showPrepare,
  [BeaconEvent.HIDE_UI]: hideUI,
  [BeaconEvent.PAIR_INIT]: showPairAlert,
  [BeaconEvent.PAIR_SUCCESS]: showExtensionConnectedAlert,
  [BeaconEvent.RELAYER_ERROR]: showRelayerErrorAlert,
  [BeaconEvent.CHANNEL_CLOSED]: showChannelClosedAlert,
  [BeaconEvent.INTERNAL_ERROR]: showInternalErrorAlert,
  [BeaconEvent.BLOCKCHAIN_REQUEST_SUCCESS]: showBlockchainRequestSuccessToast,
  [BeaconEvent.UNKNOWN]: emptyHandler()
}

// These defaults create toasts. Pairing, modal errors and UI cleanup stay enabled.
const toastEvents: readonly BeaconEvent[] = [
  BeaconEvent.PERMISSION_REQUEST_SENT,
  BeaconEvent.PERMISSION_REQUEST_SUCCESS,
  BeaconEvent.PERMISSION_REQUEST_ERROR,
  BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_SENT,
  BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS,
  BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR,
  BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SENT,
  BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS,
  BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR,
  BeaconEvent.OPERATION_REQUEST_SENT,
  BeaconEvent.OPERATION_REQUEST_SUCCESS,
  BeaconEvent.OPERATION_REQUEST_ERROR,
  BeaconEvent.SIGN_REQUEST_SENT,
  BeaconEvent.SIGN_REQUEST_SUCCESS,
  BeaconEvent.SIGN_REQUEST_ERROR,
  BeaconEvent.BROADCAST_REQUEST_SENT,
  BeaconEvent.BROADCAST_REQUEST_SUCCESS,
  BeaconEvent.BROADCAST_REQUEST_ERROR,
  BeaconEvent.ACKNOWLEDGE_RECEIVED,
  BeaconEvent.LATE_RESPONSE_RECEIVED,
  BeaconEvent.SHOW_PREPARE,
  BeaconEvent.BLOCKCHAIN_REQUEST_SUCCESS
]

/**
 * @internalapi
 *
 * Handles beacon events
 */
export class BeaconEventHandler {
  private readonly subscriptions = new Map<
    BeaconEvent,
    Map<BeaconEventHandlerFunction<never>, () => void>
  >()

  private readonly callbackMap: {
    [key in BeaconEvent]: BeaconEventHandlerFunction<BeaconEventType[key]>[]
  } = {
    [BeaconEvent.PERMISSION_REQUEST_SENT]: [defaultEventCallbacks.PERMISSION_REQUEST_SENT],
    [BeaconEvent.PERMISSION_REQUEST_SUCCESS]: [defaultEventCallbacks.PERMISSION_REQUEST_SUCCESS],
    [BeaconEvent.PERMISSION_REQUEST_ERROR]: [defaultEventCallbacks.PERMISSION_REQUEST_ERROR],
    [BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_SENT]: [
      defaultEventCallbacks.PERMISSION_REQUEST_SENT
    ],
    [BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS]: [
      defaultEventCallbacks.PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS
    ],
    [BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR]: [
      defaultEventCallbacks.PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR
    ],
    [BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SENT]: [
      defaultEventCallbacks.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SENT
    ],
    [BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS]: [
      defaultEventCallbacks.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS
    ],
    [BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR]: [
      defaultEventCallbacks.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR
    ],
    [BeaconEvent.OPERATION_REQUEST_SENT]: [defaultEventCallbacks.OPERATION_REQUEST_SENT],
    [BeaconEvent.OPERATION_REQUEST_SUCCESS]: [defaultEventCallbacks.OPERATION_REQUEST_SUCCESS],
    [BeaconEvent.OPERATION_REQUEST_ERROR]: [defaultEventCallbacks.OPERATION_REQUEST_ERROR],
    [BeaconEvent.SIGN_REQUEST_SENT]: [defaultEventCallbacks.SIGN_REQUEST_SENT],
    [BeaconEvent.SIGN_REQUEST_SUCCESS]: [defaultEventCallbacks.SIGN_REQUEST_SUCCESS],
    [BeaconEvent.SIGN_REQUEST_ERROR]: [defaultEventCallbacks.SIGN_REQUEST_ERROR],
    // TODO: ENCRYPTION
    // [BeaconEvent.ENCRYPT_REQUEST_SENT]: [defaultEventCallbacks.ENCRYPT_REQUEST_SENT],
    // [BeaconEvent.ENCRYPT_REQUEST_SUCCESS]: [defaultEventCallbacks.ENCRYPT_REQUEST_SUCCESS],
    // [BeaconEvent.ENCRYPT_REQUEST_ERROR]: [defaultEventCallbacks.ENCRYPT_REQUEST_ERROR],
    [BeaconEvent.BROADCAST_REQUEST_SENT]: [defaultEventCallbacks.BROADCAST_REQUEST_SENT],
    [BeaconEvent.BROADCAST_REQUEST_SUCCESS]: [defaultEventCallbacks.BROADCAST_REQUEST_SUCCESS],
    [BeaconEvent.BROADCAST_REQUEST_ERROR]: [defaultEventCallbacks.BROADCAST_REQUEST_ERROR],
    [BeaconEvent.BLOCKCHAIN_REQUEST_SUCCESS]: [defaultEventCallbacks.BLOCKCHAIN_REQUEST_SUCCESS],
    [BeaconEvent.ACKNOWLEDGE_RECEIVED]: [defaultEventCallbacks.ACKNOWLEDGE_RECEIVED],
    [BeaconEvent.WAITING_FOR_WALLET_ACK]: [defaultEventCallbacks.WAITING_FOR_WALLET_ACK],
    [BeaconEvent.LATE_RESPONSE_RECEIVED]: [defaultEventCallbacks.LATE_RESPONSE_RECEIVED],
    [BeaconEvent.LOCAL_RATE_LIMIT_REACHED]: [defaultEventCallbacks.LOCAL_RATE_LIMIT_REACHED],
    [BeaconEvent.NO_PERMISSIONS]: [defaultEventCallbacks.NO_PERMISSIONS],
    [BeaconEvent.ACTIVE_ACCOUNT_SET]: [defaultEventCallbacks.ACTIVE_ACCOUNT_SET],
    [BeaconEvent.ACTIVE_TRANSPORT_SET]: [defaultEventCallbacks.ACTIVE_TRANSPORT_SET],
    [BeaconEvent.TRANSPORT_STATUS_CHANGED]: [defaultEventCallbacks.TRANSPORT_STATUS_CHANGED],
    [BeaconEvent.INVALID_ACTIVE_ACCOUNT_STATE]: [
      defaultEventCallbacks.INVALID_ACTIVE_ACCOUNT_STATE
    ],
    [BeaconEvent.GENERIC_ERROR]: [showGenericErrorAlert],
    [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: [defaultEventCallbacks.INVALID_ACCOUNT_DEACTIVATED],
    [BeaconEvent.SHOW_PREPARE]: [defaultEventCallbacks.SHOW_PREPARE],
    [BeaconEvent.HIDE_UI]: [defaultEventCallbacks.HIDE_UI],
    [BeaconEvent.PAIR_INIT]: [defaultEventCallbacks.PAIR_INIT],
    [BeaconEvent.PAIR_SUCCESS]: [defaultEventCallbacks.PAIR_SUCCESS],
    [BeaconEvent.CHANNEL_CLOSED]: [defaultEventCallbacks.CHANNEL_CLOSED],
    [BeaconEvent.INTERNAL_ERROR]: [defaultEventCallbacks.INTERNAL_ERROR],
    [BeaconEvent.RELAYER_ERROR]: [defaultEventCallbacks.RELAYER_ERROR],
    [BeaconEvent.UNKNOWN]: [defaultEventCallbacks.UNKNOWN]
  }
  constructor(
    eventsToOverride: {
      [key in BeaconEvent]?: {
        handler: BeaconEventHandlerFunction<BeaconEventType[key]>
      }
    } = {},
    overrideAll?: boolean,
    uiOptions: DAppClientOptions['uiOptions'] = {}
  ) {
    if (overrideAll) {
      this.setAllHandlers()
    } else if (uiOptions?.enableToasts === false) {
      toastEvents.forEach((event) => this.setEventHandler(event))
    }
    this.overrideDefaults(eventsToOverride)
  }

  /**
   * Subscribe to a beacon event. Duplicate callback references share one subscription.
   * Returns an idempotent cleanup function; either duplicate's cleanup removes the subscription.
   * Cleanup leaves configured defaults and callbacks already being dispatched intact.
   *
   * @param event The event being emitted
   * @param eventCallback The callback that will be invoked
   */
  public async on<K extends BeaconEvent>(
    event: K,
    eventCallback: BeaconEventHandlerFunction<BeaconEventType[K]>
  ): Promise<() => void> {
    let subscriptions = this.subscriptions.get(event)
    if (!subscriptions) {
      subscriptions = new Map()
      this.subscriptions.set(event, subscriptions)
    }
    const existing = subscriptions.get(eventCallback)
    if (existing) {
      return existing
    }

    // A wrapper keeps subscriber cleanup separate from configured default handlers.
    const listener: BeaconEventHandlerFunction<BeaconEventType[K]> = (data, buttons) =>
      eventCallback(data, buttons)
    this.callbackMap[event].push(listener)
    const unsubscribe = (): void => {
      // Duplicate registrations share ownership; stale cleanup cannot remove a new registration.
      if (subscriptions.get(eventCallback) !== unsubscribe) {
        return
      }
      subscriptions.delete(eventCallback)
      const listeners = this.callbackMap[event]
      const index = listeners.indexOf(listener)
      if (index >= 0) {
        listeners.splice(index, 1)
      }
    }
    subscriptions.set(eventCallback, unsubscribe)

    return unsubscribe
  }

  /**
   * Emit a beacon event
   *
   * @param event The event being emitted
   * @param data The data to be emit
   */
  public emit<K extends BeaconEvent>(
    event: K,
    ...args: undefined extends BeaconEventType[K]
      ? [data?: BeaconEventType[K], eventCallback?: AlertButton[]]
      : [data: BeaconEventType[K], eventCallback?: AlertButton[]]
  ): Promise<void>
  public async emit<K extends BeaconEvent>(
    event: K,
    data: BeaconEventType[K],
    eventCallback?: AlertButton[]
  ): Promise<void> {
    const listeners = [...this.callbackMap[event]]
    if (listeners.length > 0) {
      listeners.forEach(async (listener) => {
        try {
          await listener(data, eventCallback)
        } catch (listenerError) {
          logger.error(`error handling event ${event}`, listenerError)
        }
      })
    }
  }

  /**
   * Override beacon event default callbacks. This can be used to disable default alert/toast behaviour
   *
   * @param eventsToOverride An object with the events to override
   */
  private overrideDefaults(eventsToOverride: {
    [key in BeaconEvent]?: {
      handler: BeaconEventHandlerFunction<BeaconEventType[key]>
    }
  }): void {
    Object.values(BeaconEvent).forEach((event) => this.overrideEvent(event, eventsToOverride))
  }

  private overrideEvent<K extends BeaconEvent>(
    event: K,
    overrides: {
      [key in BeaconEvent]?: { handler: BeaconEventHandlerFunction<BeaconEventType[key]> }
    }
  ): void {
    const override = overrides[event]
    if (override) {
      const listeners = this.callbackMap[event]
      listeners.splice(0, listeners.length, override.handler)
    }
  }

  /**
   * Set all event callbacks to a specific handler.
   */
  private setAllHandlers(handler?: BeaconEventHandlerFunction): void {
    Object.values(BeaconEvent).forEach((event) => this.setEventHandler(event, handler))
  }

  private setEventHandler<K extends BeaconEvent>(
    event: K,
    handler?: BeaconEventHandlerFunction
  ): void {
    const listeners = this.callbackMap[event]
    listeners.splice(0, listeners.length, handler ?? ((...data) => logger.log(event, ...data)))
  }
}
