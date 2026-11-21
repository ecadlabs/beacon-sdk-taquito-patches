import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconMessageType } from '../types/beacon/BeaconMessageType'
import { ErrorResponse } from '../types/beacon/messages/ErrorResponse'
import { ErrorOrigin } from '../types/ErrorOrigin'
import { RequestErrorResponse } from '../types/RequestErrorResponse'
import { TezosRpcError } from '../types/TezosRpcError'
import { BeaconError } from './BeaconError'

export const isBeaconError = (value: unknown): value is BeaconError => value instanceof BeaconError

export const isErrorOrigin = (value: unknown): value is ErrorOrigin =>
  value === 'wallet' || value === 'local'

export const isErrorResponse = (value: unknown): value is ErrorResponse => {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !('type' in value) ||
      value.type !== BeaconMessageType.Error ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !('version' in value) ||
      typeof value.version !== 'string' ||
      !('senderId' in value) ||
      typeof value.senderId !== 'string' ||
      !('errorType' in value)
    ) {
      return false
    }
    const errorType = value.errorType

    return Object.values(BeaconErrorType).some((candidate) => candidate === errorType)
  } catch {
    return false
  }
}

export const isRequestErrorResponse = (value: unknown): value is RequestErrorResponse => {
  try {
    if (!isErrorResponse(value)) {
      return false
    }
    const origin = 'errorOrigin' in value ? value.errorOrigin : undefined

    return origin === undefined || isErrorOrigin(origin)
  } catch {
    return false
  }
}

export const isTezosRpcError = (value: unknown): value is TezosRpcError =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'kind' in value &&
  typeof value.kind === 'string' &&
  value.kind.length > 0 &&
  'id' in value &&
  typeof value.id === 'string' &&
  value.id.length > 0
