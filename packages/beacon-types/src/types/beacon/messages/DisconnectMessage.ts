import { BeaconBaseMessage, BeaconMessageType } from '@ecadlabs/beacon-types'

/**
 * @category Message
 */
export interface DisconnectMessage extends BeaconBaseMessage {
  type: BeaconMessageType.Disconnect
}
