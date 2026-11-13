import {
  BeaconMessageType,
  PermissionRequestOutput,
  AppMetadata,
  OperationRequestOutput,
  SignPayloadRequestOutput,
  BroadcastRequestOutput,
  ProofOfEventChallengeRequestOutput,
  ConnectionContext,
  BeaconRequestMessage,
  BeaconMessageEnvelopeV3,
  SimulatedProofOfEventChallengeRequestOutput

  // EncryptPayloadRequestOutput
} from '@ecadlabs/beacon-types'
import { AppMetadataManager, Logger } from '@ecadlabs/beacon-core'

import type { WalletRequestOutputMessage } from '../types/WalletRequestOutputMessage'
import { isRecord, isV3Envelope } from '../utils/message-guards'

const logger = new Logger('IncomingRequestInterceptor')

interface IncomingRequestInterceptorOptions {
  message: BeaconRequestMessage | BeaconMessageEnvelopeV3
  connectionInfo: ConnectionContext
  appMetadataManager: AppMetadataManager
  interceptorCallback: (message: WalletRequestOutputMessage, connectionInfo: ConnectionContext) => void
}

interface IncomingRequestInterceptorOptionsV2 extends IncomingRequestInterceptorOptions {
  message: BeaconRequestMessage
}

interface IncomingRequestInterceptorOptionsV3 extends IncomingRequestInterceptorOptions {
  message: BeaconMessageEnvelopeV3
}
/**
 * @internalapi
 *
 * The IncomingRequestInterceptor is used in the WalletClient to intercept an incoming request and enrich it with data, like app metadata.
 */
export class IncomingRequestInterceptor {
  /**
   * The method that is called during the interception
   *
   * @param config
   */
  public static async intercept(config: IncomingRequestInterceptorOptions): Promise<void> {
    logger.log('INTERCEPTING REQUEST', config.message)

    if (config.message.version === '2') {
      // eslint-disable-next-line no-return-await
      return await IncomingRequestInterceptor.handleV2Message(
        config as IncomingRequestInterceptorOptionsV2
      )
    } else if (config.message.version === '3') {
      if (!isV3Envelope(config.message)) {
        throw new Error('Invalid V3 request envelope')
      }

      return IncomingRequestInterceptor.handleV3Message({ ...config, message: config.message })

    }
  }

  private static async getAppMetadata(
    appMetadataManager: AppMetadataManager,
    senderId: string
  ): Promise<AppMetadata> {
    const appMetadata: AppMetadata | undefined = await appMetadataManager.getAppMetadata(senderId)
    if (!appMetadata) {
      throw new Error('AppMetadata not found')
    }

    return appMetadata
  }

  private static async handleV2Message(config: IncomingRequestInterceptorOptionsV2) {
    const {
      message,
      connectionInfo,
      appMetadataManager,
      interceptorCallback
    }: IncomingRequestInterceptorOptionsV2 = config

    switch (message.type) {
      case BeaconMessageType.PermissionRequest:
        {
          logger.log('PERMISSION REQUEST V*', message)
          // TODO: Remove v1 compatibility in later version
          const appMetadata = message.appMetadata
          if ('beaconId' in appMetadata) {
            const legacyId = appMetadata.beaconId
            if (typeof legacyId === 'string' && legacyId && !appMetadata.senderId) {
              appMetadata.senderId = legacyId
              const legacyMetadata: { beaconId?: unknown } = appMetadata
              delete legacyMetadata.beaconId
            }
          }

          await appMetadataManager.addAppMetadata(message.appMetadata)
          const request: PermissionRequestOutput = message
          interceptorCallback(request, connectionInfo)
        }
        break
      case BeaconMessageType.OperationRequest:
        {
          const appMetadata: AppMetadata = await IncomingRequestInterceptor.getAppMetadata(
            appMetadataManager,
            message.senderId
          )
          const request: OperationRequestOutput = {
            appMetadata,
            ...message
          }
          interceptorCallback(request, connectionInfo)
        }
        break
      case BeaconMessageType.SignPayloadRequest:
        {
          const appMetadata: AppMetadata = await IncomingRequestInterceptor.getAppMetadata(
            appMetadataManager,
            message.senderId
          )
          const request: SignPayloadRequestOutput = {
            appMetadata,
            ...message
          }
          interceptorCallback(request, connectionInfo)
        }
        break
      // TODO: ENCRYPTION
      // case BeaconMessageType.EncryptPayloadRequest:
      //   {
      //     const appMetadata: AppMetadata = await IncomingRequestInterceptor.getAppMetadata(
      //       appMetadataManager,
      //       message.senderId
      //     )
      //     const request: EncryptPayloadRequestOutput = {
      //       appMetadata,
      //       ...message
      //     }
      //     interceptorCallback(request, connectionInfo)
      //   }
      //   break
      case BeaconMessageType.BroadcastRequest:
        {
          const appMetadata: AppMetadata = await IncomingRequestInterceptor.getAppMetadata(
            appMetadataManager,
            message.senderId
          )
          const request: BroadcastRequestOutput = {
            appMetadata,
            ...message
          }
          interceptorCallback(request, connectionInfo)
        }
        break
      case BeaconMessageType.ProofOfEventChallengeRequest:
        {
          const appMetadata: AppMetadata = await IncomingRequestInterceptor.getAppMetadata(
            appMetadataManager,
            message.senderId
          )
          const request: ProofOfEventChallengeRequestOutput = {
            appMetadata,
            ...message
          }
          interceptorCallback(request, connectionInfo)
        }
        break
      case BeaconMessageType.SimulatedProofOfEventChallengeRequest:
        {
          const appMetadata: AppMetadata = await IncomingRequestInterceptor.getAppMetadata(
            appMetadataManager,
            message.senderId
          )
          const request: SimulatedProofOfEventChallengeRequestOutput = {
            appMetadata,
            ...message
          }
          interceptorCallback(request, connectionInfo)
        }
        break
      default:
        logger.log('intercept', 'Message not handled')
        message satisfies never
        throw new Error('Function not implemented.')
    }
  }

  private static async handleV3Message(config: IncomingRequestInterceptorOptionsV3) {
    const {
      message: msg,
      connectionInfo,
      appMetadataManager,
      interceptorCallback
    }: IncomingRequestInterceptorOptionsV3 = config

    const v3Message = msg.message


    switch (v3Message.type) {
      case BeaconMessageType.PermissionRequest:
        {
          const blockchainData =
            'blockchainData' in v3Message ? v3Message.blockchainData : undefined
          const metadata = isRecord(blockchainData) ? blockchainData.appMetadata : undefined
          if (!isRecord(metadata)) {
            throw new Error('Invalid V3 permission metadata')
          }

          const name = metadata.name
          const icon = metadata.icon
          if (typeof name !== 'string' || (icon !== undefined && typeof icon !== 'string')) {
            throw new Error('Invalid V3 permission metadata')
          }

          await appMetadataManager.addAppMetadata({
            ...metadata,
            name,
            icon,
            senderId: msg.senderId
          })
          interceptorCallback(msg, connectionInfo)
        }
        break
      case BeaconMessageType.BlockchainRequest:
        interceptorCallback({ ...msg }, connectionInfo)
        break
      default:
        logger.log('intercept', 'Message not handled')
        throw new Error('Unsupported V3 request type')
    }
  }
}
