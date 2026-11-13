import { hash } from '@stablelib/blake2b'
import bs58check from 'bs58check'
import { reportDiagnostic } from './Logger'

const isHex = (str: string): boolean => /^[A-F0-9]+$/i.test(str)

/**
 * @internalapi
 *
 * Generate a deterministic sender identifier based on a public key
 *
 * @param publicKey
 */
export const getSenderId = async (publicKey: string): Promise<string> => {
  if (!isHex(publicKey)) {
    reportDiagnostic({
      level: 'error',
      service: 'getSenderId',
      method: 'validatePublicKey',
      args: ['PublicKey needs to be in hex format!']
    })
  }

  const buffer = Buffer.from(hash(Buffer.from(publicKey, 'hex'), 5))

  return bs58check.encode(buffer)
}
