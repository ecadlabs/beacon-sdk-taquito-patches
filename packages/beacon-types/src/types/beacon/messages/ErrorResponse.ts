import { BeaconBaseMessage } from '../BeaconBaseMessage'
import { BeaconErrorType } from '../../BeaconErrorType'
import { BeaconMessageType } from '../BeaconMessageType'

/**
 * @category Message
 */
export interface ErrorResponse extends BeaconBaseMessage {
  type: BeaconMessageType.Error
  errorType: BeaconErrorType
  errorData?: any
}
