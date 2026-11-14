import type { Mock } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NetworkType } from '@ecadlabs/beacon-types'
import { PairingAlert } from '../../../src/ui/alert/components/pairing-alert'
import type { ComponentProps } from 'react'
type PairingAlertProps = ComponentProps<typeof PairingAlert>
import { useWallets } from '../../../src/ui/alert/hooks/useWallets'
import { useIsMobile } from '../../../src/ui/alert/hooks/useIsMobile'
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
  useIsMobile: vi.fn(() => false)
}))

vi.mock('../../../src/utils/platform', () => ({
  isTwBrowser: vi.fn(() => false),
  isAndroid: vi.fn(() => false),
  isMobileOS: vi.fn(() => false),
  isIOS: vi.fn(() => false)
}))

vi.mock('../../../src/components/alert', () => ({
  Alert: (props: any) => (
    <div data-testid="alert" data-loading={props.loading ? 'true' : 'false'}>
      <button onClick={props.onCloseClick}>Close pairing</button>
      {props.children}
      {props.extraContent}
    </div>
  )
}))

vi.mock('../../../src/components/qr', () => ({
  QR: (props: any) => (
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
    const props: PairingAlertProps = {
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
    const props: PairingAlertProps = {
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

  it.each(['QR wins', 'close wins'])(
    'owns synchronous Use App and QR gestures before fulfilled-payload microtasks settle: %s',
    async (outcome) => {
      vi.mocked(useIsMobile).mockReturnValue(true)
      vi.mocked(isMobileOS).mockReturnValue(true)
      vi.mocked(isAndroid).mockReturnValue(true)
      window.open = vi.fn(() => null)
      const props: PairingAlertProps = {
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
        fireEvent.click(screen.getByRole('button', { name: 'Use App' }))
        expect(screen.getByTestId('alert')).toHaveAttribute('data-loading', 'true')
        const qrButton = view.container.querySelector('button#qr-code-icon')
        if (!qrButton) throw new Error('QR action was not rendered')
        fireEvent.click(qrButton)
        view.rerender(<PairingAlert {...props} title="Unrelated render" open={outcome === 'QR wins'} />)
        await act(async () => { await Promise.resolve() })
        if (outcome === 'QR wins') {
          expect(screen.getByTestId('qr')).toHaveTextContent('wc:first@2?symKey=abc&relay-protocol=irn')
        } else {
          expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
          expect(props.onClose).not.toHaveBeenCalled()
        }
        expect(window.open).not.toHaveBeenCalled()
        expect(screen.getByTestId('alert')).toHaveAttribute('data-loading', 'false')
      } finally {
        vi.mocked(useIsMobile).mockReturnValue(false)
        vi.mocked(isMobileOS).mockReturnValue(false)
        vi.mocked(isAndroid).mockReturnValue(false)
      }
    }
  )

  it.each([1, 2])('dismisses the old resolved wallet QR on payload replacement with %s discovered wallets', async (walletCount) => {
    const discovery = vi.mocked(useWallets).getMockImplementation()?.()
    if (!discovery) throw new Error('Wallet discovery fixture missing')
    vi.mocked(useWallets).mockReturnValue({ ...discovery,
      wallets: new Map(Array.from(discovery.wallets).slice(0, walletCount)) })
    const next = deferred<string>()
    const props: PairingAlertProps = {
      open: true,
      closeOnBackdropClick: true,
      title: 'Pair wallet',
      onClose: vi.fn(),
      pairingPayload: {
        p2pSyncCode: Promise.resolve('p2p-code'),
        postmessageSyncCode: Promise.resolve('post-code'),
        walletConnectSyncCode: Promise.resolve('wc:old@2?symKey=abc&relay-protocol=irn'),
        networkType: NetworkType.GHOSTNET
      }
    }
    const view = render(<PairingAlert {...props} />)
    if (walletCount > 1) fireEvent.click(screen.getByText('Kukai'))
    expect(await screen.findByTestId('qr')).toHaveTextContent('wc:old@2')
    view.rerender(<PairingAlert {...props}
      pairingPayload={{ ...props.pairingPayload, walletConnectSyncCode: next.promise }} />)
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.queryByText('Connect with Kukai Web')).not.toBeInTheDocument()
    if (walletCount > 1) {
      expect(screen.getByTestId('alert')).toHaveAttribute('data-loading', 'false')
      fireEvent.click(screen.getByText('Kukai'))
    }
    expect(screen.getByTestId('alert')).toHaveAttribute('data-loading', 'true')
    await act(async () => next.resolve('wc:old@2?symKey=abc&relay-protocol=irn'))
    expect(await screen.findByTestId('qr')).toHaveTextContent('wc:old@2')
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
      const props: PairingAlertProps = {
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

})
