import { BeaconBaseMessage } from '../BeaconBaseMessage'
import { BeaconMessageType } from '../BeaconMessageType'
import { SigningType } from '../SigningType'

/**
 * @category Message
 */
export interface SignPayloadResponse extends BeaconBaseMessage {
  type: BeaconMessageType.SignPayloadResponse
  signingType: SigningType
  signature: string // Signature of the payload
}
