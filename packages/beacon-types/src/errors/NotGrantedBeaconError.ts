import { BeaconErrorType } from '../types/BeaconErrorType'
import { getBeaconErrorCopy } from '../i18n'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class NotGrantedBeaconError extends BeaconError {
  public override readonly name: string = 'NotGrantedBeaconError'

  constructor(options?: BeaconErrorOptions) {
    const copy = getBeaconErrorCopy(BeaconErrorType.NOT_GRANTED_ERROR)
    super(
      BeaconErrorType.NOT_GRANTED_ERROR,
      copy.description,
      copy.title,
      'NotGrantedBeaconError',
      options
    )
  }
}
