import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class UnknownBeaconError extends BeaconError {
  public override readonly name: string = 'UnknownBeaconError'
  public override readonly title: string = 'Error'

  constructor(options?: BeaconErrorOptions) {
    super(
      BeaconErrorType.UNKNOWN_ERROR,
      'An unknown error occured. Please try again or report it to a developer.',
      'Error',
      'UnknownBeaconError',
      options
    )
  }
}
