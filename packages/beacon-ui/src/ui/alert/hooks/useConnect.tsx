import { Logger, reportDiagnostic, windowRef } from '@ecadlabs/beacon-core'
import { StorageKey, ExtensionMessage, ExtensionMessageTarget } from '@ecadlabs/beacon-types'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getTzip10Link } from '../../../utils/get-tzip10-link'
import { isTwBrowser, isAndroid, isMobileOS, isIOS } from '../../../utils/platform'
import { MergedWallet, OSLink } from '../../../utils/wallets'
import { getDefaultLogo } from '../getDefautlLogo'
import { AlertConfig, AlertState } from '../../common'
import { hasWalletConnectSymKey } from '../../../utils/walletconnect'

const logger = new Logger('useConnect')

interface WalletAction {
  placeholder?: Window
}

const reportLaunchFailure = (method: string, error: unknown) =>
  reportDiagnostic({ level: 'error', service: 'useConnect', method, args: [error] })

const reportWalletConnectFailure = (error: unknown): string => {
  reportLaunchFailure('walletConnectPayload', error)

  return ''
}

const getInitialWalletType = (
  selectedWallet?: MergedWallet
): 'extension' | 'mobile' | 'web' | 'desktop' => {
  if (selectedWallet?.types.length === 1) {
    switch (selectedWallet.types[0]) {
      case 'web':
        return 'web'
      case 'extension':
        return 'extension'
      case 'desktop':
        return 'desktop'
      default:
        return 'mobile'
    }
  }

  return 'mobile'
}

const storeSelectedWallet = (
  selectedWallet: MergedWallet | undefined,
  type: ReturnType<typeof getInitialWalletType>
) => {
  localStorage.setItem(
    StorageKey.LAST_SELECTED_WALLET,
    JSON.stringify({
      key: selectedWallet?.key,
      name: selectedWallet?.name,
      type,
      icon: selectedWallet?.image
    })
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readLastSelectedWallet = (): Record<string, unknown> | undefined => {
  try {
    const raw = localStorage.getItem(StorageKey.LAST_SELECTED_WALLET)
    if (!raw) {
      return undefined
    }
    const parsed: unknown = JSON.parse(raw)

    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const updateSelectedWalletWithURL = (url: string) => {
  const storedWallet = readLastSelectedWallet()
  if (!storedWallet || typeof storedWallet.key !== 'string' || !storedWallet.key) {
    return
  }
  localStorage.setItem(StorageKey.LAST_SELECTED_WALLET, JSON.stringify({ ...storedWallet, url }))
}

const openMobileLink = (link: string) => {
  if (isAndroid(window)) {
    window.open(link, '_blank', 'noopener')
  } else {
    const anchor = document.createElement('a')
    anchor.setAttribute('href', link)
    anchor.setAttribute('rel', 'noopener')
    anchor.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }))
  }
}

export const useConnect = (
  isMobile: boolean,
  wcPayload: PromiseLike<string>,
  p2pPayload: Promise<string>,
  postPayload: Promise<string>,
  wallets: Map<string, MergedWallet>,
  onCloseHandler: () => void | PromiseLike<void>
) => {
  const [wallet, setWallet] = useState<MergedWallet>()
  const [isLoading, setIsLoading] = useState(false)
  const [qrCode, setQRCode] = useState<string>()
  const [state, setState] = useState<AlertState>(AlertState.TOP_WALLETS)
  const [displayQRExtra, setDisplayQRExtra] = useState(false)
  const [showMoreContent, setShowMoreContent] = useState(false)
  const [isWCWorking, setIsWCWorking] = useState(true)
  const currentAction = useRef<WalletAction | undefined>(undefined)

  const closePlaceholder = (action: WalletAction) => {
    const placeholder = action.placeholder
    action.placeholder = undefined
    try {
      placeholder?.close?.()
    } catch (error: unknown) {
      reportLaunchFailure('closePlaceholder', error)
    }
  }

  const invalidateAction = () => {
    const previousAction = currentAction.current
    currentAction.current = undefined
    if (previousAction) {
      closePlaceholder(previousAction)
    }
  }

  useEffect(() => invalidateAction, [])

  useLayoutEffect(() => {
    invalidateAction()
    setWallet(undefined)
    setQRCode(undefined)
    setState(AlertState.TOP_WALLETS)
    setDisplayQRExtra(false)
    setShowMoreContent(false)
    setIsWCWorking(true)
    setIsLoading(false)
  }, [wcPayload, p2pPayload, postPayload])

  const isCurrentAction = (action: WalletAction) => currentAction.current === action

  const runWalletAction = async (
    method: string,
    launch: (action: WalletAction) => Promise<void>
  ): Promise<void> => {
    invalidateAction()
    const action: WalletAction = {}
    currentAction.current = action
    setIsLoading(true)
    try {
      // Invoke synchronously so web-wallet placeholders retain the user gesture.
      await launch(action)
    } catch (error: unknown) {
      if (isCurrentAction(action)) {
        reportLaunchFailure(method, error)
      }
    } finally {
      closePlaceholder(action)
      if (isCurrentAction(action)) {
        setIsLoading(false)
      }
    }
  }

  const setInstallState = (selectedWallet?: MergedWallet) => {
    if (
      !selectedWallet ||
      (selectedWallet.types.length <= 1 &&
        !selectedWallet.types.includes('ios') &&
        !selectedWallet.types.includes('desktop')) ||
      (isMobileOS(window) &&
        selectedWallet.types.length === 1 &&
        selectedWallet.types.includes('desktop'))
    ) {
      return
    }
    setState(AlertState.INSTALL)
  }

  const launchWebWallet = async (
    action: WalletAction,
    config: AlertConfig,
    selectedWallet: MergedWallet
  ) => {
    if (!config.pairingPayload) {
      return
    }
    // Noopener would make Chrome open about:blank#blocked instead.
    const newTab = window.open('', '_blank')
    action.placeholder = newTab ?? undefined
    if (newTab) {
      newTab.opener = null
    }
    let link: string
    if (
      selectedWallet.supportedInteractionStandards?.includes('wallet_connect') &&
      !selectedWallet.name.toLowerCase().includes('kukai')
    ) {
      let payload: string
      try {
        payload = await wcPayload
      } catch (error: unknown) {
        if (!isCurrentAction(action)) {
          return
        }
        payload = reportWalletConnectFailure(error)
      }
      if (!isCurrentAction(action)) {
        return
      }
      const isValid = hasWalletConnectSymKey(payload)
      setIsWCWorking(isValid)
      if (!isValid) {
        return
      }
      link = `${selectedWallet.links[OSLink.WEB]}/wc?uri=${encodeURIComponent(payload)}`
    } else {
      const payload = await p2pPayload
      if (!isCurrentAction(action)) {
        return
      }
      link = getTzip10Link(selectedWallet.links[OSLink.WEB], payload)
    }
    if (newTab) {
      newTab.location.href = link
      action.placeholder = undefined
    } else {
      window.open(link, '_blank', 'noopener')
    }
    storeSelectedWallet(selectedWallet, 'web')
  }

  const launchMobileWallet = async (selectedWallet: MergedWallet, syncCode: string) => {
    if (!selectedWallet.links[OSLink.IOS]?.length) {
      if (!syncCode.length) {
        await onCloseHandler()

        return
      }
      setQRCode(syncCode)
      setState(AlertState.QR)
      setDisplayQRExtra(true)

      return
    }
    const link = selectedWallet.supportedInteractionStandards?.includes('wallet_connect')
      ? `${selectedWallet.links[OSLink.IOS]}wc?uri=${encodeURIComponent(syncCode)}`
      : getTzip10Link(selectedWallet.links[OSLink.IOS], syncCode)
    updateSelectedWalletWithURL(link)
    logger.log(`DO DEEPLINK WITH ${link}`)
    if (isTwBrowser(window) && isAndroid(window)) {
      window.location.href = `${syncCode}`
    }
    openMobileLink(link)
  }

  const selectWalletConnectWallet = async (action: WalletAction, selectedWallet: MergedWallet) => {
    let payload: string
    try {
      payload = await wcPayload
    } catch (error: unknown) {
      if (!isCurrentAction(action)) {
        return
      }
      payload = reportWalletConnectFailure(error)
    }
    if (!isCurrentAction(action)) {
      return
    }
    const isValid = hasWalletConnectSymKey(payload)
    setIsWCWorking(isValid)
    if (!isValid && selectedWallet.name.toLowerCase().includes('kukai')) {
      setQRCode('error')
      setInstallState(selectedWallet)

      return
    }
    if (!isValid) {
      return
    }
    if (isMobile && selectedWallet.types.includes('ios') && selectedWallet.types.length === 1) {
      storeSelectedWallet(selectedWallet, 'mobile')
      await launchMobileWallet(selectedWallet, payload)
    } else {
      setQRCode(payload)
      setInstallState(selectedWallet)
    }
  }

  const selectBeaconMobileWallet = async (
    action: WalletAction,
    config: AlertConfig,
    selectedWallet: MergedWallet
  ) => {
    setQRCode('')
    if (!config.pairingPayload) {
      return
    }
    const payload = await p2pPayload
    if (!isCurrentAction(action)) {
      return
    }
    const link = getTzip10Link(
      isIOS(window) && selectedWallet.deepLink
        ? selectedWallet.deepLink
        : isAndroid(window)
          ? selectedWallet.links[OSLink.IOS]
          : 'tezos://',
      payload
    )
    updateSelectedWalletWithURL(link)
    openMobileLink(link)
  }

  const handleClickWallet = (id: string, config: AlertConfig): Promise<void> =>
    runWalletAction('handleClickWallet', async (action) => {
      setShowMoreContent(false)
      const selectedWallet = wallets.get(id)
      setWallet(selectedWallet)
      storeSelectedWallet(selectedWallet, getInitialWalletType(selectedWallet))
      if (selectedWallet?.types.includes('web') && selectedWallet.types.length === 1) {
        await launchWebWallet(action, config, selectedWallet)
      } else if (selectedWallet?.supportedInteractionStandards?.includes('wallet_connect')) {
        await selectWalletConnectWallet(action, selectedWallet)
      } else if (isMobileOS(window) && selectedWallet?.types.includes('ios') && isMobile) {
        await selectBeaconMobileWallet(action, config, selectedWallet)
      } else {
        setInstallState(selectedWallet)
        if (config.pairingPayload) {
          const payload = await p2pPayload
          if (isCurrentAction(action)) {
            setQRCode(payload)
          }
        }
      }
    })

  const handleNewTab = (config: AlertConfig, selectedWallet: MergedWallet): Promise<void> =>
    runWalletAction('handleNewTab', (action) => launchWebWallet(action, config, selectedWallet))

  const handleDeepLinking = (selectedWallet: MergedWallet): Promise<void> =>
    runWalletAction('handleDeepLinking', async (action) => {
      storeSelectedWallet(selectedWallet, 'mobile')
      let syncCode: string
      if (selectedWallet.supportedInteractionStandards?.includes('wallet_connect')) {
        try {
          syncCode = await wcPayload
        } catch (error: unknown) {
          if (!isCurrentAction(action)) {
            return
          }
          reportWalletConnectFailure(error)
          setIsWCWorking(false)
          setInstallState(selectedWallet)
          if (selectedWallet.name.toLowerCase().includes('kukai')) {
            setQRCode('error')
          }

          return
        }
      } else {
        syncCode = await p2pPayload
      }
      if (isCurrentAction(action)) {
        await launchMobileWallet(selectedWallet, syncCode)
      }
    })

  const handleClickOther = () => {
    invalidateAction()
    setIsLoading(false)
    localStorage.setItem(
      StorageKey.LAST_SELECTED_WALLET,
      JSON.stringify({
        key: 'wallet',
        name: 'wallet',
        type: 'web',
        icon: getDefaultLogo()
      })
    )
    setState(AlertState.QR)
  }

  const handleClickConnectExtension = (): Promise<void> =>
    runWalletAction('handleClickConnectExtension', async (action) => {
      setShowMoreContent(false)
      const selectedWallet = wallet
      const payload = await postPayload
      if (!isCurrentAction(action)) {
        return
      }
      const message: ExtensionMessage<string> = {
        target: ExtensionMessageTarget.EXTENSION,
        payload,
        targetId: selectedWallet?.id
      }
      windowRef.postMessage(message, windowRef.location.origin)
      if (selectedWallet?.firefoxId) {
        windowRef.postMessage(
          { ...message, targetId: selectedWallet.firefoxId },
          windowRef.location.origin
        )
      }
      storeSelectedWallet(selectedWallet, 'extension')
    })

  const handleClickInstallExtension = () => {
    invalidateAction()
    setIsLoading(false)
    setShowMoreContent(false)
    window.open(wallet?.links[OSLink.EXTENSION] || '', '_blank', 'noopener')
  }

  const handleClickOpenDesktopApp = (): Promise<void> =>
    runWalletAction('handleClickOpenDesktopApp', async (action) => {
      setShowMoreContent(false)
      const selectedWallet = wallet
      const payload = await p2pPayload
      if (!isCurrentAction(action)) {
        return
      }
      const link = getTzip10Link(selectedWallet?.deepLink || '', payload)
      window.open(link, '_blank', 'noopener')
      storeSelectedWallet(selectedWallet, 'desktop')
    })

  const handleClickDownloadDesktopApp = () => {
    invalidateAction()
    setIsLoading(false)
    setShowMoreContent(false)
    window.open(wallet?.links[OSLink.DESKTOP] || '', '_blank', 'noopener')
  }

  const cancelPendingLaunch = () => {
    invalidateAction()
    setIsLoading(false)
  }

  const handleUpdateState = (newState: AlertState) => {
    cancelPendingLaunch()
    setState(newState)
  }
  const handleUpdateQRCode = (uri: string) => setQRCode(uri)
  const handleShowMoreContent = () => setShowMoreContent((prev) => !prev)
  const handleDisplayQRExtra = (show: boolean) => setDisplayQRExtra(show)
  const handleIsLoading = (loading: boolean) => setIsLoading(loading)

  return [
    wallet,
    isLoading,
    qrCode,
    state,
    displayQRExtra,
    showMoreContent,
    isWCWorking,
    handleClickWallet,
    handleNewTab,
    handleDeepLinking,
    handleClickOther,
    handleClickConnectExtension,
    handleClickInstallExtension,
    handleClickOpenDesktopApp,
    handleClickDownloadDesktopApp,
    handleUpdateState,
    handleUpdateQRCode,
    handleShowMoreContent,
    handleDisplayQRExtra,
    handleIsLoading,
    cancelPendingLaunch
  ] as const
}
