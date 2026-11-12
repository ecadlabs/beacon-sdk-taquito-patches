import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class BroadcastBeaconError extends BeaconError {
  public override readonly name: string = 'BroadcastBeaconError'
  public override readonly title: string = 'Broadcast Error'

  constructor(options?: BeaconErrorOptions) {
    super(
      BeaconErrorType.BROADCAST_ERROR,
      'The transaction could not be broadcast to the network. Please try again.',
      'Broadcast Error',
      'BroadcastBeaconError',
      options
    )
  }
}
