import { beforeEach, expect, it, vi } from 'vitest'
import { SigningType } from '@ecadlabs/beacon-types'
import { packDataBytes, unpackDataBytes } from '@taquito/michel-codec'
import { inspectSignPayload } from '../src/wallet'

vi.mock('@taquito/michel-codec', async (importOriginal) => {
  const codec = await importOriginal<typeof import('@taquito/michel-codec')>()
  return {
    ...codec,
    unpackDataBytes: vi.fn(codec.unpackDataBytes),
    packDataBytes: vi.fn(codec.packDataBytes)
  }
})

beforeEach(() => {
  vi.mocked(unpackDataBytes).mockReset()
  vi.mocked(packDataBytes).mockReset()
})

it.each([
  ['repeated child decoding', '05' + '0509'.repeat(18) + '0306'],
  ['repeated scalar decoding', '05' + '0509'.repeat(3) + '0a00080000' + '00'.repeat(512 * 1024)],
  ['integer arithmetic', '0500' + '80'.repeat(2048) + '00']
])('rejects %s over budget before invoking the decoder', (_name, payload) => {
  // A mistaken budget gate must not send these fixtures through the expensive real decoder.
  vi.mocked(unpackDataBytes).mockImplementationOnce(() => {
    throw new Error('Decoder must not run')
  })
  const inspected = inspectSignPayload(payload, SigningType.MICHELINE)
  expect(unpackDataBytes).not.toHaveBeenCalled()
  expect(inspected).toMatchObject({
    valid: false,
    reason: expect.stringMatching(/unsupported/i)
  })
})

it.each([
  '05',
  '050b',
  '05010000000261',
  '050affffffff',
  '050200000003030b',
  '0509',
  '050907ffffffff',
  '05040b000000032561',
  '050080'
])('rejects malformed structural bounds before decoding %s', (payload) => {
  expect(inspectSignPayload(payload, SigningType.MICHELINE)).toMatchObject({ valid: false })
  expect(unpackDataBytes).not.toHaveBeenCalled()
})

it('preserves explicit RAW fallback when the preview exceeds its work budget', () => {
  const payload = '05' + '0509'.repeat(18) + '0306'
  vi.mocked(unpackDataBytes).mockImplementationOnce(() => {
    throw new Error('Decoder must not run')
  })
  expect(inspectSignPayload(payload, SigningType.RAW)).toEqual({
    valid: true,
    normalizedHex: payload,
    kind: 'raw_bytes',
    validation: 'hex'
  })
  expect(unpackDataBytes).not.toHaveBeenCalled()
})

it('skips both codec calls for a PUSH instruction at any depth', () => {
  // PUSH unit Unit and the same instruction inside a sequence inside Some.
  for (const payload of ['050743036c030b', '05050902000000060743036c030b']) {
    for (const signingType of [undefined, SigningType.MICHELINE]) {
      expect(inspectSignPayload(payload, signingType)).toMatchObject({
        valid: false,
        reason: expect.stringMatching(/unsupported/i)
      })
    }
    expect(inspectSignPayload(payload, SigningType.RAW)).toEqual({
      valid: true,
      kind: 'raw_bytes',
      normalizedHex: payload,
      validation: 'hex'
    })
  }
  expect(unpackDataBytes).not.toHaveBeenCalled()
  expect(packDataBytes).not.toHaveBeenCalled()
})

it('treats the PUSH opcode inside scalar data as ordinary bytes', () => {
  for (const payload of ['05010000000143', '050a0000000143']) {
    expect(inspectSignPayload(payload, SigningType.MICHELINE)).toMatchObject({
      valid: true,
      validation: 'canonical_micheline'
    })
  }
  expect(unpackDataBytes).not.toHaveBeenCalled()
  expect(packDataBytes).not.toHaveBeenCalled()
  const payload = '05020000000c0100000001430a0000000143'
  expect(inspectSignPayload(payload, SigningType.MICHELINE)).toMatchObject({
    valid: true,
    validation: 'canonical_micheline'
  })
  expect(unpackDataBytes).toHaveBeenCalledOnce()
  expect(packDataBytes).toHaveBeenCalledOnce()
})
