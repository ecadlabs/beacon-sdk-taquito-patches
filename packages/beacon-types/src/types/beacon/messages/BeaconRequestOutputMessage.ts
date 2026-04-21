import { Optional } from '../../utils/Optional'
import { AppMetadata } from '../AppMetadata'
import { ProofOfEventChallengeRequest } from './ProofOfEventChallengeRequest'
import { SimulatedProofOfEventChallengeRequest } from './SimulatedProofOfEventChallengeRequest'
import { PermissionRequest } from './PermissionRequest'
import { OperationRequest } from './OperationRequest'
import { SignPayloadRequest } from './SignPayloadRequest'
import { BroadcastRequest } from './BroadcastRequest'
// EncryptPayloadRequest,

/**
 * @category Wallet
 */
export type IgnoredRequestOutputProperties = 'version'

/**
 * @category Wallet
 */
export interface ExtraResponseOutputProperties {
  appMetadata: AppMetadata
}

/**
 * @category Wallet
 */
export type PermissionRequestOutput = Optional<PermissionRequest, IgnoredRequestOutputProperties> &
  ExtraResponseOutputProperties
/**
 * @category Wallet
 */
export type ProofOfEventChallengeRequestOutput = Optional<
  ProofOfEventChallengeRequest,
  IgnoredRequestOutputProperties
> &
  ExtraResponseOutputProperties
/**
 * @category Wallet
 */
export type SimulatedProofOfEventChallengeRequestOutput = Optional<
  SimulatedProofOfEventChallengeRequest,
  IgnoredRequestOutputProperties
> &
  ExtraResponseOutputProperties
/**
 * @category Wallet
 */
export type OperationRequestOutput = Optional<OperationRequest, IgnoredRequestOutputProperties> &
  ExtraResponseOutputProperties
/**
 * @category Wallet
 */
export type SignPayloadRequestOutput = Optional<
  SignPayloadRequest,
  IgnoredRequestOutputProperties
> &
  ExtraResponseOutputProperties
/**
 * @category Wallet
 */
// export type EncryptPayloadRequestOutput = Optional<
//   EncryptPayloadRequest,
//   IgnoredRequestOutputProperties
// > &
//   ExtraResponseOutputProperties
/**
 * @category Wallet
 */
export type BroadcastRequestOutput = Optional<BroadcastRequest, IgnoredRequestOutputProperties> &
  ExtraResponseOutputProperties

/**
 * @internalapi
 * @category Wallet
 */
export type BeaconRequestOutputMessage =
  | PermissionRequestOutput
  | OperationRequestOutput
  | SignPayloadRequestOutput
  // | EncryptPayloadRequestOutput
  | BroadcastRequestOutput
  | ProofOfEventChallengeRequestOutput
  | SimulatedProofOfEventChallengeRequestOutput
