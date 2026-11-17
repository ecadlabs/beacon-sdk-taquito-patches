import { BeaconErrorType } from '../types/BeaconErrorType'
import { getBeaconErrorCopy } from '../i18n'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class NoPrivateKeyBeaconError extends BeaconError {
  public override readonly name: string = 'NoPrivateKeyBeaconError'

  constructor(options?: BeaconErrorOptions) {
    const copy = getBeaconErrorCopy(BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR)
    super(
      BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR,
      copy.description,
      copy.title,
      'NoPrivateKeyBeaconError',
      options
    )
  }
}
