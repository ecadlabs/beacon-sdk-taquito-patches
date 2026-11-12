import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class AbortedBeaconError extends BeaconError {
  public override readonly name: string = 'AbortedBeaconError'
  public override readonly title: string = 'Aborted'

  constructor(options?: BeaconErrorOptions) {
    super(
      BeaconErrorType.ABORTED_ERROR,
      'The action was aborted by the user.',
      'Aborted',
      'AbortedBeaconError',
      options
    )
  }
}
