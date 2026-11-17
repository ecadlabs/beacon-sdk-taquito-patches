import { BeaconErrorType } from '../types/BeaconErrorType'
import { getBeaconErrorCopy } from '../i18n'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class PeerUnreachableBeaconError extends BeaconError {
  public override readonly name: string = 'PeerUnreachableBeaconError'

  constructor(options?: BeaconErrorOptions) {
    const copy = getBeaconErrorCopy(BeaconErrorType.PEER_UNREACHABLE)
    super(
      BeaconErrorType.PEER_UNREACHABLE,
      copy.description,
      copy.title,
      'PeerUnreachableBeaconError',
      options
    )
  }
}
