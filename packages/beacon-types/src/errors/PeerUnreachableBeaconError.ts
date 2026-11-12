import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class PeerUnreachableBeaconError extends BeaconError {
  public override readonly name: string = 'PeerUnreachableBeaconError'
  public override readonly title: string = 'No Response From Wallet'

  constructor(options?: BeaconErrorOptions) {
    super(
      BeaconErrorType.PEER_UNREACHABLE,
      'The wallet did not respond in time. The request may still be open in the wallet and can ' +
        'still be approved there. Check the wallet and your recent account activity before trying again.',
      'No Response From Wallet',
      'PeerUnreachableBeaconError',
      options
    )
  }
}
