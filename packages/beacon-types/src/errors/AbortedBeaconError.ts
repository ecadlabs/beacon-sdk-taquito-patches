import { BeaconErrorType } from '../types/BeaconErrorType'
import { getBeaconErrorCopy } from '../i18n'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class AbortedBeaconError extends BeaconError {
  public override readonly name: string = 'AbortedBeaconError'

  constructor(options?: BeaconErrorOptions) {
    const copy = getBeaconErrorCopy(BeaconErrorType.ABORTED_ERROR)
    super(
      BeaconErrorType.ABORTED_ERROR,
      copy.description,
      copy.title,
      'AbortedBeaconError',
      options
    )
  }
}
