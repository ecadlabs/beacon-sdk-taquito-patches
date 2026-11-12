import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class NotGrantedBeaconError extends BeaconError {
  public override readonly name: string = 'NotGrantedBeaconError'
  public override readonly title: string = 'Permission Not Granted'

  constructor(options?: BeaconErrorOptions) {
    super(
      BeaconErrorType.NOT_GRANTED_ERROR,
      'You do not have the necessary permissions to perform this action. Please initiate another permission request and give the necessary permissions.',
      'Permission Not Granted',
      'NotGrantedBeaconError',
      options
    )
  }
}
