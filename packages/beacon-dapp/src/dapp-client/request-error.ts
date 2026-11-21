import {
  BeaconBaseMessage,
  BeaconErrorType,
  BeaconMessage,
  BeaconMessageType,
  BeaconMessageWrapper,
  BlockchainMessage,
  ConnectionContext,
  ErrorResponse,
  WalletInfo,
  ErrorOrigin,
  RequestErrorResponse,
  TezosRpcError,
  isErrorOrigin,
  isErrorResponse,
  isRequestErrorResponse,
  isTezosRpcError,
  BeaconError,
  isBeaconError,
  getError
} from '@ecadlabs/beacon-types'

export type { ErrorOrigin, RequestErrorResponse, TezosRpcError }
export {
  isErrorOrigin,
  isErrorResponse,
  isRequestErrorResponse,
  isTezosRpcError,
  BeaconError,
  isBeaconError
}

const isKnownErrorType = (value: unknown): value is BeaconErrorType =>
  Object.values(BeaconErrorType).some((candidate) => candidate === value)

export const toBeaconError = (error: WireRequestErrorResponse): BeaconError =>
  getError(
    isKnownErrorType(error.errorType) ? error.errorType : BeaconErrorType.UNKNOWN_ERROR,
    error.errorData,
    {
      id: error.id,
      version: error.version,
      senderId: error.senderId,
      errorOrigin: error.errorOrigin
    }
  )

/** Keeps request-error events plain while preserving existing wire error objects. */
export const errorEventResponse = (error: WireRequestErrorResponse): WireRequestErrorResponse =>
  isBeaconError(error)
    ? {
        id: error.id,
        type: BeaconMessageType.Error,
        errorType: error.errorType,
        version: error.version,
        senderId: error.senderId,
        ...(error.errorOrigin ? { errorOrigin: error.errorOrigin } : {}),
        ...(error.errorData !== undefined ? { errorData: error.errorData } : {})
      }
    : error

/**
 * An error as a wallet may put it on the wire. Responses are not validated before routing, and
 * wallets do not always fill `errorType`.
 *
 * @category DApp
 */
export interface WireErrorPayload {
  type: BeaconMessageType.Error
  errorType?: unknown
  errorData?: unknown
  errorOrigin?: unknown
}

/** A V2 error message as a wallet may send it. @category DApp */
export interface WireErrorMessage extends WireErrorPayload {
  id: string
  version: string
  senderId: string
}

/**
 * An attributed plain request-error event. Wallets can send codes unknown to this SDK.
 * Use isRequestErrorResponse before indexing by BeaconErrorType, or toBeaconError to normalize.
 * @category DApp
 */
export type WireRequestErrorResponse = Omit<RequestErrorResponse, 'errorType'> & {
  errorType: string
}

/** The message inside a V3 envelope. Its shape depends on the blockchain. @category DApp */
export interface V3ResponsePayload {
  type: unknown
}

/**
 * A response as it reaches the dApp: V2 wire headers or a V3 envelope.
 * Payload fields remain unverified until the relevant consumer narrows them. Older wallets
 * can omit response fields such as signingType; routing must not invent those fields.
 * @category DApp
 */
export type ResponseMessage =
  | BeaconMessage
  | BeaconBaseMessage
  | WireErrorMessage
  | BeaconMessageWrapper<BeaconBaseMessage | BlockchainMessage | V3ResponsePayload>

/**
 * The answer a response carries: the V2 message itself, or the message inside a V3 envelope.
 *
 * @category DApp
 */
export type ResponseOutput =
  BeaconMessage | WireErrorMessage | BeaconBaseMessage | BlockchainMessage | V3ResponsePayload

interface LateResponseBase {
  requestId: string
  requestType: BeaconMessageType
  /**
   * The response as received, for debugging. An error inside it carries the same
   * `errorOrigin` as `error`, so a wallet cannot use this field to pass its error off as local.
   */
  message: ResponseMessage
  connectionInfo: ConnectionContext
  walletInfo: WalletInfo
}

/**
 * A late answer that is not an error.
 *
 * @category DApp
 */
export interface LateSuccessResponseInfo extends LateResponseBase {
  kind: 'success'
  /** What the request method would have returned: the V2 message, or the V3 inner message. */
  output: ResponseOutput
  /**
   * Set when the answer is an operation or broadcast response, or a V3 blockchain response,
   * with a non-empty transaction hash. The operation may already be on chain.
   */
  transactionHash?: string
}

/**
 * A late answer that is an error. `error` uses a known code as a timely public rejection would.
 * Unfamiliar codes become UNKNOWN_ERROR here and remain unchanged in `message`.
 *
 * @category DApp
 */
export interface LateErrorResponseInfo extends LateResponseBase {
  kind: 'error'
  error: RequestErrorResponse
}

/**
 * Payload of the LATE_RESPONSE_RECEIVED event: a wallet answer for a request whose deadline had
 * already fired. The caller already received a PEER_UNREACHABLE rejection.
 *
 * @category DApp
 */
export type LateResponseInfo = LateSuccessResponseInfo | LateErrorResponseInfo

/** The parts of the late event that come from the response itself. */
export type LateResponseClassification =
  | Pick<LateSuccessResponseInfo, 'kind' | 'message' | 'output' | 'transactionHash'>
  | Pick<LateErrorResponseInfo, 'kind' | 'message' | 'error'>

/** Routing keys on the message type alone; wallets do not always fill `errorType`. */
const isErrorMessage = (value: unknown): value is { type: BeaconMessageType.Error } =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'type' in value &&
  value.type === BeaconMessageType.Error

// Only a version 3 envelope wraps its payload; a V2 message may carry its own `message` field.
const isV3Envelope = (
  message: ResponseMessage
): message is BeaconMessageWrapper<BeaconBaseMessage | BlockchainMessage | V3ResponsePayload> =>
  'message' in message && message.version === '3'

export const responseOutput = (message: ResponseMessage): ResponseOutput =>
  isV3Envelope(message) ? message.message : message

// A wallet may send an error type this SDK does not know. It passes through, as it always has,
// and getError maps it to UnknownBeaconError. An empty one says nothing and becomes UNKNOWN_ERROR.
const isErrorTypeString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

// Preparation failures can contain accessors. Classify only own data fields before
// handing the diagnostic to a channel, and leave unreadable values to its safe fallback.
export const readErrorResponse = (
  value: unknown
): (WireErrorMessage & { errorOrigin: ErrorOrigin; errorType: string }) | undefined => {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    const readData = (key: string): unknown => {
      const field = Object.getOwnPropertyDescriptor(value, key)
      if (field && !('value' in field)) {
        throw new TypeError('Error response fields must be data properties')
      }

      return field?.value
    }
    if (readData('type') !== BeaconMessageType.Error) {
      return undefined
    }
    const id = readData('id')
    const senderId = readData('senderId')
    const version = readData('version')
    if (typeof id !== 'string' || typeof senderId !== 'string' || typeof version !== 'string') {
      return undefined
    }

    const errorType = readData('errorType')
    const errorData = readData('errorData')
    const origin = readData('errorOrigin')
    const diagnostic = !isErrorTypeString(errorType) && errorData === undefined ? value : errorData

    return {
      type: BeaconMessageType.Error,
      id,
      senderId,
      version,
      errorType: isErrorTypeString(errorType) ? errorType : BeaconErrorType.UNKNOWN_ERROR,
      errorOrigin: isErrorOrigin(origin) ? origin : 'local',
      ...(diagnostic !== undefined ? { errorData: diagnostic } : {})
    }
  } catch {
    return undefined
  }
}

// Only public typed rejections need a code from the SDK's known enum.
export const normalizeErrorResponse = (value: unknown): RequestErrorResponse | undefined => {
  const response = readErrorResponse(value)

  return response
    ? {
        ...response,
        errorType: isKnownErrorType(response.errorType)
          ? response.errorType
          : BeaconErrorType.UNKNOWN_ERROR
      }
    : undefined
}

export const diagnosticMessage = (
  value: unknown,
  source: 'error' | 'diagnostic'
): string | undefined => {
  try {
    if (source === 'error' && !(value instanceof Error)) {
      return undefined
    }
    const message =
      typeof value === 'object' && value !== null && 'message' in value ? value.message : undefined

    return typeof message === 'string' ? message : undefined
  } catch {
    return undefined
  }
}

export const localError = (error: ErrorResponse): RequestErrorResponse => ({
  ...error,
  errorOrigin: 'local'
})

/**
 * Builds an attributed wire error from an error that arrived on the response path,
 * or returns undefined when the response is not an error.
 *
 * Wallet messages and errors forwarded by the leader tab arrive on the same path, so the
 * message cannot be trusted to say where it came from. A claimed `errorOrigin` is kept only
 * when `trustClaimedOrigin` is set: in a follower tab, whose leader stamps what it forwards,
 * and for messages the WalletConnect adapter built itself. Anything else came from the wallet.
 */
export const toRequestError = (
  message: ResponseMessage,
  trustClaimedOrigin: boolean
): WireRequestErrorResponse | undefined => {
  const answer: unknown = responseOutput(message)
  if (!isErrorMessage(answer)) {
    return undefined
  }
  const errorType = 'errorType' in answer ? answer.errorType : undefined
  const claimed = 'errorOrigin' in answer ? answer.errorOrigin : undefined

  return {
    ...answer,
    id: message.id,
    version: message.version,
    senderId: message.senderId ?? '',
    type: BeaconMessageType.Error,
    errorType: isErrorTypeString(errorType) ? errorType : BeaconErrorType.UNKNOWN_ERROR,
    errorOrigin: trustClaimedOrigin && isErrorOrigin(claimed) ? claimed : 'wallet'
  }
}

/**
 * Sets `errorOrigin` on the error inside a response and leaves anything else unchanged. Used
 * when the leader forwards a response, and for the raw message in the late event.
 */
export const stampErrorOrigin = <M extends ResponseMessage>(
  message: M,
  trustClaimedOrigin: boolean
): M => {
  const error = toRequestError(message, trustClaimedOrigin)
  if (!error) {
    return message
  }
  // Spread from a value: ErrorResponse does not declare errorOrigin, the wire message has it.
  const stamp = { errorOrigin: error.errorOrigin }
  if (isV3Envelope(message)) {
    return { ...message, senderId: error.senderId, message: { ...message.message, ...stamp } }
  }

  return { ...message, senderId: error.senderId, ...stamp }
}

const hashOf = (value: unknown): string | undefined =>
  typeof value === 'object' &&
  value !== null &&
  'transactionHash' in value &&
  typeof value.transactionHash === 'string' &&
  value.transactionHash.length > 0
    ? value.transactionHash
    : undefined

/** The transaction hash of a response that submitted something. V3 blockchainData is untyped. */
const transactionHashOf = (message: ResponseMessage): string | undefined => {
  if (isV3Envelope(message)) {
    const inner: unknown = message.message

    return typeof inner === 'object' &&
      inner !== null &&
      'type' in inner &&
      inner.type === BeaconMessageType.BlockchainResponse &&
      'blockchainData' in inner
      ? hashOf(inner.blockchainData)
      : undefined
  }

  return message.type === BeaconMessageType.OperationResponse ||
    message.type === BeaconMessageType.BroadcastResponse
    ? hashOf(message)
    : undefined
}

/** Normalises a late response the same way the request methods treat a timely one. */
export const classifyLateResponse = (
  message: ResponseMessage,
  trustClaimedOrigin: boolean
): LateResponseClassification => {
  const error = toRequestError(message, trustClaimedOrigin)
  if (error) {
    return {
      kind: 'error',
      message: stampErrorOrigin(message, trustClaimedOrigin),
      error: {
        ...error,
        errorType: isKnownErrorType(error.errorType)
          ? error.errorType
          : BeaconErrorType.UNKNOWN_ERROR
      }
    }
  }

  return {
    kind: 'success',
    message,
    output: responseOutput(message),
    transactionHash: transactionHashOf(message)
  }
}
