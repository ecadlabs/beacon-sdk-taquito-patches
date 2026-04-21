import { AccountInfo } from '../../AccountInfo'
import { PermissionResponse } from './PermissionResponse'
import { OperationResponse } from './OperationResponse'
import { SignPayloadResponse } from './SignPayloadResponse'
import { BroadcastResponse } from './BroadcastResponse'
import { ProofOfEventChallengeResponse } from './ProofOfEventChallengeResponse'
import { SimulatedProofOfEventChallengeResponse } from './SimulatedProofOfEventChallengeResponse'
// EncryptPayloadResponse,

/**
 * @category DApp
 */
export type IgnoredResponseOutputProperties = 'id' | 'version' | 'type'

/**
 * @category DApp
 */
export type PermissionResponseOutput = PermissionResponse & {
  address: string
  accountInfo: AccountInfo
  walletKey?: string | undefined // Last selected wallet key
}

/**
 * @category DApp
 */
export type ProofOfEventChallengeResponseOutput = ProofOfEventChallengeResponse

/**
 * @category DApp
 */
export type SimulatedProofOfEventChallengeResponseOutput = SimulatedProofOfEventChallengeResponse

/**
 * @category DApp
 */
export type OperationResponseOutput = OperationResponse
/**
 * @category DApp
 */
export type SignPayloadResponseOutput = SignPayloadResponse
/**
 * @category DApp
 */
// export type EncryptPayloadResponseOutput = EncryptPayloadResponse
/**
 * @category DApp
 */
export type BroadcastResponseOutput = BroadcastResponse

/**
 * @internalapi
 * @category DApp
 */
export type BeaconResponseOutputMessage =
  | PermissionResponseOutput
  | OperationResponseOutput
  | SignPayloadResponseOutput
  // | EncryptPayloadResponseOutput
  | BroadcastResponseOutput
  | ProofOfEventChallengeResponseOutput
  | SimulatedProofOfEventChallengeResponseOutput
