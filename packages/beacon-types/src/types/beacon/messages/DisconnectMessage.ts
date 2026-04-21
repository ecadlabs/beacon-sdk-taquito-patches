import { BeaconBaseMessage } from '../BeaconBaseMessage'
import { BeaconMessageType } from '../BeaconMessageType'

/**
 * @category Message
 */
export interface DisconnectMessage extends BeaconBaseMessage {
  type: BeaconMessageType.Disconnect
}
