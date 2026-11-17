import { BeaconErrorType } from '../types/BeaconErrorType'
import { getBeaconErrorCopy } from '../i18n'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class NoAddressBeaconError extends BeaconError {
  public override readonly name: string = 'NoAddressBeaconError'

  constructor(options?: BeaconErrorOptions) {
    const copy = getBeaconErrorCopy(BeaconErrorType.NO_ADDRESS_ERROR)
    super(
      BeaconErrorType.NO_ADDRESS_ERROR,
      copy.description,
      copy.title,
      'NoAddressBeaconError',
      options
    )
  }
}
