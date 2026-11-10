import { BeaconErrorType } from '@ecadlabs/beacon-types'
import { BeaconError } from './BeaconError'

/**
 * @category Error
 */
export class PeerUnreachableBeaconError extends BeaconError {
  public name: string = 'PeerUnreachableBeaconError'
  public title: string = 'No Response From Wallet'

  // The dApp raises this locally when its request deadline fires. The wallet is not told and
  // can still approve the request, so the copy must not send the user off to retry.
  constructor() {
    super(
      BeaconErrorType.PEER_UNREACHABLE,
      'The wallet did not respond in time. The request may still be open in the wallet and can ' +
        'still be approved there. Check the wallet and your recent account activity before trying again.'
    )
  }
}
