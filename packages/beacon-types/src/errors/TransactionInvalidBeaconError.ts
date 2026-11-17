import { BeaconErrorType } from '../types/BeaconErrorType'
import { getBeaconErrorCopy } from '../i18n'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

const BEACON_ERROR_OPTION_KEYS = new Set([
  'id',
  'version',
  'senderId',
  'errorOrigin',
  'errorData',
  'description',
  'title'
])

const isBeaconErrorOptionsObject = (value: unknown): value is BeaconErrorOptions => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const keys = Object.keys(value)

  return keys.length > 0 && keys.every((key) => BEACON_ERROR_OPTION_KEYS.has(key))
}

/**
 * @category Error
 */
export class TransactionInvalidBeaconError extends BeaconError {
  public override readonly name: string = 'TransactionInvalidBeaconError'
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
    } else if (isBeaconErrorOptionsObject(dataOrOptions)) {
      resolvedOptions = dataOrOptions
      resolvedData = resolvedOptions.errorData
    } else {
      resolvedData = dataOrOptions
      resolvedOptions = dataOrOptions !== undefined ? { errorData: dataOrOptions } : undefined
    }

    const copy = getBeaconErrorCopy(BeaconErrorType.TRANSACTION_INVALID_ERROR)
    super(
      BeaconErrorType.TRANSACTION_INVALID_ERROR,
      copy.description,
      copy.title,
      'TransactionInvalidBeaconError',
      resolvedOptions
    )
    this.data = resolvedData
  }
}
