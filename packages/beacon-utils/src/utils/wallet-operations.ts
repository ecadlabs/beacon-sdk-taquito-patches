import type { WalletPartialTezosOperation } from '@ecadlabs/beacon-types'
import { packDataBytes, type MichelsonData } from '@taquito/michel-codec'

declare const validatedWalletOperation: unique symbol
declare class WalletOperationValidation {
  private readonly [validatedWalletOperation]: true
}
export type ValidatedWalletPartialTezosOperation = WalletPartialTezosOperation &
  WalletOperationValidation

type Parser = (value: unknown, strict: boolean, depth: number) => unknown
type Field = Parser | { parse: Parser; optional: true }
const optional = (parse: Parser): Field => ({ parse, optional: true })
const invalid = (): never => {
  throw new TypeError('Invalid operation field')
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const ownDataValue = (value: object, key: PropertyKey): unknown => {
  const property = Object.getOwnPropertyDescriptor(value, key)
  if (!property || !('value' in property)) {
    return invalid()
  }

  return property.value
}
const text: Parser = (value) => (typeof value === 'string' && value.length > 0 ? value : invalid())
const integer: Parser = (value) =>
  typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? value : invalid()
const natural: Parser = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid()
const hex: Parser = (value) =>
  typeof value === 'string' && /^(?:[a-fA-F0-9]{2})*$/.test(value) ? value : invalid()
const knownPrimitives = new Set<string>()
const primitive: Parser = (value) => {
  if (typeof value !== 'string' || value in Object.prototype) {
    return invalid()
  }
  if (!knownPrimitives.has(value)) {
    try {
      // Probe the codec's tag inventory. Unit arguments satisfy its special PUSH encoding path.
      // Object.prototype names are excluded above because older codec lookups inherit them.
      packDataBytes({
        prim: value,
        args: [{ prim: 'unit' }, { prim: 'Unit' }]
      } as unknown as MichelsonData)
    } catch {
      return invalid()
    }
    knownPrimitives.add(value)
  }

  return value
}
const oneOf =
  (...values: string[]): Parser =>
  (value) =>
    typeof value === 'string' && values.includes(value) ? value : invalid()
const array =
  (parse: Parser): Parser =>
  (value, strict, depth) => {
    if (!Array.isArray(value) || depth >= 64) {
      return invalid()
    }

    if (
      strict &&
      (Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1)
    ) {
      return invalid()
    }
    const result: unknown[] = []
    for (let index = 0; index < value.length; index++) {
      result.push(parse(ownDataValue(value, index), strict, depth + 1))
    }

    return result
  }
const shape =
  (fields: Record<string, Field>): Parser =>
  (value, strict, depth) => {
    if (!isRecord(value) || depth >= 64) {
      return invalid()
    }
    if (
      strict &&
      Reflect.ownKeys(value).some(
        (key) =>
          typeof key !== 'string' ||
          !Object.prototype.hasOwnProperty.call(fields, key) ||
          Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true
      )
    ) {
      return invalid()
    }
    const result: Record<string, unknown> = {}
    for (const [name, field] of Object.entries(fields)) {
      if (typeof field !== 'function' && !Object.prototype.hasOwnProperty.call(value, name)) {
        continue
      }
      const fieldValue = ownDataValue(value, name)
      if (typeof field !== 'function' && !strict && fieldValue === undefined) {
        continue
      }
      const parse = typeof field === 'function' ? field : field.parse
      result[name] = parse(fieldValue, strict, depth + 1)
    }

    return result
  }
const micheline: Parser = (value, strict, depth) => {
  if (Array.isArray(value)) {
    return array(micheline)(value, strict, depth)
  }
  if (!isRecord(value)) {
    return invalid()
  }
  const tags = ['int', 'string', 'bytes', 'prim'].filter((tag) =>
    Object.prototype.hasOwnProperty.call(value, tag)
  )
  if (tags.length !== 1) {
    return invalid()
  }
  switch (tags[0]) {
    case 'int':
      return shape({ int: (v) => (typeof v === 'string' && /^-?\d+$/.test(v) ? v : invalid()) })(
        value,
        strict,
        depth
      )
    case 'string':
      return shape({ ['string']: (v) => (typeof v === 'string' ? v : invalid()) })(
        value,
        strict,
        depth
      )
    case 'bytes':
      return shape({ bytes: hex })(value, strict, depth)
    default:
      return shape({
        prim: primitive,
        args: optional(array(micheline)),
        annots: optional(array(text))
      })(value, strict, depth)
  }
}
const parameters = shape({ entrypoint: text, value: micheline })
const script = shape({ code: array(micheline), storage: micheline })
const revealProof: Parser = (value, strict, depth) => {
  if (!isRecord(value)) {
    return invalid()
  }
  switch (ownDataValue(value, 'reveal_proof_kind')) {
    case 'raw_data_proof':
      return shape({ reveal_proof_kind: oneOf('raw_data_proof'), raw_data: hex })(
        value,
        strict,
        depth
      )
    case 'metadata_proof':
      return shape({ reveal_proof_kind: oneOf('metadata_proof') })(value, strict, depth)
    case 'dal_page_proof':
      return shape({
        reveal_proof_kind: oneOf('dal_page_proof'),
        dal_page_id: shape({ published_level: natural, slot_index: natural, page_index: natural }),
        dal_proof: hex
      })(value, strict, depth)
    default:
      return invalid()
  }
}
const inputProof: Parser = (value, strict, depth) => {
  if (!isRecord(value)) {
    return invalid()
  }
  switch (ownDataValue(value, 'input_proof_kind')) {
    case 'inbox_proof':
      return shape({
        input_proof_kind: oneOf('inbox_proof'),
        level: natural,
        message_counter: integer,
        serialized_proof: hex
      })(value, strict, depth)
    case 'reveal_proof':
      return shape({ input_proof_kind: oneOf('reveal_proof'), reveal_proof: revealProof })(
        value,
        strict,
        depth
      )
    case 'first_input':
      return shape({ input_proof_kind: oneOf('first_input') })(value, strict, depth)
    default:
      return invalid()
  }
}
const refutation: Parser = (value, strict, depth) => {
  if (!isRecord(value)) {
    return invalid()
  }
  const kind = ownDataValue(value, 'refutation_kind')
  if (kind === 'start') {
    return shape({
      refutation_kind: oneOf('start'),
      player_commitment_hash: text,
      opponent_commitment_hash: text
    })(value, strict, depth)
  }
  if (kind !== 'move') {
    return invalid()
  }

  return shape({
    refutation_kind: oneOf('move'),
    choice: integer,
    step: (step, nestedStrict, nestedDepth) =>
      Array.isArray(step)
        ? array(shape({ state: optional(text), tick: natural }))(step, nestedStrict, nestedDepth)
        : shape({ pvm_step: hex, input_proof: optional(inputProof) })(
            step,
            nestedStrict,
            nestedDepth
          )
  })(value, strict, depth)
}
const operationFields: Record<WalletPartialTezosOperation['kind'], Record<string, Field>> = {
  transaction: { amount: integer, destination: text, parameters: optional(parameters) },
  origination: { balance: integer, delegate: optional(text), script },
  delegation: { delegate: optional(text) },
  reveal: { public_key: text, proof: optional(text) },
  set_deposits_limit: { limit: optional(integer) },
  register_global_constant: { value: micheline },
  transfer_ticket: {
    ticket_contents: micheline,
    ticket_ty: micheline,
    ticket_ticketer: text,
    ticket_amount: integer,
    destination: text,
    entrypoint: text
  },
  increase_paid_storage: { amount: integer, destination: text },
  update_companion_key: { pk: text, proof: optional(text) },
  smart_rollup_originate: {
    pvm_kind: oneOf('wasm_2_0_0', 'arith', 'riscv'),
    kernel: hex,
    parameters_ty: micheline,
    whitelist: optional(array(text))
  },
  smart_rollup_add_messages: { message: array(hex) },
  smart_rollup_execute_outbox_message: {
    rollup: text,
    cemented_commitment: text,
    output_proof: hex
  },
  smart_rollup_publish: {
    rollup: text,
    commitment: shape({
      compressed_state: text,
      inbox_level: natural,
      predecessor: text,
      number_of_ticks: integer
    })
  },
  smart_rollup_cement: { rollup: text, commitment: text },
  smart_rollup_recover_bond: { rollup: text, staker: text },
  smart_rollup_refute: { rollup: text, opponent: text, refutation },
  smart_rollup_timeout: { rollup: text, stakers: shape({ alice: text, bob: text }) },
  dal_publish_commitment: {
    slot_header: shape({ slot_index: natural, commitment: text, commitment_proof: text })
  }
}

const isSupportedKind = (value: string): value is WalletPartialTezosOperation['kind'] =>
  Object.prototype.hasOwnProperty.call(operationFields, value)

const parseOperation = (value: unknown, strict: boolean): WalletPartialTezosOperation => {
  if (!isRecord(value)) {
    return invalid()
  }
  const kind = ownDataValue(value, 'kind')
  if (typeof kind !== 'string' || !isSupportedKind(kind)) {
    return invalid()
  }
  const fields = operationFields[kind]
  const limit = (input: unknown): unknown => {
    try {
      return integer(input, strict, 0)
    } catch {
      return undefined
    }
  }
  const result = shape({
    kind: oneOf(kind),
    ...fields,
    gas_limit: optional(strict ? integer : limit),
    storage_limit: optional(strict ? integer : limit)
  })(value, strict, 0) as WalletPartialTezosOperation
  // Sanitizing invalid optional limits removes them rather than emitting undefined properties.
  if (result.gas_limit === undefined) {
    delete result.gas_limit
  }
  if (result.storage_limit === undefined) {
    delete result.storage_limit
  }

  return result
}

/** Strict shape guard for the supported wallet manager subset, including absence of untrusted fields. */
export const isPartialTezosOperation = (
  value: unknown
): value is ValidatedWalletPartialTezosOperation => {
  try {
    parseOperation(value, true)

    return true
  } catch {
    return false
  }
}

/** Clone and sanitize a batch, or reject the original item index; no operation is silently removed. */
export const sanitizePartialTezosOperations = (
  operations: readonly unknown[]
): WalletPartialTezosOperation[] => {
  if (!Array.isArray(operations)) {
    throw new TypeError('Expected an operation array')
  }

  const result: WalletPartialTezosOperation[] = []
  for (let index = 0; index < operations.length; index++) {
    try {
      result.push(parseOperation(ownDataValue(operations, index), false))
    } catch {
      throw new TypeError(`Invalid wallet operation at index ${index}`)
    }
  }

  return result
}
