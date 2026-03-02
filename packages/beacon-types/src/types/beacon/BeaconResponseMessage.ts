import {
  PermissionResponse,
  OperationResponse,
  SignPayloadResponse,
  BroadcastResponse
  // EncryptPayloadResponse
} from '@ecadlabs/beacon-types'
import { ErrorResponse } from './messages/ErrorResponse'

/**
 * @internalapi
 */
export type BeaconResponseMessage =
  | PermissionResponse
  | OperationResponse
  | SignPayloadResponse
  // | EncryptPayloadResponse
  | BroadcastResponse
  | ErrorResponse
