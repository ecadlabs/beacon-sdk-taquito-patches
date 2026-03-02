import { BeaconBaseMessage, BeaconMessageType } from '@ecadlabs/beacon-types'

/**
 * @category Message
 */
export interface AcknowledgeResponse extends BeaconBaseMessage {
  type: BeaconMessageType.Acknowledge
}
