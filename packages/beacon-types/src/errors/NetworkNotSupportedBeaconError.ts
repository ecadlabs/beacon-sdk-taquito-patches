import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class NetworkNotSupportedBeaconError extends BeaconError {
  public override readonly name: string = 'NetworkNotSupportedBeaconError'
  public override readonly title: string = 'Network Error'

  constructor(options?: BeaconErrorOptions) {
    super(
      BeaconErrorType.NETWORK_NOT_SUPPORTED,
      'The wallet does not support this network. Please select another one.',
      'Network Error',
      'NetworkNotSupportedBeaconError',
      options
    )
  }
}
