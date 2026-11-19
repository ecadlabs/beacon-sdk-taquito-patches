import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { openAlert, openToast, setColorMode } from '@ecadlabs/beacon-ui'
import {
  BeaconErrorType,
  BeaconMessageType,
  builtInLocales,
  ColorMode,
  configureBeaconI18n,
  getBeaconDirection,
  getBeaconMessages,
  NetworkType,
  Origin,
  resetBeaconI18n,
  TransportType
} from '@ecadlabs/beacon-types'
import { BeaconEvent, defaultEventCallbacks } from '../src/events'
import { DAppClient } from '../src/dapp-client/DAppClient'
import { getDAppClientInstance } from '../src/utils/get-instance'

vi.mock('@ecadlabs/beacon-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecadlabs/beacon-ui')>()
  return {
    ...actual,
    closeAlert: vi.fn(),
    closeToast: vi.fn(),
    isMobile: vi.fn().mockReturnValue(false),
    isMobileOS: vi.fn().mockReturnValue(false),
    openAlert: vi.fn(),
    openToast: vi.fn(),
    setColorMode: vi.fn(actual.setColorMode),
    getColorMode: vi.fn(actual.getColorMode)
  }
})

describe('BeaconEvent i18n and DAppClientOptions locale configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetBeaconI18n()
  })

  afterEach(() => {
    resetBeaconI18n()
  })

  it('localizes toast and alert copy in defaultEventCallbacks across sent, error, and late-response branches', async () => {
    configureBeaconI18n({ locale: 'fr' })
    const fr = builtInLocales.fr

    await defaultEventCallbacks[BeaconEvent.PERMISSION_REQUEST_SENT]({
      requestId: 'req-1',
      requestType: BeaconMessageType.PermissionRequest,
      transport: TransportType.P2P,
      dispatchStage: 'transport',
      sentAt: 1,
      walletInfo: { name: 'Kukai' },
      extraInfo: {}
    })
    expect(openToast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: fr.dapp.requestSent,
        actions: expect.arrayContaining([
          expect.objectContaining({ text: fr.dapp.noAnswerFromWallet }),
          expect.objectContaining({
            text: fr.dapp.walletNotReceivingRequest,
            actionText: fr.dapp.resetConnection
          })
        ])
      })
    )

    await defaultEventCallbacks[BeaconEvent.PERMISSION_REQUEST_ERROR]({
      requestId: 'req-2',
      receivedAt: 2,
      walletInfo: { name: 'Kukai' },
      errorResponse: {
        id: 'req-2',
        version: '2',
        senderId: 'peer-1',
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.ABORTED_ERROR,
        errorOrigin: 'local'
      }
    })
    expect(openToast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: fr.dapp.walletRequestCancelled,
        actions: expect.arrayContaining([
          expect.objectContaining({
            text: fr.errors[BeaconErrorType.ABORTED_ERROR].title,
            isBold: true
          })
        ])
      })
    )

    await defaultEventCallbacks[BeaconEvent.LATE_RESPONSE_RECEIVED]({
      kind: 'success',
      requestId: 'req-late-bcast',
      requestType: BeaconMessageType.BroadcastRequest,
      timedOutAt: 3,
      receivedAt: 4,
      transport: TransportType.P2P,
      walletInfo: { name: 'Kukai' },
      connectionContext: { origin: Origin.P2P, id: 'peer-1' },
      transactionHash: 'ooLateBcast123',
      response: {
        id: 'req-late-bcast',
        version: '2',
        senderId: 'peer-1',
        type: BeaconMessageType.BroadcastResponse,
        transactionHash: 'ooLateBcast123'
      }
    })
    expect(openToast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: fr.dapp.lateBroadcastToast,
        actions: expect.arrayContaining([
          expect.objectContaining({ actionText: fr.dapp.copyToClipboard })
        ])
      })
    )
  })

  it('configures locale, direction, and custom translations from DAppClientOptions and cleans up on destroy without leaking', async () => {
    configureBeaconI18n({ locale: 'fr' })
    expect(getBeaconMessages().meta.locale).toBe('fr')
    expect(getBeaconDirection()).toBe('ltr')

    const client = new DAppClient({
      name: 'Test dApp',
      locale: 'es',
      direction: 'rtl',
      translations: {
        dapp: {
          preparingRequest: 'Preparando personalizado...'
        }
      }
    })

    try {
      expect(getBeaconDirection()).toBe('rtl')
      expect(getBeaconMessages().meta.locale).toBe('es')

      await defaultEventCallbacks[BeaconEvent.SHOW_PREPARE]({})
      expect(openToast).toHaveBeenLastCalledWith(
        expect.objectContaining({
          body: 'Preparando personalizado...'
        })
      )

      await defaultEventCallbacks[BeaconEvent.PAIR_INIT]({
        p2pPeerInfo: Promise.resolve('p2p'),
        postmessagePeerInfo: Promise.resolve('post'),
        walletConnectPeerInfo: Promise.resolve({ ok: true, uri: 'wc:test' }),
        networkType: NetworkType.MAINNET,
        analytics: { track: vi.fn() }
      })
      expect(openAlert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: builtInLocales.es.dapp.choosePreferredWallet
        })
      )

      await expect(client.requestSignPayload({ payload: '' })).rejects.toMatchObject({
        description: builtInLocales.es.dapp.payloadRequired
      })
    } finally {
      await client.destroy()
    }

    // Destroying the overridden client restores the preconfigured global French state
    expect(getBeaconMessages().meta.locale).toBe('fr')
    expect(getBeaconDirection()).toBe('ltr')

    // Sequential client with no i18n options after reset uses English default
    resetBeaconI18n()
    const arClient = new DAppClient({
      name: 'Arabic dApp',
      locale: 'ar'
    })
    expect(getBeaconMessages().meta.locale).toBe('ar')
    expect(getBeaconDirection()).toBe('rtl')
    await arClient.destroy()

    const defaultClient = new DAppClient({
      name: 'Default dApp'
    })
    try {
      expect(getBeaconMessages().meta.locale).toBe('en')
      expect(getBeaconDirection()).toBe('ltr')
    } finally {
      await defaultClient.destroy()
    }
  })

  it('supports runtime i18n instance methods on DAppClient and forwards updated i18n/colorMode options through getDAppClientInstance', async () => {
    const languagesSpy = vi
      .spyOn(window.navigator, 'languages', 'get')
      .mockReturnValue(['fr-FR', 'fr'])
    const languageSpy = vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('fr-FR')
    document.documentElement.lang = 'en'
    document.documentElement.removeAttribute('dir')

    const client = getDAppClientInstance(
      {
        name: 'Singleton dApp'
      },
      true
    )

    try {
      // Auto-detects French from navigator.languages despite <html lang="en">
      expect(client.getLocale()).toBeUndefined()
      expect(client.resolveLang()).toBe('fr-FR')
      expect(client.getDirection()).toBe('ltr')
      expect(client.getMessages().meta.locale).toBe('fr')

      // Programmatic updates via DAppClient instance methods preserve sibling fields
      client.setTranslations({
        ui: {
          connectWallet: 'Conectar billetera personalizada'
        }
      })
      client.setLocale('es')
      expect(client.getLocale()).toBe('es')
      expect(client.resolveLang()).toBe('es')
      expect(client.getMessages().meta.locale).toBe('es')
      expect(client.getMessages().ui.connectWallet).toBe('Conectar billetera personalizada')

      client.setDirection('rtl')
      expect(client.getDirection()).toBe('rtl')
      client.setDirection('auto')
      expect(client.getDirection()).toBe('ltr')

      // Clearing locale override via setLocale(undefined) falls back to browser locale ('fr-FR')
      client.setLocale(undefined)
      expect(client.getLocale()).toBeUndefined()
      expect(client.resolveLang()).toBe('fr-FR')
      expect(client.getMessages().meta.locale).toBe('fr')

      // Reusing getDAppClientInstance without reset forwards updated i18n and colorMode options
      const reused = getDAppClientInstance({
        name: 'Singleton dApp',
        locale: 'ar',
        direction: 'auto',
        colorMode: ColorMode.DARK,
        translations: {
          dapp: {
            preparingRequest: 'تحضير مخصص...'
          }
        }
      })
      expect(reused).toBe(client)
      expect(client.getLocale()).toBe('ar')
      expect(client.getDirection()).toBe('rtl')
      expect(client.getMessages().meta.locale).toBe('ar')
      expect(client.getMessages().dapp.preparingRequest).toBe('تحضير مخصص...')
      expect(setColorMode).toHaveBeenLastCalledWith(ColorMode.DARK)

      client.configureI18n({
        locale: 'ja',
        direction: 'ltr',
        translations: undefined
      })
      expect(client.getLocale()).toBe('ja')
      expect(client.getDirection()).toBe('ltr')
      expect(client.getTranslations()).toBeUndefined()
      expect(client.getMessages().meta.locale).toBe('ja')

      // Singleton reuse forwards explicit undefined clears for locale, direction, and translations
      const clearedViaReuse = getDAppClientInstance({
        name: 'Singleton dApp',
        locale: undefined,
        direction: undefined,
        translations: undefined
      })
      expect(clearedViaReuse).toBe(client)
      expect(client.getLocale()).toBeUndefined()
      expect(client.resolveLang()).toBe('fr-FR')
      expect(client.getDirection()).toBe('ltr')
      expect(client.getTranslations()).toBeUndefined()

      // Re-apply an override on the singleton, then verify repeat calls with identical config (e.g. StrictMode/HMR) do not clobber runtime setLocale
      const initialStrictConfig = {
        name: 'Singleton dApp',
        locale: 'en'
      }
      getDAppClientInstance(initialStrictConfig)
      expect(client.getLocale()).toBe('en')
      client.setLocale('ar')
      expect(client.getLocale()).toBe('ar')
      // Calling getDAppClientInstance again with the same initial config object or same config values must not overwrite 'ar' back to 'en'
      getDAppClientInstance(initialStrictConfig)
      expect(client.getLocale()).toBe('ar')
      getDAppClientInstance({ name: 'Singleton dApp', locale: 'en' })
      expect(client.getLocale()).toBe('ar')

      // Reset with getDAppClientInstance(..., true)
      const replacement = getDAppClientInstance(
        {
          name: 'Replacement dApp'
        },
        true
      )
      try {
        expect(replacement).not.toBe(client)
        // Old singleton's i18n registration was unregistered on reset, and late setLocale calls on the retired instance are ignored
        expect(replacement.getLocale()).toBeUndefined()
        expect(replacement.resolveLang()).toBe('fr-FR')
        expect(replacement.getDirection()).toBe('ltr')
        client.setLocale('es')
        client.configureI18n({ locale: 'es', direction: 'rtl' })
        expect(replacement.getLocale()).toBeUndefined()
        expect(replacement.resolveLang()).toBe('fr-FR')
        expect(replacement.getDirection()).toBe('ltr')
      } finally {
        await replacement.destroy()
      }
    } finally {
      await client.destroy()
      languagesSpy.mockRestore()
      languageSpy.mockRestore()
      document.documentElement.removeAttribute('lang')
      document.documentElement.removeAttribute('dir')
    }
  })

  it('dynamically re-evaluates defaultEventCallbacks toast, alert, and internal-error copy when the locale changes while mounted, and preserves preconfigured colorMode when omitted', async () => {
    configureBeaconI18n({ locale: 'fr' })
    vi.mocked(setColorMode).mockClear()
    const clientWithoutColorMode = new DAppClient({ name: 'No ColorMode dApp' })
    try {
      expect(setColorMode).not.toHaveBeenCalled()

      await defaultEventCallbacks[BeaconEvent.PERMISSION_REQUEST_SENT]({
        requestId: 'req-live-1',
        requestType: BeaconMessageType.PermissionRequest,
        transport: TransportType.P2P,
        dispatchStage: 'transport',
        sentAt: 1,
        walletInfo: { name: 'Kukai' },
        extraInfo: {}
      })

      const lastToastCall = vi.mocked(openToast).mock.calls.at(-1)?.[0]
      expect(lastToastCall).toBeDefined()
      expect(lastToastCall?.body).toBe(builtInLocales.fr.dapp.requestSent)
      expect(lastToastCall?.actions?.[0]?.text).toBe(builtInLocales.fr.dapp.noAnswerFromWallet)
      expect(lastToastCall?.actions?.[1]?.actionText).toBe(builtInLocales.fr.dapp.resetConnection)

      // Trigger an internal error alert (empty payload) while locale is French
      await expect(
        clientWithoutColorMode.requestSignPayload({ payload: '' })
      ).rejects.toMatchObject({
        description: builtInLocales.fr.dapp.payloadRequired
      })
      const lastAlertCall = vi.mocked(openAlert).mock.calls.at(-1)?.[0]
      expect(lastAlertCall?.title).toBe(builtInLocales.fr.dapp.internalErrorTitle)
      expect(lastAlertCall?.body).toBe(builtInLocales.fr.dapp.payloadRequired)

      // Switch locale while the toast and internal-error alert configs are active
      configureBeaconI18n({ locale: 'de' })
      expect(lastToastCall?.body).toBe(builtInLocales.de.dapp.requestSent)
      expect(lastToastCall?.actions?.[0]?.text).toBe(builtInLocales.de.dapp.noAnswerFromWallet)
      expect(lastToastCall?.actions?.[1]?.actionText).toBe(builtInLocales.de.dapp.resetConnection)
      expect(lastAlertCall?.title).toBe(builtInLocales.de.dapp.internalErrorTitle)
      expect(lastAlertCall?.body).toBe(builtInLocales.de.dapp.payloadRequired)
    } finally {
      await clientWithoutColorMode.destroy()
    }
  })
})
