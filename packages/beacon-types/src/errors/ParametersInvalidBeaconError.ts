import { BeaconErrorType } from '../types/BeaconErrorType'
import { getBeaconErrorCopy } from '../i18n'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class ParametersInvalidBeaconError extends BeaconError {
  public override readonly name: string = 'ParametersInvalidBeaconError'

  constructor(options?: BeaconErrorOptions) {
    const copy = getBeaconErrorCopy(BeaconErrorType.PARAMETERS_INVALID_ERROR)
    super(
      BeaconErrorType.PARAMETERS_INVALID_ERROR,
      copy.description,
      copy.title,
      'ParametersInvalidBeaconError',
      options
    )
  }
}
