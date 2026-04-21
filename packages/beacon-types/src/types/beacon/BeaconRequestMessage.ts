import { PermissionRequest } from './messages/PermissionRequest'
import { OperationRequest } from './messages/OperationRequest'
import { SignPayloadRequest } from './messages/SignPayloadRequest'
import { BroadcastRequest } from './messages/BroadcastRequest'
import { ProofOfEventChallengeRequest } from './messages/ProofOfEventChallengeRequest'
import { SimulatedProofOfEventChallengeRequest } from './messages/SimulatedProofOfEventChallengeRequest'
// EncryptPayloadRequest

/**
 * @internalapi
 */
export type BeaconRequestMessage =
  | PermissionRequest
  | OperationRequest
  | SignPayloadRequest
  // | EncryptPayloadRequest
  | BroadcastRequest
  | ProofOfEventChallengeRequest
  | SimulatedProofOfEventChallengeRequest
