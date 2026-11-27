const MAX_DECODE_WORK = 4 * 1024 * 1024
const MAX_DEPTH = 64
const MICHELSON_PUSH = 0x43

/** Bound the supported codec's repeated child reads without decoding values or primitive names. */
export const assertMichelineBudget = (hex: string): void => {
  let offset = 1
  let remainingWork = MAX_DECODE_WORK
  const end = hex.length / 2
  const unsupported = (): never => {
    throw new TypeError('Invalid or unsupported packed Micheline data')
  }
  const charge = (units: number, weight: number): void => {
    // Divide before multiplying so rejected work cannot overflow the budget arithmetic.
    if (units > remainingWork / weight) {
      unsupported()
    }
    remainingWork -= units * weight
  }
  const readByte = (limit: number, weight: number): number => {
    if (offset >= limit) {
      return unsupported()
    }
    charge(1, weight)
    const byte = parseInt(hex.slice(offset * 2, offset * 2 + 2), 16)
    offset++

    return byte
  }
  const readLength = (limit: number, weight: number): number => {
    let length = 0
    for (let index = 0; index < 4; index++) {
      length = length * 256 + readByte(limit, weight)
    }
    if (length > limit - offset) {
      return unsupported()
    }

    return length
  }
  const skipLength = (limit: number, weight: number): void => {
    const length = readLength(limit, weight)
    charge(length, weight)
    offset += length
  }
  const readExpression = (limit: number, weight: number, depth: number): void => {
    if (depth >= MAX_DEPTH) {
      unsupported()
    }
    charge(16, weight)
    const tag = readByte(limit, weight)
    switch (tag) {
      case 0: {
        let length = 0
        let byte: number
        do {
          byte = readByte(limit, weight)
          length++
          // Growing BigInt shifts in the codec need more than a linear byte allowance.
          charge(2 * length - 1, weight)
        } while (byte >= 128)
        break
      }
      case 1:
      case 10:
        skipLength(limit, weight)
        break
      case 2: {
        const length = readLength(limit, weight)
        const sequenceEnd = offset + length
        while (offset < sequenceEnd) {
          readExpression(sequenceEnd, weight * 2, depth + 1)
        }
        break
      }
      default: {
        if (tag < 3 || tag > 9) {
          unsupported()
        }
        // PUSH activates typed conversions during both decoding and canonical repacking.
        if (readByte(limit, weight) === MICHELSON_PUSH) {
          unsupported()
        }
        const arity = Math.floor((tag - 3) / 2)
        if (arity < 3) {
          for (let index = 0; index < arity; index++) {
            readExpression(limit, weight * 2, depth + 1)
          }
        } else {
          const length = readLength(limit, weight)
          const argsEnd = offset + length
          while (offset < argsEnd) {
            readExpression(argsEnd, weight * 2, depth + 1)
          }
        }
        if (tag % 2 === 0 || tag === 9) {
          skipLength(limit, weight)
        }
      }
    }
  }

  // Both supported untyped codec decoders visit sequence and primitive children twice.
  readExpression(end, 1, 0)
  if (offset !== end) {
    unsupported()
  }
}
