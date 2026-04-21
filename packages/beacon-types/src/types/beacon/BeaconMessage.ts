import { PermissionResponse } from './messages/PermissionResponse'
import { PermissionRequest } from './messages/PermissionRequest'
import { OperationRequest } from './messages/OperationRequest'
import { OperationResponse } from './messages/OperationResponse'
import { SignPayloadRequest } from './messages/SignPayloadRequest'
import { SignPayloadResponse } from './messages/SignPayloadResponse'
import { BroadcastRequest } from './messages/BroadcastRequest'
import { BroadcastResponse } from './messages/BroadcastResponse'
import { AcknowledgeResponse } from './messages/AcknowledgeResponse'
import { DisconnectMessage } from './messages/DisconnectMessage'
import { ErrorResponse } from './messages/ErrorResponse'
import { ProofOfEventChallengeRequest } from './messages/ProofOfEventChallengeRequest'
import { ProofOfEventChallengeResponse } from './messages/ProofOfEventChallengeResponse'
import { SimulatedProofOfEventChallengeRequest } from './messages/SimulatedProofOfEventChallengeRequest'
import { SimulatedProofOfEventChallengeResponse } from './messages/SimulatedProofOfEventChallengeResponse'
import { ChangeAccountRequest } from './messages/ChangeAccountRequest'
// EncryptPayloadRequest,
// EncryptPayloadResponse,

/**
 * @internalapi
 */
export type BeaconMessage =
  | PermissionRequest
  | PermissionResponse
  | ProofOfEventChallengeRequest
  | ProofOfEventChallengeResponse
  | SimulatedProofOfEventChallengeRequest
  | SimulatedProofOfEventChallengeResponse
  | OperationRequest
  | OperationResponse
  | SignPayloadRequest
  | SignPayloadResponse
  // | EncryptPayloadRequest
  // | EncryptPayloadResponse
  | BroadcastRequest
  | BroadcastResponse
  | AcknowledgeResponse
  | DisconnectMessage
  | ErrorResponse
  | ChangeAccountRequest
