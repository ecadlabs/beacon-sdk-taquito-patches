# Wallet request helpers

Wallets can opt into these helpers from `@ecadlabs/beacon-utils/wallet`. The root utility, SDK and wallet-client
entrypoints do not load these helpers or the codec. Receiving a request still behaves as before; the SDK
does not automatically validate or rewrite requests.

## Install the optional codec

Only the wallet subpath needs `@taquito/michel-codec`. It is an optional peer,
so installing Beacon alone does not install the codec or `@taquito/core`.
The root utility, SDK and wallet-client entrypoints work without it.

The supported range is `^25.1.1 || ^25.2.0-beta3`. It covers stable 25.x releases
from 25.1.1 and the 25.2.0 prereleases from beta3, and excludes 26.x.
The installed-consumer checks exercise 25.1.1 and 25.2.0-beta3.
An application must provide a compatible codec before importing the wallet
subpath. Taquito applications can reuse their compatible installed version.
Applications without it can install the tested stable version:

```sh
npm install @taquito/michel-codec@25.1.1
```

Importing the wallet subpath without its peer reports a missing-codec module error.

## Operations

`WalletPartialTezosOperation` is exported by `@ecadlabs/beacon-types`.
`isPartialTezosOperation(value)` checks its supported shapes, rejects unknown
properties, and rejects dApp-supplied `source`, `fee` and `counter`. A successful
guard narrows to `ValidatedWalletPartialTezosOperation`, a type-only export from
`@ecadlabs/beacon-utils/wallet` with codec-validated Micheline names. Libraries can
publish inferred guarded return values and filtered arrays in their declarations.
Validation describes the input at the time of the check and adds no runtime
property. An ordinary object spread drops the private validation member in
TypeScript. Revalidate after mutation or generic copying, including
`Object.assign`, which can preserve the validated type in its inferred result.
A failed guard does not exclude the wire type, because structurally assignable
operations can still have rejected extra properties. Optional fields must be absent
or contain their declared value. The guard rejects a present `undefined` even in
nested objects, so callers can use `exactOptionalPropertyTypes`.
Operation records must use own enumerable data properties so JSON encoding keeps
the validated fields. Sanitization copies own data fields into fresh enumerable
properties, including fields that were non-enumerable on the input. Arrays must have the ordinary
array prototype, dense indexed data properties and no extra keys.

Pass plain JSON data to the guard. Micheline nodes created by
`@taquito/michel-codec`'s `Parser` can have symbol-keyed source locations, which
the guard rejects. For a locally constructed operation, pass it through
`sanitizePartialTezosOperations` to copy the supported fields and drop the
source locations.

`sanitizePartialTezosOperations(operations)` creates a fresh array and nested
objects. It copies array elements by index and ignores extra array properties
and overridden iterators. A missing index or an accessor on a field being copied
rejects the batch.
It removes unknown properties, `source`, `fee` and `counter`, and optional
fields whose value is `undefined`.
`gas_limit` and `storage_limit` survive only as canonical nonnegative integer
strings, such as `"0"` or `"100"`; numbers, signs, whitespace, fractions and
leading zeroes are removed. Required invalid fields reject the whole call with
the original batch index. No operation is silently removed.

```ts
import { sanitizePartialTezosOperations } from '@ecadlabs/beacon-utils/wallet'

const operations = sanitizePartialTezosOperations(request.operationDetails)
// Continue the wallet's address checks, estimation, preview and approval flow.
```

Supported kinds are `transaction`, `origination`, `delegation`, `reveal`,
`set_deposits_limit`, `register_global_constant`, `transfer_ticket`,
`increase_paid_storage`, `update_companion_key`, `smart_rollup_originate`,
`smart_rollup_add_messages`, `smart_rollup_execute_outbox_message`,
`smart_rollup_publish`, `smart_rollup_cement`, `smart_rollup_recover_bond`,
`smart_rollup_refute`, `smart_rollup_timeout`, and `dal_publish_commitment`.
The legacy request union keeps its existing operation kinds and Micheline primitive names.
The wallet type also supports `smart_rollup_timeout`. Sanitization returns `WalletPartialTezosOperation[]`. Its Micheline fields can contain newer
primitive names than legacy request types allow. Use the wallet type for the resulting operations.

These are structural checks against Beacon's operation types. They do not check
address checksums, keys or proof cryptography, Michelson execution, current
protocol availability, fees, permissions, or the user's intent. Consensus,
evidence, governance and other operation kinds are rejected. Nested objects and
arrays have a maximum validation depth of 64. Micheline names must exist in the
installed codec's tag inventory. This includes instruction, type and data names;
the check does not validate each primitive's arity or Michelson semantics.
Micheline integers retain accepted decimal spellings such as "01" or "-0"; the
codec and node canonicalize them when encoding. Canonical spelling is required
only for the manager amounts and optional gas/storage limits described above.
For example, Taquito can send `transfer_ticket` with numeric `ticket_amount: 3`.
These helpers reject that value and require `ticket_amount: "3"`, matching Beacon's
wire type. Applications adapting Taquito requests must account for this boundary
before using the helpers.
The existing PVM and refutation enums are public exports for constructing the
advanced manager variants.

Wallet operation types accept string names so new protocol names can be
represented without updating Beacon's type inventory. Existing request types
continue to use `MichelsonPrimitives`. The guard validates names against the installed codec. Constructing a typed operation does not
replace runtime validation.

## Signing bytes

`packMessageText(text)` packs the exact supplied UTF-8 text as
`0501` + four-byte byte length + UTF-8 bytes. It preserves a leading Unicode BOM
and rejects lone surrogates. It does not prepend text or invent a domain, nonce
or expiry. The caller supplies those values.

```ts
import { packMessageText, inspectSignPayload } from '@ecadlabs/beacon-utils/wallet'
import { SigningType } from '@ecadlabs/beacon-types'

const payload = packMessageText('Tezos Signed Message: example.org hello')
const preview = inspectSignPayload(payload, SigningType.MICHELINE)
```

`inspectSignPayload(payload, signingType?)` accepts nonempty, even-length hex,
with an optional `0x` prefix, and returns lowercase `normalizedHex` on success.
It does not guess whether RAW text should be encoded as UTF-8. Inputs are capped
at 1 MiB of encoded bytes.

Packed Micheline also has a conservative decoder-work support limit. Before the
codec runs, a structural scan checks all wire tags and lengths, limits nesting to
64, and allows 4,194,304 work units. Each node costs 16 units plus its encoded
bytes. Child costs double at each enclosing sequence or primitive because both
tested codec versions decode those children twice. String, byte and annotation
payload lengths receive that same weight. An integer's encoded byte length also
costs its square to limit the codec's growing integer arithmetic. The scan skips
payloads without decoding them and does not own a second Michelson name table.
The scan rejects the Michelson `PUSH` instruction at any depth because it activates
typed conversions during decoding and canonical repacking. A packed value containing
`PUSH` returns an unsupported result, or raw bytes for an explicit RAW request.
Operation guards still accept `PUSH` in Micheline operation fields.
After the scan, top-level strings use strict UTF-8 decoding that preserves the
BOM, and top-level bytes retain their exact hex data. Both use unique scalar
framing directly. Other supported values use the public codec decoder and encoder
for canonical checking. The scalar path avoids repeated decoding, large temporary
arrays and the tested codec writer's spread limit. It is not a general Micheline
encoder.

This limits repeated work for one preview while retaining large flat scalar
payloads. It is not a calibrated time limit. A well-formed value can exceed the
budget and return an invalid-or-unsupported result before reaching the codec.
Explicit RAW requests retain their raw-byte fallback in that case.

The `kind` describes recognized bytes; it does not change the requested signing
type. Canonical packed data, including RAW requests, produces `micheline` or
`signed_message_text` with `validation: 'canonical_micheline'`. Only a top-level string
starting with `Tezos Signed Message: ` gets the latter label. This is a display
convention, not proof of authentication, domain binding or replay protection.
The decoded string is available as `decodedText`.

An `operation` result has `validation: 'watermark_only'`: it checks the `03`
prefix and presence of following bytes. It does not parse a branch, operation
contents, a signature or their protocol validity. A RAW request can also expose
this operation hint. Other RAW bytes have `kind: 'raw_bytes'` and
`validation: 'hex'`. A malformed `05` payload can remain raw bytes only when RAW
was explicitly requested; an explicit MICHELINE request rejects it.

`valid: false` means invalid **or unsupported**, not proof that the bytes are
malformed. The public decoder in `@taquito/michel-codec` 25.1.1 strips leading
BOMs from nested strings, so exact canonical validation conservatively rejects
those values. For example, `0502000000090100000004efbbbf61` is a valid sequence
containing `"\uFEFFa"` but returns an unsupported/noncanonical result. Top-level
strings use strict UTF-8 decoding and preserve their BOM. Other codec errors
and noncanonical/trailing bytes are rejected. Large nested values can remain
unsupported by the codec even when they fit the preview's work budget.

The helpers have a separate public entrypoint so applications that use only
the existing utility, SDK, dApp or wallet-client entrypoints do not load the codec.
Applications opting into the helpers include the codec in that module's bundle.
The packed browser test exercises this entrypoint independently of the default
SDK bundle.

## Sources

[TZIP-10](https://gitlab.com/tezos/tzip/-/blob/master/proposals/tzip-10/tzip-10.md)
defines the wallet interaction messages and arbitrary signing payloads. It does
not define the signed-message text prefix or an authentication format.
[The SDK's `SigningType` definition](https://github.com/ecadlabs/beacon-sdk-taquito-patches/blob/4d38b5918bf3225555760ebfaa8a1503be1d814b/packages/beacon-types/src/types/beacon/SigningType.ts)
records the `05` Micheline, `03` operation and RAW conventions used here.

[Octez's Micheline guide](https://octez.tezos.com/docs/shell/micheline.html)
describes the wire expression format and protocol-specific primitive vocabulary.
