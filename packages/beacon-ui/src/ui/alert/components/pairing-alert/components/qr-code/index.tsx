import { useLayoutEffect, useRef, useState } from 'react'
import { getBeaconMessages, interpolateBeaconMessage } from '@ecadlabs/beacon-types'
import { QRCodeProps } from '../../../../../common'
import { QR } from '../../../../../../components/qr'
import { WCInitError } from '../wc-init-error'
import { runUICallback } from '../../../../../../utils/callback'

export const QRCode: React.FC<QRCodeProps> = ({
  wallet,
  isWCWorking,
  wcFailureReason,
  isMobile,
  qrCode,
  defaultPairing,
  handleIsLoading
}) => {
  const [fallback, setFallback] = useState<{
    wallet: QRCodeProps['wallet']
    pairing: QRCodeProps['defaultPairing']
    code: string
  }>()
  const loadingCallback = useRef(handleIsLoading)
  useLayoutEffect(() => {
    loadingCallback.current = handleIsLoading
  }, [handleIsLoading])
  const supportsWalletConnect = wallet?.supportedInteractionStandards?.includes('wallet_connect')
  const isConnected = !supportsWalletConnect || isWCWorking
  const codeQr =
    qrCode ||
    (fallback?.wallet === wallet && fallback?.pairing === defaultPairing
      ? fallback?.code
      : undefined)

  useLayoutEffect(() => {
    let current = true
    if (!defaultPairing || qrCode || supportsWalletConnect) {
      return
    }
    const finishLoading = () =>
      runUICallback(() => loadingCallback.current(false), 'QRCode', 'handleIsLoading')
    defaultPairing.then(
      (code) => {
        if (current) {
          setFallback({ wallet, pairing: defaultPairing, code })
          finishLoading()
        }
      },
      () => {
        if (current) {
          finishLoading()
        }
      }
    )

    return () => {
      current = false
    }
  }, [wallet, qrCode, defaultPairing, supportsWalletConnect])

  const { ui } = getBeaconMessages()

  if (!isConnected) {
    return (
      <WCInitError
        title={interpolateBeaconMessage(ui.connectWithMobile, { wallet: wallet?.name ?? '' })}
        reason={wcFailureReason}
      />
    )
  }

  if (!codeQr || codeQr.length === 0) {
    return (
      <div className="qr-wrapper">
        <div className="qr-left">
          {!isMobile && <h3>{ui.orScanToConnect}</h3>}
          <span>
            {interpolateBeaconMessage(ui.preparingQrCode, {
              wallet: wallet?.name || ui.defaultWalletName
            })}
          </span>
        </div>
      </div>
    )
  }

  const isWalletConnectQr = codeQr.startsWith('wc:')

  return (
    <QR
      isWalletConnect={isWalletConnectQr}
      isMobile={isMobile}
      walletName={wallet?.name || 'AirGap'}
      code={codeQr}
    />
  )
}
