import { sha256 } from '@noble/hashes/sha2.js'
import bs58check from 'bs58check'
import { decodeBase58, encodeBase58 } from './utils/base58'

// Keep the existing lightweight path for small pairing and control messages.
const largePayloadBytes = 1024
const checksumBytes = 4
const largeWireDigits = Math.ceil(((largePayloadBytes + checksumBytes) * 8) / Math.log2(58))

function checksum(payload: Uint8Array): Buffer {
  return Buffer.from(sha256(sha256(Uint8Array.from(payload))).subarray(0, checksumBytes))
}

/**
 * @internalapi
 *
 * The Serializer is used to serialize / deserialize JSON objects and encode them with bs58check
 */
export class Serializer {
  /**
   * Serialize and bs58check encode an object
   *
   * @param message JSON object to serialize
   */
  public async serialize(message: unknown): Promise<string> {
    const str = JSON.stringify(message)

    const bytes = Buffer.from(str)
    if (bytes.length < largePayloadBytes) {
      return bs58check.encode(bytes)
    }

    return encodeBase58(Buffer.concat([bytes, checksum(bytes)]))
  }

  /**
   * Deserialize a bs58check encoded string
   *
   * @param encoded String to be deserialized
   */
  public async deserialize(encoded: string): Promise<unknown> {
    if (typeof encoded !== 'string') {
      throw new Error('Encoded payload needs to be a string')
    }

    if (encoded.length >= largeWireDigits) {
      const raw = decodeBase58(encoded)
      const payloadLength = raw.length - checksumBytes
      const expected = checksum(raw.subarray(0, payloadLength))
      if (raw.readUInt32BE(payloadLength) !== expected.readUInt32BE(0)) {
        throw new Error('Invalid checksum')
      }

      return JSON.parse(raw.toString('utf8', 0, payloadLength))
    }
    const decodedBytes = bs58check.decode(encoded)
    const jsonString = Buffer.from(decodedBytes).toString('utf8')

    return JSON.parse(jsonString)
  }
}
