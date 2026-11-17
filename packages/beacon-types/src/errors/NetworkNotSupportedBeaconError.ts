import { BeaconErrorType } from '../types/BeaconErrorType'
import { getBeaconErrorCopy } from '../i18n'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class NetworkNotSupportedBeaconError extends BeaconError {
  public override readonly name: string = 'NetworkNotSupportedBeaconError'

  constructor(options?: BeaconErrorOptions) {
    const copy = getBeaconErrorCopy(BeaconErrorType.NETWORK_NOT_SUPPORTED)
    super(
      BeaconErrorType.NETWORK_NOT_SUPPORTED,
      copy.description,
      copy.title,
      'NetworkNotSupportedBeaconError',
      options
    )
  }
}
