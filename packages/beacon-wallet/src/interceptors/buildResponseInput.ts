import {
  BeaconErrorType,
  BeaconMessageType,
  ErrorResponseInput,
  Network,
  Notification,
  OperationRequestOutput,
  OperationResponseInput,
  PermissionRequestOutput,
  PermissionResponseInput,
  PermissionScope,
  SignPayloadRequestOutput,
  SignPayloadResponseInput,
  SigningType,
  Threshold,
  BroadcastRequestOutput,
  BroadcastResponseInput
} from '@ecadlabs/beacon-types'
import { createErrorResponseInput } from './createErrorResponseInput'

export interface BasePermissionResponseBuilderOptions {
  network?: Network
  scopes?: PermissionScope[]
  threshold?: Threshold
  notification?: Notification
  verificationType?: 'proof_of_event'
}

export interface ImplicitPermissionResponseBuilderOptions extends BasePermissionResponseBuilderOptions {
  walletType?: 'implicit'
  publicKey: string
  address?: string
}

export interface AbstractedPermissionResponseBuilderOptions extends BasePermissionResponseBuilderOptions {
  walletType: 'abstracted_account'
  address: string
  publicKey?: undefined
}

export type PermissionResponseBuilderOptions =
  | ImplicitPermissionResponseBuilderOptions
  | AbstractedPermissionResponseBuilderOptions

export const buildPermissionResponse = (
  request: Pick<PermissionRequestOutput, 'id' | 'network' | 'scopes'>,
  options: PermissionResponseBuilderOptions
): PermissionResponseInput => {
  let result: PermissionResponseInput
  if (options.walletType === 'abstracted_account') {
    result = {
      id: request.id,
      type: BeaconMessageType.PermissionResponse,
      network: options.network ?? request.network,
      scopes: options.scopes ?? request.scopes,
      walletType: 'abstracted_account',
      address: options.address
    }
  } else {
    result = {
      id: request.id,
      type: BeaconMessageType.PermissionResponse,
      network: options.network ?? request.network,
      scopes: options.scopes ?? request.scopes,
      walletType: 'implicit',
      publicKey: options.publicKey,
      ...(options.address !== undefined ? { address: options.address } : {})
    }
  }

  if (options.threshold !== undefined) {
    result.threshold = options.threshold
  }
  if (options.notification !== undefined) {
    result.notification = options.notification
  }
  if (options.verificationType !== undefined) {
    result.verificationType = options.verificationType
  }

  return result
}

export const buildOperationResponse = (
  request: Pick<OperationRequestOutput, 'id'>,
  transactionHash: string
): OperationResponseInput => ({
  id: request.id,
  type: BeaconMessageType.OperationResponse,
  transactionHash
})

export const buildSignPayloadResponse = (
  request: Pick<SignPayloadRequestOutput, 'id' | 'signingType'>,
  signature: string,
  signingType?: SigningType
): SignPayloadResponseInput => ({
  id: request.id,
  type: BeaconMessageType.SignPayloadResponse,
  signingType: signingType ?? request.signingType,
  signature
})

export const buildBroadcastResponse = (
  request: Pick<BroadcastRequestOutput, 'id'>,
  transactionHash: string
): BroadcastResponseInput => ({
  id: request.id,
  type: BeaconMessageType.BroadcastResponse,
  transactionHash
})

export const buildErrorResponse = (
  request: { id: string } | string,
  errorType: BeaconErrorType,
  errorData?: unknown
): ErrorResponseInput => createErrorResponseInput(request, errorType, errorData)
