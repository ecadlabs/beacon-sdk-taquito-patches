import { BeaconBaseMessage } from '../BeaconBaseMessage'
import { BeaconMessageType } from '../BeaconMessageType'

/**
 * @category Message
 */
export interface AcknowledgeResponse extends BeaconBaseMessage {
  type: BeaconMessageType.Acknowledge
}
