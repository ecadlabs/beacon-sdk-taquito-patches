import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class NoPrivateKeyBeaconError extends BeaconError {
  public override readonly name: string = 'NoPrivateKeyBeaconError'
  public override readonly title: string = 'No Private Key Found'

  constructor(options?: BeaconErrorOptions) {
    super(
      BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR,
      'The account you are trying to interact with is not available. Please make sure to add the account to your wallet and try again.',
      'No Private Key Found',
      'NoPrivateKeyBeaconError',
      options
    )
  }
}
