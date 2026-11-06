import type { Mock } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NetworkType } from '@ecadlabs/beacon-types'
import PairingAlert from '../../../src/ui/alert/components/pairing-alert'
import { ConfigurableAlertProps } from '../../../src/ui/common'
import useWallets from '../../../src/ui/alert/hooks/useWallets'

vi.mock('../../../src/ui/alert/hooks/useWallets', () => ({
  __esModule: true,
  default: vi.fn()
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
})
