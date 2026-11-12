import { Optional } from '../../utils/Optional'
import { ProofOfEventChallengeResponse } from './ProofOfEventChallengeResponse'
import { SimulatedProofOfEventChallengeResponse } from './SimulatedProofOfEventChallengeResponse'
import { PermissionResponse } from './PermissionResponse'
import { OperationResponse } from './OperationResponse'
import { SignPayloadResponse } from './SignPayloadResponse'
import { BroadcastResponse } from './BroadcastResponse'
import { AcknowledgeResponse } from './AcknowledgeResponse'
import { ErrorResponse } from './ErrorResponse'
import type {
  BeaconRequestOutputMessage,
  PermissionRequestOutput,
  OperationRequestOutput,
  SignPayloadRequestOutput,
  BroadcastRequestOutput,
  ProofOfEventChallengeRequestOutput,
  SimulatedProofOfEventChallengeRequestOutput
} from './BeaconRequestOutputMessage'
// EncryptPayloadResponse,

/**
 * @category Wallet
 */
export type IgnoredResponseInputProperties = 'senderId' | 'version'

/**
 * @category Wallet
 */
export type PermissionResponseBaseInput = Omit<
  Optional<PermissionResponse, IgnoredResponseInputProperties | 'appMetadata'>,
  'walletType' | 'publicKey' | 'address'
>

/**
 * @category Wallet
 */
export type ImplicitPermissionResponseInput = PermissionResponseBaseInput & {
  walletType?: 'implicit'
  publicKey: string
  address?: string
}

/**
 * @category Wallet
 */
export type AbstractedPermissionResponseInput = PermissionResponseBaseInput & {
  walletType: 'abstracted_account'
  address: string
  publicKey?: undefined
}

/**
 * @category Wallet
 */
export type PermissionResponseInput =
  | ImplicitPermissionResponseInput
  | AbstractedPermissionResponseInput
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
 * @category Wallet
 */
export type ResponseInputForRequest<
  T extends BeaconRequestOutputMessage = BeaconRequestOutputMessage
> = T extends PermissionRequestOutput
  ? PermissionResponseInput | ErrorResponseInput
  : T extends OperationRequestOutput
    ? OperationResponseInput | ErrorResponseInput
    : T extends SignPayloadRequestOutput
      ? SignPayloadResponseInput | ErrorResponseInput
      : T extends BroadcastRequestOutput
        ? BroadcastResponseInput | ErrorResponseInput
        : T extends ProofOfEventChallengeRequestOutput
          ? ProofOfEventChallengeResponseInput | ErrorResponseInput
          : T extends SimulatedProofOfEventChallengeRequestOutput
            ? SimulatedProofOfEventChallengeResponseInput | ErrorResponseInput
            : never

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
