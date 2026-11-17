import { BeaconErrorType } from '../types/BeaconErrorType'
import { getBeaconErrorCopy } from '../i18n'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class SignatureTypeNotSupportedBeaconError extends BeaconError {
  public override readonly name: string = 'SignatureTypeNotSupportedBeaconError'

  constructor(options?: BeaconErrorOptions) {
    const copy = getBeaconErrorCopy(BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED)
    super(
      BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED,
      copy.description,
      copy.title,
      'SignatureTypeNotSupportedBeaconError',
      options
    )
  }
}
