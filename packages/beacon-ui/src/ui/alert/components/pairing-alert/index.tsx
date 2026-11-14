import { reportDiagnostic } from '@ecadlabs/beacon-core'
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import type { Extension } from '@ecadlabs/beacon-types'
import { Alert } from '../../../../components/alert'
import { useConnect } from '../../hooks/useConnect'
import { Info } from '../../../../components/info'
import { PairOther } from '../../../../components/pair-other'
import { TopWallets } from '../../../../components/top-wallets'
import { Wallets } from '../../../../components/wallets'
import { isMobileOS } from '../../../../utils/platform'
import { useWallets } from '../../hooks/useWallets'
import {
  AlertState,
  type ConfigurableAlertProps,
  type PairingPayload,
  type QRCodeProps
} from '../../../common'
import type { MergedWallet } from '../../../../utils/wallets'
import { runUICallback } from '../../../../utils/callback'
import { useIsMobile } from '../../hooks/useIsMobile'
import { WCInitError } from './components/wc-init-error'
import { QRCode } from './components/qr-code'
import { MobilePairing } from './components/mobile-pairing'

type PairingAlertProps = Omit<ConfigurableAlertProps, 'pairingPayload'> & {
  pairingPayload: PairingPayload
}
type ConnectResult = ReturnType<typeof useConnect>
const contentStyle: CSSProperties = {
  opacity: 1,
  height: 'unset',
  overflow: 'unset',
  transform: 'scale(1)',
  transition: 'all ease 0.3s'
}
const stackStyle: CSSProperties = {
  ...contentStyle,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.9em'
}

interface InstallViewProps {
  wallet: MergedWallet
  isMobile: boolean
  isWCWorking: boolean
  availableExtensions: Extension[]
  onOpenWeb: () => Promise<void>
  onConnectExtension: ConnectResult[11]
  onInstallExtension: ConnectResult[12]
  onOpenDesktop: ConnectResult[13]
  onDownloadDesktop: ConnectResult[14]
  qrProps: Omit<QRCodeProps, 'isMobile'>
  mobileContent: ReactNode
}

const ExtensionInstall = ({
  wallet,
  availableExtensions,
  onConnectExtension,
  onInstallExtension
}: Pick<
  InstallViewProps,
  'wallet' | 'availableExtensions' | 'onConnectExtension' | 'onInstallExtension'
>) => {
  const installed = availableExtensions.some(
    (extension) => extension.id === wallet.id || extension.id === wallet.firefoxId
  )

  return (
    <Info
      border
      title={
        installed
          ? `Connect with ${wallet.name} Browser Extension`
          : `Install ${wallet.name} Wallet`
      }
      description={
        installed
          ? `Please connect below to use your ${wallet.name} Wallet browser extension.`
          : `To connect your ${wallet.name} Wallet, install the browser extension.`
      }
      buttons={[
        {
          label: installed ? 'Use Extension' : 'Install extension',
          type: 'primary',
          onClick: installed ? onConnectExtension : onInstallExtension
        }
      ]}
    />
  )
}

const InstallView = ({
  wallet,
  isMobile,
  isWCWorking,
  availableExtensions,
  onOpenWeb,
  onConnectExtension,
  onInstallExtension,
  onOpenDesktop,
  onDownloadDesktop,
  qrProps,
  mobileContent
}: InstallViewProps) => {
  const mobileOS = isMobileOS(window)

  return (
    <div style={stackStyle}>
      {navigator.onLine && wallet.types.includes('web') && (
        <Info
          border
          title={`Connect with ${wallet.name} Web`}
          description="(It will open the wallet in a new tab)"
          buttons={[{ label: 'Use Browser', type: 'primary', onClick: onOpenWeb }]}
        />
      )}
      {!isMobile && wallet.types.includes('extension') && (
        <ExtensionInstall
          wallet={wallet}
          availableExtensions={availableExtensions}
          onConnectExtension={onConnectExtension}
          onInstallExtension={onInstallExtension}
        />
      )}
      {!mobileOS && wallet.types.includes('desktop') && (
        <Info
          border
          title={`Connect with ${wallet.name} Desktop App`}
          description="If you don't have the desktop app installed, click below to download it."
          buttons={[
            { label: 'Open desktop app', type: 'primary', onClick: onOpenDesktop },
            { label: 'Download desktop app', type: 'secondary', onClick: onDownloadDesktop }
          ]}
        />
      )}
      {!mobileOS && Boolean(qrProps.qrCode?.length) && wallet.types.includes('ios') && (
        <QRCode {...qrProps} isMobile={wallet.types.length <= 1} />
      )}
      {mobileOS &&
        wallet.types.includes('ios') &&
        (isWCWorking && wallet.supportedInteractionStandards?.includes('wallet_connect') ? (
          mobileContent
        ) : (
          <WCInitError title={`Connect with ${wallet.name} Mobile`} />
        ))}
    </div>
  )
}

interface SelectionViewProps {
  wallets: MergedWallet[]
  state: AlertState
  isMobile: boolean
  isLoading: boolean
  onWallet: (id: string) => Promise<void>
  onOther: ConnectResult[10]
  onShowAll: () => void
}

const SelectionView = ({
  wallets,
  state,
  isMobile,
  isLoading,
  onWallet,
  onOther,
  onShowAll
}: SelectionViewProps) => (
  <div style={contentStyle}>
    {state === AlertState.WALLETS ? (
      <Wallets
        wallets={wallets.slice(-(wallets.length - (isMobile ? 3 : 4)))}
        isMobile={isMobile}
        onClickWallet={onWallet}
        onClickOther={onOther}
      />
    ) : (
      <TopWallets
        wallets={isMobile ? wallets.slice(0, 3) : wallets.slice(0, 4)}
        isMobile={isMobile}
        onClickWallet={onWallet}
        disabled={isLoading}
        otherWallets={
          isMobile && wallets.length >= 6
            ? {
                images: [wallets[3].image, wallets[4].image, wallets[5].image],
                onClick: onShowAll
              }
            : undefined
        }
      />
    )}
  </div>
)

const QRChoiceView = ({
  displayExtra,
  walletList,
  p2pPayload,
  wcPayload,
  qrProps
}: {
  displayExtra: boolean
  walletList: MergedWallet[]
  p2pPayload: PairingPayload['p2pSyncCode']
  wcPayload: PairingPayload['walletConnectSyncCode']
  qrProps: Omit<QRCodeProps, 'isMobile'>
}) => (
  <div style={stackStyle}>
    {displayExtra ? (
      <QRCode {...qrProps} isMobile />
    ) : (
      <PairOther walletList={walletList} p2pPayload={p2pPayload} wcPayload={wcPayload} />
    )}
  </div>
)

export const PairingAlert: React.FC<PairingAlertProps> = (props) => {
  const wcPayload = props.pairingPayload.walletConnectSyncCode
  const p2pPayload = props.pairingPayload.p2pSyncCode
  const postPayload = props.pairingPayload.postmessageSyncCode
  const isMobile = useIsMobile()
  const { wallets, availableExtensions } = useWallets(
    props.pairingPayload.networkType,
    props.featuredWallets
  )
  const [
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
  ] = useConnect(isMobile, wcPayload, p2pPayload, postPayload, wallets, props.onClose)
  useLayoutEffect(() => {
    if (!props.open) {
      cancelPendingLaunch()
    }

    return cancelPendingLaunch
  }, [props.open, wcPayload, p2pPayload, postPayload])

  const handleClose = async () => {
    cancelPendingLaunch()
    try {
      const onClose: () => void | PromiseLike<void> = props.onClose
      await onClose()
    } catch (error: unknown) {
      reportDiagnostic({
        level: 'error',
        service: 'PairingAlert',
        method: 'onClose',
        args: [error]
      })
    }
  }

  const walletList = Array.from(wallets.values())
  const soleWallet = wallets.size === 1 ? walletList[0] : undefined
  const latestStart = useRef({ props, handleClickWallet })
  useLayoutEffect(() => {
    latestStart.current = { props, handleClickWallet }
  }, [props, handleClickWallet])

  useEffect(() => {
    if (!props.open || !soleWallet) {
      return
    }
    runUICallback(
      () => latestStart.current.handleClickWallet(soleWallet.id, latestStart.current.props),
      'PairingAlert',
      'autoStart'
    )
  }, [soleWallet, props.open, wcPayload, p2pPayload, postPayload])

  const qrProps: Omit<QRCodeProps, 'isMobile'> = {
    wallet,
    isWCWorking,
    qrCode,
    defaultPairing: p2pPayload,
    handleIsLoading
  }

  return (
    <Alert
      {...props}
      closeOnBackdropClick
      loading={isLoading}
      onCloseClick={handleClose}
      open={props.open}
      showMore={showMoreContent}
      extraContent={
        state !== AlertState.TOP_WALLETS || isMobile ? undefined : (
          <Wallets
            small
            disabled={isLoading}
            wallets={walletList.slice(-(walletList.length - 4))}
            isMobile={isMobile}
            onClickWallet={(id) => handleClickWallet(id, props)}
            onClickOther={handleClickOther}
          />
        )
      }
      onClickShowMore={handleShowMoreContent}
      onBackClick={
        walletList.length === 1
          ? undefined
          : [AlertState.INSTALL, AlertState.QR].includes(state) ||
              (state === AlertState.WALLETS && isMobile)
            ? () => handleUpdateState(AlertState.TOP_WALLETS)
            : undefined
      }
    >
      <div>
        {state === AlertState.INSTALL && wallet && (
          <InstallView
            wallet={wallet}
            isMobile={isMobile}
            isWCWorking={isWCWorking}
            availableExtensions={availableExtensions}
            qrProps={qrProps}
            onOpenWeb={() => handleNewTab(props, wallet)}
            onConnectExtension={handleClickConnectExtension}
            onInstallExtension={handleClickInstallExtension}
            onOpenDesktop={handleClickOpenDesktopApp}
            onDownloadDesktop={handleClickDownloadDesktopApp}
            mobileContent={
              <MobilePairing
                open={props.open}
                wallet={wallet}
                handleUpdateState={handleUpdateState}
                handleDeepLinking={handleDeepLinking}
                cancelPendingLaunch={cancelPendingLaunch}
                wcPayload={wcPayload}
                p2pPayload={p2pPayload}
                handleUpdateQRCode={handleUpdateQRCode}
                handleDisplayQRExtra={handleDisplayQRExtra}
                onClose={props.onClose}
              />
            }
          />
        )}
        {state === AlertState.QR && (
          <QRChoiceView
            displayExtra={displayQRExtra}
            walletList={walletList}
            p2pPayload={p2pPayload}
            wcPayload={wcPayload}
            qrProps={qrProps}
          />
        )}
        {![AlertState.QR, AlertState.INSTALL].includes(state) && (
          <SelectionView
            wallets={walletList}
            state={state}
            isMobile={isMobile}
            isLoading={isLoading}
            onWallet={(id) => handleClickWallet(id, props)}
            onOther={handleClickOther}
            onShowAll={() => handleUpdateState(AlertState.WALLETS)}
          />
        )}
      </div>
    </Alert>
  )
}
