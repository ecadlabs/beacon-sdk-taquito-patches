import { BeaconErrorType, TezosRpcError, isTezosRpcError } from '@ecadlabs/beacon-types'

export interface BeaconJsonRpcErrorData {
  beaconErrorType: BeaconErrorType
  errorData?: TezosRpcError[]
}

export interface BeaconJsonRpcError {
  code: number
  message: string
  data?: string
}

export interface ParsedBeaconJsonRpcError {
  errorType: BeaconErrorType
  errorData?: TezosRpcError[]
}

export const BEACON_JSON_RPC_ERROR_CODES: Record<BeaconErrorType, number> = {
  [BeaconErrorType.BROADCAST_ERROR]: -32001,
  [BeaconErrorType.NETWORK_NOT_SUPPORTED]: -32002,
  [BeaconErrorType.NO_ADDRESS_ERROR]: -32003,
  [BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR]: -32004,
  [BeaconErrorType.NOT_GRANTED_ERROR]: -32005,
  [BeaconErrorType.PARAMETERS_INVALID_ERROR]: -32006,
  [BeaconErrorType.TOO_MANY_OPERATIONS]: -32007,
  [BeaconErrorType.TRANSACTION_INVALID_ERROR]: -32008,
  [BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED]: -32009,
  [BeaconErrorType.ABORTED_ERROR]: -32010,
  [BeaconErrorType.PEER_UNREACHABLE]: -32011,
  [BeaconErrorType.UNKNOWN_ERROR]: -32012
}

const BEACON_ERROR_MESSAGES: Record<BeaconErrorType, string> = {
  [BeaconErrorType.BROADCAST_ERROR]: 'The transaction could not be broadcast.',
  [BeaconErrorType.NETWORK_NOT_SUPPORTED]: 'The requested network is not supported by the wallet.',
  [BeaconErrorType.NO_ADDRESS_ERROR]: 'No matching address found in the wallet.',
  [BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR]: 'No matching private key found in the wallet.',
  [BeaconErrorType.NOT_GRANTED_ERROR]: 'The requested permission or signature was not granted.',
  [BeaconErrorType.PARAMETERS_INVALID_ERROR]: 'The operation parameters are invalid.',
  [BeaconErrorType.TOO_MANY_OPERATIONS]: 'Too many operations in a single request.',
  [BeaconErrorType.TRANSACTION_INVALID_ERROR]: 'The transaction is invalid or rejected by the node.',
  [BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED]: 'The requested signing type is not supported.',
  [BeaconErrorType.ABORTED_ERROR]: 'The request was aborted by the user or wallet.',
  [BeaconErrorType.PEER_UNREACHABLE]: 'The wallet peer is unreachable.',
  [BeaconErrorType.UNKNOWN_ERROR]: 'An unknown error occurred.'
}

const CODE_TO_BEACON_ERROR_TYPE = new Map<number, BeaconErrorType>(
  Object.entries(BEACON_JSON_RPC_ERROR_CODES).map(([errorType, code]) => [
    code,
    errorType as BeaconErrorType
  ])
)

const VALID_BEACON_ERROR_TYPES = new Set<string>(Object.values(BeaconErrorType))

const isBeaconErrorType = (value: unknown): value is BeaconErrorType =>
  typeof value === 'string' && VALID_BEACON_ERROR_TYPES.has(value)

const extractValidTezosRpcErrors = (value: unknown): TezosRpcError[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }
  const filtered = value.filter(isTezosRpcError)

  return filtered.length > 0 ? filtered : undefined
}

export const serializeBeaconErrorToJsonRpcError = (
  errorType: BeaconErrorType,
  errorData?: unknown
): BeaconJsonRpcError => {
  const validErrorData = extractValidTezosRpcErrors(errorData)
  const payload: BeaconJsonRpcErrorData = validErrorData
    ? { beaconErrorType: errorType, errorData: validErrorData }
    : { beaconErrorType: errorType }

  return {
    code: BEACON_JSON_RPC_ERROR_CODES[errorType],
    message: BEACON_ERROR_MESSAGES[errorType],
    data: JSON.stringify(payload)
  }
}

const parseRawErrorData = (rawData: unknown): unknown => {
  if (typeof rawData !== 'string') {
    return rawData
  }
  try {
    return JSON.parse(rawData) as unknown
  } catch {
    return undefined
  }
}

export const parseJsonRpcErrorToBeaconError = (error: unknown): ParsedBeaconJsonRpcError => {
  if (typeof error !== 'object' || error === null) {
    return { errorType: BeaconErrorType.ABORTED_ERROR }
  }

  let errorType: BeaconErrorType | undefined
  let errorData: TezosRpcError[] | undefined

  const parsedData = 'data' in error ? parseRawErrorData(error.data) : undefined
  if (typeof parsedData === 'object' && parsedData !== null) {
    if ('beaconErrorType' in parsedData && isBeaconErrorType(parsedData.beaconErrorType)) {
      errorType = parsedData.beaconErrorType
    }
    if ('errorData' in parsedData) {
      errorData = extractValidTezosRpcErrors(parsedData.errorData)
    }
  }

  if (!errorType && 'code' in error && typeof error.code === 'number') {
    errorType = CODE_TO_BEACON_ERROR_TYPE.get(error.code)
  }

  return {
    errorType: errorType ?? BeaconErrorType.ABORTED_ERROR,
    ...(errorData !== undefined ? { errorData } : {})
  }
}
