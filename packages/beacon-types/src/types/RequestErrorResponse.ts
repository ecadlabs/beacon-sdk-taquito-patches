import { ErrorResponse } from './beacon/messages/ErrorResponse'
import { ErrorOrigin } from './ErrorOrigin'

/**
 * A request error as reported across SDK boundaries and events.
 *
 * @category Error
 */
export interface RequestErrorResponse extends ErrorResponse {
  errorOrigin?: ErrorOrigin
}
