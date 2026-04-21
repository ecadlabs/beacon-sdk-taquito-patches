import { PermissionResponse } from './messages/PermissionResponse'
import { OperationResponse } from './messages/OperationResponse'
import { SignPayloadResponse } from './messages/SignPayloadResponse'
import { BroadcastResponse } from './messages/BroadcastResponse'
// EncryptPayloadResponse
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
