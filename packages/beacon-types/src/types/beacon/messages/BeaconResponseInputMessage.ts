import { Optional } from '../../utils/Optional'
import { ProofOfEventChallengeResponse } from './ProofOfEventChallengeResponse'
import { SimulatedProofOfEventChallengeResponse } from './SimulatedProofOfEventChallengeResponse'
import { PermissionResponse } from './PermissionResponse'
import { OperationResponse } from './OperationResponse'
import { SignPayloadResponse } from './SignPayloadResponse'
import { BroadcastResponse } from './BroadcastResponse'
import { AcknowledgeResponse } from './AcknowledgeResponse'
import { ErrorResponse } from './ErrorResponse'
// EncryptPayloadResponse,

/**
 * @category Wallet
 */
export type IgnoredResponseInputProperties = 'senderId' | 'version'

/**
 * @category Wallet
 */
export type PermissionResponseInput = Optional<
  PermissionResponse,
  IgnoredResponseInputProperties | 'appMetadata'
>
/**
 * @category Wallet
 */
export type ProofOfEventChallengeResponseInput = Optional<
  ProofOfEventChallengeResponse,
  IgnoredResponseInputProperties
>
/**
 * @category Wallet
 */
export type SimulatedProofOfEventChallengeResponseInput = Optional<
  SimulatedProofOfEventChallengeResponse,
  IgnoredResponseInputProperties
>
/**
 * @category Wallet
 */
export type OperationResponseInput = Optional<OperationResponse, IgnoredResponseInputProperties>
/**
 * @category Wallet
 */
export type SignPayloadResponseInput = Optional<SignPayloadResponse, IgnoredResponseInputProperties>
/**
 * @category Wallet
 */
// export type EncryptPayloadResponseInput = Optional<
//   EncryptPayloadResponse,
//   IgnoredResponseInputProperties
// >
/**
 * @category Wallet
 */
export type BroadcastResponseInput = Optional<BroadcastResponse, IgnoredResponseInputProperties>
/**
 * @category Wallet
 */
export type AcknowledgeResponseInput = Optional<AcknowledgeResponse, IgnoredResponseInputProperties>
/**
 * @category Wallet
 */
export type ErrorResponseInput = Optional<ErrorResponse, IgnoredResponseInputProperties>

/**
 * @internalapi
 * @category Wallet
 */
export type BeaconResponseInputMessage =
  | PermissionResponseInput
  | OperationResponseInput
  | SignPayloadResponseInput
  // | EncryptPayloadResponseInput
  | BroadcastResponseInput
  | AcknowledgeResponseInput
  | ErrorResponseInput
  | ProofOfEventChallengeResponseInput
  | SimulatedProofOfEventChallengeResponseInput
