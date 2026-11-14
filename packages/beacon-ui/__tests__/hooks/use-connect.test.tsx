import type { Mock } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import { useConnect } from '../../src/ui/alert/hooks/useConnect'
import { StorageKey, ExtensionMessageTarget, NetworkType } from '@ecadlabs/beacon-types'
import { reportDiagnostic, windowRef } from '@ecadlabs/beacon-core'
import { getDefaultLogo } from '../../src/ui/alert/getDefautlLogo'
import { type MergedWallet, OSLink } from '../../src/utils/wallets'
import { AlertState } from '../../src/ui/common'

vi.mock('@ecadlabs/beacon-core', async (importActual) => ({
  ...(await importActual<typeof import('@ecadlabs/beacon-core')>()),
  reportDiagnostic: vi.fn()
}))

vi.mock('../../src/utils/get-tzip10-link', () => ({
  getTzip10Link: vi.fn().mockReturnValue('https://example.com/tzip10')
}))

vi.mock('../../src/utils/platform', () => ({
  isTwBrowser: vi.fn().mockReturnValue(false),
  isAndroid: vi.fn().mockReturnValue(false),
  isMobileOS: vi.fn().mockReturnValue(false),
  isIOS: vi.fn().mockReturnValue(false)
}))

HTMLAnchorElement.prototype.click = vi.fn()
global.window.URL.createObjectURL = vi.fn()

// Mock window.open properly
const windowOpenMock = vi.fn()

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  return { promise, resolve, reject }
}

beforeEach(() => {
  window.open = windowOpenMock
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useConnect hook', () => {
  let wallets: Map<string, any>
  let onCloseHandler: Mock

  beforeEach(() => {
    wallets = new Map()
    onCloseHandler = vi.fn()
  })

  it('should initialize with default values', async () => {
    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('wc-payload'),
        Promise.resolve('p2p-payload'),
        Promise.resolve('post-payload'),
        wallets,
        onCloseHandler
      )
    )

    const [wallet, isLoading, qrCode, state, displayQRExtra, showMoreContent, isWCWorking] =
      result.current

    expect(wallet).toBeUndefined()
    expect(isLoading).toBe(false)
    expect(qrCode).toBeUndefined()
    expect(state).toBe('top-wallets')
    expect(displayQRExtra).toBe(false)
    expect(showMoreContent).toBe(false)
    expect(isWCWorking).toBe(true)
  })

  it('should handle clickOther and update state to "qr"', async () => {
    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('wc-payload'),
        Promise.resolve('p2p-payload'),
        Promise.resolve('post-payload'),
        wallets,
        onCloseHandler
      )
    )

    act(() => {
      result.current[10]()
    })

    const storedWallet = JSON.parse(localStorage.getItem(StorageKey.LAST_SELECTED_WALLET)!)
    expect(storedWallet).toEqual({
      key: 'wallet',
      name: 'wallet',
      type: 'web',
      icon: getDefaultLogo()
    })
    expect(result.current[3]).toBe('qr')
  })

  it('should handle clickWallet for a web wallet and open a new tab', async () => {
    const testWallet = {
      key: 'wallet1',
      name: 'Test Wallet',
      id: 'wallet1-id',
      types: ['web'],
      supportedInteractionStandards: [],
      links: {
        [OSLink.WEB]: 'https://example.com',
        [OSLink.IOS]: 'https://example-ios.com',
        [OSLink.EXTENSION]: 'https://extension.com',
        [OSLink.DESKTOP]: 'https://desktop.com'
      },
      image: 'https://example.com/icon.png'
    }
    wallets.set('wallet1', testWallet)

    // Mock window.open to return a fake new-tab object.
    const newTabMock = { opener: {}, location: { href: '' } }
    const windowOpenMock = vi.fn().mockReturnValue(newTabMock)
    window.open = windowOpenMock

    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('wc-payload'),
        Promise.resolve('p2p-payload'),
        Promise.resolve('post-payload'),
        wallets,
        onCloseHandler
      )
    )

    // Wrap the async click handler in async act.
    await act(async () => {
      await result.current[7]('wallet1', {
        title: 'test',
        pairingPayload: {
          networkType: NetworkType.GHOSTNET,
          p2pSyncCode: Promise.resolve('test'),
          postmessageSyncCode: Promise.resolve('test'),
          walletConnectSyncCode: Promise.resolve('test')
        }
      })
    })

    expect(windowOpenMock).toHaveBeenCalledWith('', '_blank')
    expect(newTabMock.location.href).toBe('https://example.com/tzip10')

    const storedWallet = JSON.parse(localStorage.getItem(StorageKey.LAST_SELECTED_WALLET)!)
    expect(storedWallet).toEqual({
      key: testWallet.key,
      name: testWallet.name,
      type: 'web',
      icon: testWallet.image
    })
  })

  it('should handle clickConnectExtension and post messages', async () => {
    const extensionWallet = {
      key: 'wallet-ext',
      name: 'Extension Wallet',
      id: 'ext-id',
      firefoxId: 'firefox-ext-id',
      types: ['extension'],
      supportedInteractionStandards: [],
      links: {
        [OSLink.EXTENSION]: 'https://extension.com'
      },
      image: 'https://extension.com/icon.png'
    }
    wallets.set('wallet-ext', extensionWallet)
    const postPayload = 'post-payload'

    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('wc-payload'),
        Promise.resolve('p2p-payload'),
        Promise.resolve(postPayload),
        wallets,
        onCloseHandler
      )
    )

    await act(async () => {
      await result.current[7]('wallet-ext', {
        title: 'test',
        pairingPayload: {
          networkType: NetworkType.GHOSTNET,
          p2pSyncCode: Promise.resolve('test'),
          postmessageSyncCode: Promise.resolve('test'),
          walletConnectSyncCode: Promise.resolve('test')
        }
      })
    })

    const postMessageSpy = vi.spyOn(windowRef, 'postMessage').mockImplementation(() => {})

    await act(async () => {
      await result.current[11]()
    })

    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        target: ExtensionMessageTarget.EXTENSION,
        payload: postPayload,
        targetId: extensionWallet.id
      },
      windowRef.location.origin
    )
    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        target: ExtensionMessageTarget.EXTENSION,
        payload: postPayload,
        targetId: extensionWallet.firefoxId
      },
      windowRef.location.origin
    )

    const storedWallet = JSON.parse(localStorage.getItem(StorageKey.LAST_SELECTED_WALLET)!)
    expect(storedWallet).toEqual({
      key: extensionWallet.key,
      name: extensionWallet.name,
      type: 'extension',
      icon: extensionWallet.image
    })
  })

  it('should handle clickInstallExtension by opening the extension URL', async () => {
    const extensionWallet = {
      key: 'wallet-ext',
      name: 'Extension Wallet',
      id: 'ext-id',
      types: ['extension'],
      supportedInteractionStandards: [],
      links: {
        [OSLink.EXTENSION]: 'https://extension.com'
      },
      image: 'https://extension.com/icon.png'
    }
    wallets.set('wallet-ext', extensionWallet)

    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('wc-payload'),
        Promise.resolve('p2p-payload'),
        Promise.resolve('post-payload'),
        wallets,
        onCloseHandler
      )
    )

    await act(async () => {
      await result.current[7]('wallet-ext', {
        title: 'test',
        pairingPayload: {
          networkType: NetworkType.GHOSTNET,
          p2pSyncCode: Promise.resolve('test'),
          postmessageSyncCode: Promise.resolve('test'),
          walletConnectSyncCode: Promise.resolve('test')
        }
      })
    })

    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    // handleClickInstallExtension is synchronous.
    act(() => {
      result.current[12]()
    })

    expect(windowOpenSpy).toHaveBeenCalledWith('https://extension.com', '_blank', 'noopener')
  })

  it('should handle clickOpenDesktopApp by opening the deep link with p2p payload and updating localStorage', async () => {
    const desktopWallet = {
      key: 'wallet-desktop',
      name: 'Desktop Wallet',
      id: 'wallet-desktop-id',
      types: ['desktop'],
      deepLink: 'https://desktopapp.com/deeplink',
      links: {
        [OSLink.DESKTOP]: 'https://desktopapp.com/download'
      },
      image: 'https://desktopapp.com/icon.png'
    }
    wallets.set('wallet-desktop', desktopWallet)

    const p2pPayload = 'p2p-payload'
    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('wc-payload'),
        Promise.resolve(p2pPayload),
        Promise.resolve('post-payload'),
        wallets,
        onCloseHandler
      )
    )

    await act(async () => {
      await result.current[7]('wallet-desktop', {
        title: 'test',
        pairingPayload: {
          networkType: NetworkType.GHOSTNET,
          p2pSyncCode: Promise.resolve('test'),
          postmessageSyncCode: Promise.resolve('test'),
          walletConnectSyncCode: Promise.resolve('test')
        }
      })
    })

    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    await act(async () => {
      await result.current[13]()
    })

    expect(windowOpenSpy).toHaveBeenCalledWith('https://example.com/tzip10', '_blank', 'noopener')

    const storedWallet = JSON.parse(localStorage.getItem(StorageKey.LAST_SELECTED_WALLET)!)
    expect(storedWallet).toEqual({
      key: desktopWallet.key,
      name: desktopWallet.name,
      type: 'desktop',
      icon: desktopWallet.image
    })
  })

  it('should handle clickDownloadDesktopApp by opening the download link', async () => {
    const desktopWallet = {
      key: 'wallet-desktop',
      name: 'Desktop Wallet',
      id: 'wallet-desktop-id',
      types: ['desktop'],
      links: {
        [OSLink.DESKTOP]: 'https://desktopapp.com/download'
      },
      image: 'https://desktopapp.com/icon.png'
    }
    wallets.set('wallet-desktop', desktopWallet)

    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('wc-payload'),
        Promise.resolve('p2p-payload'),
        Promise.resolve('post-payload'),
        wallets,
        onCloseHandler
      )
    )

    await act(async () => {
      await result.current[7]('wallet-desktop', {
        title: 'test',
        pairingPayload: {
          networkType: NetworkType.GHOSTNET,
          p2pSyncCode: Promise.resolve('test'),
          postmessageSyncCode: Promise.resolve('test'),
          walletConnectSyncCode: Promise.resolve('test')
        }
      })
    })

    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    act(() => {
      result.current[14]()
    })

    expect(windowOpenSpy).toHaveBeenCalledWith(
      'https://desktopapp.com/download',
      '_blank',
      'noopener'
    )
  })

  // --- Additional tests for remaining branches --- //

  it('should handle wallet_connect branch with valid wcPayload (non-mobile)', async () => {
    const wcWallet = {
      key: 'wallet-wc-valid',
      name: 'Valid Wallet',
      id: 'wallet-wc-valid-id',
      types: ['ios', 'web'],
      supportedInteractionStandards: ['wallet_connect'],
      links: {
        [OSLink.WEB]: 'https://wcwallet.com',
        [OSLink.IOS]: 'https://wcwallet-ios.com'
      },
      image: 'https://wcwallet.com/icon.png'
    }
    wallets.set('wallet-wc-valid', wcWallet)
    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('wc:topic@2?symKey=abc&relay-protocol=irn'),
        Promise.resolve('p2p-payload'),
        Promise.resolve('post-payload'),
        wallets,
        onCloseHandler
      )
    )

    await act(async () => {
      await result.current[7]('wallet-wc-valid', {
        title: 'wc test',
        pairingPayload: {
          networkType: NetworkType.GHOSTNET,
          p2pSyncCode: Promise.resolve('test'),
          postmessageSyncCode: Promise.resolve('test'),
          walletConnectSyncCode: Promise.resolve('test')
        }
      })
    })

    expect(result.current[2]).toBe('wc:topic@2?symKey=abc&relay-protocol=irn')
    expect(result.current[3]).toBe('install')
    expect(result.current[1]).toBe(false)
  })

  it('waits for WalletConnect payload before showing Kukai WalletConnect QR', async () => {
    const webWallet = {
      key: 'wallet-web-wc',
      name: 'Kukai Wallet',
      id: 'wallet-web-wc-id',
      types: ['web', 'ios'],
      supportedInteractionStandards: ['wallet_connect'],
      links: {
        [OSLink.WEB]: 'https://kukai.example.com',
        [OSLink.IOS]: 'https://kukai-ios.example.com'
      },
      image: 'https://kukai.example.com/icon.png'
    }
    wallets.set('wallet-web-wc', webWallet)
    const wcPayload = deferred<string>()

    const { result } = renderHook(() =>
      useConnect(
        false,
        wcPayload.promise,
        Promise.resolve('p2p-payload'),
        Promise.resolve('post-payload'),
        wallets,
        onCloseHandler
      )
    )

    let clickPromise!: Promise<void>
    await act(async () => {
      clickPromise = result.current[7]('wallet-web-wc', {
        title: 'wc web fallback test',
        pairingPayload: {
          networkType: NetworkType.GHOSTNET,
          p2pSyncCode: Promise.resolve('test'),
          postmessageSyncCode: Promise.resolve('test'),
          walletConnectSyncCode: Promise.resolve('test')
        }
      })
      await Promise.resolve()
    })

    expect(result.current[2]).toBeUndefined()
    expect(result.current[1]).toBe(true)

    await act(async () => {
      wcPayload.resolve('wc:topic@2?symKey=abc&relay-protocol=irn')
      await clickPromise
    })

    expect(result.current[2]).toBe('wc:topic@2?symKey=abc&relay-protocol=irn')
    expect(result.current[3]).toBe('install')
    expect(result.current[1]).toBe(false)
  })

  it('marks Kukai web wallet as errored when WalletConnect payload is invalid', async () => {
    const wcWalletInvalid = {
      key: 'wallet-wc-invalid',
      name: 'Kukai Wallet',
      id: 'wallet-wc-invalid-id',
      types: ['web', 'ios'],
      supportedInteractionStandards: ['wallet_connect'],
      links: {
        [OSLink.WEB]: 'https://kukaiexample.com'
      },
      image: 'https://kukaiexample.com/icon.png'
    }
    wallets.set('wallet-wc-invalid', wcWalletInvalid)
    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('invalid-wc-payload'),
        Promise.resolve('p2p-payload'),
        Promise.resolve('post-payload'),
        wallets,
        onCloseHandler
      )
    )

    await act(async () => {
      await result.current[7]('wallet-wc-invalid', {
        title: 'wc invalid test',
        pairingPayload: {
          networkType: NetworkType.GHOSTNET,
          p2pSyncCode: Promise.resolve('test'),
          postmessageSyncCode: Promise.resolve('test'),
          walletConnectSyncCode: Promise.resolve('test')
        }
      })
    })

    await waitFor(() => expect(result.current[3]).toBe('install'))
    expect(result.current[2]).toBe('error')
    expect(result.current[3]).toBe('install')
    expect(result.current[1]).toBe(false)
  })

  it('should handle final else branch in handleClickWallet', async () => {
    const otherWallet = {
      key: 'wallet-final',
      name: 'Final Wallet',
      id: 'wallet-final-id',
      types: ['custom'],
      supportedInteractionStandards: [],
      links: {
        [OSLink.WEB]: 'https://finalwallet.com'
      },
      image: 'https://finalwallet.com/icon.png'
    }
    wallets.set('wallet-final', otherWallet)

    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('wc-payload'),
        Promise.resolve('p2p-payload'),
        Promise.resolve('post-payload'),
        wallets,
        onCloseHandler
      )
    )

    await act(async () => {
      await result.current[7]('wallet-final', {
        title: 'final test',
        pairingPayload: {
          networkType: NetworkType.GHOSTNET,
          p2pSyncCode: Promise.resolve('test'),
          postmessageSyncCode: Promise.resolve('test'),
          walletConnectSyncCode: Promise.resolve('test')
        }
      })
    })

    expect(result.current[2]).toBe('p2p-payload')
    expect(result.current[3]).toBe('top-wallets')
    expect(result.current[1]).toBe(false)
  })

  it('should handle handleNewTab with invalid wcPayload (wallet_connect branch)', async () => {
    const newTabWallet = {
      key: 'wallet-newtab-invalid',
      name: 'Other Wallet',
      id: 'wallet-newtab-invalid-id',
      types: ['web'],
      supportedInteractionStandards: ['wallet_connect'] as any,
      links: ['https://newtabwallet.com', '', '', ''],
      image: 'https://newtabwallet.com/icon.png',
      descriptions: ['test']
    }
    wallets.set('wallet-newtab-invalid', newTabWallet)
    const newTabMock = { opener: {}, location: { href: '' } }
    const windowOpenMock = vi.fn().mockReturnValue(newTabMock)
    window.open = windowOpenMock

    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('invalid-wc-payload'),
        Promise.resolve('p2p-payload'),
        Promise.resolve('post-payload'),
        wallets,
        onCloseHandler
      )
    )

    await act(async () => {
      await result.current[8](
        {
          title: 'new tab test',
          pairingPayload: {
            networkType: NetworkType.GHOSTNET,
            p2pSyncCode: Promise.resolve('test'),
            postmessageSyncCode: Promise.resolve('test'),
            walletConnectSyncCode: Promise.resolve('test')
          }
        },
        newTabWallet
      )
    })

    expect(newTabMock.location.href).toBe('')
    expect(localStorage.getItem(StorageKey.LAST_SELECTED_WALLET)).toBeNull()
    expect(result.current[1]).toBe(false)
    expect(result.current[6]).toBe(false)
  })

  it('should call onCloseHandler in handleDeepLinking when syncCode is empty', async () => {
    const deepLinkWallet = {
      key: 'wallet-deeplink-close',
      name: 'DeepLink Wallet',
      id: 'wallet-deeplink-close-id',
      types: ['ios'],
      supportedInteractionStandards: ['wallet_connect'] as any,
      links: ['', '', '', ''],
      image: 'https://deeplinkwallet.com/icon.png',
      descriptions: ['test']
    }
    wallets.set('wallet-deeplink-close', deepLinkWallet)

    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve(''),
        Promise.resolve('p2p-payload'),
        Promise.resolve('post-payload'),
        wallets,
        onCloseHandler
      )
    )

    await act(async () => {
      await result.current[9](deepLinkWallet)
    })

    expect(onCloseHandler).toHaveBeenCalled()
  })

  // Updated test: pass testUri as p2pPayload so that the expected deep link is generated.
  it('should handle handleDeepLinking when wallet.links[OSLink.IOS] is present', async () => {
    const wcPayload = 'wc-payload'
    const deepLinkWallet = {
      key: 'wallet-deeplink',
      name: 'DeepLink Wallet',
      id: 'wallet-deeplink-id',
      types: ['ios'],
      supportedInteractionStandards: ['wallet_connect'] as any,
      links: ['', 'https://ioswallet.com/', '', ''],
      image: 'https://ioswallet.com/icon.png',
      descriptions: ['test']
    }
    wallets.set('wallet-deeplink', deepLinkWallet)
    const testUri = 'my-uri'

    // --- Return a real anchor element ---
    const fakeAnchor = document.createElement('a')
    fakeAnchor.addEventListener('click', (event) => event.preventDefault())
    const setAttributeSpy = vi.spyOn(fakeAnchor, 'setAttribute')
    const dispatchEventSpy = vi.spyOn(fakeAnchor, 'dispatchEvent')
    const originalCreateElement = document.createElement.bind(document)
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) => {
        if (tag === 'a') {
          return fakeAnchor
        }
        return originalCreateElement(tag)
      })

    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve(wcPayload),
        Promise.resolve(testUri), // Use testUri as the p2pPayload value
        Promise.resolve('post-payload'),
        wallets,
        onCloseHandler
      )
    )

    await act(async () => {
      await result.current[9](deepLinkWallet)
    })

    const storedWallet = JSON.parse(localStorage.getItem(StorageKey.LAST_SELECTED_WALLET)!)
    expect(storedWallet.url).toBe(`https://ioswallet.com/wc?uri=${wcPayload}`)

    expect(createElementSpy).toHaveBeenCalledWith('a')
    expect(setAttributeSpy).toHaveBeenCalledWith(
      'href',
      `https://ioswallet.com/wc?uri=${encodeURIComponent(wcPayload)}`
    )
    expect(setAttributeSpy).toHaveBeenCalledWith('rel', 'noopener')
    expect(dispatchEventSpy).toHaveBeenCalled()

    createElementSpy.mockRestore()
  })

  it('should update state, QR code, showMoreContent, and displayQRExtra via update functions', () => {
    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('initial-wc'),
        Promise.resolve('initial-p2p'),
        Promise.resolve('initial-post'),
        wallets,
        onCloseHandler
      )
    )

    act(() => {
      result.current[15](AlertState.WALLETS)
    })
    expect(result.current[3]).toBe(AlertState.WALLETS)

    act(() => {
      result.current[16]('new-qr-code')
    })
    expect(result.current[2]).toBe('new-qr-code')

    const initialShowMore = result.current[5]
    act(() => {
      result.current[17]()
    })
    expect(result.current[5]).toBe(!initialShowMore)

    act(() => {
      result.current[18](true)
    })
    expect(result.current[4]).toBe(true)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })
})

describe('useConnect persisted wallet display names', () => {
  const wallet: MergedWallet = {
    id: 'example-mobile',
    key: 'example_mobile',
    name: 'Example Wallet',
    image: 'https://wallet.test/icon',
    descriptions: [],
    types: ['ios'],
    links: [],
    supportedInteractionStandards: ['beacon']
  }

  it.each(['wallet tile', 'mobile deep link'] as const)(
    'stores the display name when selecting through %s',
    async (entryPoint) => {
      const { result } = renderHook(() =>
        useConnect(
          false,
          Promise.resolve('wc-payload'),
          Promise.resolve('p2p-payload'),
          Promise.resolve('post-payload'),
          new Map([[wallet.id, wallet]]),
          vi.fn()
        )
      )

      await act(async () => {
        if (entryPoint === 'wallet tile') {
          await result.current[7](wallet.id, { title: 'Select wallet' })
        } else {
          await result.current[9](wallet)
        }
      })

      const persisted: unknown = JSON.parse(
        localStorage.getItem(StorageKey.LAST_SELECTED_WALLET) ?? 'null'
      )
      expect(persisted).toEqual({
        key: wallet.key,
        name: wallet.name,
        type: 'mobile',
        icon: wallet.image
      })
    }
  )

  it.each([
    { types: ['extension'], expectedType: 'extension' },
    { types: ['desktop'], expectedType: 'desktop' },
    { types: ['web'], expectedType: 'web' },
    { types: ['ios'], expectedType: 'mobile' },
    { types: ['extension', 'ios'], expectedType: 'mobile' }
  ] as const)(
    'derives initial type $expectedType on wallet tile click when types is $types',
    async ({ types, expectedType }) => {
      const candidate: MergedWallet = {
        ...wallet,
        id: `wallet-${types.join('-')}`,
        key: `key_${types.join('_')}`,
        types: [...types]
      }

      const { result } = renderHook(() =>
        useConnect(
          false,
          Promise.resolve('wc-payload'),
          Promise.resolve('p2p-payload'),
          Promise.resolve('post-payload'),
          new Map([[candidate.id, candidate]]),
          vi.fn()
        )
      )

      await act(async () => {
        await result.current[7](candidate.id, { title: 'Select wallet' })
      })

      const persisted: unknown = JSON.parse(
        localStorage.getItem(StorageKey.LAST_SELECTED_WALLET) ?? 'null'
      )
      expect(persisted).toEqual({
        key: candidate.key,
        name: candidate.name,
        type: expectedType,
        icon: candidate.image
      })
    }
  )

  it.each(['{bad json', 'null', 'undefined', '[1,2]'])(
    'does not throw when LAST_SELECTED_WALLET contains %s during deep-link URL update',
    async (corruptValue) => {
      const mobileWallet: MergedWallet = {
        ...wallet,
        links: ['', 'https://wallet.test/app']
      }
      const dispatchEventSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'dispatchEvent')
        .mockReturnValue(true)
      const getItemSpy = vi
        .spyOn(Storage.prototype, 'getItem')
        .mockImplementation((key: string) =>
          key === StorageKey.LAST_SELECTED_WALLET ? corruptValue : null
        )

      try {
        const { result } = renderHook(() =>
          useConnect(
            false,
            Promise.resolve('wc-payload'),
            Promise.resolve('p2p-payload'),
            Promise.resolve('post-payload'),
            new Map([[mobileWallet.id, mobileWallet]]),
            vi.fn()
          )
        )

        await expect(
          act(async () => {
            await result.current[9](mobileWallet)
          })
        ).resolves.not.toThrow()
      } finally {
        getItemSpy.mockRestore()
        dispatchEventSpy.mockRestore()
      }
    }
  )
})

describe('useConnect launch lifetime', () => {
  const webWallet: MergedWallet = {
    id: 'web-wallet',
    key: 'web_wallet',
    name: 'Web Wallet',
    image: 'wallet.png',
    descriptions: [],
    types: ['web'],
    links: ['https://wallet.example'],
    supportedInteractionStandards: ['beacon']
  }
  const config = {
    title: 'Pair wallet',
    pairingPayload: {
      networkType: NetworkType.GHOSTNET,
      p2pSyncCode: Promise.resolve('unused'),
      postmessageSyncCode: Promise.resolve('unused'),
      walletConnectSyncCode: Promise.resolve('unused')
    }
  }

  it('opens an isolated placeholder synchronously and keeps the blocked-popup fallback', async () => {
    const pairing = deferred<string>()
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() }
    window.open = vi.fn().mockReturnValueOnce(tab).mockReturnValue(null)
    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('unused'),
        pairing.promise,
        Promise.resolve('unused'),
        new Map([[webWallet.id, webWallet]]),
        vi.fn()
      )
    )
    let launch!: Promise<void>
    act(() => {
      launch = result.current[7](webWallet.id, config)
    })
    expect(window.open).toHaveBeenCalledWith('', '_blank')
    expect(tab.opener).toBeNull()
    expect(tab.location.href).toBe('')
    await act(async () => {
      pairing.resolve('pairing-code')
      await launch
    })
    await waitFor(() => expect(tab.location.href).toBe('https://example.com/tzip10'))
    expect(result.current[1]).toBe(false)
    expect(tab.close).not.toHaveBeenCalled()
    await act(async () => {
      await result.current[8](config, webWallet)
    })
    expect(window.open).toHaveBeenLastCalledWith('https://example.com/tzip10', '_blank', 'noopener')
  })

  it.each(['Beacon web', 'WalletConnect web', 'extension', 'desktop'] as const)(
    'consumes a rejected %s preparation, clears loading and closes only unused tabs',
    async (path) => {
      const pending = deferred<string>()
      const error = new Error('preparation failed')
      const selected: MergedWallet = {
        ...webWallet,
        types: path === 'extension' ? ['extension'] : path === 'desktop' ? ['desktop'] : ['web'],
        supportedInteractionStandards:
          path === 'WalletConnect web' ? ['wallet_connect'] : ['beacon']
      }
      const tab = { opener: {}, location: { href: '' }, close: vi.fn() }
      window.open = vi.fn().mockReturnValue(tab)
      const { result } = renderHook(() =>
        useConnect(
          false,
          path === 'WalletConnect web' ? pending.promise : Promise.resolve('unused'),
          path === 'Beacon web' || path === 'desktop' ? pending.promise : Promise.resolve('unused'),
          path === 'extension' ? pending.promise : Promise.resolve('unused'),
          new Map([[selected.id, selected]]),
          vi.fn()
        )
      )
      let launch!: Promise<void>
      if (path === 'extension' || path === 'desktop') {
        await act(async () => {
          await result.current[7](selected.id, { title: 'Select' })
        })
        act(() => {
          launch = path === 'extension' ? result.current[11]() : result.current[13]()
        })
      } else {
        act(() => {
          launch = result.current[7](selected.id, config)
        })
      }
      await act(async () => {
        pending.reject(error)
        await launch
      })
      expect(result.current[1]).toBe(false)
      expect(tab.location.href).toBe('')
      expect(tab.close).toHaveBeenCalledTimes(path.endsWith('web') ? 1 : 0)
      expect(reportDiagnostic).toHaveBeenCalledTimes(1)
      expect(reportDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ args: [error] }))
      if (path === 'WalletConnect web') expect(result.current[6]).toBe(false)
    }
  )

  it('keeps a handed-off wallet tab open when persisting the selection fails', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() }
    window.open = vi.fn().mockReturnValue(tab)
    const error = new Error('storage unavailable')
    const setItem = vi
      .spyOn(Object.getPrototypeOf(localStorage), 'setItem')
      .mockImplementation(() => {
        throw error
      })
    try {
      const { result, unmount } = renderHook(() =>
        useConnect(
          false,
          Promise.resolve('unused'),
          Promise.resolve('code'),
          Promise.resolve('unused'),
          new Map([[webWallet.id, webWallet]]),
          vi.fn()
        )
      )
      await act(async () => {
        await result.current[8](config, webWallet)
      })
      unmount()
      expect(tab.location.href).toBe('https://example.com/tzip10')
      expect(tab.close).not.toHaveBeenCalled()
      expect(result.current[1]).toBe(false)
      expect(reportDiagnostic).toHaveBeenCalledTimes(1)
      expect(reportDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ args: [error] }))
    } finally {
      setItem.mockRestore()
    }
  })

  it.each(['resolve', 'reject'] as const)(
    'keeps a newer wallet selection loading when an older launch will %s',
    async (outcome) => {
      const oldPairing = deferred<string>()
      const newPairing = deferred<string>()
      const newerWallet: MergedWallet = {
        ...webWallet,
        id: 'new-wallet',
        key: 'new_wallet',
        types: ['ios', 'web'],
        supportedInteractionStandards: ['wallet_connect']
      }
      const tab = { opener: {}, location: { href: '' }, close: vi.fn() }
      window.open = vi.fn().mockReturnValue(tab)
      const { result } = renderHook(() =>
        useConnect(
          false,
          newPairing.promise,
          oldPairing.promise,
          Promise.resolve('unused'),
          new Map([
            [webWallet.id, webWallet],
            [newerWallet.id, newerWallet]
          ]),
          vi.fn()
        )
      )
      let oldLaunch!: Promise<void>
      let newLaunch!: Promise<void>
      act(() => {
        oldLaunch = result.current[7](webWallet.id, config)
      })
      act(() => {
        newLaunch = result.current[7](newerWallet.id, config)
      })
      await act(async () => {
        if (outcome === 'resolve') oldPairing.resolve('old-code')
        else oldPairing.reject(new Error('old failure'))
        await oldLaunch
      })
      expect(tab.close).toHaveBeenCalledTimes(1)
      expect(tab.location.href).toBe('')
      expect(result.current[0]).toEqual(newerWallet)
      expect(result.current[1]).toBe(true)
      expect(JSON.parse(localStorage.getItem(StorageKey.LAST_SELECTED_WALLET)!).key).toBe(
        'new_wallet'
      )
      await act(async () => {
        newPairing.resolve('wc:new@2?symKey=abc&relay-protocol=irn')
        await newLaunch
      })
      expect(result.current[2]).toBe('wc:new@2?symKey=abc&relay-protocol=irn')
      expect(result.current[1]).toBe(false)
    }
  )

  it.each(['back', 'unmount'] as const)(
    'abandons an unused web tab on %s and ignores its late payload',
    async (exit) => {
      const pairing = deferred<string>()
      const tab = { opener: {}, location: { href: '' }, close: vi.fn() }
      window.open = vi.fn().mockReturnValue(tab)
      const { result, unmount } = renderHook(() =>
        useConnect(
          false,
          Promise.resolve('unused'),
          pairing.promise,
          Promise.resolve('unused'),
          new Map([[webWallet.id, webWallet]]),
          vi.fn()
        )
      )
      let launch!: Promise<void>
      act(() => {
        launch = result.current[7](webWallet.id, config)
      })
      if (exit === 'back') act(() => result.current[15](AlertState.TOP_WALLETS))
      else unmount()
      const stored = localStorage.getItem(StorageKey.LAST_SELECTED_WALLET)
      expect(tab.close).toHaveBeenCalledTimes(1)
      await act(async () => {
        pairing.resolve('late-code')
        await launch
      })
      expect(tab.location.href).toBe('')
      expect(localStorage.getItem(StorageKey.LAST_SELECTED_WALLET)).toBe(stored)
      if (exit === 'back') expect(result.current[1]).toBe(false)
    }
  )

  it('awaits and consumes an async close rejection from an empty mobile payload', async () => {
    const closing = deferred<void>()
    const error = new Error('close failed')
    const onClose = vi.fn(() => closing.promise)
    const mobileWallet: MergedWallet = { ...webWallet, types: ['ios'], links: [] }
    const { result } = renderHook(() =>
      useConnect(
        false,
        Promise.resolve('unused'),
        Promise.resolve(''),
        Promise.resolve('unused'),
        new Map([[mobileWallet.id, mobileWallet]]),
        onClose
      )
    )
    let launch!: Promise<void>
    await act(async () => {
      launch = result.current[9](mobileWallet)
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(result.current[1]).toBe(true)
    await act(async () => {
      closing.reject(error)
      await launch
    })
    expect(result.current[1]).toBe(false)
    expect(reportDiagnostic).toHaveBeenCalledTimes(1)
    expect(reportDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ args: [error] }))
  })
})
