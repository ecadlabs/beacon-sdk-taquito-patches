import { StorageKey, StorageKeyReturnType, defaultValues } from '@ecadlabs/beacon-types'

export const ARRAY_STORAGE_KEYS = new Set<StorageKey>([
  StorageKey.TRANSPORT_P2P_PEERS_DAPP,
  StorageKey.TRANSPORT_P2P_PEERS_WALLET,
  StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP,
  StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET,
  StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP,
  StorageKey.ACCOUNTS,
  StorageKey.PUSH_TOKENS,
  StorageKey.APP_METADATA_LIST,
  StorageKey.PERMISSION_LIST,
  StorageKey.ONGOING_PROOF_OF_EVENT_CHALLENGES
])

export const BOOLEAN_STORAGE_KEYS = new Set<StorageKey>([
  StorageKey.MULTI_NODE_SETUP_DONE,
  StorageKey.ENABLE_METRICS
])

export const OBJECT_STORAGE_KEYS = new Set<StorageKey>([
  StorageKey.LAST_SELECTED_WALLET,
  StorageKey.MATRIX_PRESERVED_STATE,
  StorageKey.MATRIX_PEER_ROOM_IDS
])

export const STRING_STORAGE_KEYS = new Set<StorageKey>([
  StorageKey.ACTIVE_ACCOUNT,
  StorageKey.BEACON_SDK_SECRET_SEED,
  StorageKey.BEACON_LAST_ERROR,
  StorageKey.BEACON_SDK_VERSION,
  StorageKey.MATRIX_SELECTED_NODE,
  StorageKey.USER_ID,
  StorageKey.WC_INIT_ERROR,
  StorageKey.WC_2_CLIENT_SESSION,
  StorageKey.WC_2_CORE_PAIRING,
  StorageKey.WC_2_CORE_KEYCHAIN,
  StorageKey.WC_2_CORE_MESSAGES,
  StorageKey.WC_2_CLIENT_PROPOSAL,
  StorageKey.WC_2_CORE_SUBSCRIPTION,
  StorageKey.WC_2_CORE_HISTORY,
  StorageKey.WC_2_CORE_EXPIRER
])

const SENTINEL_STRINGS = new Set(['undefined', 'null'])
const CLASSIFIED_STORAGE_KEYS = [
  ...ARRAY_STORAGE_KEYS,
  ...BOOLEAN_STORAGE_KEYS,
  ...OBJECT_STORAGE_KEYS,
  ...STRING_STORAGE_KEYS
]
const STORAGE_KEY_VALUES = new Set<string>(Object.values(StorageKey))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseStringifiedString = (rawValue: string): unknown => {
  try {
    return JSON.parse(rawValue)
  } catch {
    return undefined
  }
}

const parseStoredValue = (rawValue: string): unknown => {
  try {
    return JSON.parse(rawValue)
  } catch {
    return rawValue
  }
}

const formatKeys = (keys: readonly string[]): string =>
  keys.length === 0 ? 'none' : keys.join(', ')

const defaultValue = <K extends StorageKey>(key: K): StorageKeyReturnType[K] => {
  const value = defaultValues[key]

  return (
    isRecord(value) || Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : value
  ) as StorageKeyReturnType[K]
}

const normalizeRawStringValue = <K extends StorageKey>(
  key: K,
  rawValue: string
): StorageKeyReturnType[K] => {
  // STRING keys are SDK-controlled identifiers and serialized WalletConnect blobs, not free-form text.
  if (!rawValue.startsWith('"')) {
    return rawValue as StorageKeyReturnType[K]
  }

  const parsedValue = parseStringifiedString(rawValue)

  if (typeof parsedValue !== 'string' || !parsedValue || SENTINEL_STRINGS.has(parsedValue)) {
    return defaultValue(key)
  }

  return parsedValue as StorageKeyReturnType[K]
}

export const normalizeParsedStoredValue = <K extends StorageKey>(
  key: K,
  value: unknown
): StorageKeyReturnType[K] => {
  if (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && (!value || SENTINEL_STRINGS.has(value)))
  ) {
    return defaultValue(key)
  }

  if (ARRAY_STORAGE_KEYS.has(key)) {
    return (Array.isArray(value) ? value : defaultValue(key)) as StorageKeyReturnType[K]
  }

  if (BOOLEAN_STORAGE_KEYS.has(key)) {
    return (typeof value === 'boolean' ? value : defaultValue(key)) as StorageKeyReturnType[K]
  }

  if (OBJECT_STORAGE_KEYS.has(key)) {
    return (isRecord(value) ? value : defaultValue(key)) as StorageKeyReturnType[K]
  }

  if (STRING_STORAGE_KEYS.has(key)) {
    return (typeof value === 'string' ? value : defaultValue(key)) as StorageKeyReturnType[K]
  }

  return defaultValue(key)
}

// LocalStorage exposes raw strings; Chrome and IndexedDB expose already-decoded JS values.
export const normalizeStoredValue = <K extends StorageKey>(
  key: K,
  rawValue: string | null | undefined
): StorageKeyReturnType[K] => {
  if (!rawValue || SENTINEL_STRINGS.has(rawValue)) {
    return defaultValue(key)
  }

  if (STRING_STORAGE_KEYS.has(key)) {
    return normalizeRawStringValue(key, rawValue)
  }

  return normalizeParsedStoredValue(key, parseStoredValue(rawValue))
}

export const isStorageKey = (key: string): key is StorageKey => STORAGE_KEY_VALUES.has(key)

export const assertStorageKeyNormalizationIsExhaustive = (
  expectedStorageKeys: readonly string[] = Object.values(StorageKey)
): void => {
  const expectedKeys = new Set(expectedStorageKeys)
  const classifiedKeyValues = new Set<string>(CLASSIFIED_STORAGE_KEYS)
  const missingKeys = expectedStorageKeys.filter((key) => !classifiedKeyValues.has(key))
  const extraKeys = CLASSIFIED_STORAGE_KEYS.filter((key) => !expectedKeys.has(key))
  const duplicateKeys = CLASSIFIED_STORAGE_KEYS.filter(
    (key, index) => CLASSIFIED_STORAGE_KEYS.indexOf(key) !== index
  )

  if (missingKeys.length > 0 || extraKeys.length > 0 || duplicateKeys.length > 0) {
    throw new Error(
      [
        'Storage normalization keys are not exhaustive.',
        `Missing: ${formatKeys(missingKeys)}.`,
        `Extra: ${formatKeys(extraKeys)}.`,
        `Duplicate: ${formatKeys(duplicateKeys)}.`
      ].join(' ')
    )
  }
}

assertStorageKeyNormalizationIsExhaustive()
