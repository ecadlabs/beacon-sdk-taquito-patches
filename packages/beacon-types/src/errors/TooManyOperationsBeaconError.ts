import { BeaconErrorType } from '../types/BeaconErrorType'
import { getBeaconErrorCopy } from '../i18n'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class TooManyOperationsBeaconError extends BeaconError {
  public override readonly name: string = 'TooManyOperationsBeaconError'

  constructor(options?: BeaconErrorOptions) {
    const copy = getBeaconErrorCopy(BeaconErrorType.TOO_MANY_OPERATIONS)
    super(
      BeaconErrorType.TOO_MANY_OPERATIONS,
      copy.description,
      copy.title,
      'TooManyOperationsBeaconError',
      options
    )
  }
}
