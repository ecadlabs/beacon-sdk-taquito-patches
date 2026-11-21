# Request errors

DAppClient permission, blockchain, operation, signing, broadcast and proof request methods reject with a `BeaconError` subclass. Use `isBeaconError(error)` to narrow an unknown rejection. Within the same tab, existing typed errors retain their identity and unexpected local failures become `UnknownBeaconError` with the original value in `errorData`; invalid V3 permission scopes and mismatched blockchain identifiers become `ParametersInvalidBeaconError`.

This normalization also covers preparation and response processing. It does not add request-error events to failures that did not emit them before. Request-error events continue to carry plain response objects. `isErrorResponse` validates a known error type and string `id`, `version` and `senderId` headers; `isRequestErrorResponse` also validates the optional `errorOrigin` (`wallet` or `local`). Empty string headers remain valid for local failures before admission. An admitted wallet error that omits `senderId` still rejects the request; its normalized sender is an empty string.

An unset origin can be omitted or explicitly undefined. Check its value even when
the property is present.

The response guards return false if field inspection throws. A local error can
still have empty metadata before admission. When forwarding that error to a
follower, Beacon supplies version `2` if its version is empty so the terminal
reply passes incoming routing. The original local error remains unchanged.

Unfamiliar nonempty wallet error codes and their existing `errorData` pass through
plain request-error events and leader/follower forwarding. Public request methods
still reject with `UnknownBeaconError` for those codes. The response guards reject
unfamiliar codes because they cannot narrow them to the SDK's known error enum.

Ordinary request-error events expose `WireRequestErrorResponse`, whose `errorType`
is a string because a wallet can introduce codes this SDK does not know. Consumers
that previously indexed an exhaustive `Record<BeaconErrorType, Handler>` must first
use `isRequestErrorResponse(event.errorResponse)` to narrow known codes, or call
`toBeaconError(event.errorResponse)` to obtain a known typed error.

For a late error, `LATE_RESPONSE_RECEIVED.error` remains a `RequestErrorResponse`
with a known enum code. An unfamiliar code becomes `UNKNOWN_ERROR` in that derived
field. The event's `message` keeps the original code and both fields retain the
original diagnostic data. Origin attribution applies to both fields.

A delegated preparation failure crosses a tab boundary. Beacon sends a detached
copy of JSON data so that the localStorage fallback can encode the same reply as
the native channel. Plain objects with string data fields, arrays, strings,
booleans, null and numbers that round-trip through JSON retain their values. If the diagnostic
would change or fail during encoding, including a Map, Set, BigInt, cycle or
callback, the follower receives a summary in `errorData`. Its `diagnostic`
field is `"Uncloneable request diagnostic"`. Its `message` contains up to
256 UTF-16 code units from an own string `message` data property, including a
normal Error instance's message, or a generic explanation. Forwarding reads data
descriptors and does not invoke `toJSON` or property getters. Accessor messages
use the generic explanation. A same-tab caller keeps the original diagnostic by
identity.

V3 wallet errors and delegated preparation errors settle without looking up peer
metadata. If that lookup fails while processing a V3 success response, the
request rejects with a local `UnknownBeaconError` carrying the storage or wallet
lookup failure. Permission preparation stops before storing an account or
reporting success.

Local permission denials and rate limits create typed errors at their admission
checks and keep their existing `NO_PERMISSIONS` or `LOCAL_RATE_LIMIT_REACHED`
events. Unrelated plugin or dependency failures with the same message text remain
`UnknownBeaconError` with their original rejection in `errorData` within the same
tab, or a JSON copy or summary when delegated.

`TransactionInvalidBeaconError` preserves its first argument as transaction data. Pass envelope metadata as the second argument so RPC payload fields such as `id` cannot be mistaken for a Beacon request ID:

```ts
const error = new TransactionInvalidBeaconError(rpcData, {
  id: requestId,
  senderId: walletSenderId,
  version: '2',
  errorOrigin: 'wallet'
})
```

For metadata without transaction data, use `new TransactionInvalidBeaconError(undefined, options)`. Replace any options-only single-argument calls with this explicit form. Other Beacon error constructors still accept options as their first argument. `getError(BeaconErrorType.TRANSACTION_INVALID_ERROR)` leaves both `data` and `errorData` undefined.

## Prerelease migration

Prereleases that accepted options as the sole constructor argument need a migration.
A single object passed to TransactionInvalidBeaconError is now always transaction
data, including objects that contain option-like fields. To set metadata without
data, pass undefined first and options second. Taquito re-exports this class from
@taquito/beacon-wallet, so applications using that export need the same migration
when they adopt this Beacon release.

Malformed V3 permission responses carry the offending scopes or blockchain
identifier in errorData. Their errorOrigin is local because the SDK rejects the
response during validation. Other unexpected failures keep their original value
within the same tab; delegated preparation failures use the copies or summaries
described above.
