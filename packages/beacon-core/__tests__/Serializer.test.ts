import { createHash } from 'node:crypto'
import bs58check from 'bs58check'
import { describe, expect, it } from 'vitest'
import { Serializer } from '../src/Serializer'

const serializer = new Serializer()

function legacyEncode(message: unknown): string {
  return bs58check.encode(Buffer.from(JSON.stringify(message)))
}

describe('Beacon message serialization', () => {
  it.each([0, 1, 255, 1023, 1024, 1025, 4095, 4096, 4097])(
    'exchanges Unicode payloads of length %i with legacy peers',
    async (length) => {
      const message = {
        operationDetails: [{ parameters: { value: { string: '🍵é'.repeat(length) } } }]
      }
      const legacyWire = legacyEncode(message)
      expect(await serializer.serialize(message)).toBe(legacyWire)
      expect(await serializer.deserialize(legacyWire)).toEqual(message)
    }
  )

  const wire = legacyEncode({ payload: 'a'.repeat(8192) })
  // Legacy wire suffixes for this fixture, with one bit flipped in each checksum byte.
  it.each(['KA6xrbaN', 'KA6zLvLe', 'KA6zLanJ', 'KA6zLarh'])(
    'validates the full checksum (corrupted suffix %s)',
    async (suffix) => {
      expect(wire.slice(-8)).toBe('KA6zLari')
      await expect(serializer.deserialize(wire.slice(0, -8) + suffix)).rejects.toThrow()
    }
  )
  const middle = Math.floor(wire.length / 2)
  const unicodeAlias = String.fromCharCode(wire.charCodeAt(middle) + 256)
  it.each([
    ['non-ASCII digit', wire.slice(0, middle) + unicodeAlias + wire.slice(middle + 1)],
    ['invalid digit', wire.slice(0, -1) + '0'],
    ['extra leading zero', '1' + wire]
  ])('rejects a large message with %s', async (_, corrupted) => {
    await expect(serializer.deserialize(corrupted)).rejects.toThrow()
  })

  it('rejects checksum-valid data containing invalid JSON', async () => {
    const malformed = bs58check.encode(Buffer.from('{'.repeat(8192)))
    await expect(serializer.deserialize(malformed)).rejects.toThrow(SyntaxError)
  })

  it('exchanges a 128 KiB message across multiple conversion blocks', async () => {
    const message = { payload: 'x'.repeat(128 * 1024) }
    const encoded = await serializer.serialize(message)
    // Digest of the complete Base58Check string from an independent reference conversion.
    expect(createHash('sha256').update(encoded).digest('hex')).toBe(
      '069c7ed6d0e0dc75ec3cbff1277e2054f2d186dca7f718b5a97ea7b665fc0898'
    )
    expect(await serializer.deserialize(encoded)).toEqual(message)
  })

  it('encodes and decodes large operation requests faster than the legacy codec', async () => {
    const message = {
      type: 'operation_request',
      operationDetails: [
        {
          kind: 'transaction',
          parameters: { entrypoint: 'default', value: { string: 'x'.repeat(16384) } }
        }
      ]
    }
    const start = performance.now()
    const legacyWire = legacyEncode(message)
    const encoded = performance.now()
    bs58check.decode(legacyWire)
    const decoded = performance.now()
    const wire = await serializer.serialize(message)
    const endEncode = performance.now()
    const result = await serializer.deserialize(legacyWire)
    const endDecode = performance.now()

    expect(wire).toBe(legacyWire)
    expect(result).toEqual(message)
    expect.soft(endEncode - decoded).toBeLessThan((encoded - start) / 4)
    expect.soft(endDecode - endEncode).toBeLessThan((decoded - encoded) / 4)
  })
})
