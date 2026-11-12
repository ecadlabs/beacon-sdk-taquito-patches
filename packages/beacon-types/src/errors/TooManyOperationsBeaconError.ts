import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class TooManyOperationsBeaconError extends BeaconError {
  public override readonly name: string = 'TooManyOperationsBeaconError'
  public override readonly title: string = 'Too Many Operations'

  constructor(options?: BeaconErrorOptions) {
    super(
      BeaconErrorType.TOO_MANY_OPERATIONS,
      'The request contains too many transactions. Please include fewer operations and try again.',
      'Too Many Operations',
      'TooManyOperationsBeaconError',
      options
    )
  }
}
