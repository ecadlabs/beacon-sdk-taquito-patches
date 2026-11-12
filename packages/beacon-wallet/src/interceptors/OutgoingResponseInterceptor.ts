import {
  AppMetadataManager,
  getAccountIdentifier,
  Logger,
  PermissionManager
} from '@ecadlabs/beacon-core'
import {
  ErrorResponse,
  BeaconResponseInputMessage,
  BeaconMessageType,
  PermissionResponse,
  OperationResponse,
  SignPayloadResponse,
  BroadcastResponse,
  PermissionInfo,
  AcknowledgeResponse,
  AppMetadata,
  BeaconRequestMessage,
  BeaconErrorType,
  BeaconMessageEnvelopeV3,
  type BlockchainMessage,
  ProofOfEventChallengeResponse,
  SimulatedProofOfEventChallengeResponse,
  isTezosRpcError
  // EncryptPayloadResponse
} from '@ecadlabs/beacon-types'
import { getAddressFromPublicKey, CONTRACT_PREFIX, isValidAddress } from '@ecadlabs/beacon-utils'
import type {
  WalletResponseInputMessage,
  WalletResponseOutputMessage
} from '../types/WalletResponseMessage'

interface OutgoingResponseInterceptorOptions {
  senderId: string
  request: BeaconRequestMessage | BeaconMessageEnvelopeV3
  message: WalletResponseInputMessage
  ownAppMetadata: AppMetadata
  permissionManager: PermissionManager
  appMetadataManager: AppMetadataManager
  interceptorCallback: (message: WalletResponseOutputMessage) => unknown

}

interface OutgoingResponseInterceptorOptionsV2 extends OutgoingResponseInterceptorOptions {
  message: BeaconResponseInputMessage
}

const isObject = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function')

const isEnvelopeShape = (value: unknown): value is BeaconMessageEnvelopeV3 => {
  if (!isObject(value) || !('message' in value)) {
    return false
  }

  const message = value.message

  return (
    'id' in value &&
    typeof value.id === 'string' &&
    'version' in value &&
    typeof value.version === 'string' &&
    'senderId' in value &&
    typeof value.senderId === 'string' &&
    isObject(message) &&
    'type' in message
  )
}

const isFlatChainShape = (
  value: unknown
): value is Extract<WalletResponseInputMessage, BlockchainMessage> =>
  isObject(value) &&
  'id' in value &&
  typeof value.id === 'string' &&
  'blockchainIdentifier' in value &&
  typeof value.blockchainIdentifier === 'string' &&
  'blockchainData' in value &&
  'type' in value

const logger = new Logger('OutgoingResponseInterceptor')

/**
 * @internalapi
 *
 * The OutgoingResponseInterceptor enriches V2 responses and forwards the existing V3 response forms.
 */
export class OutgoingResponseInterceptor {
  public static async intercept(config: OutgoingResponseInterceptorOptions): Promise<void> {
    if (config.request.version === '2') {
      const message = config.message
      if (isEnvelopeShape(message) || isFlatChainShape(message)) {
        throw new Error('A V3 response shape cannot be sent for a V2 request')
      }

      return OutgoingResponseInterceptor.handleV2Message({ ...config, message })
    } else if (config.request.version === '3') {
      return OutgoingResponseInterceptor.handleV3Message(config)

    }
  }

  private static async handleV3Message(config: OutgoingResponseInterceptorOptions) {
    const { message, appMetadataManager, interceptorCallback } = config
    const payload = 'message' in message ? message.message : undefined
    logger.log('LOGGING OUTGOING V3', payload, appMetadataManager)

    await interceptorCallback(message)

  }

  private static async handleV2Message(config: OutgoingResponseInterceptorOptionsV2) {
    const {
      senderId,
      request,
      message,
      ownAppMetadata,
      permissionManager,
      appMetadataManager,
      interceptorCallback
    }: OutgoingResponseInterceptorOptionsV2 = config

    switch (message.type) {
      case BeaconMessageType.Error: {
        const response: ErrorResponse = {
          type: message.type,
          version: '2',
          senderId,
          id: message.id,
          errorType: message.errorType
        }
        if (message.errorType === BeaconErrorType.TRANSACTION_INVALID_ERROR && message.errorData) {
          const errorData = message.errorData
          // Check only the RPC identifiers required for forwarding; preserve all other fields.
          if (Array.isArray(errorData) && errorData.every((item: unknown) => isTezosRpcError(item))) {
            response.errorData = errorData
          } else {
            logger.warn(
              'ErrorData provided is not in correct format. It needs to be an array of RPC errors. It will not be included in the message sent to the dApp'
            )
          }
        }
        await interceptorCallback(response)
        break
      }
      case BeaconMessageType.Acknowledge: {
        const response: AcknowledgeResponse = {
          type: message.type,
          version: '2',
          senderId,
          id: message.id
        }
        await interceptorCallback(response)
        break
      }
      case BeaconMessageType.PermissionResponse: {
        const walletType = message.walletType ?? 'implicit'
        const response: PermissionResponse = {
          senderId,
          version: '2',
          appMetadata: ownAppMetadata,
          ...message,
          walletType
        }

        if (!response.address && !response.publicKey) {
          throw new Error('Address or PublicKey must be defined')
        }

        const publicKey = response.publicKey

        const address: string = response.address ?? (await getAddressFromPublicKey(publicKey!))

        if (!isValidAddress(address)) {
          throw new Error(`Invalid address: "${address}"`)
        }

        if (
          walletType === 'abstracted_account' &&
          address.substring(0, 3) !== CONTRACT_PREFIX
        ) {
          throw new Error(
            `Invalid abstracted account address "${address}", it should be a ${CONTRACT_PREFIX} address`
          )
        }

        const appMetadata = await appMetadataManager.getAppMetadata(request.senderId)

        if (!appMetadata) {
          throw new Error('AppMetadata not found')
        }

        const permission: PermissionInfo = {
          accountIdentifier: await getAccountIdentifier(address, response.network),
          senderId: request.senderId,
          appMetadata,
          website: '',
          address,
          publicKey,
          network: response.network,
          scopes: response.scopes,
          connectedAt: new Date().getTime()
        }

        await permissionManager.addPermission(permission)

        await interceptorCallback(response)
        break
      }
      case BeaconMessageType.OperationResponse:
        {
          const response: OperationResponse = {
            senderId,
            version: '2',
            ...message
          }
          await interceptorCallback(response)
        }
        break
      case BeaconMessageType.SignPayloadResponse:
        {
          const response: SignPayloadResponse = {
            senderId,
            version: '2',
            ...message
          }
          await interceptorCallback(response)
        }
        break
      // TODO: ENCRYPTION
      // case BeaconMessageType.EncryptPayloadResponse:
      //   {
      //     const response: EncryptPayloadResponse = {
      //       senderId,
      //       version: BEACON_VERSION,
      //       ...message
      //     }
      //     interceptorCallback(response)
      //   }
      //   break
      case BeaconMessageType.BroadcastResponse:
        {
          const response: BroadcastResponse = {
            senderId,
            version: '2',
            ...message
          }
          await interceptorCallback(response)
        }
        break
      case BeaconMessageType.ProofOfEventChallengeResponse:
        {
          const response: ProofOfEventChallengeResponse = {
            senderId,
            version: '2',
            ...message
          }
          await interceptorCallback(response)
        }
        break
      case BeaconMessageType.SimulatedProofOfEventChallengeResponse:
        {
          const response: SimulatedProofOfEventChallengeResponse = {
            senderId,
            version: '2',
            ...message
          }
          await interceptorCallback(response)
        }
        break
      default:
        logger.log('intercept', 'Message not handled')
        assertNever(message)
    }
  }
}
function assertNever(_message: never) {
  throw new Error('Function not implemented.')
}
