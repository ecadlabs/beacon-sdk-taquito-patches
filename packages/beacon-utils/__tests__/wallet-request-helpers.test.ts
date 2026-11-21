import { describe, expect, it } from 'vitest'
import tz5 from '../../../test-fixtures/tz5-account.json'
import { SigningType } from '@ecadlabs/beacon-types'
import { packDataBytes } from '@taquito/michel-codec'
import { managerOperations as operations } from './type-fixtures/manager-operations'
import {
  packMessageText,
  inspectSignPayload,
  isPartialTezosOperation,
  sanitizePartialTezosOperations
} from '../src/wallet'

describe('wallet manager operation helpers', () => {
  it('preserves tz5 destinations and mdpk reveal keys from the shared account fixture', () => {
    const operations = [
      { kind: 'transaction', amount: '0', destination: tz5.publicKeyHash },
      { kind: 'reveal', public_key: tz5.publicKey }
    ]
    for (const operation of operations) {
      expect(isPartialTezosOperation(operation)).toBe(true)
    }
    expect(sanitizePartialTezosOperations(operations)).toEqual(operations)
  })

  it('rejects present undefined optional fields while sanitizing them away', () => {
    const delegation = { kind: 'delegation', delegate: undefined }
    const constant = {
      kind: 'register_global_constant',
      value: { prim: 'Some', args: undefined, annots: undefined }
    }
    expect(isPartialTezosOperation(delegation)).toBe(false)
    expect(isPartialTezosOperation(constant)).toBe(false)
    expect(sanitizePartialTezosOperations([delegation, constant])).toEqual([
      { kind: 'delegation' },
      { kind: 'register_global_constant', value: { prim: 'Some' } }
    ])
    expect(Object.hasOwn(delegation, 'delegate')).toBe(true)
    expect(isPartialTezosOperation({ kind: 'delegation' })).toBe(true)
    expect(isPartialTezosOperation({ kind: 'delegation', delegate: 'tz1delegate' })).toBe(true)
  })

  it.each(['kind', 'amount', 'destination'])(
    'rejects a non-enumerable transaction %s while sanitation preserves its wire value',
    (field) => {
      const operation = { kind: 'transaction', amount: '0', destination: 'tz1destination' }
      Object.defineProperty(operation, field, { enumerable: false })
      expect(isPartialTezosOperation(operation)).toBe(false)
      const [sanitized] = sanitizePartialTezosOperations([operation])
      expect(isPartialTezosOperation(sanitized)).toBe(true)
      expect(JSON.parse(JSON.stringify(sanitized))).toEqual({
        kind: 'transaction',
        amount: '0',
        destination: 'tz1destination'
      })
    }
  )

  it.each(['int', 'prim'])(
    'rejects a non-enumerable Micheline %s while sanitation preserves it',
    (field) => {
      const value = field === 'int' ? { int: '1' } : { prim: 'Unit' }
      Object.defineProperty(value, field, { enumerable: false })
      const operation = { kind: 'register_global_constant', value }
      expect(isPartialTezosOperation(operation)).toBe(false)
      const [sanitized] = sanitizePartialTezosOperations([operation])
      expect(isPartialTezosOperation(sanitized)).toBe(true)
      expect(JSON.parse(JSON.stringify(sanitized))).toEqual({
        kind: 'register_global_constant',
        value: field === 'int' ? { int: '1' } : { prim: 'Unit' }
      })
    }
  )

  it('rejects non-enumerable optional record fields without dropping them during sanitation', () => {
    const operation = { kind: 'delegation', delegate: 'tz1delegate' }
    Object.defineProperty(operation, 'delegate', { enumerable: false })
    expect(isPartialTezosOperation(operation)).toBe(false)
    expect(JSON.parse(JSON.stringify(sanitizePartialTezosOperations([operation])))).toEqual([
      { kind: 'delegation', delegate: 'tz1delegate' }
    ])
  })

  it('accepts non-enumerable array indices because JSON retains indexed values', () => {
    const message = ['aa']
    Object.defineProperty(message, 0, { enumerable: false })
    const operation = { kind: 'smart_rollup_add_messages', message }
    expect(isPartialTezosOperation(operation)).toBe(true)
    expect(JSON.parse(JSON.stringify(operation))).toEqual({
      kind: 'smart_rollup_add_messages',
      message: ['aa']
    })
  })

  it('requires ordinary dense arrays with only indexed data properties', () => {
    const messages = (message: unknown) => ({ kind: 'smart_rollup_add_messages', message })
    const shadowed = Object.assign(['aa'], { map: null })
    const extra = Object.defineProperty(['aa'], '00', { value: 'aa' })
    const holeWithExtraKey = Object.assign(new Array(1), { '01': 'aa' })
    const symbol = Object.assign(['aa'], { [Symbol('extra')]: true })
    const customPrototype = Object.setPrototypeOf(['aa'], Object.create(Array.prototype))
    const accessor = Object.defineProperty(['aa'], 0, { get: () => 'aa' })
    for (const array of [
      shadowed,
      structuredClone(shadowed),
      extra,
      holeWithExtraKey,
      symbol,
      customPrototype,
      accessor
    ]) {
      expect(isPartialTezosOperation(messages(array))).toBe(false)
    }
    expect(isPartialTezosOperation(messages(['aa']))).toBe(true)
  })

  it('sanitizes indexed items into fresh arrays even when batch and nested iterators are overridden', () => {
    const overrides = {
      map: null,
      [Symbol.iterator]() {
        throw new Error('An input iterator was invoked')
      }
    }
    const message = Object.assign(['aa'], overrides)
    const batch = Object.assign([{ kind: 'smart_rollup_add_messages', message }], overrides)
    const [sanitized] = sanitizePartialTezosOperations(batch)
    expect(sanitized).toEqual({ kind: 'smart_rollup_add_messages', message: ['aa'] })
    if (sanitized.kind !== 'smart_rollup_add_messages') {
      throw new Error('Unexpected operation kind')
    }
    expect(sanitized.message).not.toBe(message)
    expect(sanitized.message.map((item) => item.toUpperCase())).toEqual(['AA'])
    expect(Reflect.ownKeys(sanitized.message)).toEqual(['0', 'length'])
    expect(isPartialTezosOperation(sanitized)).toBe(true)
  })

  it('rejects accessor fields and discriminants without invoking them', () => {
    let reads = 0
    const accessor = {
      get() {
        reads++
        return 'delegation'
      }
    }
    const kind = Object.defineProperty({}, 'kind', accessor)
    const delegate = Object.defineProperty({ kind: 'delegation' }, 'delegate', accessor)
    const message = Object.defineProperty(['aa'], 0, accessor)
    const refutation = Object.defineProperty({}, 'refutation_kind', accessor)
    const rollup = {
      kind: 'smart_rollup_refute',
      rollup: 'sr1rollup',
      opponent: 'tz1opponent',
      refutation
    }
    for (const operation of [
      kind,
      delegate,
      rollup,
      { kind: 'smart_rollup_add_messages', message }
    ]) {
      expect(isPartialTezosOperation(operation)).toBe(false)
      expect(() => sanitizePartialTezosOperations([operation])).toThrow(/index 0/)
    }
    expect(reads).toBe(0)
  })

  it('rejects sparse operation batches and sparse nested sequences', () => {
    expect(() => sanitizePartialTezosOperations(new Array(1))).toThrow(/index 0/)
    expect(isPartialTezosOperation({ kind: 'register_global_constant', value: new Array(1) })).toBe(
      false
    )
  })

  it.each([
    'UNPAIR',
    'PUSH',
    'VIEW',
    'EMIT',
    'Lambda_rec',
    'constant',
    'SUB_MUTEZ',
    'ticket',
    'TICKET',
    'Ticket'
  ])('accepts the codec-known primitive %s during structural inspection', (prim) => {
    const operation = { kind: 'register_global_constant', value: { prim } }
    expect(isPartialTezosOperation(operation)).toBe(true)
    expect(sanitizePartialTezosOperations([operation])).toEqual([operation])
  })
  it('preserves an origination using UNPAIR and a Ticket parameter value', () => {
    const origination = {
      kind: 'origination',
      balance: '0',
      script: {
        code: [
          { prim: 'parameter', args: [{ prim: 'unit' }] },
          { prim: 'storage', args: [{ prim: 'unit' }] },
          {
            prim: 'code',
            args: [
              [
                { prim: 'UNPAIR' },
                { prim: 'DROP' },
                { prim: 'PUSH', args: [{ prim: 'unit' }, { prim: 'Unit' }] },
                { prim: 'DROP' },
                { prim: 'NIL', args: [{ prim: 'operation' }] },
                { prim: 'PAIR' }
              ]
            ]
          }
        ],
        storage: { prim: 'Unit' }
      }
    }
    const transaction = {
      kind: 'transaction',
      amount: '0',
      destination: 'KT1GFkBEDZtngCS737gNgtt6LemG2a8kaifC',
      parameters: {
        entrypoint: 'default',
        value: {
          prim: 'Ticket',
          args: [
            { string: 'KT1GFkBEDZtngCS737gNgtt6LemG2a8kaifC' },
            { prim: 'unit' },
            { prim: 'Unit' },
            { int: '1' }
          ]
        }
      }
    }
    expect(isPartialTezosOperation(origination)).toBe(true)
    expect(isPartialTezosOperation(transaction)).toBe(true)
    expect(sanitizePartialTezosOperations([origination, transaction])).toEqual([
      origination,
      transaction
    ])
  })
  it.each(['-0', '00', '01', '-01'])('preserves accepted Micheline decimal spelling %j', (int) => {
    const operation = { kind: 'register_global_constant', value: { int } }
    expect(isPartialTezosOperation(operation)).toBe(true)
    expect(sanitizePartialTezosOperations([operation])).toEqual([operation])
  })
  it.each(['0', '1', '-1'])('preserves canonical Micheline integer %j', (int) => {
    const operation = { kind: 'register_global_constant', value: { int } }
    expect(isPartialTezosOperation(operation)).toBe(true)
    expect(sanitizePartialTezosOperations([operation])).toEqual([operation])
  })
  it.each(operations)('preserves the supported $kind fields', (operation) => {
    expect(isPartialTezosOperation(operation)).toBe(true)
    expect(sanitizePartialTezosOperations([operation])).toEqual([operation])
  })
  it('strips wallet-owned and unknown fields without mutating input or nested values', () => {
    const input = {
      ...operations[0],
      source: 'spoof',
      fee: '1',
      counter: '2',
      injected: true,
      gas_limit: '100',
      storage_limit: '2.5',
      parameters: { entrypoint: 'default', value: { int: '7', source: 'spoof' }, extra: true }
    }
    const before = JSON.stringify(input)
    const result = sanitizePartialTezosOperations([input])
    expect(result).toEqual([{ ...operations[0], gas_limit: '100' }])
    expect(JSON.stringify(input)).toBe(before)
    expect(result[0]).not.toBe(input)
    expect(isPartialTezosOperation(input)).toBe(false)
  })
  it.each(['-1', '1.5', '', ' 2 ', 2, NaN])(
    'strips a noncanonical gas/storage value %s',
    (limit) => {
      expect(
        sanitizePartialTezosOperations([
          { kind: 'delegation', gas_limit: limit, storage_limit: limit }
        ])
      ).toEqual([{ kind: 'delegation' }])
    }
  )
  it.each([
    null,
    [],
    { kind: 'endorsement' },
    { kind: 'transaction', amount: 1, destination: 'tz1' },
    { kind: 'transaction', amount: '-1', destination: 'tz1' },
    { kind: 'origination', balance: '0' },
    { kind: 'register_global_constant', value: { prim: 'NOT_A_PRIMITIVE' } },
    ...['__proto__', 'constructor', 'toString', '', '1ADD', 'ADD;DROP', 'a-b'].map((prim) => ({
      kind: 'register_global_constant',
      value: { prim }
    }))
  ])('rejects invalid or unsupported input %j', (operation) => {
    expect(isPartialTezosOperation(operation)).toBe(false)
    expect(() => sanitizePartialTezosOperations([operations[0], operation])).toThrow(/index 1/)
  })
  it('rejects malformed nested refutations and cyclic or overdeep Micheline', () => {
    const recursive: { prim: string; args?: unknown[] } = { prim: 'Pair' }
    recursive.args = [recursive]
    expect(isPartialTezosOperation({ kind: 'register_global_constant', value: recursive })).toBe(
      false
    )
    expect(
      isPartialTezosOperation({
        ...operations[15],
        refutation: { refutation_kind: 'move', choice: '0', step: [{ tick: -1 }] }
      })
    ).toBe(false)
  })
  it('preserves move/proof forms and strips nested untrusted properties', () => {
    const operation = {
      ...operations[15],
      refutation: {
        refutation_kind: 'move',
        choice: '0',
        step: {
          pvm_step: '00',
          extra: true,
          input_proof: {
            input_proof_kind: 'reveal_proof',
            reveal_proof: {
              reveal_proof_kind: 'dal_page_proof',
              dal_page_id: { published_level: 1, slot_index: 0, page_index: 0 },
              dal_proof: '00'
            }
          }
        }
      }
    }
    const result = sanitizePartialTezosOperations([operation])
    expect(JSON.stringify(result)).not.toContain('extra')
    expect(isPartialTezosOperation(result[0])).toBe(true)
  })
})

describe('signing payload inspection', () => {
  it.each(['', 'hello', 'é', '🌍', '\uFEFFa'])(
    'packs scalar text identically to the codec for %j',
    (text) => {
      const payload = packMessageText(text)
      expect(payload).toBe(packDataBytes({ string: text }).bytes)
      expect(inspectSignPayload(payload, SigningType.MICHELINE)).toMatchObject({
        valid: true,
        decodedText: text
      })
    }
  )

  it.each(['', '00', 'ff00ab'])('retains canonical scalar byte framing for %j', (bytes) => {
    const payload = packDataBytes({ bytes }).bytes
    expect(inspectSignPayload(payload, SigningType.MICHELINE)).toMatchObject({
      valid: true,
      normalizedHex: payload
    })
  })

  it.each([
    '050007',
    '05010000000161',
    '050200000002030b',
    '05030b',
    '05040b000000022561',
    '0505090306',
    '0506090306000000022561',
    '050707030b030b',
    '050807030b030b000000022561',
    '05090700000006030b030b030b00000000',
    '050a0000000100',
    '05050905090a000000020000'
  ])('retains canonical Micheline tag and nested decoding for %s', (payload) => {
    expect(inspectSignPayload(payload, SigningType.MICHELINE)).toMatchObject({
      valid: true,
      validation: 'canonical_micheline'
    })
  })

  it('supports a flat string at the encoded byte limit', () => {
    const text = 'a'.repeat(1024 * 1024 - 6)
    const payload = packMessageText(text)
    expect(payload.length / 2).toBe(1024 * 1024)
    expect(payload.startsWith('0501000ffffa')).toBe(true)
    expect(inspectSignPayload(payload, SigningType.MICHELINE)).toMatchObject({
      valid: true,
      decodedText: text
    })
  })

  it('supports a flat byte value at the encoded byte limit', () => {
    const payload = '050a000ffffa' + 'ab'.repeat(1024 * 1024 - 6)
    expect(inspectSignPayload(payload, SigningType.MICHELINE)).toMatchObject({
      valid: true,
      normalizedHex: payload
    })
    expect(() => packMessageText('a'.repeat(1024 * 1024 - 5))).toThrow(/1 MiB/)
  })

  it('preserves BOM-leading text and recognizes packed previews for explicit RAW requests', () => {
    expect(packMessageText('\uFEFFa')).toBe('050100000004efbbbf61')
    expect(inspectSignPayload('050100000004efbbbf61', SigningType.MICHELINE)).toMatchObject({
      valid: true,
      decodedText: '\uFEFFa'
    })
    expect(() => packMessageText('\ud800')).toThrow(/Unicode/)
    expect(
      inspectSignPayload(packMessageText('Tezos Signed Message: hello'), SigningType.RAW)
    ).toMatchObject({ valid: true, kind: 'signed_message_text' })
    expect(inspectSignPayload('0300', SigningType.RAW)).toMatchObject({
      valid: true,
      kind: 'operation',
      validation: 'watermark_only'
    })
    expect(inspectSignPayload('05ff', SigningType.RAW)).toMatchObject({
      valid: true,
      kind: 'raw_bytes',
      validation: 'hex'
    })
  })

  it('encodes UTF-8 byte length and only labels the signed-message convention when present', () => {
    expect(packMessageText('é')).toBe('050100000002c3a9')
    expect(inspectSignPayload(packMessageText('é'), SigningType.MICHELINE)).toMatchObject({
      valid: true,
      kind: 'micheline',
      decodedText: 'é',
      validation: 'canonical_micheline'
    })
    const text = 'Tezos Signed Message: example.org hello 🌍'
    const encoded = packMessageText(text)
    expect(inspectSignPayload('0x' + encoded.toUpperCase())).toMatchObject({
      valid: true,
      kind: 'signed_message_text',
      decodedText: text,
      normalizedHex: encoded
    })
  })
  it('reports a valid nested BOM string as unsupported by the current canonical decoder', () => {
    expect(inspectSignPayload('0502000000090100000004efbbbf61', SigningType.MICHELINE)).toEqual({
      valid: false,
      reason: 'Unsupported or noncanonical packed Micheline encoding'
    })
  })
  it('accepts complete canonical packed data and rejects malformed/trailing/noncanonical bytes', () => {
    expect(inspectSignPayload('050007', SigningType.MICHELINE)).toMatchObject({
      valid: true,
      kind: 'micheline'
    })
    for (const payload of [
      '05',
      '05010000000261',
      '050100000001ff',
      '0501000000016100',
      '050100000002c0af',
      '050100000003eda080',
      '050100000004f4908080',
      '05000700',
      '05008000'
    ]) {
      expect(inspectSignPayload(payload, SigningType.MICHELINE)).toMatchObject({ valid: false })
    }
  })
  it('keeps raw input hex-only and explicitly limits operation inspection to its watermark', () => {
    expect(inspectSignPayload('hello', SigningType.RAW)).toMatchObject({ valid: false })
    expect(inspectSignPayload('a', SigningType.RAW)).toMatchObject({ valid: false })
    expect(inspectSignPayload(' 00', SigningType.RAW)).toMatchObject({ valid: false })
    expect(inspectSignPayload('0xABCD', SigningType.RAW)).toEqual({
      valid: true,
      normalizedHex: 'abcd',
      kind: 'raw_bytes',
      validation: 'hex'
    })
    expect(inspectSignPayload('0300', SigningType.OPERATION)).toEqual({
      valid: true,
      normalizedHex: '0300',
      kind: 'operation',
      validation: 'watermark_only'
    })
    expect(inspectSignPayload('050007', SigningType.OPERATION)).toMatchObject({ valid: false })
    expect(inspectSignPayload('03', SigningType.OPERATION)).toMatchObject({ valid: false })
    expect(inspectSignPayload('03', SigningType.RAW)).toEqual({
      valid: true,
      normalizedHex: '03',
      kind: 'raw_bytes',
      validation: 'hex'
    })
  })
})
