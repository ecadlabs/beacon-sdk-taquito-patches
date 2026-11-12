import { BeaconMessageType } from '../types/beacon/BeaconMessageType'
import { ErrorResponse } from '../types/beacon/messages/ErrorResponse'
import { ErrorOrigin } from '../types/ErrorOrigin'
import { RequestErrorResponse } from '../types/RequestErrorResponse'
import { TezosRpcError } from '../types/TezosRpcError'
import { BeaconError } from './BeaconError'

export const isBeaconError = (value: unknown): value is BeaconError =>
  value instanceof BeaconError

export const isErrorOrigin = (value: unknown): value is ErrorOrigin =>
  value === 'wallet' || value === 'local'

export const isErrorResponse = (value: unknown): value is ErrorResponse =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  value.type === BeaconMessageType.Error &&
  'errorType' in value &&
  typeof value.errorType === 'string'

export const isRequestErrorResponse = (value: unknown): value is RequestErrorResponse => {
  if (!isErrorResponse(value)) {
    return false
  }

  return !('errorOrigin' in value) || value.errorOrigin === undefined || isErrorOrigin(value.errorOrigin)
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
