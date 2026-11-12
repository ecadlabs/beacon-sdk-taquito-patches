import {
  BeaconErrorType,
  BeaconMessageType,
  ErrorResponseInput
} from '@ecadlabs/beacon-types'

export const createErrorResponseInput = (
  request: { id: string } | string,
  errorType: BeaconErrorType,
  errorData?: unknown
): ErrorResponseInput => {
  const id = typeof request === 'string' ? request : request.id
  const result: ErrorResponseInput = {
    type: BeaconMessageType.Error,
    id,
    errorType
  }
  if (errorData !== undefined) {
    result.errorData = errorData
  }

  return result
}
