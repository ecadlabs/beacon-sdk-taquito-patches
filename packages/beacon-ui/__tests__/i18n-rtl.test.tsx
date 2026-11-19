import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  builtInLocales,
  configureBeaconI18n,
  NetworkType,
  resetBeaconI18n
} from '@ecadlabs/beacon-types'
import { TopWallets } from '../src/components/top-wallets'
import { Wallets } from '../src/components/wallets'
import { PairOther } from '../src/components/pair-other'
import { QR } from '../src/components/qr'
import { Toast } from '../src/components/toast'
import { WCInitError } from '../src/ui/alert/components/pairing-alert/components/wc-init-error'
import { useWallets } from '../src/ui/alert/hooks/useWallets'

describe('Beacon UI i18n, lang, and RTL support', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    resetBeaconI18n()
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('dir')
    document.documentElement.removeAttribute('lang')
  })

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers()
    })
    vi.useRealTimers()
    resetBeaconI18n()
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('dir')
    document.documentElement.removeAttribute('lang')
  })

  it('sets dir="rtl" and lang="ar" on <beacon-alert> and <beacon-toast> and updates mounted UI when locale changes dynamically', async () => {
    const { configureBeaconI18n: configI18n } = await import('@ecadlabs/beacon-types')
    configI18n({ locale: 'fr' })
    const { openAlert, closeAlert } = await import('../src/ui/alert')
    const { openToast, closeToast } = await import('../src/ui/toast')

    await act(async () => {
      openAlert({ title: 'Test', body: 'Contenu' })
      openToast({
        body: builtInLocales.fr.dapp.requestSent,
        state: 'loading',
        walletInfo: { name: 'Kukai' },
        openWalletAction: vi.fn()
      })
    })

    const alertHost = document.querySelector('beacon-alert')
    const alertThemeContainer = alertHost?.shadowRoot?.querySelector('[dir]')
    expect(alertHost?.getAttribute('dir')).toBe('ltr')
    expect(alertHost?.getAttribute('lang')).toBe('fr')
    expect(alertThemeContainer?.getAttribute('dir')).toBe('ltr')
    expect(alertThemeContainer?.getAttribute('lang')).toBe('fr')
    expect(alertHost?.shadowRoot?.textContent).toContain(builtInLocales.fr.ui.close)

    const toastHost = document.querySelector('beacon-toast')
    const toastThemeContainer = toastHost?.shadowRoot?.querySelector('[dir]')
    expect(toastHost?.getAttribute('dir')).toBe('ltr')
    expect(toastHost?.getAttribute('lang')).toBe('fr')
    expect(toastThemeContainer?.getAttribute('dir')).toBe('ltr')
    expect(toastThemeContainer?.getAttribute('lang')).toBe('fr')
    expect(toastHost?.shadowRoot?.textContent).toContain(builtInLocales.fr.ui.openWallet)

    // Dynamically switch to Arabic / RTL after mount
    await act(async () => {
      configI18n({ locale: 'ar', direction: 'rtl' })
    })

    expect(alertHost?.getAttribute('dir')).toBe('rtl')
    expect(alertHost?.getAttribute('lang')).toBe('ar')
    expect(alertThemeContainer?.getAttribute('dir')).toBe('rtl')
    expect(alertThemeContainer?.getAttribute('lang')).toBe('ar')
    expect(alertHost?.shadowRoot?.textContent).toContain(builtInLocales.ar.ui.close)

    expect(toastHost?.getAttribute('dir')).toBe('rtl')
    expect(toastHost?.getAttribute('lang')).toBe('ar')
    expect(toastThemeContainer?.getAttribute('dir')).toBe('rtl')
    expect(toastThemeContainer?.getAttribute('lang')).toBe('ar')
    expect(toastHost?.shadowRoot?.textContent).toContain(builtInLocales.ar.ui.openWallet)

    await act(async () => {
      closeAlert()
      closeToast()
      vi.advanceTimersByTime(350)
    })
  })

  it('inherits document.documentElement.dir and supported lang when not explicitly configured, and avoids mislabeling unsupported document lang', async () => {
    document.documentElement.dir = 'rtl'
    document.documentElement.lang = 'ar'

    const { openAlert, closeAlert } = await import('../src/ui/alert')
    await act(async () => {
      openAlert({ title: 'Title', body: 'Body' })
    })

    const alertHost = document.querySelector('beacon-alert')
    const alertThemeContainer = alertHost?.shadowRoot?.querySelector('[dir]')
    expect(alertThemeContainer?.getAttribute('dir')).toBe('rtl')
    expect(alertThemeContainer?.getAttribute('lang')).toBe('ar')
    expect(alertHost?.shadowRoot?.textContent).toContain(builtInLocales.ar.ui.close)

    // Unsupported document lang without custom translations falls back to English catalog and lang="en"
    document.documentElement.dir = 'ltr'
    document.documentElement.lang = 'it'
    await act(async () => {
      openAlert({ title: 'Title', body: 'Body' })
    })
    expect(alertThemeContainer?.getAttribute('dir')).toBe('ltr')
    expect(alertThemeContainer?.getAttribute('lang')).toBe('en')
    expect(alertHost?.shadowRoot?.textContent).toContain(builtInLocales.en.ui.close)

    await act(async () => {
      closeAlert()
      vi.advanceTimersByTime(350)
    })
  })

  it('renders localized strings across TopWallets, Wallets, PairOther, QR, WCInitError, and useWallets', async () => {
    configureBeaconI18n({ locale: 'fr' })
    const fr = builtInLocales.fr

    const { result } = renderHook(() => useWallets(NetworkType.MAINNET))
    const walletsList = Array.from(result.current.wallets.values())
    expect(walletsList.length).toBeGreaterThan(0)
    const allDescriptions = walletsList.flatMap((w) => w.descriptions)
    expect(allDescriptions).toContain(fr.ui.walletTypes.webApp)
    expect(allDescriptions).not.toContain('Web App')

    const wallet = walletsList[0]

    const { unmount: unmountTop } = render(
      <TopWallets
        wallets={[wallet]}
        isMobile={false}
        onClickWallet={vi.fn()}
        otherWallets={{ images: ['1.svg', '2.svg', '3.svg'], onClick: vi.fn() }}
      />
    )
    expect(screen.getByText(fr.ui.connectWallet)).toBeInTheDocument()
    expect(screen.getByText(fr.ui.otherWallets)).toBeInTheDocument()
    expect(screen.getByText(fr.ui.otherWalletsDescription)).toBeInTheDocument()
    unmountTop()

    const { unmount: unmountWallets } = render(
      <Wallets wallets={[wallet]} isMobile={false} onClickWallet={vi.fn()} onClickOther={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: fr.ui.showQrCode })).toBeInTheDocument()
    unmountWallets()

    let unmountPairOther: () => void = () => {}
    await act(async () => {
      const rendered = render(
        <PairOther
          walletList={walletsList}
          p2pPayload={Promise.resolve('p2p-qr')}
          wcPayload={Promise.resolve({ ok: true as const, uri: 'wc:qr' })}
          onClickLearnMore={vi.fn()}
        />
      )
      unmountPairOther = rendered.unmount
    })
    expect(screen.getByText(fr.ui.selectQrType)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: fr.ui.beaconQrOption })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: fr.ui.walletConnectQrOption })).toBeInTheDocument()
    unmountPairOther()

    const { unmount: unmountQr } = render(
      <QR isWalletConnect={false} isMobile={false} walletName="Kukai" code="tezos://test" />
    )
    expect(screen.getByText(fr.ui.orScanToConnect)).toBeInTheDocument()
    expect(screen.getByText(fr.ui.copyToClipboard)).toBeInTheDocument()
    unmountQr()

    const { unmount: unmountWcError } = render(<WCInitError reason="timeout" />)
    expect(screen.getByText(fr.ui.scanQrCode)).toBeInTheDocument()
    expect(screen.getByText(fr.ui.walletConnectErrors.timeout.heading)).toBeInTheDocument()
    unmountWcError()
  })

  it('delays showing Toast actions by 3000ms for loading state, supports whitespace in {{ wallet }} placeholders, and keeps mid-sentence wallet labels in a single inline container', () => {
    configureBeaconI18n({ locale: 'de' })
    const de = builtInLocales.de

    const { container } = render(
      <Toast
        open
        state="loading"
        label="Anfrage für {{ wallet }} wird vorbereitet..."
        walletInfo={{ name: 'Kukai', icon: 'kukai.svg' }}
        onClickClose={vi.fn()}
        openWalletAction={vi.fn()}
        actions={[{ text: de.dapp.noAnswerFromWallet, isBold: true }]}
      />
    )

    expect(screen.getByText('Kukai')).toBeInTheDocument()
    expect(screen.queryByText(/\{\{/)).not.toBeInTheDocument()
    expect(screen.getByText(de.ui.openWallet)).toBeInTheDocument()
    expect(screen.queryByText(de.dapp.noAnswerFromWallet)).not.toBeInTheDocument()

    // Ensure the wallet name is wrapped in <bdi> inside a single .toast-content inline group
    const toastContent = container.querySelector('.toast-content')
    expect(toastContent).not.toBeNull()
    expect(toastContent?.querySelector('bdi')?.textContent).toBe('Kukai')
    expect(toastContent?.textContent).toContain('Anfrage für')
    expect(toastContent?.textContent).toContain('wird vorbereitet...')

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(screen.getByText(de.dapp.noAnswerFromWallet)).toBeInTheDocument()
  })

  it('shares i18n singleton state between @ecadlabs/beacon-types and the built @ecadlabs/beacon-ui bundle', async () => {
    const builtUi = await import('../dist/esm/index.js')
    await act(async () => {
      configureBeaconI18n({ locale: 'ar', direction: 'rtl' })
    })

    expect(builtUi.getBeaconLocale()).toBe('ar')
    expect(builtUi.getBeaconDirection()).toBe('rtl')
    expect(builtUi.getBeaconMessages().meta.locale).toBe('ar')
  })

  it('resolves named i18n exports from the built @ecadlabs/beacon-dapp browser ESM entrypoint without Rollup NAMESPACE_CONFLICT or MISSING_EXPORT warnings', async () => {
    const path = await import('node:path')
    const { rollup } = await import('rollup')
    const { nodeResolve } = await import('@rollup/plugin-node-resolve')
    const dappEsmEntry = path.resolve(__dirname, '../../beacon-dapp/dist/esm/index.js')
    const warnings: Array<{ code?: string; message: string }> = []

    const bundle = await rollup({
      input: 'entry.js',
      onwarn(warning) {
        if (warning.code === 'NAMESPACE_CONFLICT' || warning.code === 'MISSING_EXPORT') {
          warnings.push({ code: warning.code, message: warning.message })
        }
      },
      external: (id) =>
        id !== 'entry.js' &&
        !id.startsWith('.') &&
        !id.startsWith('/') &&
        !id.startsWith('@ecadlabs/beacon-'),
      plugins: [
        {
          name: 'virtual-entry',
          resolveId(id) {
            return id === 'entry.js' ? id : null
          },
          load(id) {
            if (id !== 'entry.js') {
              return null
            }
            return `export {
              configureBeaconI18n,
              detectBrowserLocale,
              hasBuiltInLocale,
              normalizeLocaleTag,
              resolveBuiltInLocaleCatalog,
              setBeaconLocale,
              getBeaconLocale,
              resolveBeaconLang,
              setBeaconDirection,
              getBeaconDirection,
              setBeaconTranslations,
              getBeaconTranslations,
              getBeaconMessages,
              getBeaconErrorCopy,
              interpolateBeaconMessage,
              resetBeaconI18n,
              subscribeBeaconI18n,
              builtInLocales,
              enMessages,
              frMessages,
              esMessages,
              deMessages,
              jaMessages,
              arMessages,
              plMessages
            } from ${JSON.stringify(dappEsmEntry)}`
          }
        },
        nodeResolve({ browser: true })
      ]
    })
    await bundle.close()
    expect(warnings).toEqual([])
  })

  it('repaints mounted <beacon-alert> and <beacon-toast> on runtime setColorMode, window languagechange, and <html lang/dir> mutations', async () => {
    const { ColorMode } = await import('@ecadlabs/beacon-types')
    const { setColorMode, getColorMode } = await import('../src/utils/colorMode')
    const { openAlert, closeAlert } = await import('../src/ui/alert')
    const { openToast, closeToast } = await import('../src/ui/toast')

    setColorMode(ColorMode.LIGHT)
    document.documentElement.lang = 'en'
    document.documentElement.dir = 'ltr'

    await act(async () => {
      openAlert({ title: 'Test', body: 'Body' })
      openToast({
        body: builtInLocales.en.dapp.requestSent,
        state: 'loading',
        walletInfo: { name: 'Kukai' },
        openWalletAction: vi.fn()
      })
    })

    const alertHost = document.querySelector('beacon-alert')
    const alertThemeContainer = alertHost?.shadowRoot?.querySelector('[dir]')
    const toastHost = document.querySelector('beacon-toast')
    const toastThemeContainer = toastHost?.shadowRoot?.querySelector('[dir]')

    expect(alertThemeContainer?.className).toContain('theme__light')
    expect(toastThemeContainer?.className).toContain('theme__light')

    // Runtime colorMode update repaints both open roots
    await act(async () => {
      setColorMode(ColorMode.DARK)
    })
    expect(getColorMode()).toBe(ColorMode.DARK)
    expect(alertThemeContainer?.className).toContain('theme__dark')
    expect(toastThemeContainer?.className).toContain('theme__dark')

    // Host SPA mutating <html lang="de"> updates open modals/toasts when browser language is default English
    const languagesSpy = vi
      .spyOn(window.navigator, 'languages', 'get')
      .mockReturnValue(['en-US', 'en'])
    const languageSpy = vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('en-US')

    await act(async () => {
      document.documentElement.lang = 'de'
      await Promise.resolve()
    })
    expect(alertHost?.getAttribute('lang')).toBe('de')
    expect(alertHost?.shadowRoot?.textContent).toContain(builtInLocales.de.ui.close)
    expect(toastHost?.getAttribute('lang')).toBe('de')
    expect(toastHost?.shadowRoot?.textContent).toContain(builtInLocales.de.ui.openWallet)

    // Browser languagechange event updates open modals/toasts when <html lang="en"> is boilerplate
    document.documentElement.lang = 'en'
    languagesSpy.mockReturnValue(['ar-EG', 'ar'])
    languageSpy.mockReturnValue('ar-EG')

    await act(async () => {
      window.dispatchEvent(new Event('languagechange'))
    })
    expect(alertHost?.getAttribute('lang')).toBe('ar-EG')
    expect(alertHost?.getAttribute('dir')).toBe('rtl')
    expect(alertHost?.shadowRoot?.textContent).toContain(builtInLocales.ar.ui.close)
    expect(toastHost?.getAttribute('lang')).toBe('ar-EG')
    expect(toastHost?.getAttribute('dir')).toBe('rtl')
    expect(toastHost?.shadowRoot?.textContent).toContain(builtInLocales.ar.ui.openWallet)

    languagesSpy.mockRestore()
    languageSpy.mockRestore()
    setColorMode(ColorMode.LIGHT)

    await act(async () => {
      closeAlert()
      closeToast()
      vi.advanceTimersByTime(350)
    })
  })
})
