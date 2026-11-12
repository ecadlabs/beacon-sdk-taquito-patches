import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class ParametersInvalidBeaconError extends BeaconError {
  public override readonly name: string = 'ParametersInvalidBeaconError'
  public override readonly title: string = 'Parameters Invalid'

  constructor(options?: BeaconErrorOptions) {
    super(
      BeaconErrorType.PARAMETERS_INVALID_ERROR,
      'Some of the parameters you provided are invalid and the request could not be completed. Please check your inputs and try again.',
      'Parameters Invalid',
      'ParametersInvalidBeaconError',
      options
    )
  }
}
