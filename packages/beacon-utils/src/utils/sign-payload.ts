import { SigningType } from '@ecadlabs/beacon-types'
import { packDataBytes, unpackDataBytes } from '@taquito/michel-codec'
import { assertMichelineBudget } from './micheline-budget'

export type SignPayloadInspection =
  | { valid: false; reason: string }
  | {
      valid: true
      normalizedHex: string
      kind: 'signed_message_text' | 'micheline'
      validation: 'canonical_micheline'
      decodedText?: string
    }
  | { valid: true; normalizedHex: string; kind: 'operation'; validation: 'watermark_only' }
  | { valid: true; normalizedHex: string; kind: 'raw_bytes'; validation: 'hex' }

const MAX_PAYLOAD_BYTES = 1024 * 1024
const SIGNED_MESSAGE_PREFIX = 'Tezos Signed Message: '
const HEX_DIGIT_CODES = Array.from('0123456789abcdef', (digit) => digit.charCodeAt(0))

const frameScalar = (tag: '01' | '0a', hex: string): string =>
  `05${tag}${(hex.length / 2).toString(16).padStart(8, '0')}${hex}`

const bytesToHex = (bytes: Uint8Array, decoder: TextDecoder): string => {
  const hex = new Uint8Array(bytes.length * 2)
  for (let input = 0, output = 0; input < bytes.length; input++, output += 2) {
    const byte = bytes[input]
    hex[output] = HEX_DIGIT_CODES[Math.floor(byte / 16)]
    hex[output + 1] = HEX_DIGIT_CODES[byte % 16]
  }

  return decoder.decode(hex)
}

/**
 * Pack the exact supplied UTF-8 text as a Micheline string (0501 + byte length + bytes).
 * Callers add their own message prefix/domain/nonce. This does not construct an authentication protocol.
 */
export const packMessageText = (text: string): string => {
  if (typeof text !== 'string') {
    throw new TypeError('Expected message text')
  }
  if (text.length + 6 > MAX_PAYLOAD_BYTES) {
    throw new RangeError('Signing payload exceeds 1 MiB')
  }
  const bytes = new TextEncoder().encode(text)
  if (bytes.length + 6 > MAX_PAYLOAD_BYTES) {
    throw new RangeError('Signing payload exceeds 1 MiB')
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  if (decoder.decode(bytes) !== text) {
    throw new TypeError('Invalid Unicode message text')
  }

  return frameScalar('01', bytesToHex(bytes, decoder))
}

const lowercaseHexNibble = (code: number): number => (code <= 57 ? code - 48 : code - 87)

const isEvenLengthHex = (hex: string): boolean =>
  hex.length !== 0 && hex.length % 2 === 0 && !/[^0-9a-f]/.test(hex)

const inspectMicheline = (normalizedHex: string): SignPayloadInspection => {
  try {
    assertMichelineBudget(normalizedHex)
    let decodedText: string | undefined
    if (normalizedHex.startsWith('0501')) {
      // The hex check and budget scan have already validated the complete scalar frame.
      const bytes = new Uint8Array(normalizedHex.length / 2 - 6)
      for (let output = 0, input = 12; output < bytes.length; output++, input += 2) {
        const high = lowercaseHexNibble(normalizedHex.charCodeAt(input))
        const low = lowercaseHexNibble(normalizedHex.charCodeAt(input + 1))
        bytes[output] = high * 16 + low
      }
      decodedText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } else if (!normalizedHex.startsWith('050a')) {
      const decoded = unpackDataBytes({ bytes: normalizedHex })
      if (packDataBytes(decoded).bytes !== normalizedHex) {
        return { valid: false, reason: 'Unsupported or noncanonical packed Micheline encoding' }
      }
    }

    return {
      valid: true,
      normalizedHex,
      kind: decodedText?.startsWith(SIGNED_MESSAGE_PREFIX) ? 'signed_message_text' : 'micheline',
      validation: 'canonical_micheline',
      ...(decodedText !== undefined ? { decodedText } : {})
    }
  } catch {
    return { valid: false, reason: 'Invalid or unsupported packed Micheline data' }
  }
}

/**
 * Inspect hex signing bytes without changing requests or inferring RAW text encoding.
 * A successful operation result validates its 03 watermark only, not forged operation contents.
 */
export const inspectSignPayload = (
  payload: string,
  signingType?: SigningType
): SignPayloadInspection => {
  if (typeof payload !== 'string') {
    return { valid: false, reason: 'Expected hex payload' }
  }
  if (payload.length > MAX_PAYLOAD_BYTES * 2 + 2) {
    return { valid: false, reason: 'Signing payload exceeds 1 MiB' }
  }
  const normalizedHex = (
    payload.startsWith('0x') || payload.startsWith('0X') ? payload.slice(2) : payload
  ).toLowerCase()
  if (!isEvenLengthHex(normalizedHex)) {
    return { valid: false, reason: 'Expected nonempty, even-length hex payload' }
  }
  if (normalizedHex.length / 2 > MAX_PAYLOAD_BYTES) {
    return { valid: false, reason: 'Signing payload exceeds 1 MiB' }
  }
  if (signingType !== undefined && !Object.values(SigningType).includes(signingType)) {
    return { valid: false, reason: 'Unsupported signing type' }
  }
  if (signingType === SigningType.MICHELINE) {
    return normalizedHex.startsWith('05')
      ? inspectMicheline(normalizedHex)
      : { valid: false, reason: 'Micheline payload requires 05 prefix' }
  }
  if (
    signingType === SigningType.OPERATION ||
    (normalizedHex.startsWith('03') && normalizedHex.length > 2)
  ) {
    return normalizedHex.startsWith('03') && normalizedHex.length > 2
      ? { valid: true, normalizedHex, kind: 'operation', validation: 'watermark_only' }
      : { valid: false, reason: 'Operation payload requires 03 watermark and payload bytes' }
  }
  if (normalizedHex.startsWith('05')) {
    const inspected = inspectMicheline(normalizedHex)
    if (inspected.valid || signingType !== SigningType.RAW) {
      return inspected
    }
  }

  return { valid: true, normalizedHex, kind: 'raw_bytes', validation: 'hex' }
}
