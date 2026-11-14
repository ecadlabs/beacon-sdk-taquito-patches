import { reportDiagnostic } from '@ecadlabs/beacon-core'
import type { Mock } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NetworkType } from '@ecadlabs/beacon-types'
import PairingAlert from '../../../src/ui/alert/components/pairing-alert'
import { ConfigurableAlertProps } from '../../../src/ui/common'
import { useWallets } from '../../../src/ui/alert/hooks/useWallets'
import useIsMobile from '../../../src/ui/alert/hooks/useIsMobile'
import { isMobileOS, isAndroid } from '../../../src/utils/platform'

vi.mock('@ecadlabs/beacon-core', async (importActual) => ({
  ...(await importActual<typeof import('@ecadlabs/beacon-core')>()),
  reportDiagnostic: vi.fn()
}))

vi.mock('../../../src/ui/alert/hooks/useWallets', () => ({
  useWallets: vi.fn()
}))

vi.mock('../../../src/ui/alert/hooks/useIsMobile', () => ({
  __esModule: true,
  default: vi.fn(() => false)
}))

vi.mock('../../../src/utils/platform', () => ({
  isTwBrowser: vi.fn(() => false),
  isAndroid: vi.fn(() => false),
  isMobileOS: vi.fn(() => false),
  isIOS: vi.fn(() => false)
}))

vi.mock('../../../src/components/alert', () => ({
  default: (props: any) => (
    <div data-testid="alert" data-loading={props.loading ? 'true' : 'false'}>
      <button onClick={props.onCloseClick}>Close pairing</button>
      {props.children}
      {props.extraContent}
    </div>
  )
}))

vi.mock('../../../src/components/qr', () => ({
  default: (props: any) => (
    <div data-testid="qr" data-walletconnect={props.isWalletConnect ? 'true' : 'false'}>
      {props.code}
    </div>
  )
}))

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  return { promise, resolve, reject }
}

describe('PairingAlert Kukai async pairing paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window.navigator, 'onLine', { value: true, writable: true })

    const kukaiWallet = {
      id: 'kukai',
      key: 'kukai_web',
      name: 'Kukai',
      image: 'kukai.png',
      descriptions: ['Web App', 'Mobile App'],
      links: ['https://kukai.example.com', 'kukai://', '', ''],
      types: ['web', 'ios'],
      supportedInteractionStandards: ['wallet_connect'],
      deepLink: 'kukai://'
    }
    const otherWallet = {
      id: 'other',
      key: 'other',
      name: 'Other',
      image: 'other.png',
      descriptions: ['Web App'],
      links: ['https://other.example.com', '', '', ''],
      types: ['web'],
      supportedInteractionStandards: ['beacon']
    }

    ;(useWallets as Mock).mockReturnValue({
      wallets: new Map([
        ['kukai', kukaiWallet],
        ['other', otherWallet]
      ]),
      availableExtensions: []
    })
  })

  it('shows Kukai browser path and WalletConnect QR after WalletConnect pairing resolves', async () => {
    const wcPairing = deferred<string>()
    const openedTab = { opener: undefined as Window | null | undefined, location: { href: '' } }
    window.open = vi.fn(() => openedTab as unknown as Window)
    const props: ConfigurableAlertProps = {
      open: true,
      closeOnBackdropClick: true,
      title: 'Pair wallet',
      onClose: vi.fn(),
      pairingPayload: {
        p2pSyncCode: Promise.resolve('p2p-code'),
        postmessageSyncCode: Promise.resolve('post-code'),
        walletConnectSyncCode: wcPairing.promise,
        networkType: NetworkType.GHOSTNET
      }
    }

    render(<PairingAlert {...props} />)

    fireEvent.click(screen.getByText('Kukai'))

    expect(screen.queryByText('Connect with Kukai Web')).not.toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()

    await act(async () => {
      wcPairing.resolve('wc:topic@2?symKey=abc&relay-protocol=irn')
    })

    expect(await screen.findByText('Connect with Kukai Web')).toBeInTheDocument()
    expect(screen.getByText('Use Browser')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByTestId('qr')).toHaveTextContent('wc:topic@2?symKey=abc&relay-protocol=irn')
    })
    expect(screen.getByTestId('qr')).toHaveAttribute('data-walletconnect', 'true')

    fireEvent.click(screen.getByText('Use Browser'))
    await waitFor(() => {
      expect(openedTab.location.href).toContain('https://kukai.example.com')
    })
  })

  it('shows the WalletConnect init error when Kukai WalletConnect pairing fails', async () => {
    const props: ConfigurableAlertProps = {
      open: true,
      closeOnBackdropClick: true,
      title: 'Pair wallet',
      onClose: vi.fn(),
      pairingPayload: {
        p2pSyncCode: Promise.resolve('p2p-code'),
        postmessageSyncCode: Promise.resolve('post-code'),
        walletConnectSyncCode: Promise.resolve(''),
        networkType: NetworkType.GHOSTNET
      }
    }

    render(<PairingAlert {...props} />)

    fireEvent.click(screen.getByText('Kukai'))

    expect(await screen.findByText('Connect with Kukai Web')).toBeInTheDocument()
    expect(await screen.findByText('A network error occurred.')).toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
  })

  it('keeps the pending Use App launch owned until a QR gesture supersedes it', async () => {
    vi.mocked(useIsMobile).mockReturnValue(true)
    vi.mocked(isMobileOS).mockReturnValue(true)
    vi.mocked(isAndroid).mockReturnValue(true)
    const pendingPairing = deferred<string>()
    const open = vi.fn(() => null)
    window.open = open
    const props: ConfigurableAlertProps = {
      open: true,
      closeOnBackdropClick: true,
      title: 'Pair wallet',
      onClose: vi.fn(),
      pairingPayload: {
        p2pSyncCode: Promise.resolve('p2p-code'),
        postmessageSyncCode: Promise.resolve('post-code'),
        walletConnectSyncCode: Promise.resolve('wc:first@2?symKey=abc&relay-protocol=irn'),
        networkType: NetworkType.GHOSTNET
      }
    }
    try {
      const view = render(<PairingAlert {...props} />)
      fireEvent.click(screen.getByText('Kukai'))
      await screen.findByRole('button', { name: 'Use App' })
      view.rerender(
        <PairingAlert
          {...props}
          pairingPayload={{
            ...props.pairingPayload!,
            walletConnectSyncCode: pendingPairing.promise
          }}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Use App' }))
      expect(screen.getByTestId('alert')).toHaveAttribute('data-loading', 'true')
      const qrButton = view.container.querySelector('button#qr-code-icon')
      if (!qrButton) throw new Error('QR action was not rendered')
      fireEvent.click(qrButton)
      await act(async () => {
        pendingPairing.resolve('wc:requested@2?symKey=abc&relay-protocol=irn')
      })
      await waitFor(() =>
        expect(screen.getByTestId('qr')).toHaveTextContent(
          'wc:requested@2?symKey=abc&relay-protocol=irn'
        )
      )
      expect(open).not.toHaveBeenCalled()
      expect(screen.getByTestId('alert')).toHaveAttribute('data-loading', 'false')
    } finally {
      vi.mocked(useIsMobile).mockReturnValue(false)
      vi.mocked(isMobileOS).mockReturnValue(false)
      vi.mocked(isAndroid).mockReturnValue(false)
    }
  })

  it.each(['close button', 'closed prop', 'replacement payload'] as const)(
    'cancels a pending browser launch on %s before the alert unmounts',
    async (change) => {
      const pairing = deferred<string>()
      const tab = {
        opener: undefined as Window | null | undefined,
        location: { href: '' },
        close: vi.fn()
      }
      window.open = vi.fn().mockReturnValue(tab)
      const props: ConfigurableAlertProps = {
        open: true,
        closeOnBackdropClick: true,
        title: 'Pair wallet',
        onClose: vi.fn(),
        pairingPayload: {
          p2pSyncCode: pairing.promise,
          postmessageSyncCode: Promise.resolve('post'),
          walletConnectSyncCode: Promise.resolve('unused'),
          networkType: NetworkType.GHOSTNET
        }
      }
      const view = render(<PairingAlert {...props} />)
      fireEvent.click(screen.getByText('Other'))
      expect(window.open).toHaveBeenCalledWith('', '_blank')
      if (change === 'close button')
        fireEvent.click(screen.getByRole('button', { name: 'Close pairing' }))
      else if (change === 'closed prop') view.rerender(<PairingAlert {...props} open={false} />)
      else
        view.rerender(
          <PairingAlert
            {...props}
            pairingPayload={{ ...props.pairingPayload!, p2pSyncCode: Promise.resolve('new-code') }}
          />
        )
      expect(tab.close).toHaveBeenCalledTimes(1)
      await act(async () => {
        pairing.resolve('old-code')
      })
      expect(tab.location.href).toBe('')
      expect(screen.getByTestId('alert')).toHaveAttribute('data-loading', 'false')
    }
  )

  it.each(['Use App', 'Use App then QR', 'QR then Use App'] as const)(
    'reports a rejected mobile pairing once after %s and never navigates',
    async (gesture) => {
      vi.mocked(useIsMobile).mockReturnValue(true)
      vi.mocked(isMobileOS).mockReturnValue(true)
      vi.mocked(isAndroid).mockReturnValue(true)
      const pairing = deferred<string>()
      const error = new Error('mobile pairing failed')
      window.open = vi.fn(() => null)
      const props: ConfigurableAlertProps = {
        open: true,
        closeOnBackdropClick: true,
        title: 'Pair wallet',
        onClose: vi.fn(),
        pairingPayload: {
          p2pSyncCode: Promise.resolve('p2p-code'),
          postmessageSyncCode: Promise.resolve('post-code'),
          walletConnectSyncCode: Promise.resolve('wc:initial@2?symKey=abc&relay-protocol=irn'),
          networkType: NetworkType.GHOSTNET
        }
      }
      try {
        const view = render(<PairingAlert {...props} />)
        fireEvent.click(screen.getByText('Kukai'))
        await screen.findByRole('button', { name: 'Use App' })
        view.rerender(
          <PairingAlert
            {...props}
            pairingPayload={{ ...props.pairingPayload!, walletConnectSyncCode: pairing.promise }}
          />
        )
        if (gesture !== 'QR then Use App')
          fireEvent.click(screen.getByRole('button', { name: 'Use App' }))
        if (gesture !== 'Use App') {
          const qrButton = view.container.querySelector('button#qr-code-icon')
          if (!qrButton) throw new Error('QR action was not rendered')
          fireEvent.click(qrButton)
        }
        if (gesture === 'QR then Use App')
          fireEvent.click(screen.getByRole('button', { name: 'Use App' }))
        await act(async () => {
          pairing.reject(error)
        })
        expect(window.open).not.toHaveBeenCalled()
        expect(reportDiagnostic).toHaveBeenCalledTimes(1)
        expect(reportDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ args: [error] }))
        if (gesture !== 'Use App then QR')
          expect(screen.getByText('A network error occurred.')).toBeInTheDocument()
        expect(screen.getByTestId('alert')).toHaveAttribute('data-loading', 'false')
      } finally {
        vi.mocked(useIsMobile).mockReturnValue(false)
        vi.mocked(isMobileOS).mockReturnValue(false)
        vi.mocked(isAndroid).mockReturnValue(false)
      }
    }
  )

  it.each(['late-code', ''])(
    'ignores a pending mobile QR payload %j while the alert is closed but mounted',
    async (code) => {
      vi.mocked(useIsMobile).mockReturnValue(true)
      vi.mocked(isMobileOS).mockReturnValue(true)
      const pairing = deferred<string>()
      const onClose = vi.fn()
      const props: ConfigurableAlertProps = {
        open: true,
        closeOnBackdropClick: true,
        title: 'Pair wallet',
        onClose,
        pairingPayload: {
          p2pSyncCode: Promise.resolve('p2p-code'),
          postmessageSyncCode: Promise.resolve('post-code'),
          walletConnectSyncCode: Promise.resolve('wc:initial@2?symKey=abc&relay-protocol=irn'),
          networkType: NetworkType.GHOSTNET
        }
      }
      try {
        const view = render(<PairingAlert {...props} />)
        fireEvent.click(screen.getByText('Kukai'))
        await screen.findByRole('button', { name: 'Use App' })
        const pendingProps = {
          ...props,
          pairingPayload: { ...props.pairingPayload!, walletConnectSyncCode: pairing.promise }
        }
        view.rerender(<PairingAlert {...pendingProps} />)
        const qrButton = view.container.querySelector('button#qr-code-icon')
        if (!qrButton) throw new Error('QR action was not rendered')
        fireEvent.click(qrButton)
        view.rerender(<PairingAlert {...pendingProps} open={false} />)
        await act(async () => {
          pairing.resolve(code)
        })
        expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
        expect(onClose).not.toHaveBeenCalled()
      } finally {
        vi.mocked(useIsMobile).mockReturnValue(false)
        vi.mocked(isMobileOS).mockReturnValue(false)
      }
    }
  )
})
