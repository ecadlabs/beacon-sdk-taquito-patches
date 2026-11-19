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
  arMessages,
  plMessages
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

interface SequencedValue<T> {
  readonly value: T
  readonly seq: number
}

interface BeaconClientI18nEntry {
  readonly ownerId: symbol
  readonly locale?: SequencedValue<string>
  readonly direction?: SequencedValue<BeaconTextDirection>
  readonly translations?: SequencedValue<BeaconTranslationOverrides>
}

interface BeaconI18nSharedState {
  seq: number
  globalLocale?: SequencedValue<string>
  globalDirection?: SequencedValue<BeaconTextDirection>
  globalOverrides?: SequencedValue<BeaconTranslationOverrides>
  clientStack: BeaconClientI18nEntry[]
  listeners: Set<() => void>
}

const I18N_GLOBAL_SYMBOL = Symbol.for('@ecadlabs/beacon-sdk/i18n-state')

const getSharedState = (): BeaconI18nSharedState => {
  const host = globalThis as Record<symbol, BeaconI18nSharedState | undefined>
  if (!host[I18N_GLOBAL_SYMBOL]) {
    host[I18N_GLOBAL_SYMBOL] = {
      seq: 0,
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

const hasNonEmptyTranslations = (value: unknown): boolean => {
  if (!isPlainObject(value)) {
    return false
  }
  for (const entry of Object.values(value)) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      return true
    }
    if (isPlainObject(entry) && hasNonEmptyTranslations(entry)) {
      return true
    }
  }

  return false
}

const deepMergeRecord = <T extends object>(base: T, overrides?: DeepPartial<T>): T => {
  if (!overrides) {
    return base
  }
  const clone: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (value === undefined || (typeof value === 'string' && value.trim().length === 0)) {
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

const isEnglishLocaleTag = (locale: string): boolean => {
  const lower = locale.toLowerCase()

  return lower === 'en' || lower.startsWith('en-')
}

const getNavigatorLocales = (): string[] => {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') {
    return []
  }

  const rawCandidates = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    ...(typeof navigator.language === 'string' ? [navigator.language] : [])
  ]

  const seen = new Set<string>()
  const normalized: string[] = []
  for (const candidate of rawCandidates) {
    const tag = normalizeLocaleTag(candidate)
    if (tag && !seen.has(tag)) {
      seen.add(tag)
      normalized.push(tag)
    }
  }

  return normalized
}

export const detectBrowserLocale = (
  _translations?: BeaconTranslationOverrides,
  documentLang?: string
): string | undefined => {
  const docLang = getDocumentLang(documentLang)
  const browserCandidates = getNavigatorLocales()

  if (docLang && !isEnglishLocaleTag(docLang)) {
    if (hasBuiltInLocale(docLang)) {
      return docLang
    }
    const firstSupportedBrowserMatch = browserCandidates.find((candidate) =>
      hasBuiltInLocale(candidate)
    )
    if (firstSupportedBrowserMatch) {
      return isEnglishLocaleTag(firstSupportedBrowserMatch)
        ? enMessages.meta.locale
        : firstSupportedBrowserMatch
    }

    return undefined
  }

  for (const candidate of browserCandidates) {
    if (hasBuiltInLocale(candidate)) {
      return candidate
    }
  }

  if (docLang && hasBuiltInLocale(docLang)) {
    return docLang
  }

  return undefined
}

const pickMostRecent = <T>(
  globalCandidate: SequencedValue<T> | undefined,
  stack: readonly BeaconClientI18nEntry[],
  selector: (entry: BeaconClientI18nEntry) => SequencedValue<T> | undefined
): T | undefined => {
  let best = globalCandidate
  for (const entry of stack) {
    const candidate = selector(entry)
    if (candidate && (!best || candidate.seq >= best.seq)) {
      best = candidate
    }
  }

  return best?.value
}

const getEffectiveLocale = (): string | undefined => {
  const state = getSharedState()

  return pickMostRecent(state.globalLocale, state.clientStack, (entry) => entry.locale)
}

const getEffectiveDirection = (): BeaconTextDirection | undefined => {
  const state = getSharedState()

  return pickMostRecent(state.globalDirection, state.clientStack, (entry) => entry.direction)
}

const getEffectiveOverrides = (): BeaconTranslationOverrides | undefined => {
  const state = getSharedState()

  return pickMostRecent(state.globalOverrides, state.clientStack, (entry) => entry.translations)
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
  const existing = state.clientStack.find((item) => item.ownerId === ownerId)

  let nextLocale = existing?.locale
  if ('locale' in config) {
    const normalizedLocale = normalizeLocaleTag(config.locale)
    nextLocale =
      normalizedLocale !== undefined ? { value: normalizedLocale, seq: ++state.seq } : undefined
  }

  let nextDirection = existing?.direction
  if ('direction' in config) {
    nextDirection =
      config.direction !== undefined ? { value: config.direction, seq: ++state.seq } : undefined
  }

  let nextTranslations = existing?.translations
  if ('translations' in config) {
    nextTranslations =
      config.translations !== undefined
        ? { value: config.translations, seq: ++state.seq }
        : undefined
  }

  const entry: BeaconClientI18nEntry = {
    ownerId,
    locale: nextLocale,
    direction: nextDirection,
    translations: nextTranslations
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
    state.clientStack.push({
      ownerId: entry.ownerId,
      locale:
        entry.locale !== undefined ? { value: entry.locale.value, seq: ++state.seq } : undefined,
      direction:
        entry.direction !== undefined
          ? { value: entry.direction.value, seq: ++state.seq }
          : undefined,
      translations:
        entry.translations !== undefined
          ? { value: entry.translations.value, seq: ++state.seq }
          : undefined
    })
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
    const normalizedLocale = normalizeLocaleTag(config.locale)
    state.globalLocale =
      normalizedLocale !== undefined ? { value: normalizedLocale, seq: ++state.seq } : undefined
  }
  if ('direction' in config) {
    state.globalDirection =
      config.direction !== undefined ? { value: config.direction, seq: ++state.seq } : undefined
  }
  if ('translations' in config) {
    state.globalOverrides =
      config.translations !== undefined
        ? { value: config.translations, seq: ++state.seq }
        : undefined
  }
  notifyListeners()
}

export const resetBeaconI18n = (): void => {
  const state = getSharedState()
  state.seq = 0
  state.globalLocale = undefined
  state.globalDirection = undefined
  state.globalOverrides = undefined
  state.clientStack = []
  notifyListeners()
}

export const setBeaconLocale = (locale?: string): void => {
  const state = getSharedState()
  const normalizedLocale = normalizeLocaleTag(locale)
  state.globalLocale =
    normalizedLocale !== undefined ? { value: normalizedLocale, seq: ++state.seq } : undefined
  notifyListeners()
}

export const getBeaconLocale = (): string | undefined => getEffectiveLocale()

export const resolveBeaconLang = (documentLang?: string): string => {
  const effectiveLocale = getEffectiveLocale()
  const effectiveOverrides = getEffectiveOverrides()
  const hasCustomTranslations = hasNonEmptyTranslations(effectiveOverrides)
  if (effectiveLocale) {
    if (hasBuiltInLocale(effectiveLocale) || hasCustomTranslations) {
      return effectiveLocale
    }

    return enMessages.meta.locale
  }

  const detectedLocale = detectBrowserLocale(effectiveOverrides, documentLang)
  if (detectedLocale && hasBuiltInLocale(detectedLocale)) {
    return detectedLocale
  }

  return enMessages.meta.locale
}

export const setBeaconDirection = (direction?: BeaconTextDirection): void => {
  const state = getSharedState()
  state.globalDirection =
    direction !== undefined ? { value: direction, seq: ++state.seq } : undefined
  notifyListeners()
}

export const getBeaconDirection = (documentDir?: string): BeaconResolvedDirection => {
  const effectiveDirection = getEffectiveDirection()
  if (effectiveDirection === 'ltr' || effectiveDirection === 'rtl') {
    return effectiveDirection
  }

  const effectiveLocale = getEffectiveLocale()
  const effectiveOverrides = getEffectiveOverrides()
  const hasCustomTranslations = hasNonEmptyTranslations(effectiveOverrides)
  if (effectiveLocale) {
    if (hasBuiltInLocale(effectiveLocale) || hasCustomTranslations) {
      return isRtlLocaleTag(effectiveLocale) ? 'rtl' : 'ltr'
    }

    return 'ltr'
  }

  const detectedLocale = detectBrowserLocale(effectiveOverrides)
  if (detectedLocale && hasBuiltInLocale(detectedLocale)) {
    return isRtlLocaleTag(detectedLocale) ? 'rtl' : 'ltr'
  }

  const docLang = getDocumentLang()
  if (docLang && !hasBuiltInLocale(docLang) && documentDir === undefined) {
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

  return 'ltr'
}

export const setBeaconTranslations = (translations?: BeaconTranslationOverrides): void => {
  const state = getSharedState()
  state.globalOverrides =
    translations !== undefined ? { value: translations, seq: ++state.seq } : undefined
  notifyListeners()
}

export const getBeaconTranslations = (): BeaconTranslationOverrides | undefined =>
  getEffectiveOverrides()

export const getBeaconMessages = (): BeaconLocaleMessages => {
  const effectiveOverrides = getEffectiveOverrides()
  const effectiveLocale = getEffectiveLocale() ?? detectBrowserLocale(effectiveOverrides)
  const base = resolveBuiltInLocaleCatalog(effectiveLocale)
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
  plMessages,
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
