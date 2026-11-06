import type { Mock } from 'vitest'
import { act, render, screen, fireEvent, RenderResult } from '@testing-library/react'
import { NetworkType, StorageKey } from '@ecadlabs/beacon-types'
import PairingAlert from '../../../src/ui/alert/components/pairing-alert'
import { ConfigurableAlertProps } from '../../../src/ui/common'

// --- Mocks for hooks and platform utilities ---
import useIsMobile from '../../../src/ui/alert/hooks/useIsMobile'
import useWallets from '../../../src/ui/alert/hooks/useWallets'
import useConnect from '../../../src/ui/alert/hooks/useConnect'

vi.mock('../../../src/ui/alert/hooks/useIsMobile', () => ({
  __esModule: true,
  default: vi.fn()
}))
vi.mock('../../../src/ui/alert/hooks/useWallets', () => ({
  __esModule: true,
  default: vi.fn()
}))
vi.mock('../../../src/ui/alert/hooks/useConnect', () => ({
  __esModule: true,
  default: vi.fn()
}))

// Updated Alert mock: explicitly remove closeOnBackdropClick so it isn’t passed to the DOM
vi.mock('../../../src/components/alert', () => ({
  default: (props: any) => {
    const {
      pairingPayload,
      featuredWallets,
      loading,
      onCloseClick,
      onClickShowMore,
      showMore,
      extraContent,
      onBackClick,
      closeOnBackdropClick, // remove it
      ...rest
    } = props
    return (
      <div data-testid="alert" data-onbackclick={onBackClick ? 'true' : 'false'} {...rest}>
        {props.children}
        {extraContent && <div data-testid="alert-extra-content">{extraContent}</div>}
      </div>
    )
  }
}))

// Other mocks
vi.mock('../../../src/components/info', () => ({
  default: (props: any) => (
    <div data-testid="info">
      <div>{props.title}</div>
      <div>{props.description}</div>
      {props.buttons &&
        props.buttons.map((button: any, index: number) => (
          <button key={index} data-testid="info-button" onClick={button.onClick}>
            {button.label}
          </button>
        ))}
      {props.onShowQRCodeClick && (
        <button data-testid="qr-button" onClick={props.onShowQRCodeClick}>
          QR
        </button>
      )}
    </div>
  )
}))
vi.mock('../../../src/components/pair-other', () => ({
  default: () => <div data-testid="pair-other">PairOther</div>
}))
vi.mock('../../../src/components/top-wallets', () => ({
  default: (props: any) => (
    <div data-testid="top-wallets">
      TopWallets
      {props.otherWallets && (
        <button data-testid="other-wallets-btn" onClick={props.otherWallets.onClick}>
          Other Wallets
        </button>
      )}
    </div>
  )
}))
vi.mock('../../../src/components/wallets', () => ({
  default: () => <div data-testid="wallets">Wallets</div>
}))
vi.mock('../../../src/components/qr', () => ({
  default: (props: any) => (
    <div data-testid="qr">
      QR: {props.code} - isMobile: {props.isMobile ? 'true' : 'false'}
    </div>
  )
}))

// Override platform utils.
import * as platformUtils from '../../../src/utils/platform'

vi.mock('../../../src/utils/platform', () => ({
  isIOS: vi.fn(() => false),
  isMobileOS: vi.fn(() => false)
}))

// --- Test Data ---
const pairingPayload = {
  walletConnectSyncCode: Promise.resolve('wcCode'),
  p2pSyncCode: Promise.resolve('p2pCode'),
  postmessageSyncCode: Promise.resolve('postCode'),
  networkType: NetworkType.GHOSTNET
}

const walletObj = {
  id: 'wallet1',
  key: 'wallet1',
  name: 'Wallet One',
  image: 'wallet-one.png',
  types: ['web', 'extension', 'desktop', 'ios'],
  firefoxId: 'firefox1',
  supportedInteractionStandards: ['wallet_connect']
}
// Default wallets map (with one wallet) used in most tests.
const walletsMap = new Map<string, typeof walletObj>([['wallet1', walletObj]])
const walletHookResult = {
  wallets: walletsMap,
  availableExtensions: [{ id: 'wallet1', name: 'Wallet One' }]
}

const defaultProps: ConfigurableAlertProps = {
  open: true,
  title: 'Test',
  onClose: vi.fn(),
  pairingPayload,
  featuredWallets: [],
  closeOnBackdropClick: true
}

// A default useConnect return value array.
// Index positions:
// [0] wallet, [1] isLoading, [2] qrCode, [3] state,
// [4] displayQRExtra, [5] showMoreContent, [6] isWCWorking,
// [7] handleClickWallet, [8] handleNewTab, [9] handleDeepLinking,
// [10] handleClickOther, [11] handleClickConnectExtension,
// [12] handleClickInstallExtension, [13] handleClickOpenDesktopApp,
// [14] handleClickDownloadDesktopApp, [15] handleUpdateState,
// [16] handleUpdateQRCode, [17] handleShowMoreContent,
// [18] handleDisplayQRExtra, [19] handleIsLoading
const defaultUseConnect = [
  walletObj, // wallet
  false, // isLoading
  'QR_CODE_123', // qrCode
  'install', // state (will be overridden in tests)
  false, // displayQRExtra
  true, // showMoreContent
  true, // isWCWorking
  vi.fn(), // handleClickWallet
  vi.fn(), // handleNewTab
  vi.fn(), // handleDeepLinking
  vi.fn(), // handleClickOther
  vi.fn(), // handleClickConnectExtension
  vi.fn(), // handleClickInstallExtension
  vi.fn(), // handleClickOpenDesktopApp
  vi.fn(), // handleClickDownloadDesktopApp
  vi.fn(), // handleUpdateState
  vi.fn(), // handleUpdateQRCode
  vi.fn(), // handleShowMoreContent
  vi.fn(), // handleDisplayQRExtra
  vi.fn() // handleIsLoading
]

// Helper function to render PairingAlert and wait for async effects
async function renderPairingAlert(props: ConfigurableAlertProps): Promise<RenderResult> {
  let rendered: RenderResult | undefined
  await act(async () => {
    rendered = render(<PairingAlert {...props} />)
  })
  return rendered!
}

describe('PairingAlert Component', () => {
  beforeEach(() => {
    ;(useIsMobile as Mock).mockReturnValue(false)
    ;(useWallets as Mock).mockReturnValue(walletHookResult)
    ;(useConnect as Mock).mockReturnValue(defaultUseConnect)
    Object.defineProperty(window.navigator, 'onLine', { value: true, writable: true })
    localStorage.clear()
    ;(platformUtils.isIOS as Mock).mockReturnValue(false)
    ;(platformUtils.isMobileOS as Mock).mockReturnValue(false)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // --- Install State Tests ---
  describe('Install State', () => {
    beforeEach(() => {
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'install'
      ;(useConnect as Mock).mockReturnValue(connectReturn)
    })

    test('renders Info components for web, extension, and desktop branches', async () => {
      await renderPairingAlert(defaultProps)
      const infoTitles = screen.getAllByTestId('info').map((el) => el.textContent)
      expect(infoTitles).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`Connect with ${walletObj.name} Web`),
          expect.stringContaining(`Connect with ${walletObj.name} Browser Extension`),
          expect.stringContaining(`Connect with ${walletObj.name} Desktop App`)
        ])
      )
    })

    test('renders QR component for the iOS branch when wallet.types length > 1', async () => {
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'install'
      connectReturn[2] = 'QR_CODE_123'
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      await renderPairingAlert(defaultProps)
      expect(screen.getByTestId('qr')).toHaveTextContent('QR: QR_CODE_123 - isMobile: false')
    })

    test('renders QR component with isMobile true when wallet.types length equals 1', async () => {
      const iosWallet = { ...walletObj, types: ['ios'] }
      const walletsMapSingle = new Map([['wallet1', iosWallet]])
      ;(useWallets as Mock).mockReturnValue({
        wallets: walletsMapSingle,
        availableExtensions: []
      })
      const connectReturn = [...defaultUseConnect]
      connectReturn[0] = iosWallet
      connectReturn[3] = 'install'
      connectReturn[2] = 'QR_CODE_SINGLE'
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      await renderPairingAlert(defaultProps)
      expect(screen.getByTestId('qr')).toHaveTextContent('QR: QR_CODE_SINGLE - isMobile: true')
    })

    test('clicking "Use Browser" button calls handleNewTab', async () => {
      const newTabMock = vi.fn()
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'install'
      connectReturn[8] = newTabMock
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      await renderPairingAlert(defaultProps)
      const useBrowserBtn = screen.getByText('Use Browser')
      fireEvent.click(useBrowserBtn)
      expect(newTabMock).toHaveBeenCalled()
    })

    test('clicking "Use Extension" button calls handleClickConnectExtension when extension is detected', async () => {
      const clickConnectMock = vi.fn()
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'install'
      connectReturn[11] = clickConnectMock
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      await renderPairingAlert(defaultProps)
      const useExtensionBtn = screen.getByText('Use Extension')
      fireEvent.click(useExtensionBtn)
      expect(clickConnectMock).toHaveBeenCalled()
    })

    test('clicking "Install extension" button calls handleClickInstallExtension when extension is not detected', async () => {
      ;(useWallets as Mock).mockReturnValue({
        wallets: walletsMap,
        availableExtensions: []
      })
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'install'
      const installExtensionMock = vi.fn()
      connectReturn[12] = installExtensionMock
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      await renderPairingAlert(defaultProps)
      const installExtensionBtn = screen.getByText('Install extension')
      fireEvent.click(installExtensionBtn)
      expect(installExtensionMock).toHaveBeenCalled()
    })

    test('detects installed extension via firefoxId fallback in availableExtensions', async () => {
      const walletWithFirefoxOnly = { ...walletObj, firefoxId: 'firefox1' }
      ;(useWallets as Mock).mockReturnValue({
        wallets: new Map([['wallet1', walletWithFirefoxOnly]]),
        availableExtensions: [{ id: 'firefox1', name: 'Wallet One Firefox' }]
      })
      const connectReturn = [...defaultUseConnect]
      connectReturn[0] = walletWithFirefoxOnly
      connectReturn[3] = 'install'
      ;(useConnect as Mock).mockReturnValue(connectReturn)

      await renderPairingAlert(defaultProps)

      expect(screen.getByText('Use Extension')).toBeInTheDocument()
      expect(screen.queryByText('Install extension')).not.toBeInTheDocument()
    })

    test('clicking desktop app buttons calls appropriate handlers', async () => {
      const clickOpenDesktopApp = vi.fn()
      const clickDownloadDesktopApp = vi.fn()
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'install'
      connectReturn[13] = clickOpenDesktopApp
      connectReturn[14] = clickDownloadDesktopApp
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      await renderPairingAlert(defaultProps)
      const openDesktopBtn = screen.getByText('Open desktop app')
      const downloadDesktopBtn = screen.getByText('Download desktop app')
      fireEvent.click(openDesktopBtn)
      fireEvent.click(downloadDesktopBtn)
      expect(clickOpenDesktopApp).toHaveBeenCalled()
      expect(clickDownloadDesktopApp).toHaveBeenCalled()
    })
  })

  // --- QR State Tests ---
  describe('QR State', () => {
    test('renders PairOther when displayQRExtra is false', async () => {
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'qr'
      connectReturn[4] = false
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      await renderPairingAlert(defaultProps)
      expect(screen.getByTestId('pair-other')).toBeInTheDocument()
    })

    test('renders QR component when displayQRExtra is true', async () => {
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'qr'
      connectReturn[4] = true
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      await renderPairingAlert(defaultProps)
      expect(screen.getByTestId('qr')).toBeInTheDocument()
    })
  })

  // --- Wallets State Tests ---
  describe('Wallets State', () => {
    test('renders Wallets component when state is "wallets"', async () => {
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'wallets'
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      await renderPairingAlert(defaultProps)
      expect(screen.getAllByTestId('wallets').length).toBeGreaterThan(0)
    })
  })

  describe('WalletConnect initialization errors', () => {
    test('keeps local connection details without a retired reporting link', async () => {
      ;(platformUtils.isMobileOS as Mock).mockReturnValue(true)
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'install'
      connectReturn[6] = false
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      localStorage.setItem(StorageKey.WC_INIT_ERROR, 'Network error details')

      await renderPairingAlert(defaultProps)

      expect(screen.getByText('Network error details')).toBeInTheDocument()
      expect(screen.queryByText(/report it|Beacon team|report a bug/i)).not.toBeInTheDocument()
    })
  })

  // --- Top-Wallets Extra Content Tests ---
  describe('Top-Wallets Extra Content', () => {
    test('renders extraContent with Wallets when state is "top-wallets" and not mobile', async () => {
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'top-wallets'
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      ;(useIsMobile as Mock).mockReturnValue(false)
      await renderPairingAlert(defaultProps)
      const extraContent = screen.getByTestId('alert-extra-content')
      expect(extraContent).toBeInTheDocument()
      expect(extraContent).toHaveTextContent('Wallets')
    })
  })

  // --- Other State Tests ---
  describe('Other State', () => {
    test('renders TopWallets when state is not install, qr, wallets, or help', async () => {
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'other'
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      await renderPairingAlert(defaultProps)
      const topWallets = screen.getByTestId('top-wallets')
      expect(topWallets).toBeInTheDocument()
      expect(topWallets.parentElement).toHaveStyle('opacity: 1')
    })
  })

  // --- Back Button and Show More Handling Tests ---
  describe('Back Button and Show More Handling', () => {
    test('provides onBackClick prop when state is install, qr, (wallets and mobile) or help', async () => {
      const newWalletsMap = new Map<string, typeof walletObj>([
        ['wallet1', walletObj],
        ['wallet2', { ...walletObj }]
      ])
      ;(useWallets as Mock).mockReturnValue({
        wallets: newWalletsMap,
        availableExtensions: []
      })
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'install'
      const updateStateMock = vi.fn()
      connectReturn[15] = updateStateMock
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      const { container } = await renderPairingAlert(defaultProps)
      expect(container.firstChild).toHaveAttribute('data-onbackclick', 'true')
    })
  })

  // --- QRCode LocalStorage Side Effect Tests ---
  describe('QRCode LocalStorage Side Effect', () => {
    test('sets LAST_SELECTED_WALLET when selecting a wallet and rendering its QR code', async () => {
      const { default: realUseConnect } = await vi.importActual<
        typeof import('../../../src/ui/alert/hooks/useConnect')
      >('../../../src/ui/alert/hooks/useConnect')
      vi.mocked(useConnect).mockImplementation(realUseConnect)
      const wcCode = `wc:topic@2?relay-protocol=irn&symKey=${'a'.repeat(64)}`
      try {
        await renderPairingAlert({
          ...defaultProps,
          pairingPayload: { ...pairingPayload, walletConnectSyncCode: Promise.resolve(wcCode) }
        })
        expect(screen.getByTestId('qr')).toHaveTextContent(wcCode)
        expect(localStorage.getItem(StorageKey.LAST_SELECTED_WALLET)).toEqual(
          JSON.stringify({ key: walletObj.key, type: 'mobile', icon: walletObj.image })
        )
      } finally {
        vi.mocked(useConnect).mockReset()
      }
    })
  })

  // --- Mobile OS Branch Tests ---
  describe('Mobile OS Branch', () => {
    test('renders error Info when on mobile OS and wallet_connect is supported but isWCWorking is false', async () => {
      ;(platformUtils.isMobileOS as Mock).mockReturnValue(true)
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'install'
      connectReturn[6] = false // force error branch
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      await renderPairingAlert(defaultProps)
      const infoElements = screen.getAllByTestId('info')
      const errorInfo = infoElements.find((el) =>
        el.textContent?.includes(`Connect with ${walletObj.name} Mobile`)
      )
      expect(errorInfo).toBeDefined()
    })

    test('mobile OS Info "QR" button calls appropriate handlers', async () => {
      ;(platformUtils.isMobileOS as Mock).mockReturnValue(true)
      const updateStateMock = vi.fn()
      const updateQRCodeMock = vi.fn()
      const displayQRExtraMock = vi.fn()
      const deepLinkingMock = vi.fn()
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'install'
      connectReturn[6] = true
      connectReturn[15] = updateStateMock
      connectReturn[16] = updateQRCodeMock
      connectReturn[18] = displayQRExtraMock
      connectReturn[9] = deepLinkingMock
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      await renderPairingAlert(defaultProps)
      const qrBtn = screen.getByTestId('qr-button')
      await act(async () => {
        fireEvent.click(qrBtn)
      })
      expect(updateQRCodeMock).toHaveBeenCalledWith('wcCode')
      expect(updateStateMock).toHaveBeenCalledWith('qr')
      expect(displayQRExtraMock).toHaveBeenCalledWith(true)
    })

    test('does not render mobile OS branch when wallet does not include ios', async () => {
      const nonIosWallet = { ...walletObj, types: ['web', 'extension', 'desktop'] }
      const walletsMapNonIos = new Map([['wallet1', nonIosWallet]])
      ;(useWallets as Mock).mockReturnValue({
        wallets: walletsMapNonIos,
        availableExtensions: []
      })
      const connectReturn = [...defaultUseConnect]
      connectReturn[0] = nonIosWallet
      connectReturn[3] = 'install'
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      ;(platformUtils.isMobileOS as Mock).mockReturnValue(true)
      await renderPairingAlert(defaultProps)
      const infos = screen.queryAllByTestId('info').map((el) => el.textContent)
      expect(infos).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining(`Connect with ${nonIosWallet.name} Mobile`)
        ])
      )
    })

    test('clicking "Use App" in mobile OS branch calls handleDeepLinking', async () => {
      ;(platformUtils.isMobileOS as Mock).mockReturnValue(true)
      const deepLinkMock = vi.fn()
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'install'
      connectReturn[6] = true
      connectReturn[9] = deepLinkMock
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      await renderPairingAlert(defaultProps)
      const useAppBtn = screen.getByText('Use App')
      fireEvent.click(useAppBtn)
      expect(deepLinkMock).toHaveBeenCalled()
    })

    test('onShowQRCodeClick with empty syncCode calls props.onClose', async () => {
      ;(platformUtils.isMobileOS as Mock).mockReturnValue(true)
      const onCloseMock = vi.fn()
      const connectReturn = [...defaultUseConnect]
      connectReturn[3] = 'install'
      connectReturn[6] = true
      ;(useConnect as Mock).mockReturnValue(connectReturn)
      // Set walletConnectSyncCode to empty so that syncCode becomes empty
      const newPairingPayload = {
        ...pairingPayload,
        walletConnectSyncCode: Promise.resolve('')
      }
      await renderPairingAlert({
        ...defaultProps,
        onClose: onCloseMock,
        pairingPayload: newPairingPayload
      })
      const qrButton = screen.getByTestId('qr-button')
      await act(async () => {
        fireEvent.click(qrButton)
      })
      expect(onCloseMock).toHaveBeenCalled()
    })
  })
})
