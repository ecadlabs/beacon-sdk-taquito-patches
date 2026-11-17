import { BeaconErrorType } from '../types/BeaconErrorType'
import { getBeaconErrorCopy } from '../i18n'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class BroadcastBeaconError extends BeaconError {
  public override readonly name: string = 'BroadcastBeaconError'

  constructor(options?: BeaconErrorOptions) {
    const copy = getBeaconErrorCopy(BeaconErrorType.BROADCAST_ERROR)
    super(
      BeaconErrorType.BROADCAST_ERROR,
      copy.description,
      copy.title,
      'BroadcastBeaconError',
      options
    )
  }
}
