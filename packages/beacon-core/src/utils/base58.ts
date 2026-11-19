// The legacy converter scans an ever-growing digit array for every input byte.
// Balanced splits let the BigInt implementation handle large products and divisions.
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const radix = BigInt(58)
// Eight Base58 digits fit exactly in a JavaScript number.
const leafDigits = 8

function radixPowers(): (digits: number) => bigint {
  const powers = new Map<number, bigint>([
    [0, BigInt(1)],
    [1, radix]
  ])

  return function powerOf58(digits: number): bigint {
    let power = powers.get(digits)
    if (power === undefined) {
      const half = powerOf58(Math.floor(digits / 2))
      power = half * half
      if (digits % 2 !== 0) {
        power *= radix
      }
      powers.set(digits, power)
    }

    return power
  }
}

// JavaScriptCore limits individual BigInts to roughly one megabit. Convert
// larger inputs a block at a time so even a product of two blocks fits.
const hexBlockDigits = 64 * 1024
const base58BlockDigits = 44 * 1024

function hexBlockRadix(): bigint {
  // One followed by hexBlockDigits zero nibbles.
  // eslint-disable-next-line no-bitwise
  return BigInt(1) << BigInt(4 * hexBlockDigits)
}

function convertBlocks(
  input: string,
  blockSize: number,
  readBlock: (digits: string) => bigint,
  inputRadix: bigint,
  outputRadix: bigint
): bigint[] {
  const blocks: bigint[] = []
  const firstWidth = input.length % blockSize || blockSize
  for (let end = firstWidth; end <= input.length; end += blockSize) {
    let carry = readBlock(input.slice(Math.max(0, end - blockSize), end))
    for (let i = 0; i < blocks.length; i++) {
      const value = blocks[i] * inputRadix + carry
      blocks[i] = value % outputRadix
      carry = value / outputRadix
    }
    while (carry > BigInt(0)) {
      blocks.push(carry % outputRadix)
      carry /= outputRadix
    }
  }

  return blocks.reverse()
}

export function encodeBase58(bytes: Buffer): string {
  const first = bytes.findIndex((byte) => byte !== 0)
  if (first < 0) {
    return '1'.repeat(bytes.length)
  }
  const power = radixPowers()

  function encode(value: bigint, width: number): string {
    if (width <= leafDigits) {
      let rest = Number(value)
      let digits = ''
      while (rest > 0) {
        digits = alphabet[rest % 58] + digits
        rest = Math.floor(rest / 58)
      }

      return digits.padStart(width, '1')
    }
    const lowWidth = Math.floor(width / 2)
    const divisor = power(lowWidth)

    return encode(value / divisor, width - lowWidth) + encode(value % divisor, lowWidth)
  }

  const hex = bytes.toString('hex', first)
  const readHex = (digits: string): bigint => BigInt(`0x${digits}`)
  let encoded: string
  if (hex.length <= hexBlockDigits) {
    const maxDigits = Math.ceil(((bytes.length - first) * 8) / Math.log2(58))
    encoded = encode(readHex(hex), maxDigits)
  } else {
    const blocks = convertBlocks(
      hex,
      hexBlockDigits,
      readHex,
      hexBlockRadix(),
      power(base58BlockDigits)
    )
    encoded = blocks.map((block) => encode(block, base58BlockDigits)).join('')
  }

  return '1'.repeat(first) + encoded.replace(/^1+/, '')
}

export function decodeBase58(wire: string): Buffer {
  if (/[^1-9A-HJ-NP-Za-km-z]/.test(wire)) {
    throw new Error('Non-base58 character')
  }
  const first = wire.search(/[^1]/)
  if (first < 0) {
    return Buffer.alloc(wire.length)
  }
  const power = radixPowers()

  function decode(digits: string, start: number, end: number): bigint {
    if (end - start <= leafDigits) {
      let value = 0
      for (let index = start; index < end; index++) {
        value = value * 58 + alphabet.indexOf(digits[index])
      }

      return BigInt(value)
    }
    const mid = start + Math.floor((end - start) / 2)

    return decode(digits, start, mid) * power(end - mid) + decode(digits, mid, end)
  }

  let hex: string
  if (wire.length - first <= base58BlockDigits) {
    hex = decode(wire, first, wire.length).toString(16)
  } else {
    const blocks = convertBlocks(
      wire.slice(first),
      base58BlockDigits,
      (digits) => decode(digits, 0, digits.length),
      power(base58BlockDigits),
      hexBlockRadix()
    )
    hex = blocks
      .map((block, index) => block.toString(16).padStart(index === 0 ? 1 : hexBlockDigits, '0'))
      .join('')
  }
  const bytes = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, 'hex')

  return first === 0 ? bytes : Buffer.concat([Buffer.alloc(first), bytes])
}
