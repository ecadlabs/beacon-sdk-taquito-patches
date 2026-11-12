/**
 * Where a request error came from.
 *
 * - `wallet`: the error arrived on the response path. Usually the wallet sent it. Over
 *   WalletConnect it can also be a failure the WalletConnect adapter reported for the request,
 *   such as a lost session or a failed publish.
 * - `local`: the dApp produced it, for example when its request deadline fired, when the dApp
 *   aborted the request, or when WalletConnect's own request expiry passed. The wallet was not
 *   told and may still complete the request.
 *
 * @category Error
 */
export type ErrorOrigin = 'wallet' | 'local'
