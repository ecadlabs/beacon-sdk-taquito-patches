/**
 * What a rejected signClient.request() means, as far as @walletconnect/sign-client 2.18.0 lets
 * the adapter tell. The package is pinned (see scripts/check-security-deps.mjs), and
 * RequestFailureClassification.test.ts checks the assumptions below against the installed copy.
 *
 * - `wallet`: the wallet answered with a JSON-RPC error. Sign-client rejects with the error
 *   object itself, `{ code, message }`, which is not an Error.
 * - `expired`: sign-client's own request expiry passed (wc_sessionRequest TTL, five minutes).
 *   The wallet sent nothing and may still act on the request; sign-client drops any later reply.
 * - `local`: anything else: validation, a failed publish, or the USER_DISCONNECTED rejection
 *   sign-client gives pending requests when the wallet deletes the session.
 */
export type RequestFailure = 'wallet' | 'expired' | 'local'

export const SIGN_CLIENT_REQUEST_EXPIRED_MESSAGE = 'Request expired. Please try again.'

/** getSdkError('USER_DISCONNECTED').code */
export const SIGN_CLIENT_USER_DISCONNECTED_CODE = 6000

export const classifyRequestFailure = (error: unknown): RequestFailure => {
  if (error instanceof Error) {
    return error.message === SIGN_CLIENT_REQUEST_EXPIRED_MESSAGE ? 'expired' : 'local'
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'number' &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.code !== SIGN_CLIENT_USER_DISCONNECTED_CODE
  ) {
    return 'wallet'
  }

  return 'local'
}
