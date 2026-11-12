import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class NoAddressBeaconError extends BeaconError {
  public override readonly name: string = 'NoAddressBeaconError'
  public override readonly title: string = 'No Address Error'

  constructor(options?: BeaconErrorOptions) {
    super(
      BeaconErrorType.NO_ADDRESS_ERROR,
      'No matching account was found for this network. Please switch networks or accounts in your wallet and try again.',
      'No Address Error',
      'NoAddressBeaconError',
      options
    )
  }
}
