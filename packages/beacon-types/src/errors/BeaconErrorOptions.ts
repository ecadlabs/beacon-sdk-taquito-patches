import { ErrorOrigin } from '../types/ErrorOrigin'

/**
 * Optional metadata that can be attached to a BeaconError instance.
 *
 * @category Error
 */
export interface BeaconErrorOptions {
  id?: string
  version?: string
  senderId?: string
  errorOrigin?: ErrorOrigin
  errorData?: unknown
  description?: string
}
