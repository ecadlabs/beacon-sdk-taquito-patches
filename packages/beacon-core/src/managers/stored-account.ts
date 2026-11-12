import {
  Network,
  NetworkType,
  Origin,
  PermissionScope,
  StoredAccountInfo
} from '@ecadlabs/beacon-types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'

const isNetworkType = (value: unknown): value is NetworkType =>
  typeof value === 'string' && value.trim().length > 0

const isNetwork = (value: unknown): value is Network =>
  isRecord(value) &&
  isNetworkType(value.type) &&
  optionalString(value.name) &&
  optionalString(value.rpcUrl)

const isAccountOrigin = (value: unknown): value is StoredAccountInfo['origin'] =>
  isRecord(value) &&
  Object.values(Origin).some((type) => type === value.type) &&
  typeof value.id === 'string'

const isOptionalNotification = (value: unknown): boolean =>
  value === undefined ||
  (isRecord(value) &&
    typeof value.version === 'number' &&
    Number.isFinite(value.version) &&
    typeof value.apiUrl === 'string' &&
    typeof value.token === 'string')

const hasAccountFields = (value: Record<string, unknown>): boolean =>
  typeof value.accountIdentifier === 'string' &&
  typeof value.senderId === 'string' &&
  typeof value.address === 'string' &&
  isAccountOrigin(value.origin) &&
  typeof value.connectedAt === 'number' &&
  Number.isFinite(value.connectedAt) &&
  optionalString(value.walletKey) &&
  optionalString(value.publicKey) &&
  (value.hasVerifiedChallenge === undefined || typeof value.hasVerifiedChallenge === 'boolean') &&
  (value.verificationType === undefined || value.verificationType === 'proof_of_event') &&
  isOptionalNotification(value.notification) &&
  (value.threshold === undefined ||
    (isRecord(value.threshold) &&
      typeof value.threshold.amount === 'string' &&
      typeof value.threshold.timeframe === 'string'))

const isStoredAccount = (value: unknown): value is StoredAccountInfo => {
  if (
    !isRecord(value) ||
    !hasAccountFields(value) ||
    !Array.isArray(value.scopes) ||
    !Array.from(value.scopes).every((scope: unknown) => typeof scope === 'string')
  ) {
    return false
  }

  if (isNetwork(value.network)) {
    return (
      (value.walletType === 'implicit' || value.walletType === 'abstracted_account') &&
      value.scopes.every((scope: unknown) =>
        Object.values(PermissionScope).some((known) => known === scope)
      )
    )
  }

  return (
    value.network === undefined &&
    value.walletType === undefined &&
    Object.prototype.hasOwnProperty.call(value, 'chainData') &&
    optionalString(value.blockchainIdentifier)
  )
}

/** Validate without discarding records or claiming the opaque chain data is Tezos data. */
export const decodeStoredAccount = (value: unknown): StoredAccountInfo => {
  // The pre-walletType Tezos shape has the same default as new V2 permission responses.
  const candidate =
    isRecord(value) && isNetwork(value.network) && value.walletType === undefined
      ? { ...value, walletType: 'implicit' }
      : value
  if (!isStoredAccount(candidate)) {
    throw new Error('Invalid stored account')
  }

  return candidate
}
