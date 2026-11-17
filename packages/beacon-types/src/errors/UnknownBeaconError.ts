import { BeaconErrorType } from '../types/BeaconErrorType'
import { getBeaconErrorCopy } from '../i18n'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class UnknownBeaconError extends BeaconError {
  public override readonly name: string = 'UnknownBeaconError'

  constructor(options?: BeaconErrorOptions) {
    const copy = getBeaconErrorCopy(BeaconErrorType.UNKNOWN_ERROR)
    super(
      BeaconErrorType.UNKNOWN_ERROR,
      copy.description,
      copy.title,
      'UnknownBeaconError',
      options
    )
  }
}
