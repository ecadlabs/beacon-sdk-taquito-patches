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
  TransportType
} from '@ecadlabs/beacon-types'
import {
  UnknownBeaconError,
  Transport,
  Logger,
  getError
  // EncryptPayloadResponseOutput,
  // EncryptionOperation
} from '@ecadlabs/beacon-core'
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
  /** A wallet answered a request after its deadline fired and the caller got PEER_UNREACHABLE. */
  LATE_RESPONSE_RECEIVED = 'LATE_RESPONSE_RECEIVED',

  LOCAL_RATE_LIMIT_REACHED = 'LOCAL_RATE_LIMIT_REACHED',

  NO_PERMISSIONS = 'NO_PERMISSIONS',

  ACTIVE_ACCOUNT_SET = 'ACTIVE_ACCOUNT_SET',

  ACTIVE_TRANSPORT_SET = 'ACTIVE_TRANSPORT_SET',

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
export interface BeaconEventType {
  [BeaconEvent.PERMISSION_REQUEST_SENT]: RequestSentInfo
  [BeaconEvent.PERMISSION_REQUEST_SUCCESS]: RequestResponseInfo & {
    account: AccountInfo
    output: PermissionResponseOutput
    blockExplorer: BlockExplorer
    connectionContext: ConnectionContext
    walletInfo: WalletInfo
  }
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
  [BeaconEvent.BROADCAST_REQUEST_ERROR]: RequestResponseInfo & {
    errorResponse: RequestErrorResponse
    walletInfo: WalletInfo
  }
  [BeaconEvent.ACKNOWLEDGE_RECEIVED]: AcknowledgeInfo
  [BeaconEvent.LOCAL_RATE_LIMIT_REACHED]: undefined
  [BeaconEvent.NO_PERMISSIONS]: undefined
  [BeaconEvent.ACTIVE_ACCOUNT_SET]: AccountInfo | undefined
  [BeaconEvent.ACTIVE_TRANSPORT_SET]: Transport
  [BeaconEvent.INVALID_ACTIVE_ACCOUNT_STATE]: undefined
  [BeaconEvent.GENERIC_ERROR]: string
  [BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]: InvalidAccountDeactivatedEvent | undefined
  [BeaconEvent.SHOW_PREPARE]: { walletInfo?: WalletInfo }
  [BeaconEvent.HIDE_UI]: ('alert' | 'toast')[] | undefined
  [BeaconEvent.PAIR_INIT]: {
    p2pPeerInfo: Promise<string>
    postmessagePeerInfo: Promise<string>
    walletConnectPeerInfo: PromiseLike<string>
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
  [BeaconEvent.CHANNEL_CLOSED]: string
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
    text: `No answer from your wallet received yet. Please make sure the wallet is open.`,
    isBold: true
  })
  actions.push({
    text: 'Wallet not receiving request?',
    actionText: 'Reset Connection',
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
    body: `Request sent to\u00A0 {{wallet}}`,
    walletInfo: data.walletInfo,
    state: 'loading',
    timer: isMobileOS(window) ? SUCCESS_TIMER : 0,
    actions,
    openWalletAction
  })
}

const showAcknowledgedToast = async (data: AcknowledgeInfo): Promise<void> => {
  openToast({
    body: 'Awaiting confirmation in\u00A0 {{wallet}}',
    state: 'acknowledge',
    walletInfo: data.walletInfo
  })
}

const showPrepare = async (data: { walletInfo?: WalletInfo }): Promise<void> => {
  const text = data.walletInfo
    ? `Preparing Request for\u00A0 {{wallet}}...`
    : 'Preparing Request...'
  openToast({
    body: text,
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
    title: 'No Permission',
    body: 'Please allow the wallet to handle this type of request.'
  })
}

/**
 * Show an "Invalid state" alert
 */
const showInvalidActiveAccountState = async (): Promise<void> => {
  openAlert({
    title: 'Invalid state',
    body: `An active account has been received, but no active subscription was found for BeaconEvent.ACTIVE_ACCOUNT_SET.
    For more information, visit: https://docs.walletbeacon.io/guides/migration-guide`
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

  await openAlert({
    title: 'Error',
    body: `Your session has expired. Please pair with your wallet again.`
  })
}

/**
 * Show an "Invalid state" alert
 */
const showGenericErrorAlert = async (errorMessage: string): Promise<void> => {
  openAlert({
    title: `${errorMessage}`,
    body: 'Please try again.'
  })
}

/**
 * An error the dApp produced itself (timeout, abort) did not come from the wallet, so the
 * toast must not say the wallet returned it.
 */
const errorToastBody = (errorType: BeaconErrorType, local: boolean): string => {
  if (!local) {
    return `{{wallet}}\u00A0 has returned an error`
  }
  switch (errorType) {
    case BeaconErrorType.PEER_UNREACHABLE:
      return `{{wallet}}\u00A0 did not respond`
    case BeaconErrorType.ABORTED_ERROR:
      return `{{wallet}}\u00A0 request was cancelled`
    default:
      return `{{wallet}}\u00A0 request failed`
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
  const error = response.errorResponse.errorType
    ? getError(response.errorResponse.errorType, response.errorResponse.errorData)
    : new UnknownBeaconError()
  const local = response.errorResponse.errorOrigin === 'local'

  const actions: ToastAction[] = [
    {
      text: error.title,
      isBold: true
    }
  ]

  // A local timeout is not an answer: the wallet may still approve the request, so the user
  // needs the explanation before deciding whether to retry.
  if (local && response.errorResponse.errorType === BeaconErrorType.PEER_UNREACHABLE) {
    actions.push({ text: error.description })
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
      contractMessage ? { text: contractMessage, isBold: true } : { text: error.description }
    )

    actions.push({
      text: '',
      actionText: 'Show Details',
      actionCallback: async (): Promise<void> => {
        closeToast()
        openAlert({
          title: error.title,
          // eslint-disable-next-line @typescript-eslint/unbound-method
          body: error.fullDescription.description,
          data: error.fullDescription.data,
          buttons
        })
      }
    })
  }

  openToast({
    body: errorToastBody(response.errorResponse.errorType, local),
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
    title: 'Error',
    body: 'Rate limit reached. Please slow down',
    buttons: [{ text: 'Done', style: 'outline' }],
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
    title: 'Error',
    body: `Failed to connect to the relayer. Please check that your system time is synchronized with the current time and reload the page.`,
    buttons: [{ text: 'Done', style: 'outline' }],
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
    body: broadcast
      ? `{{wallet}}\u00A0 broadcast the transaction after the request timed out`
      : `{{wallet}}\u00A0 submitted the operation after the request timed out`,
    state: 'finished',
    walletInfo: data.walletInfo,
    actions: [
      {
        text: shortenString(hash),
        isBold: true,
        actionText: 'Copy to clipboard',
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

  buttons.push({ text: 'Done', style: 'outline' })

  const alertConfig: AlertConfig = {
    title: 'Internal Error',
    body: data.text,
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
    title: 'Choose your preferred wallet',
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
  const { output } = data

  const actions: any[] = [
    {
      text: 'Address',
      actionText: shortenString(output.address),
      isBold: true
    }
  ]

  // V3 accounts carry chain-specific permissions rather than the Tezos network/scope schema.
  if (!('chainData' in data.account)) {
    actions.push({
      text: 'Network',
      actionText: `${output.network.type}`
    })
    actions.push({
      text: 'Permissions',
      actionText: output.scopes.join(', ')
    })
  }

  openToast({
    body: `{{wallet}}\u00A0 has granted permission`,
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
    body: `{{wallet}}\u00A0 has ${output.isAccepted ? 'accepted' : 'refused'} the challenge`,
    timer: SUCCESS_TIMER,
    walletInfo: data.walletInfo,
    state: 'finished',
    actions: output.isAccepted
      ? [
          {
            text: `Payload hash: ${output.payloadHash}`,
            actionText: 'Copy to clipboard',
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
    body: !output.errorMessage
      ? `{{wallet}}\u00A0 has returned the list of operation`
      : `{{wallet}}\u00A0 has returned an error`,
    timer: SUCCESS_TIMER,
    walletInfo: data.walletInfo,
    state: 'finished',
    actions: !output.errorMessage
      ? [
          {
            text: 'Operation list',
            actionText: 'Copy to clipboard',
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
      : [{ text: 'Error message', actionText: output.errorMessage }]
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
    body: `{{wallet}}\u00A0 successfully submitted operation`,
    timer: SUCCESS_TIMER,
    state: 'finished',
    walletInfo: data.walletInfo,
    actions: [
      {
        text: shortenString(output.transactionHash),
        isBold: true,
        actionText: `Open Blockexplorer`,
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
    body: `{{wallet}}\u00A0 successfully signed payload`,
    timer: SUCCESS_TIMER,
    state: 'finished',
    walletInfo: data.walletInfo,
    actions: [
      {
        text: `Signature: ${shortenString(output.signature)}`,
        actionText: 'Copy to clipboard',
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
    body: `{{wallet}}\u00A0 request successfully executed`,
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
    body: `{{wallet}}\u00A0 successfully injected operation`,
    timer: SUCCESS_TIMER,
    state: 'finished',
    walletInfo: data.walletInfo,
    actions: [
      {
        text: shortenString(output.transactionHash),
        isBold: true,
        actionText: `Open Blockexplorer`,
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
  [BeaconEvent.LATE_RESPONSE_RECEIVED]: showLateResponseToast,
  [BeaconEvent.LOCAL_RATE_LIMIT_REACHED]: showRateLimitReached,
  [BeaconEvent.NO_PERMISSIONS]: showNoPermissionAlert,
  [BeaconEvent.ACTIVE_ACCOUNT_SET]: emptyHandler(),
  [BeaconEvent.ACTIVE_TRANSPORT_SET]: emptyHandler(),
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
    [key in BeaconEvent]: BeaconEventHandlerFunction<any>[] // TODO: Fix type
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
    [BeaconEvent.LATE_RESPONSE_RECEIVED]: [defaultEventCallbacks.LATE_RESPONSE_RECEIVED],
    [BeaconEvent.LOCAL_RATE_LIMIT_REACHED]: [defaultEventCallbacks.LOCAL_RATE_LIMIT_REACHED],
    [BeaconEvent.NO_PERMISSIONS]: [defaultEventCallbacks.NO_PERMISSIONS],
    [BeaconEvent.ACTIVE_ACCOUNT_SET]: [defaultEventCallbacks.ACTIVE_ACCOUNT_SET],
    [BeaconEvent.ACTIVE_TRANSPORT_SET]: [defaultEventCallbacks.ACTIVE_TRANSPORT_SET],
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
    overrideAll?: boolean
  ) {
    if (overrideAll) {
      this.setAllHandlers()
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
      this.callbackMap[event] = this.callbackMap[event].filter((entry) => entry !== listener)
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
  public async emit<K extends BeaconEvent>(
    event: K,
    data?: BeaconEventType[K],
    eventCallback?: AlertButton[]
  ): Promise<void> {
    const listeners = this.callbackMap[event]
    if (listeners && listeners.length > 0) {
      listeners.forEach(async (listener: BeaconEventHandlerFunction) => {
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
    Object.keys(eventsToOverride).forEach((untypedEvent: string) => {
      const eventType: BeaconEvent = untypedEvent as BeaconEvent
      const event = eventsToOverride[eventType]
      if (event) {
        this.callbackMap[eventType] = [event.handler]
      }
    })
  }

  /**
   * Set all event callbacks to a specific handler.
   */
  private setAllHandlers(handler?: BeaconEventHandlerFunction): void {
    Object.keys(this.callbackMap).forEach((untypedEvent: string) => {
      const eventType: BeaconEvent = untypedEvent as BeaconEvent
      this.callbackMap[eventType] = []
      if (handler) {
        this.callbackMap[eventType].push(handler)
      } else {
        this.callbackMap[eventType].push((...data) => {
          logger.log(untypedEvent, ...data)
        })
      }
    })
  }
}
