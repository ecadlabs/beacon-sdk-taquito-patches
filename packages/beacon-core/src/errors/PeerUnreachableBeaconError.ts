import { BeaconErrorType } from '@ecadlabs/beacon-types'
import { BeaconError } from './BeaconError'

/**
 * @category Error
 */
export class PeerUnreachableBeaconError extends BeaconError {
  public name: string = 'PeerUnreachableBeaconError'
  public title: string = 'Peer Unreachable'

  constructor() {
    super(
      BeaconErrorType.PEER_UNREACHABLE,
      'The wallet did not answer the request. Reset the connection and pair the wallet again.'
    )
  }
}
