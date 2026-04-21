import { BeaconBaseMessage } from '../BeaconBaseMessage'
import { BeaconMessageType } from '../BeaconMessageType'

/**
 * @category Message
 */
export interface BroadcastResponse extends BeaconBaseMessage {
  type: BeaconMessageType.BroadcastResponse
  transactionHash: string // Hash of the broadcast transaction
}
