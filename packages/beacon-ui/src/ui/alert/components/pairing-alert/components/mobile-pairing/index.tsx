import { reportDiagnostic } from '@ecadlabs/beacon-core'
import { useLayoutEffect, useRef, type FC } from 'react'
import type { MergedWallet } from '../../../../../../utils/wallets'
import { Info } from '../../../../../../components/info'
import { AlertState, type PairingPayload } from '../../../../../common'
import { isIOS } from '../../../../../../utils/platform'
import { suffixMap } from './utils/suffix-map'

interface MobilePairingProps {
  open?: boolean
  wallet: MergedWallet
  handleUpdateState: (state: AlertState) => void
  handleDeepLinking: (wallet: MergedWallet) => Promise<void>
  wcPayload: PairingPayload['walletConnectSyncCode']
  p2pPayload: PairingPayload['p2pSyncCode']
  handleUpdateQRCode: (code: string) => void
  handleDisplayQRExtra: (display: boolean) => void
  onClose: () => void | PromiseLike<void>
  cancelPendingLaunch?: () => void
}

const reportActionFailure = (method: string, error: unknown) =>
  reportDiagnostic({ level: 'error', service: 'MobilePairing', method, args: [error] })

export const MobilePairing: FC<MobilePairingProps> = ({
  open = true,
  wallet,
  handleUpdateState,
  handleDeepLinking,
  wcPayload,
  p2pPayload,
  handleUpdateQRCode,
  handleDisplayQRExtra,
  onClose,
  cancelPendingLaunch
}) => {
  const qrAction = useRef(0)
  useLayoutEffect(() => {
    if (!open) {
      qrAction.current += 1
    }

    return () => {
      qrAction.current += 1
    }
  }, [open, wallet, wcPayload, p2pPayload, onClose])

  const openApp = async () => {
    if (!open) {
      return
    }
    const action = ++qrAction.current
    try {
      await handleDeepLinking(wallet)
    } catch (error: unknown) {
      if (action === qrAction.current) {
        reportActionFailure('openApp', error)
      }
    }
  }

  const showQRCode = async () => {
    if (!open) {
      return
    }
    const action = ++qrAction.current
    try {
      cancelPendingLaunch?.()
      const syncCode = await (wallet.supportedInteractionStandards?.includes('wallet_connect')
        ? wcPayload
        : p2pPayload)
      if (action !== qrAction.current) {
        return
      }
      if (!syncCode.length) {
        await onClose()

        return
      }
      handleUpdateQRCode(syncCode)
      handleUpdateState(AlertState.QR)
      handleDisplayQRExtra(true)
    } catch (error: unknown) {
      if (action === qrAction.current) {
        reportActionFailure('showQRCode', error)
      }
    }
  }

  return (
    <Info
      border
      title={`Connect with ${wallet.name} ${suffixMap.get(wallet.id) ?? ''}`}
      description={''}
      buttons={[{ label: 'Use App', type: 'primary', onClick: openApp }]}
      downloadLink={
        wallet.name.toLowerCase().includes('kukai') && isIOS(window)
          ? { label: 'Get Kukai Mobile >', url: 'https://ios.kukai.app' }
          : undefined
      }
      onShowQRCodeClick={showQRCode}
    />
  )
}
