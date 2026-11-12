import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class TransactionInvalidBeaconError extends BeaconError {
  public override readonly name: string = 'TransactionInvalidBeaconError'
  public override readonly title: string = 'Transaction Invalid'
  public readonly data: unknown

  public override get fullDescription(): { description: string; data?: string } {
    return { description: this.description, data: JSON.stringify(this.data, undefined, 2) }
  }

  constructor(dataOrOptions?: unknown, maybeOptions?: BeaconErrorOptions) {
    let resolvedOptions: BeaconErrorOptions | undefined
    let resolvedData: unknown

    if (maybeOptions !== undefined) {
      resolvedData = dataOrOptions
      resolvedOptions = {
        ...maybeOptions,
        errorData: maybeOptions.errorData !== undefined ? maybeOptions.errorData : resolvedData
      }
    } else if (
      dataOrOptions !== null &&
      typeof dataOrOptions === 'object' &&
      !Array.isArray(dataOrOptions) &&
      ('id' in dataOrOptions ||
        'version' in dataOrOptions ||
        'senderId' in dataOrOptions ||
        'errorOrigin' in dataOrOptions ||
        'errorData' in dataOrOptions ||
        'description' in dataOrOptions)
    ) {
      resolvedOptions = dataOrOptions as BeaconErrorOptions
      resolvedData = resolvedOptions.errorData
    } else {
      resolvedData = dataOrOptions
      resolvedOptions = dataOrOptions !== undefined ? { errorData: dataOrOptions } : undefined
    }

    super(
      BeaconErrorType.TRANSACTION_INVALID_ERROR,
      'The transaction is invalid and the node did not accept it.',
      'Transaction Invalid',
      'TransactionInvalidBeaconError',
      resolvedOptions
    )
    this.data = resolvedData
  }
}
