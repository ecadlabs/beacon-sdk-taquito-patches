import { QRCodeProps } from '../../../../../common'
import QR from '../../../../../../components/qr'
import WCInitError from '../wc-init-error'
import { useEffect, useState } from 'react'

const QRCode: React.FC<QRCodeProps> = ({
  wallet,
  isWCWorking,
  isMobile,
  qrCode,
  defaultPairing,
  handleUpdateState,
  handleIsLoading
}) => {
  const [codeQr, setCodeQr] = useState(qrCode)
  const supportsWalletConnect = wallet?.supportedInteractionStandards?.includes('wallet_connect')
  const isConnected =
    !supportsWalletConnect || isWCWorking

  useEffect(() => {
    if (qrCode) {
      setCodeQr(qrCode)
    }
  }, [qrCode])

  useEffect(() => {
    let isMounted = true

    const pair = async () => {
      if (codeQr || supportsWalletConnect) {
        return
      }

      try {
        const pairing = await defaultPairing
        if (isMounted) {
          setCodeQr(pairing)
          handleIsLoading(false)
        }
      } catch {
        if (isMounted) {
          handleIsLoading(false)
        }
      }
    }

    void pair()

    return () => {
      isMounted = false
    }
  }, [codeQr, defaultPairing, handleIsLoading, supportsWalletConnect])

  if (!isConnected) {
    return (
      <WCInitError
        title={`Connect with ${wallet?.name} Mobile`}
        handleUpdateState={handleUpdateState}
      />
    )
  }

  if (!codeQr || codeQr.length === 0) {
    return (
      <div className="qr-wrapper">
        <div className="qr-left">
          {!isMobile && <h3>Or scan to connect</h3>}
          <span>{`Preparing ${wallet?.name || 'wallet'} QR code...`}</span>
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
      onClickLearnMore={() => {}}
      onClickQrCode={() => {}}
    />
  )
}

export default QRCode
