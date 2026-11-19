import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  BeaconErrorType,
  AbortedBeaconError,
  BroadcastBeaconError,
  NetworkNotSupportedBeaconError,
  NoAddressBeaconError,
  NoPrivateKeyBeaconError,
  NotGrantedBeaconError,
  ParametersInvalidBeaconError,
  PeerUnreachableBeaconError,
  SignatureTypeNotSupportedBeaconError,
  TooManyOperationsBeaconError,
  TransactionInvalidBeaconError,
  UnknownBeaconError,
  getError,
  enMessages,
  builtInLocales,
  configureBeaconI18n,
  detectBrowserLocale,
  resetBeaconI18n,
  getBeaconLocale,
  getBeaconDirection,
  getBeaconMessages,
  getBeaconTranslations,
  interpolateBeaconMessage,
  resolveBeaconLang,
  registerBeaconClientI18n,
  unregisterBeaconClientI18n,
  setBeaconDirection,
  setBeaconLocale,
  setBeaconTranslations
} from '../src'

const extractPlaceholders = (text: string): string[] => {
  const matches = text.match(/\{\{\s*\w+\s*\}\}/g) ?? []
  return matches.map((token) => token.replace(/\s+/g, '')).sort()
}

const collectStringEntries = (
  obj: Record<string, unknown>,
  prefix = ''
): Array<[string, string]> => {
  const entries: Array<[string, string]> = []
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'meta') {
      continue
    }
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      entries.push([path, value])
    } else if (typeof value === 'object' && value !== null) {
      entries.push(...collectStringEntries(value as Record<string, unknown>, path))
    }
  }
  return entries
}

describe('Beacon i18n catalog and error localization', () => {
  beforeEach(() => {
    resetBeaconI18n()
  })

  it('validates all built-in locales for non-empty strings, placeholder parity, and direction metadata', () => {
    const canonicalEntries = collectStringEntries(enMessages as unknown as Record<string, unknown>)
    expect(canonicalEntries.length).toBeGreaterThan(50)

    const expectedLocaleCodes = ['en', 'fr', 'es', 'de', 'ja', 'ar', 'pl']
    for (const code of expectedLocaleCodes) {
      expect(builtInLocales[code]).toBeDefined()
    }

    for (const [localeCode, catalog] of Object.entries(builtInLocales)) {
      expect(catalog.meta.locale).toBe(localeCode)
      expect(catalog.meta.name.trim().length).toBeGreaterThan(0)
      expect(['ltr', 'rtl']).toContain(catalog.meta.direction)
      expect(['canonical', 'ai-draft', 'human-reviewed']).toContain(catalog.meta.status)

      if (['ar', 'he', 'fa', 'ur'].includes(localeCode)) {
        expect(catalog.meta.direction).toBe('rtl')
      }

      const localeEntries = new Map(
        collectStringEntries(catalog as unknown as Record<string, unknown>)
      )

      for (const [path, enValue] of canonicalEntries) {
        const translated = localeEntries.get(path)
        expect(translated, `Missing key "${path}" in locale "${localeCode}"`).toBeDefined()
        expect(
          translated!.trim().length,
          `Empty translation for "${path}" in locale "${localeCode}"`
        ).toBeGreaterThan(0)

        expect(
          extractPlaceholders(translated!),
          `Placeholder mismatch for "${path}" in locale "${localeCode}"`
        ).toEqual(extractPlaceholders(enValue))
      }
    }
  })

  it('uses a self-contained descriptive link label rather than a sentence fragment in relay-unreachable error copy', () => {
    const linkLabel = enMessages.ui.walletConnectErrors['relay-unreachable'].link?.label
    expect(linkLabel).toBeDefined()
    expect(linkLabel?.toLowerCase()).not.toBe('here')
    expect(linkLabel!.length).toBeGreaterThan(10)
  })

  it('resolves BCP-47 language subtags and falls back to English for unknown locales', () => {
    configureBeaconI18n({ locale: 'fr-CA' })
    expect(getBeaconLocale()).toBe('fr-CA')
    expect(getBeaconMessages().meta.locale).toBe('fr')
    expect(getBeaconDirection()).toBe('ltr')

    configureBeaconI18n({ locale: 'ar_EG' })
    expect(getBeaconMessages().meta.locale).toBe('ar')
    expect(getBeaconDirection()).toBe('rtl')

    configureBeaconI18n({ locale: 'tlh-KL' })
    expect(getBeaconMessages().meta.locale).toBe('en')
    expect(getBeaconDirection()).toBe('ltr')
    expect(resolveBeaconLang()).toBe('en')

    configureBeaconI18n({
      locale: 'it',
      translations: {
        ui: {
          connectWallet: 'Connetti portafoglio'
        }
      }
    })
    expect(resolveBeaconLang()).toBe('it')
    expect(getBeaconMessages().ui.connectWallet).toBe('Connetti portafoglio')

    // Prototype property names must never resolve as locale catalogs
    resetBeaconI18n()
    configureBeaconI18n({ locale: 'constructor' })
    expect(getBeaconMessages().meta.locale).toBe('en')
    expect(getBeaconDirection()).toBe('ltr')
    expect(resolveBeaconLang()).toBe('en')

    configureBeaconI18n({ locale: 'ar', direction: 'auto' })
    expect(getBeaconDirection()).toBe('rtl')
    configureBeaconI18n({ locale: 'fr', direction: 'auto' })
    expect(getBeaconDirection()).toBe('ltr')

    // Unlocalized RTL locale without custom translations falls back to English catalog and LTR layout
    resetBeaconI18n()
    configureBeaconI18n({ locale: 'fa' })
    expect(getBeaconMessages().meta.locale).toBe('en')
    expect(resolveBeaconLang()).toBe('en')
    expect(getBeaconDirection()).toBe('ltr')

    // Unlocalized RTL locale WITH custom translations resolves to RTL and preserves the requested lang
    configureBeaconI18n({
      locale: 'fa',
      translations: {
        ui: {
          connectWallet: 'اتصال کیف پول'
        }
      }
    })
    expect(resolveBeaconLang()).toBe('fa')
    expect(getBeaconDirection()).toBe('rtl')

    // Script-subtag awareness: ku-Latn is LTR, pa-Arab is RTL when custom translations are provided
    configureBeaconI18n({
      locale: 'ku-Latn',
      translations: { ui: { connectWallet: 'Girêdana cîzdanê' } }
    })
    expect(getBeaconDirection()).toBe('ltr')

    configureBeaconI18n({
      locale: 'pa-Arab',
      translations: { ui: { connectWallet: 'والٹ جوڑو' } }
    })
    expect(getBeaconDirection()).toBe('rtl')
  })

  it('resolves multi-client i18n stack per field and preserves global setter updates across client lifecycles', () => {
    const clientA = Symbol('clientA')
    const clientB = Symbol('clientB')

    // Client A sets French, then Client B registers with no i18n options -> French stays active
    registerBeaconClientI18n(clientA, { locale: 'fr' })
    registerBeaconClientI18n(clientB, {})
    expect(getBeaconMessages().meta.locale).toBe('fr')
    expect(getBeaconDirection()).toBe('ltr')
    unregisterBeaconClientI18n(clientB)
    unregisterBeaconClientI18n(clientA)

    // Global locale 'de' + client with only custom translations inherits 'de' catalog
    configureBeaconI18n({ locale: 'de' })
    registerBeaconClientI18n(clientA, {
      translations: {
        ui: {
          close: 'Schließen (Custom)'
        }
      }
    })
    expect(getBeaconMessages().meta.locale).toBe('de')
    expect(getBeaconMessages().ui.close).toBe('Schließen (Custom)')
    expect(getBeaconMessages().ui.connectWallet).toBe(builtInLocales.de.ui.connectWallet)

    // Calling setBeaconLocale('ja') overrides active locale and survives unrelated client B lifecycle
    setBeaconLocale('ja')
    expect(getBeaconMessages().meta.locale).toBe('ja')
    registerBeaconClientI18n(clientB, {})
    unregisterBeaconClientI18n(clientB)
    expect(getBeaconMessages().meta.locale).toBe('ja')
    unregisterBeaconClientI18n(clientA)

    // Clearing a client field only clears that client's override and never erases the global baseline
    resetBeaconI18n()
    configureBeaconI18n({
      locale: 'fr',
      direction: 'rtl',
      translations: { ui: { close: 'Fermer global' } }
    })
    registerBeaconClientI18n(clientA, {
      locale: 'es',
      direction: 'ltr',
      translations: { ui: { close: 'Cerrar cliente' } }
    })
    expect(getBeaconLocale()).toBe('es')
    expect(getBeaconDirection()).toBe('ltr')
    expect(getBeaconMessages().ui.close).toBe('Cerrar cliente')

    registerBeaconClientI18n(clientA, {
      locale: undefined,
      direction: undefined,
      translations: undefined
    })
    expect(getBeaconLocale()).toBe('fr')
    expect(getBeaconDirection()).toBe('rtl')
    expect(getBeaconMessages().ui.close).toBe('Fermer global')
    unregisterBeaconClientI18n(clientA)
    expect(getBeaconLocale()).toBe('fr')

    // Partial client updates do not reclaim precedence for untouched fields
    resetBeaconI18n()
    registerBeaconClientI18n(clientA, { locale: 'fr' })
    setBeaconLocale('ja')
    expect(getBeaconLocale()).toBe('ja')
    registerBeaconClientI18n(clientA, { direction: 'rtl' })
    expect(getBeaconLocale()).toBe('ja')
    expect(getBeaconDirection()).toBe('rtl')

    // Two clients: partial update on older client A does not steal locale from newer client B
    resetBeaconI18n()
    registerBeaconClientI18n(clientA, { locale: 'fr' })
    registerBeaconClientI18n(clientB, { locale: 'de' })
    expect(getBeaconLocale()).toBe('de')
    registerBeaconClientI18n(clientA, { direction: 'rtl' })
    expect(getBeaconLocale()).toBe('de')
    expect(getBeaconDirection()).toBe('rtl')
    registerBeaconClientI18n(clientA, {})
    expect(getBeaconLocale()).toBe('de')
    unregisterBeaconClientI18n(clientA)
    unregisterBeaconClientI18n(clientB)

    // Interleaved client and global updates restore in exact recency order on teardown
    resetBeaconI18n()
    registerBeaconClientI18n(clientA, { locale: 'es' })
    setBeaconLocale('ja')
    registerBeaconClientI18n(clientB, { locale: 'fr' })
    expect(getBeaconLocale()).toBe('fr')
    unregisterBeaconClientI18n(clientB)
    expect(getBeaconLocale()).toBe('ja')
    setBeaconLocale(undefined)
    expect(getBeaconLocale()).toBe('es')
    unregisterBeaconClientI18n(clientA)
    expect(getBeaconLocale()).toBeUndefined()
  })

  it('merges custom partial translation overrides deeply without mutating built-in catalogs', () => {
    configureBeaconI18n({
      locale: 'fr',
      translations: {
        dapp: {
          preparingRequest: 'Préparation personnalisée...'
        }
      }
    })

    const messages = getBeaconMessages()
    expect(messages.dapp.preparingRequest).toBe('Préparation personnalisée...')
    expect(messages.ui.connectWallet).toBe(builtInLocales.fr.ui.connectWallet)
    expect(builtInLocales.fr.dapp.preparingRequest).not.toBe('Préparation personnalisée...')
  })

  it('interpolates named placeholders cleanly and ignores inherited Object.prototype properties', () => {
    expect(
      interpolateBeaconMessage('Open {{wallet}} Wallet ({{standard}}) {{constructor}}', {
        wallet: 'Kukai',
        standard: 'WalletConnect'
      })
    ).toBe('Open Kukai Wallet (WalletConnect) {{constructor}}')
  })

  it('localizes BeaconError subclasses and getError() using the active locale and custom overrides', () => {
    const defaultAborted = new AbortedBeaconError()
    expect(defaultAborted.title).toBe('Aborted')
    expect(defaultAborted.description).toBe('The action was aborted by the user.')

    configureBeaconI18n({ locale: 'fr' })

    const frAborted = new AbortedBeaconError()
    expect(frAborted.title).toBe(builtInLocales.fr.errors[BeaconErrorType.ABORTED_ERROR].title)
    expect(frAborted.description).toBe(
      builtInLocales.fr.errors[BeaconErrorType.ABORTED_ERROR].description
    )

    const errorClasses = [
      [BeaconErrorType.BROADCAST_ERROR, () => new BroadcastBeaconError()],
      [BeaconErrorType.NETWORK_NOT_SUPPORTED, () => new NetworkNotSupportedBeaconError()],
      [BeaconErrorType.NO_ADDRESS_ERROR, () => new NoAddressBeaconError()],
      [BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR, () => new NoPrivateKeyBeaconError()],
      [BeaconErrorType.NOT_GRANTED_ERROR, () => new NotGrantedBeaconError()],
      [BeaconErrorType.PARAMETERS_INVALID_ERROR, () => new ParametersInvalidBeaconError()],
      [BeaconErrorType.PEER_UNREACHABLE, () => new PeerUnreachableBeaconError()],
      [
        BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED,
        () => new SignatureTypeNotSupportedBeaconError()
      ],
      [BeaconErrorType.TOO_MANY_OPERATIONS, () => new TooManyOperationsBeaconError()],
      [BeaconErrorType.TRANSACTION_INVALID_ERROR, () => new TransactionInvalidBeaconError()],
      [BeaconErrorType.UNKNOWN_ERROR, () => new UnknownBeaconError()]
    ] as const

    for (const [errorType, factory] of errorClasses) {
      const instance = factory()
      expect(instance.title).toBe(builtInLocales.fr.errors[errorType].title)
      expect(instance.description).toBe(builtInLocales.fr.errors[errorType].description)

      const viaGetError = getError(errorType)
      expect(viaGetError.title).toBe(builtInLocales.fr.errors[errorType].title)
      expect(viaGetError.description).toBe(builtInLocales.fr.errors[errorType].description)
    }

    const explicitOverride = new AbortedBeaconError({
      title: 'Explicit caller title',
      description: 'Explicit caller description'
    })
    expect(explicitOverride.title).toBe('Explicit caller title')
    expect(explicitOverride.description).toBe('Explicit caller description')

    configureBeaconI18n({
      locale: 'fr',
      translations: {
        errors: {
          [BeaconErrorType.ABORTED_ERROR]: {
            title: 'Titre personnalisé',
            description: 'Description personnalisée'
          }
        }
      }
    })
    const customAborted = new AbortedBeaconError()
    expect(customAborted.title).toBe('Titre personnalisé')
    expect(customAborted.description).toBe('Description personnalisée')

    // TransactionInvalidBeaconError preserves legacy RPC error objects that happen to include a "title" key
    const rpcPayloadWithTitle = {
      title: 'Node failure',
      detail: 'execution failed'
    }
    const txError = new TransactionInvalidBeaconError(rpcPayloadWithTitle)
    expect(txError.data).toEqual(rpcPayloadWithTitle)
    expect(txError.errorData).toEqual(rpcPayloadWithTitle)
    expect(txError.fullDescription.data).toContain('execution failed')
    expect(txError.title).toBe(
      builtInLocales.fr.errors[BeaconErrorType.TRANSACTION_INVALID_ERROR].title
    )

    const txOptionsOnly = new TransactionInvalidBeaconError({
      title: 'Custom TX Invalid Title'
    })
    expect(txOptionsOnly.title).toBe('Custom TX Invalid Title')
  })

  describe('browser language auto-detection and clearing global overrides', () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')

    const setMockBrowserEnv = (options: {
      languages?: readonly string[]
      language?: string
      docLang?: string
      docDir?: string
    }) => {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: {
          languages: options.languages,
          language: options.language
        }
      })
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        writable: true,
        value: {
          documentElement: {
            lang: options.docLang ?? '',
            dir: options.docDir ?? ''
          }
        }
      })
    }

    afterEach(() => {
      resetBeaconI18n()
      if (navigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
      } else {
        delete (globalThis as Record<string, unknown>).navigator
      }
      if (documentDescriptor) {
        Object.defineProperty(globalThis, 'document', documentDescriptor)
      } else {
        delete (globalThis as Record<string, unknown>).document
      }
    })

    it('detects browser locale from navigator.languages even when document.documentElement.lang is boilerplate en', () => {
      setMockBrowserEnv({
        languages: ['fr-CA', 'fr', 'en-US'],
        language: 'fr-CA',
        docLang: 'en'
      })

      expect(detectBrowserLocale()).toBe('fr-CA')
      expect(getBeaconLocale()).toBeUndefined()
      expect(resolveBeaconLang()).toBe('fr-CA')
      expect(getBeaconDirection()).toBe('ltr')
      expect(getBeaconMessages().meta.locale).toBe('fr')
      expect(new AbortedBeaconError().title).toBe(
        builtInLocales.fr.errors[BeaconErrorType.ABORTED_ERROR].title
      )
    })

    it('skips unsupported preferred languages in navigator.languages and selects the first supported built-in locale', () => {
      setMockBrowserEnv({
        languages: ['pt-BR', 'es-MX', 'en-US'],
        language: 'pt-BR',
        docLang: 'en'
      })

      expect(detectBrowserLocale()).toBe('es-MX')
      expect(resolveBeaconLang()).toBe('es-MX')
      expect(getBeaconMessages().meta.locale).toBe('es')
    })

    it('resolves RTL direction automatically when browser language is Arabic even on an LTR boilerplate document', () => {
      setMockBrowserEnv({
        languages: ['ar-EG', 'ar'],
        language: 'ar-EG',
        docLang: 'en',
        docDir: 'ltr'
      })

      expect(detectBrowserLocale()).toBe('ar-EG')
      expect(resolveBeaconLang()).toBe('ar-EG')
      expect(getBeaconDirection()).toBe('rtl')
      expect(getBeaconMessages().meta.locale).toBe('ar')
    })

    it('honors an explicitly localized non-English document lang when browser language is default English, and falls back to en for unsupported locales without custom translations', () => {
      setMockBrowserEnv({
        languages: ['en-US', 'en'],
        language: 'en-US',
        docLang: 'de'
      })

      expect(detectBrowserLocale()).toBe('de')
      expect(resolveBeaconLang()).toBe('de')
      expect(getBeaconMessages().meta.locale).toBe('de')

      setMockBrowserEnv({
        languages: ['it-IT'],
        language: 'it-IT',
        docLang: ''
      })

      expect(detectBrowserLocale()).toBeUndefined()
      expect(resolveBeaconLang()).toBe('en')
      expect(getBeaconDirection()).toBe('ltr')
      expect(getBeaconMessages().meta.locale).toBe('en')

      // Custom translation overrides without an explicit locale do NOT claim unsupported auto-detected browser locales (e.g. it-IT or fa-IR)
      setBeaconTranslations({
        ui: {
          connectWallet: 'Connect to MyDapp'
        }
      })
      expect(detectBrowserLocale(getBeaconTranslations())).toBeUndefined()
      expect(resolveBeaconLang()).toBe('en')
      expect(getBeaconDirection()).toBe('ltr')
      expect(getBeaconMessages().ui.connectWallet).toBe('Connect to MyDapp')

      setMockBrowserEnv({
        languages: ['fa-IR'],
        language: 'fa-IR',
        docLang: 'en'
      })
      expect(detectBrowserLocale(getBeaconTranslations())).toBe('en')
      expect(resolveBeaconLang()).toBe('en')
      expect(getBeaconDirection()).toBe('ltr')

      // Setting an explicit locale alongside custom translations preserves that custom locale tag and RTL direction
      configureBeaconI18n({
        locale: 'fa-IR',
        translations: {
          ui: {
            connectWallet: 'اتصال کیف پول'
          }
        }
      })
      expect(resolveBeaconLang()).toBe('fa-IR')
      expect(getBeaconDirection()).toBe('rtl')
      expect(getBeaconMessages().ui.connectWallet).toBe('اتصال کیف پول')

      // Empty translation objects or whitespace-only string leaves do not count as custom translations or blank out base labels
      resetBeaconI18n()
      setMockBrowserEnv({
        languages: ['he-IL'],
        language: 'he-IL',
        docLang: 'en'
      })
      configureBeaconI18n({
        translations: {
          ui: {
            connectWallet: '',
            close: '   '
          }
        }
      })
      expect(detectBrowserLocale(getBeaconTranslations())).toBe('en')
      expect(resolveBeaconLang()).toBe('en')
      expect(getBeaconDirection()).toBe('ltr')
      expect(getBeaconMessages().ui.connectWallet).toBe(builtInLocales.en.ui.connectWallet)
      expect(getBeaconMessages().ui.close).toBe(builtInLocales.en.ui.close)

      setMockBrowserEnv({
        languages: ['he-IL'],
        language: 'he-IL',
        docLang: ''
      })
      expect(detectBrowserLocale(getBeaconTranslations())).toBeUndefined()

      configureBeaconI18n({ locale: 'he-IL', translations: { ui: {} } })
      expect(resolveBeaconLang()).toBe('en')
      expect(getBeaconDirection()).toBe('ltr')

      // Unsupported non-English document lang respects navigator.languages priority order and does not render English fallback as RTL when document.dir is rtl
      resetBeaconI18n()
      setMockBrowserEnv({
        languages: ['en-GB', 'ar-EG'],
        language: 'en-GB',
        docLang: 'he',
        docDir: 'rtl'
      })
      expect(detectBrowserLocale()).toBe('en')
      expect(resolveBeaconLang()).toBe('en')
      expect(getBeaconDirection()).toBe('ltr')
      expect(getBeaconMessages().meta.locale).toBe('en')

      // Unsupported RTL document with unsupported browser language still renders the English fallback catalog as LTR
      setMockBrowserEnv({
        languages: ['he-IL'],
        language: 'he-IL',
        docLang: 'he',
        docDir: 'rtl'
      })
      expect(detectBrowserLocale()).toBeUndefined()
      expect(resolveBeaconLang()).toBe('en')
      expect(getBeaconDirection()).toBe('ltr')
      expect(getBeaconMessages().meta.locale).toBe('en')
    })

    it('clears global precedence when setBeaconLocale(undefined), setBeaconDirection(undefined), or setBeaconTranslations(undefined) is called', () => {
      setMockBrowserEnv({
        languages: ['fr-FR', 'fr'],
        language: 'fr-FR',
        docLang: 'en'
      })

      const clientA = Symbol('clientA')
      registerBeaconClientI18n(clientA, {
        locale: 'es',
        direction: 'rtl',
        translations: { ui: { close: 'Cerrar cliente' } }
      })

      setBeaconLocale('de')
      setBeaconDirection('ltr')
      setBeaconTranslations({ ui: { close: 'Schließen global' } })
      expect(getBeaconLocale()).toBe('de')
      expect(getBeaconDirection()).toBe('ltr')
      expect(getBeaconMessages().ui.close).toBe('Schließen global')

      // Passing undefined clears the global overrides so the active client entry takes effect again
      setBeaconLocale(undefined)
      setBeaconDirection(undefined)
      setBeaconTranslations(undefined)
      expect(getBeaconLocale()).toBe('es')
      expect(getBeaconDirection()).toBe('rtl')
      expect(getBeaconMessages().ui.close).toBe('Cerrar cliente')

      // Unregistering the client then falls back to browser auto-detection ('fr-FR')
      unregisterBeaconClientI18n(clientA)
      expect(getBeaconLocale()).toBeUndefined()
      expect(resolveBeaconLang()).toBe('fr-FR')
      expect(getBeaconMessages().meta.locale).toBe('fr')
    })
  })
})
