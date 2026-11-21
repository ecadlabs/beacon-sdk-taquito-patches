import {
  BeaconErrorType,
  BeaconMessageType,
  isBeaconError,
  isRequestErrorResponse,
  RequestErrorResponse
} from '@ecadlabs/beacon-types'
import {
  BeaconEvent,
  type BeaconEventType,
  type LateErrorResponseInfo,
  toBeaconError
} from '@ecadlabs/beacon-dapp'

export const explicitUndefinedOrigin = {
  type: BeaconMessageType.Error,
  errorType: BeaconErrorType.NOT_GRANTED_ERROR,
  id: 'request',
  version: '2',
  senderId: 'wallet',
  errorOrigin: undefined
} satisfies RequestErrorResponse

export function requestOrigin(value: unknown): string | undefined {
  if (isRequestErrorResponse(value) && 'errorOrigin' in value) {
    // @ts-expect-error Presence does not exclude an explicitly undefined origin.
    value.errorOrigin.toUpperCase()
    return value.errorOrigin?.toUpperCase()
  }

  return undefined
}

export function exceptionOrigin(value: unknown): string | undefined {
  if (isBeaconError(value) && 'errorOrigin' in value) {
    // @ts-expect-error BeaconError instances also retain an explicitly undefined origin.
    value.errorOrigin.toUpperCase()
    return value.errorOrigin?.toUpperCase()
  }

  return undefined
}

declare const handlers: Record<BeaconErrorType, () => void>
declare const event: BeaconEventType[BeaconEvent.OPERATION_REQUEST_ERROR]
declare const late: LateErrorResponseInfo

// Wallet events retain future codes, so enum-indexed handlers need narrowing first.
// @ts-expect-error A raw wallet code is not necessarily a known BeaconErrorType.
handlers[event.errorResponse.errorType]()
if (isRequestErrorResponse(event.errorResponse)) {
  handlers[event.errorResponse.errorType]()
}
handlers[toBeaconError(event.errorResponse).errorType]()
// The derived late error is normalized; its raw message remains available separately.
handlers[late.error.errorType]()
