import { BeaconErrorType } from '@ecadlabs/beacon-types'
import { BeaconError } from './BeaconError'

/**
 * @category Error
 */
export class AbortedBeaconError extends BeaconError {
  public name: string = 'AbortedBeaconError'
  public title: string = 'Aborted'

  constructor() {
    super(BeaconErrorType.ABORTED_ERROR, 'The action was aborted by the user.')
  }
}
