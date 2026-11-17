import { BeaconErrorType } from '../types/BeaconErrorType'
import {
  BeaconErrorCopy,
  BeaconI18nConfig,
  BeaconLocaleMessages,
  BeaconLocaleMetadata,
  BeaconLocaleStatus,
  BeaconResolvedDirection,
  BeaconTextDirection,
  BeaconTranslationOverrides,
  BeaconDAppMessages,
  BeaconUIMessages,
  BeaconAriaMessages,
  BeaconWalletTypeMessages,
  DeepPartial,
  DisplayableWalletConnectFailureReason,
  WalletConnectErrorCopy
} from './schema'
import {
  builtInLocales,
  enMessages,
  frMessages,
  esMessages,
  deMessages,
  jaMessages,
  arMessages
} from './locales'

const RTL_SCRIPTS = new Set([
  'Arab',
  'Hebr',
  'Thaa',
  'Syrc',
  'Nkoo',
  'Adlm',
  'Rohg',
  'Mand',
  'Samr'
])

const RTL_PRIMARY_SUBTAGS = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'he',
  'iw',
  'khw',
  'ks',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi'
])

interface BeaconClientI18nEntry {
  readonly ownerId: symbol
  readonly locale?: string
  readonly direction?: BeaconTextDirection
  readonly translations?: BeaconTranslationOverrides
}

interface BeaconI18nSharedState {
  globalLocale?: string
  globalDirection?: BeaconTextDirection
  globalOverrides?: BeaconTranslationOverrides
  globalLocaleTakesPrecedence: boolean
  globalDirectionTakesPrecedence: boolean
  globalOverridesTakesPrecedence: boolean
  clientStack: BeaconClientI18nEntry[]
  listeners: Set<() => void>
}

const I18N_GLOBAL_SYMBOL = Symbol.for('@ecadlabs/beacon-sdk/i18n-state')

const getSharedState = (): BeaconI18nSharedState => {
  const host = globalThis as Record<symbol, BeaconI18nSharedState | undefined>
  if (!host[I18N_GLOBAL_SYMBOL]) {
    host[I18N_GLOBAL_SYMBOL] = {
      globalLocaleTakesPrecedence: false,
      globalDirectionTakesPrecedence: false,
      globalOverridesTakesPrecedence: false,
      clientStack: [],
      listeners: new Set()
    }
  }

  return host[I18N_GLOBAL_SYMBOL]
}

const notifyListeners = (): void => {
  const state = getSharedState()
  for (const listener of Array.from(state.listeners)) {
    listener()
  }
}

export const subscribeBeaconI18n = (listener: () => void): (() => void) => {
  const state = getSharedState()
  state.listeners.add(listener)

  return () => {
    state.listeners.delete(listener)
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const deepMergeRecord = <T extends object>(base: T, overrides?: DeepPartial<T>): T => {
  if (!overrides) {
    return base
  }
  const clone: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (value === undefined) {
      continue
    }
    const existing = clone[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      clone[key] = deepMergeRecord(existing, value)
    } else {
      clone[key] = value
    }
  }

  return clone as T
}

export const normalizeLocaleTag = (locale?: string): string | undefined => {
  const trimmed = locale?.trim()
  if (!trimmed) {
    return undefined
  }

  return trimmed.replace(/_/g, '-')
}

const getOwnBuiltInCatalog = (key?: string): BeaconLocaleMessages | undefined => {
  if (!key || !Object.prototype.hasOwnProperty.call(builtInLocales, key)) {
    return undefined
  }

  return builtInLocales[key]
}

export const hasBuiltInLocale = (locale?: string): boolean => {
  const normalized = normalizeLocaleTag(locale)?.toLowerCase()
  if (!normalized) {
    return false
  }
  if (getOwnBuiltInCatalog(normalized)) {
    return true
  }
  const primarySubtag = normalized.split('-')[0]

  return Boolean(getOwnBuiltInCatalog(primarySubtag))
}

export const resolveBuiltInLocaleCatalog = (locale?: string): BeaconLocaleMessages => {
  const normalized = normalizeLocaleTag(locale)?.toLowerCase()
  if (!normalized) {
    return enMessages
  }

  const exact = getOwnBuiltInCatalog(normalized)
  if (exact) {
    return exact
  }

  const primarySubtag = normalized.split('-')[0]
  const primaryCatalog = getOwnBuiltInCatalog(primarySubtag)
  if (primaryCatalog) {
    return primaryCatalog
  }

  return enMessages
}

const isRtlLocaleTag = (locale?: string): boolean => {
  const normalized = normalizeLocaleTag(locale)
  if (!normalized) {
    return false
  }
  const lower = normalized.toLowerCase()
  const exact = getOwnBuiltInCatalog(lower)
  if (exact) {
    return exact.meta.direction === 'rtl'
  }
  const parts = normalized.split('-')
  const primary = parts[0]?.toLowerCase()
  if (!primary) {
    return false
  }
  const primaryCatalog = getOwnBuiltInCatalog(primary)
  if (primaryCatalog) {
    return primaryCatalog.meta.direction === 'rtl'
  }

  // Check explicit 4-letter ISO 15924 script subtag first (e.g. ku-Latn vs pa-Arab)
  for (let i = 1; i < parts.length; i++) {
    const subtag = parts[i]
    if (subtag && subtag.length === 4) {
      const titleCaseScript = subtag.charAt(0).toUpperCase() + subtag.slice(1).toLowerCase()

      return RTL_SCRIPTS.has(titleCaseScript)
    }
  }

  if (typeof Intl !== 'undefined' && typeof Intl.Locale === 'function') {
    try {
      const maximizedScript = new Intl.Locale(normalized).maximize().script
      if (maximizedScript) {
        return RTL_SCRIPTS.has(maximizedScript)
      }
    } catch {
      // Ignore invalid BCP-47 tags for Intl.Locale and fall back to primary subtag lookup
    }
  }

  return RTL_PRIMARY_SUBTAGS.has(primary)
}

const getDocumentLang = (documentLang?: string): string | undefined =>
  normalizeLocaleTag(
    documentLang ?? (typeof document !== 'undefined' ? document.documentElement?.lang : undefined)
  )

const getEffectiveLocale = (): string | undefined => {
  const state = getSharedState()
  if (state.globalLocaleTakesPrecedence) {
    return state.globalLocale
  }
  for (let i = state.clientStack.length - 1; i >= 0; i--) {
    const entry = state.clientStack[i]
    if (entry?.locale !== undefined) {
      return entry.locale
    }
  }

  return state.globalLocale
}

const getEffectiveDirection = (): BeaconTextDirection | undefined => {
  const state = getSharedState()
  if (state.globalDirectionTakesPrecedence) {
    return state.globalDirection
  }
  for (let i = state.clientStack.length - 1; i >= 0; i--) {
    const entry = state.clientStack[i]
    if (entry?.direction !== undefined) {
      return entry.direction
    }
  }

  return state.globalDirection
}

const getEffectiveOverrides = (): BeaconTranslationOverrides | undefined => {
  const state = getSharedState()
  if (state.globalOverridesTakesPrecedence) {
    return state.globalOverrides
  }
  for (let i = state.clientStack.length - 1; i >= 0; i--) {
    const entry = state.clientStack[i]
    if (entry?.translations !== undefined) {
      return entry.translations
    }
  }

  return state.globalOverrides
}

/**
 * Fold client-scoped locale overrides onto the active ownership stack.
 * Retain global baseline settings whenever a client omits a specific field.
 * Ensure each registered instance tracks its own lifecycle symbol cleanly.
 * Evaluate effective direction only against catalogs that are actually active.
 *
 * Restore the prior client configuration immediately when an owner unregisters.
 * Isolate shared state on globalThis so bundled UI entrypoints stay in sync.
 * Defer to explicit global setter calls until a newer client claims ownership.
 * Emit change notifications to all subscribed shadow-root listeners on update.
 */
export const registerBeaconClientI18n = (ownerId: symbol, config: BeaconI18nConfig): void => {
  const state = getSharedState()
  const normalizedLocale = normalizeLocaleTag(config.locale)
  if (normalizedLocale !== undefined) {
    state.globalLocaleTakesPrecedence = false
  }
  if (config.direction !== undefined) {
    state.globalDirectionTakesPrecedence = false
  }
  if (config.translations !== undefined) {
    state.globalOverridesTakesPrecedence = false
  }
  const entry: BeaconClientI18nEntry = {
    ownerId,
    locale: normalizedLocale,
    direction: config.direction,
    translations: config.translations
  }
  state.clientStack = state.clientStack.filter((item) => item.ownerId !== ownerId)
  state.clientStack.push(entry)
  notifyListeners()
}

export const activateBeaconClientI18n = (ownerId: symbol): void => {
  const state = getSharedState()
  const index = state.clientStack.findIndex((item) => item.ownerId === ownerId)
  if (index === -1) {
    return
  }
  const [entry] = state.clientStack.splice(index, 1)
  if (entry) {
    if (entry.locale !== undefined) {
      state.globalLocaleTakesPrecedence = false
    }
    if (entry.direction !== undefined) {
      state.globalDirectionTakesPrecedence = false
    }
    if (entry.translations !== undefined) {
      state.globalOverridesTakesPrecedence = false
    }
    state.clientStack.push(entry)
  }
  notifyListeners()
}

export const unregisterBeaconClientI18n = (ownerId: symbol): void => {
  const state = getSharedState()
  const before = state.clientStack.length
  state.clientStack = state.clientStack.filter((item) => item.ownerId !== ownerId)
  if (state.clientStack.length !== before) {
    notifyListeners()
  }
}

export const configureBeaconI18n = (config: BeaconI18nConfig): void => {
  const state = getSharedState()
  if ('locale' in config) {
    state.globalLocale = normalizeLocaleTag(config.locale)
    state.globalLocaleTakesPrecedence = true
  }
  if ('direction' in config) {
    state.globalDirection = config.direction
    state.globalDirectionTakesPrecedence = true
  }
  if ('translations' in config) {
    state.globalOverrides = config.translations
    state.globalOverridesTakesPrecedence = true
  }
  notifyListeners()
}

export const resetBeaconI18n = (): void => {
  const state = getSharedState()
  state.globalLocale = undefined
  state.globalDirection = undefined
  state.globalOverrides = undefined
  state.globalLocaleTakesPrecedence = false
  state.globalDirectionTakesPrecedence = false
  state.globalOverridesTakesPrecedence = false
  state.clientStack = []
  notifyListeners()
}

export const setBeaconLocale = (locale?: string): void => {
  const state = getSharedState()
  state.globalLocale = normalizeLocaleTag(locale)
  state.globalLocaleTakesPrecedence = true
  notifyListeners()
}

export const getBeaconLocale = (): string | undefined => getEffectiveLocale()

export const resolveBeaconLang = (documentLang?: string): string => {
  const effectiveLocale = getEffectiveLocale()
  const effectiveOverrides = getEffectiveOverrides()
  if (effectiveLocale) {
    if (hasBuiltInLocale(effectiveLocale) || effectiveOverrides) {
      return effectiveLocale
    }

    return enMessages.meta.locale
  }

  const docLang = getDocumentLang(documentLang)
  if (docLang && (hasBuiltInLocale(docLang) || effectiveOverrides)) {
    return docLang
  }

  return enMessages.meta.locale
}

export const setBeaconDirection = (direction?: BeaconTextDirection): void => {
  const state = getSharedState()
  state.globalDirection = direction
  state.globalDirectionTakesPrecedence = true
  notifyListeners()
}

export const getBeaconDirection = (documentDir?: string): BeaconResolvedDirection => {
  const effectiveDirection = getEffectiveDirection()
  if (effectiveDirection === 'ltr' || effectiveDirection === 'rtl') {
    return effectiveDirection
  }

  const effectiveLocale = getEffectiveLocale()
  const effectiveOverrides = getEffectiveOverrides()
  if (effectiveLocale) {
    if (hasBuiltInLocale(effectiveLocale) || effectiveOverrides) {
      return isRtlLocaleTag(effectiveLocale) ? 'rtl' : 'ltr'
    }

    return 'ltr'
  }

  const rawDocDir = (
    documentDir ?? (typeof document !== 'undefined' ? document.documentElement?.dir : undefined)
  )
    ?.trim()
    .toLowerCase()
  if (rawDocDir === 'rtl' || rawDocDir === 'ltr') {
    return rawDocDir
  }

  const docLang = getDocumentLang()
  if (docLang && (hasBuiltInLocale(docLang) || effectiveOverrides) && isRtlLocaleTag(docLang)) {
    return 'rtl'
  }

  return 'ltr'
}

export const setBeaconTranslations = (translations?: BeaconTranslationOverrides): void => {
  const state = getSharedState()
  state.globalOverrides = translations
  state.globalOverridesTakesPrecedence = true
  notifyListeners()
}

export const getBeaconTranslations = (): BeaconTranslationOverrides | undefined =>
  getEffectiveOverrides()

export const getBeaconMessages = (): BeaconLocaleMessages => {
  const effectiveLocale =
    getEffectiveLocale() ??
    (() => {
      const docLang = getDocumentLang()

      return docLang && hasBuiltInLocale(docLang) ? docLang : undefined
    })()
  const base = resolveBuiltInLocaleCatalog(effectiveLocale)
  const effectiveOverrides = getEffectiveOverrides()
  if (!effectiveOverrides) {
    return base
  }

  return deepMergeRecord<BeaconLocaleMessages>(base, effectiveOverrides)
}

export const getBeaconErrorCopy = (errorType: BeaconErrorType): BeaconErrorCopy => {
  const messages = getBeaconMessages()

  return messages.errors[errorType] ?? messages.errors[BeaconErrorType.UNKNOWN_ERROR]
}

export const interpolateBeaconMessage = (
  template: string,
  params: Readonly<Record<string, string | number>>
): string =>
  template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      return match
    }
    const replacement = params[key]

    return replacement !== undefined ? String(replacement) : match
  })

export {
  builtInLocales,
  enMessages,
  frMessages,
  esMessages,
  deMessages,
  jaMessages,
  arMessages,
  type BeaconErrorCopy,
  type BeaconI18nConfig,
  type BeaconLocaleMessages,
  type BeaconLocaleMetadata,
  type BeaconLocaleStatus,
  type BeaconResolvedDirection,
  type BeaconTextDirection,
  type BeaconTranslationOverrides,
  type BeaconDAppMessages,
  type BeaconUIMessages,
  type BeaconAriaMessages,
  type BeaconWalletTypeMessages,
  type DeepPartial,
  type DisplayableWalletConnectFailureReason,
  type WalletConnectErrorCopy
}
