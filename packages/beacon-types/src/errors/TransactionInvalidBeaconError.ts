import { BeaconErrorType } from '../types/BeaconErrorType'
import { getBeaconErrorCopy } from '../i18n'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class TransactionInvalidBeaconError extends BeaconError {
  public override readonly name: string = 'TransactionInvalidBeaconError'
  public readonly data: unknown

  public override get fullDescription(): { description: string; data?: string } {
    return { description: this.description, data: JSON.stringify(this.data, undefined, 2) }
  }

  /**
   * The first argument is legacy transaction data, even when it resembles metadata.
   * Pass envelope metadata explicitly as the second argument.
   */
  constructor(data?: unknown, options?: BeaconErrorOptions) {
    const resolvedOptions = {
      ...options,
      errorData: options?.errorData !== undefined ? options.errorData : data
    }

    const copy = getBeaconErrorCopy(BeaconErrorType.TRANSACTION_INVALID_ERROR)
    super(
      BeaconErrorType.TRANSACTION_INVALID_ERROR,
      copy.description,
      copy.title,
      'TransactionInvalidBeaconError',
      resolvedOptions
    )
    this.data = data
  }
}
