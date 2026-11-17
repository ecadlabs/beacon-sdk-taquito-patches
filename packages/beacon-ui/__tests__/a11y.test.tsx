import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  builtInLocales,
  configureBeaconI18n,
  NetworkType,
  resetBeaconI18n
} from '@ecadlabs/beacon-types'
import { Alert } from '../src/components/alert'
import { ButtonIcon } from '../src/components/button-icon/button-icon'
import { CloseIcon, LeftIcon, LogoIcon, QRCodeIcon } from '../src/components/icons'
import { Info } from '../src/components/info'
import { Loader } from '../src/components/loader'
import { PairOther } from '../src/components/pair-other'
import { QR } from '../src/components/qr'
import { Toast } from '../src/components/toast'
import { TopWallets } from '../src/components/top-wallets'
import { Wallet } from '../src/components/wallet'
import { Wallets } from '../src/components/wallets'

const readCss = (relPath: string): string =>
  readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8')

describe('Beacon UI accessibility (WCAG / WAI-ARIA, keyboard, focus, live regions)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    resetBeaconI18n()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers()
    })
    vi.useRealTimers()
    resetBeaconI18n()
    document.body.innerHTML = ''
  })

  it('exposes dialog semantics (role="dialog", aria-modal="true", aria-labelledby) on Alert, hides closed dialog from AT, and wires localized Close/Back labels', () => {
    const onClose = vi.fn()
    const onBack = vi.fn()
    const onShowMore = vi.fn()
    const { container, rerender } = render(
      <Alert
        open
        closeOnBackdropClick
        onCloseClick={onClose}
        onBackClick={onBack}
        extraContent={<div>Extra wallets</div>}
        showMore={false}
        onClickShowMore={onShowMore}
      >
        <Info title="Accessible Modal Title" description="Modal body" />
      </Alert>
    )

    const dialog = container.querySelector('.alert-modal-show')
    expect(dialog).not.toBeNull()
    expect(dialog).toHaveAttribute('role', 'dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).not.toHaveAttribute('aria-hidden', 'true')

    const labelledBy = dialog?.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    const heading = labelledBy ? container.querySelector(`#${CSS.escape(labelledBy)}`) : null
    expect(heading?.textContent).toBe('Accessible Modal Title')

    const backBtn = screen.getByRole('button', { name: builtInLocales.en.aria.goBack })
    const closeBtn = screen.getByRole('button', { name: builtInLocales.en.aria.closeModal })
    expect(backBtn).toHaveClass('button-icon')
    expect(closeBtn).toHaveClass('button-icon')

    fireEvent.keyDown(backBtn, { key: 'Enter' })
    expect(onBack).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(closeBtn, { key: ' ' })
    expect(onClose).toHaveBeenCalledTimes(1)

    const showMoreToggle = screen.getByRole('button', { name: builtInLocales.en.ui.showMore })
    expect(showMoreToggle).toHaveClass('alert-footer')
    expect(showMoreToggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(showMoreToggle, { key: 'Enter' })
    expect(onShowMore).toHaveBeenCalledTimes(1)

    // When open is false, the exiting dialog must be hidden from assistive tech and non-modal
    rerender(
      <Alert open={false} closeOnBackdropClick onCloseClick={onClose}>
        <Info title="Accessible Modal Title" description="Modal body" />
      </Alert>
    )
    const closedDialog = container.querySelector('.alert-modal-hide')
    expect(closedDialog).toHaveAttribute('aria-hidden', 'true')
    expect(closedDialog).not.toHaveAttribute('aria-modal')
  })

  it('traps Tab / Shift+Tab focus inside <beacon-alert>, closes on Escape, and restores focus to trigger (including Shadow DOM triggers) on close', async () => {
    const outerHost = document.createElement('div')
    document.body.appendChild(outerHost)
    const outerShadow = outerHost.attachShadow({ mode: 'open' })
    const triggerButton = document.createElement('button')
    triggerButton.textContent = 'Connect Wallet Trigger'
    outerShadow.appendChild(triggerButton)
    triggerButton.focus()
    expect(outerShadow.activeElement).toBe(triggerButton)

    const { openAlert, closeAlert } = await import('../src/ui/alert')
    const closeCallback = vi.fn()

    try {
      await act(async () => {
        openAlert({
          title: 'Keyboard Modal',
          body: 'Press Escape or Tab',
          closeButtonCallback: closeCallback
        })
      })

      const host = document.querySelector('beacon-alert')
      const shadow = host?.shadowRoot
      expect(shadow).toBeTruthy()

      const dialog = shadow?.querySelector<HTMLElement>('[role="dialog"]')
      expect(dialog).toBeTruthy()

      const focusables = Array.from(
        dialog?.querySelectorAll<HTMLElement>('button, [role="button"][tabindex="0"]') ?? []
      )
      expect(focusables.length).toBeGreaterThanOrEqual(2)

      // Initial focus must move inside the shadow root dialog onto the primary body action (not the header Close icon)
      expect(shadow?.activeElement).not.toBeNull()
      expect(dialog?.contains(shadow?.activeElement ?? null)).toBe(true)
      expect(shadow?.activeElement).toHaveClass('info-button')

      // Tab on last focusable element wraps to first focusable element
      const firstEl = focusables[0]
      const lastEl = focusables[focusables.length - 1]
      lastEl.focus()
      expect(shadow?.activeElement).toBe(lastEl)

      const tabForward = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
        composed: true
      })
      lastEl.dispatchEvent(tabForward)
      expect(tabForward.defaultPrevented).toBe(true)
      expect(shadow?.activeElement).toBe(firstEl)

      // Shift+Tab on first focusable element wraps to last focusable element
      const tabBackward = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        composed: true
      })
      firstEl.dispatchEvent(tabBackward)
      expect(tabBackward.defaultPrevented).toBe(true)
      expect(shadow?.activeElement).toBe(lastEl)

      // Escape from current focused element closes the modal and restores focus to triggerButton inside outerShadow
      await act(async () => {
        fireEvent.keyDown(shadow?.activeElement ?? dialog!, { key: 'Escape' })
      })

      expect(closeCallback).toHaveBeenCalledTimes(1)
      expect(outerShadow.activeElement).toBe(triggerButton)
      expect(shadow?.querySelector('.alert-modal-hide')).toHaveAttribute('aria-hidden', 'true')
    } finally {
      await act(async () => {
        closeAlert()
        vi.advanceTimersByTime(350)
      })
    }
  })

  it('retains focus inside <beacon-alert> across sub-view transitions (TopWallets -> Show more -> QR choice -> QR view -> Back) and never labels dialog with a wallet name', async () => {
    const { openAlert, closeAlert } = await import('../src/ui/alert')

    try {
      await act(async () => {
        openAlert({
          title: 'Choose your preferred wallet',
          pairingPayload: {
            p2pSyncCode: Promise.resolve('p2p-sync-payload'),
            postmessageSyncCode: Promise.resolve('post-sync-payload'),
            walletConnectSyncCode: Promise.resolve({ ok: true as const, uri: 'wc:sync@2' }),
            networkType: NetworkType.MAINNET
          }
        })
      })

      const host = document.querySelector('beacon-alert')
      const shadow = host?.shadowRoot
      const dialog = shadow?.querySelector<HTMLElement>('[role="dialog"]')
      expect(dialog).toBeTruthy()
      expect(dialog?.contains(shadow?.activeElement ?? null)).toBe(true)
      // Initial focus on TopWallets lands on the first wallet tile inside .alert-body, not the header Close button
      expect(shadow?.activeElement).toHaveClass('wallet-main')

      // 1. Expand "Show more" via keyboard
      const showMoreFooter = dialog?.querySelector<HTMLElement>('.alert-footer')
      expect(showMoreFooter).toBeTruthy()
      showMoreFooter?.focus()
      await act(async () => {
        fireEvent.keyDown(showMoreFooter!, { key: 'Enter' })
      })

      // 2. Activate "Show QR code" button in Wallets section (which unmounts the TopWallets view)
      const showQrBtn = Array.from(dialog?.querySelectorAll<HTMLElement>('button') ?? []).find(
        (btn) => btn.textContent === builtInLocales.en.ui.showQrCode
      )
      expect(showQrBtn).toBeTruthy()
      showQrBtn?.focus()
      await act(async () => {
        fireEvent.click(showQrBtn!)
      })

      // Focus must remain inside the dialog and land on the first QR type choice button in .alert-body (not Back/Close)
      expect(shadow?.activeElement).not.toBeNull()
      expect(dialog?.contains(shadow?.activeElement ?? null)).toBe(true)
      expect(shadow?.activeElement?.textContent).toBe(builtInLocales.en.ui.beaconQrOption)

      // 3. Activate "Beacon" button in PairOther (which unmounts the button and mounts QR)
      const beaconChoiceBtn = Array.from(
        dialog?.querySelectorAll<HTMLElement>('button') ?? []
      ).find((btn) => btn.textContent === builtInLocales.en.ui.beaconQrOption)
      expect(beaconChoiceBtn).toBeTruthy()
      beaconChoiceBtn?.focus()
      await act(async () => {
        fireEvent.click(beaconChoiceBtn!)
      })

      // Focus must remain inside the dialog and land on the QR copy button (.qr-right) in .alert-body
      expect(shadow?.activeElement).not.toBeNull()
      expect(dialog?.contains(shadow?.activeElement ?? null)).toBe(true)
      expect(shadow?.activeElement).toHaveClass('qr-right')

      // 4. Activate Back button (which unmounts the Back button when returning to TopWallets)
      const backBtn = dialog?.querySelector<HTMLElement>('.alert-header .button-icon')
      expect(backBtn).toHaveAttribute('aria-label', builtInLocales.en.aria.goBack)
      backBtn?.focus()
      await act(async () => {
        fireEvent.keyDown(backBtn!, { key: 'Enter' })
      })

      // Focus must remain inside the dialog and land on the first wallet tile in .alert-body
      expect(shadow?.activeElement).not.toBeNull()
      expect(dialog?.contains(shadow?.activeElement ?? null)).toBe(true)
      expect(shadow?.activeElement).toHaveClass('wallet-main')

      // Verify dialog aria-labelledby resolves to a modal/section heading, never a wallet tile name
      const labelledById = dialog?.getAttribute('aria-labelledby')
      const labelEl = labelledById ? shadow?.querySelector(`#${CSS.escape(labelledById)}`) : null
      expect(labelEl?.textContent).toBe(builtInLocales.en.ui.connectWallet)
    } finally {
      await act(async () => {
        closeAlert()
        vi.advanceTimersByTime(350)
      })
    }
  })

  it('supports keyboard activation (Enter / Space) across ButtonIcon, Info, Wallet, TopWallets, and Wallets controls while preserving E2E selectors', () => {
    const onIconClick = vi.fn()
    const { unmount: unmountIcon } = render(
      <ButtonIcon ariaLabel="Custom Action" onClick={onIconClick}>
        <CloseIcon />
      </ButtonIcon>
    )
    const iconBtn = screen.getByRole('button', { name: 'Custom Action' })
    expect(iconBtn.tagName.toLowerCase()).toBe('div')
    expect(iconBtn).toHaveClass('button-icon')
    expect(iconBtn).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(iconBtn, { key: 'Enter' })
    fireEvent.keyDown(iconBtn, { key: ' ' })
    expect(onIconClick).toHaveBeenCalledTimes(2)
    unmountIcon()

    const onQrClick = vi.fn()
    const { container: infoContainer, unmount: unmountInfo } = render(
      <Info title="Card Title" onShowQRCodeClick={onQrClick} />
    )
    const qrIconBtn = infoContainer.querySelector('button#qr-code-icon')
    expect(qrIconBtn).not.toBeNull()
    expect(qrIconBtn).toHaveAttribute('aria-label', builtInLocales.en.aria.showQrCode)
    expect(qrIconBtn).toHaveAttribute('type', 'button')
    fireEvent.click(qrIconBtn!)
    expect(onQrClick).toHaveBeenCalledTimes(1)
    unmountInfo()

    const onWalletClick = vi.fn()
    const { unmount: unmountWallet } = render(
      <Wallet
        name="Kukai"
        image="kukai.svg"
        description="Web App"
        tags={['popular']}
        onClick={onWalletClick}
      />
    )
    const walletTile = screen.getByRole('button', { name: 'Kukai, Web App, popular' })
    expect(walletTile).toHaveClass('wallet-main')
    expect(walletTile).toHaveAttribute('tabindex', '0')
    expect(walletTile.getAttribute('aria-label')).not.toContain('logo')
    fireEvent.keyDown(walletTile, { key: 'Enter' })
    fireEvent.keyDown(walletTile, { key: ' ' })
    expect(onWalletClick).toHaveBeenCalledTimes(2)
    unmountWallet()

    const onDisabledWalletClick = vi.fn()
    const { container: disabledContainer, unmount: unmountDisabled } = render(
      <Wallet name="Temple" image="temple.svg" disabled onClick={onDisabledWalletClick} />
    )
    const disabledTile = disabledContainer.querySelector('.wallet-main')
    expect(disabledTile).toHaveAttribute('aria-disabled', 'true')
    expect(disabledTile).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(disabledTile!, { key: 'Enter' })
    expect(onDisabledWalletClick).not.toHaveBeenCalled()
    unmountDisabled()

    const onOtherWallets = vi.fn()
    const { unmount: unmountTop } = render(
      <TopWallets
        wallets={[]}
        isMobile
        onClickWallet={vi.fn()}
        otherWallets={{ images: ['1.svg', '2.svg', '3.svg'], onClick: onOtherWallets }}
      />
    )
    const otherWalletsTile = screen.getByRole('button', {
      name: `${builtInLocales.en.ui.otherWallets}, ${builtInLocales.en.ui.otherWalletsDescription}`
    })
    expect(otherWalletsTile).toHaveClass('top-wallets-other-wallets')
    expect(otherWalletsTile).toHaveAttribute('tabindex', '0')
    expect(otherWalletsTile.getAttribute('aria-label')).not.toContain('Other Wallet 1')
    fireEvent.keyDown(otherWalletsTile, { key: 'Enter' })
    expect(onOtherWallets).toHaveBeenCalledTimes(1)
    unmountTop()

    const onPairOtherDevice = vi.fn()
    const { unmount: unmountWallets } = render(
      <Wallets wallets={[]} isMobile onClickWallet={vi.fn()} onClickOther={onPairOtherDevice} />
    )
    const pairOtherBtn = screen.getByRole('button', {
      name: builtInLocales.en.ui.pairWalletOnAnotherDevice
    })
    expect(pairOtherBtn).toHaveAttribute('type', 'button')
    fireEvent.click(pairOtherBtn)
    expect(onPairOtherDevice).toHaveBeenCalledTimes(1)
    unmountWallets()
  })

  it('wires QR copy control with keyboard support, localized SVG role="img" label, persistent live status region, and intact checkmark path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    const onClickQrCode = vi.fn()
    let container!: HTMLElement
    await act(async () => {
      const rendered = render(
        <QR
          isWalletConnect={true}
          isMobile={false}
          walletName="Kukai"
          code="wc:test-uri@2"
          onClickQrCode={onClickQrCode}
        />
      )
      container = rendered.container
    })

    const qrRight = container.querySelector('div.qr-right')
    expect(qrRight).not.toBeNull()
    expect(qrRight).toHaveAttribute('role', 'button')
    expect(qrRight).toHaveAttribute('tabindex', '0')
    expect(qrRight).toHaveAttribute(
      'aria-label',
      `WalletConnect pairing QR code for Kukai. ${builtInLocales.en.aria.copyQrToClipboard}`
    )

    // Persistent live region exists before copying and starts empty
    const liveStatus = container.querySelector('[role="status"][aria-live="polite"]')
    expect(liveStatus).not.toBeNull()
    expect(liveStatus?.textContent).toBe('')

    const qrSvg = container.querySelector('.qr-svg-wrapper svg')
    expect(qrSvg).not.toBeNull()
    expect(qrSvg).toHaveAttribute('role', 'img')
    expect(qrSvg).toHaveAttribute('aria-label', 'WalletConnect pairing QR code for Kukai')

    await act(async () => {
      fireEvent.keyDown(qrRight!, { key: 'Enter' })
    })

    expect(onClickQrCode).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('wc:test-uri@2')
    expect(qrRight).toHaveAttribute(
      'aria-label',
      `WalletConnect pairing QR code for Kukai. ${builtInLocales.en.aria.copiedToClipboard}`
    )
    expect(liveStatus?.textContent).toBe(builtInLocales.en.aria.copiedToClipboard)

    // Verify checkmark SVG path data was not corrupted
    const copiedPath = container.querySelector('.qr-copy-wrapper svg path')?.getAttribute('d')
    expect(copiedPath).toContain('c10.9-10.9 28.7-10.9 39.6 0 10.9 10.9 10.9 28.7 0 39.6')
  })

  it('exposes live region and keyboard-operable actions on Toast, status on Loader, and aria-hidden on decorative icons', () => {
    configureBeaconI18n({ locale: 'fr' })
    const fr = builtInLocales.fr
    const onOpenWallet = vi.fn()
    const onAction = vi.fn()
    const onClose = vi.fn()

    const { container } = render(
      <Toast
        open
        state="finished"
        label="Opération terminée"
        onClickClose={onClose}
        openWalletAction={onOpenWallet}
        actions={[{ text: 'Détails', actionText: fr.dapp.showDetails, actionCallback: onAction }]}
      />
    )

    const toastWrapper = container.querySelector('.toast-wrapper-show')
    expect(toastWrapper).toHaveAttribute('role', 'status')
    expect(toastWrapper).toHaveAttribute('aria-live', 'polite')
    expect(toastWrapper).toHaveAttribute('aria-atomic', 'true')
    expect(toastWrapper).toHaveAttribute('aria-label', 'Opération terminée. Détails')
    expect(toastWrapper?.getAttribute('aria-label')).not.toContain(fr.ui.openWallet)
    expect(toastWrapper?.getAttribute('aria-label')).not.toContain(fr.aria.closeToast)
    expect(container.querySelector('p.toast-label')?.textContent).toBe('Opération terminée')

    const loader = container.querySelector('.loader')
    expect(loader).toHaveAttribute('role', 'status')
    expect(loader).toHaveAttribute('aria-label', fr.aria.loading)

    const openWalletBtn = screen.getByRole('button', { name: fr.ui.openWallet })
    fireEvent.keyDown(openWalletBtn, { key: 'Enter' })
    expect(onOpenWallet).toHaveBeenCalledTimes(1)

    const detailBtn = screen.getByRole('button', { name: fr.dapp.showDetails })
    fireEvent.keyDown(detailBtn, { key: ' ' })
    expect(onAction).toHaveBeenCalledTimes(1)

    const closeBtn = screen.getByRole('button', { name: fr.aria.closeToast })
    fireEvent.keyDown(closeBtn, { key: 'Enter' })
    expect(onClose).toHaveBeenCalledTimes(1)

    const { container: iconsContainer } = render(
      <div>
        <CloseIcon />
        <LeftIcon />
        <LogoIcon />
        <QRCodeIcon />
        <Loader />
      </div>
    )
    const svgs = iconsContainer.querySelectorAll('svg')
    expect(svgs.length).toBe(4)
    svgs.forEach((svg) => {
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg).toHaveAttribute('focusable', 'false')
    })
  })

  it('preserves span.pair-other-info and button type="button" in PairOther', async () => {
    let containerEl!: HTMLElement
    await act(async () => {
      const rendered = render(
        <PairOther
          walletList={[]}
          p2pPayload={Promise.resolve('p2p-code')}
          wcPayload={Promise.resolve('wc-code')}
        />
      )
      containerEl = rendered.container
    })

    expect(containerEl.querySelector('span.pair-other-info')).not.toBeNull()
    const beaconBtn = screen.getByRole('button', { name: builtInLocales.en.ui.beaconQrOption })
    expect(beaconBtn).toHaveAttribute('type', 'button')
  })

  it('includes prefers-reduced-motion and :focus-visible rules in component stylesheets', () => {
    const alertCss = readCss('../src/components/alert/styles.css')
    const toastCss = readCss('../src/components/toast/styles.css')
    const loaderCss = readCss('../src/components/loader/styles.css')
    const buttonIconCss = readCss('../src/components/button-icon/button-icon.css')
    const infoCss = readCss('../src/components/info/styles.css')
    const walletCss = readCss('../src/components/wallet/styles.css')
    const walletsCss = readCss('../src/components/wallets/styles.css')
    const topWalletsCss = readCss('../src/components/top-wallets/styles.css')
    const qrCss = readCss('../src/components/qr/styles.css')

    expect(alertCss).toContain('prefers-reduced-motion: reduce')
    expect(toastCss).toContain('prefers-reduced-motion: reduce')
    expect(loaderCss).toContain('prefers-reduced-motion: reduce')

    expect(alertCss).toContain(':focus-visible')
    expect(toastCss).toContain(':focus-visible')
    expect(buttonIconCss).toContain(':focus-visible')
    expect(infoCss).toContain(':focus-visible')
    expect(walletCss).toContain(':focus-visible')
    expect(walletsCss).toContain(':focus-visible')
    expect(topWalletsCss).toContain(':focus-visible')
    expect(qrCss).toContain(':focus-visible')
  })
})
