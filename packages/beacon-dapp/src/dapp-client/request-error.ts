import {
  BeaconBaseMessage,
  BeaconMessage,
  BeaconMessageType,
  BeaconMessageWrapper,
  BlockchainMessage,
  ConnectionContext,
  ErrorResponse,
  WalletInfo
} from '@ecadlabs/beacon-types'

/**
 * Who produced a request error.
 *
 * - `wallet`: the wallet sent an error message.
 * - `local`: the dApp produced it, for example when its request deadline fired or the dApp
 *   aborted the request. The wallet was not told and may still complete the request.
 *
 * @category DApp
 */
export type ErrorOrigin = 'wallet' | 'local'

/**
 * A request error as the dApp reports it to callers and events.
 *
 * `origin` is always set by DAppClient. It is optional in the type so that handlers can be
 * called with errors built elsewhere; a missing origin is treated as `wallet`.
 *
 * @category DApp
 */
export interface RequestErrorResponse extends ErrorResponse {
  origin?: ErrorOrigin
}

/**
 * Payload of the LATE_RESPONSE_RECEIVED event: a wallet response for a request whose
 * deadline had already fired. The caller already received a PEER_UNREACHABLE rejection.
 *
 * @category DApp
 */
export interface LateResponseInfo {
  requestId: string
  requestType: BeaconMessageType
  message: BeaconMessage | BeaconMessageWrapper<BeaconBaseMessage | BlockchainMessage>
  connectionInfo: ConnectionContext
  walletInfo: WalletInfo
}

export const isErrorOrigin = (value: unknown): value is ErrorOrigin =>
  value === 'wallet' || value === 'local'

export const isErrorResponse = (value: unknown): value is ErrorResponse =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  value.type === BeaconMessageType.Error &&
  'errorType' in value &&
  typeof value.errorType === 'string'

export const localError = (error: ErrorResponse): RequestErrorResponse => ({
  ...error,
  origin: 'local'
})

/**
 * Attributes an error that arrived on the response path.
 *
 * Wallet messages and errors forwarded by the leader tab arrive on the same path, so the
 * message itself cannot be trusted to say where it came from. Only a follower tab trusts the
 * origin, because the leader stamps it before forwarding. Anything else came from the wallet.
 */
export const attributeError = (
  error: ErrorResponse,
  trustForwardedOrigin: boolean
): RequestErrorResponse => {
  const claimed = 'origin' in error ? error.origin : undefined

  return {
    ...error,
    origin: trustForwardedOrigin && isErrorOrigin(claimed) ? claimed : 'wallet'
  }
}

export const getErrorOrigin = (error: ErrorResponse): ErrorOrigin => {
  const claimed = 'origin' in error ? error.origin : undefined

  return isErrorOrigin(claimed) ? claimed : 'wallet'
}
