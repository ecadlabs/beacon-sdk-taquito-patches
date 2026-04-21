import { BeaconBaseMessage } from '../BeaconBaseMessage'
import { BeaconMessageType } from '../BeaconMessageType'

/**
 * @category Message
 */
export interface OperationResponse extends BeaconBaseMessage {
  type: BeaconMessageType.OperationResponse
  transactionHash: string // Hash of the broadcast transaction
}
