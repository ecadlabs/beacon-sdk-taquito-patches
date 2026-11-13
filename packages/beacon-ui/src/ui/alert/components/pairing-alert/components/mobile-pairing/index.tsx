import type { FC } from 'react'
import type { MergedWallet } from '../../../../../../utils/wallets'
import Info from '../../../../../../components/info'
import { AlertState, type ConfigurableAlertProps, type PairingPayload } from '../../../../../common'
import { isIOS } from '../../../../../../utils/platform'
import { suffixMap } from './utils/suffix-map'

interface MobilePairingProps {
  wallet: MergedWallet
  handleUpdateState: (state: AlertState) => void
  handleDeepLinking: (wallet: MergedWallet) => Promise<void>
  wcPayload: PairingPayload['walletConnectSyncCode']
  p2pPayload: PairingPayload['p2pSyncCode']
  handleUpdateQRCode: (code: string) => void
  handleDisplayQRExtra: (display: boolean) => void
  onClose: ConfigurableAlertProps['onClose']
}

const MobilePairing: FC<MobilePairingProps> = ({
  wallet,
  handleUpdateState,
  handleDeepLinking,
  wcPayload,
  p2pPayload,
  handleUpdateQRCode,
  handleDisplayQRExtra,
  onClose
}) => {
  return (
    <Info
      border
      title={`Connect with ${wallet?.name} ${suffixMap.get(wallet?.id) ?? ''}`}
      description={''}
      buttons={[
        {
          label: 'Use App',
          type: 'primary',
          onClick: () => {
            if (!wallet) {
              console.error('No wallet found.')
              return
            }

            handleDeepLinking(wallet)
          }
        }
      ]}
      downloadLink={
        wallet?.name.toLowerCase().includes('kukai') && isIOS(window)
          ? {
              label: 'Get Kukai Mobile >',
              url: 'https://ios.kukai.app'
            }
          : undefined
      }
      onShowQRCodeClick={async () => {
        const syncCode = await (wallet?.supportedInteractionStandards?.includes('wallet_connect')
          ? wcPayload
          : p2pPayload)

        if (!syncCode.length) {
          onClose()
          return
        }

        handleUpdateQRCode(syncCode)
        handleUpdateState(AlertState.QR)
        handleDisplayQRExtra(true)
      }}
    />
  )
}

export default MobilePairing
