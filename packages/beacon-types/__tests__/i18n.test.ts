import { describe, expect, it, beforeEach } from 'vitest'
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
  resetBeaconI18n,
  getBeaconLocale,
  getBeaconDirection,
  getBeaconMessages,
  interpolateBeaconMessage,
  resolveBeaconLang,
  registerBeaconClientI18n,
  unregisterBeaconClientI18n,
  setBeaconLocale
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

    const expectedLocaleCodes = ['en', 'fr', 'es', 'de', 'ja', 'ar']
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
})
