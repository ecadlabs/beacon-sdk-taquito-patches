export { keys } from './utils/keys'
export { ExposedPromise, ExposedPromiseStatus } from './utils/exposed-promise'
export {
  getKeypairFromSeed,
  toHex,
  getAddressFromPublicKey,
  decryptCryptoboxPayload,
  encryptCryptoboxPayload,
  getHexHash,
  sealCryptobox,
  openCryptobox,
  recipientString,
  signMessage,
  isValidAddress,
  prefixPublicKey,
  encodePoeChallengePayload,
  isPublicKeySC
} from './utils/crypto'
export {
  convertPublicKeyToX25519,
  convertSecretKeyToX25519,
  generateKeyPairFromSeed,
  sign,
  type KeyPair
} from './utils/ed25519'
export { generateGUID } from './utils/generate-uuid'

export const CONTRACT_PREFIX = 'KT1'
export const secretbox_NONCEBYTES = 24 // crypto_secretbox_NONCEBYTES
export const secretbox_MACBYTES = 16 // crypto_secretbox_MACBYTES
