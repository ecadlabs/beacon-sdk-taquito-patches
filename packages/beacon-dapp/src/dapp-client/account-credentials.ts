import type { AccountInfo, ChangeAccountRequest, PermissionResponse } from '@ecadlabs/beacon-types'
import { CONTRACT_PREFIX, isValidAddress, prefixPublicKey } from '@ecadlabs/beacon-utils'
import { getLegacyPublicKey } from '../utils/legacy-public-key'

type AccountCredentialMessage = PermissionResponse | ChangeAccountRequest

export const prepareAccountPublicKey = (
  message: AccountCredentialMessage
): AccountInfo['publicKey'] => {
  // TODO: Migration code. Remove sometime after 1.0.0 release.
  const tempPK = getLegacyPublicKey(message)
  const publicKey = tempPK ? prefixPublicKey(tempPK) : undefined

  if (!publicKey && !message.address) {
    throw new Error('PublicKey or Address must be defined')
  }

  return publicKey
}

export const assertValidAccountAddress = ({
  message,
  publicKey,
  derivedAddress,
  address
}: {
  message: AccountCredentialMessage
  publicKey: AccountInfo['publicKey']
  derivedAddress: AccountInfo['address'] | undefined
  address: AccountInfo['address']
}): void => {
  if (derivedAddress && message.address && message.address !== derivedAddress) {
    throw new Error(`Address "${message.address}" does not match publicKey "${publicKey}"`)
  }

  if (!isValidAddress(address)) {
    throw new Error(`Invalid address: "${address}"`)
  }

  if (message.walletType === 'abstracted_account' && address.substring(0, 3) !== CONTRACT_PREFIX) {
    throw new Error(
      `Invalid abstracted account address "${address}", it should be a ${CONTRACT_PREFIX} address`
    )
  }
}
