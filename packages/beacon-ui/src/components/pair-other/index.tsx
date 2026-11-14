import React, { useState, useEffect } from 'react'
import QR from '../qr'

import { PairOtherProps } from '../../ui/common'

export const PairOther: React.FC<PairOtherProps> = (props: PairOtherProps) => {
  const [uiState, setUiState] = useState<'selection' | 'p2p' | 'walletconnect'>('selection')
  const [hasBeacon, setHasBeacon] = useState<boolean>(false)
  const [hasWalletConnect, setHasWalletConnect] = useState<boolean>(false)
  const [qrData, setQrData] = useState<string>('')

  useEffect(() => {
    props.p2pPayload
      .then((p2p) => setHasBeacon(p2p && p2p.length > 0 ? true : false))
      .catch(() => setHasBeacon(false))
    Promise.resolve(props.wcPayload)
      .then((wc) => setHasWalletConnect(wc && wc.length > 0 ? true : false))
      .catch(() => setHasWalletConnect(false))
    setUiState('selection')
    setQrData('')
  }, [])

  const buttonClickHandler = async (state: 'p2p' | 'walletconnect') => {
    const payload = state === 'p2p' ? await props.p2pPayload : await props.wcPayload
    setQrData(payload)
    setUiState(state)
  }

  return (
    <>
      {uiState === 'selection' && (
        <div>
          <span className="pair-other-info">Select QR Type</span>
          <br />
          {hasBeacon && (
            <button className="wallets-button" onClick={() => buttonClickHandler('p2p')}>
              Beacon
            </button>
          )}
          {hasWalletConnect && (
            <button className="wallets-button" onClick={() => buttonClickHandler('walletconnect')}>
              WalletConnect
            </button>
          )}
        </div>
      )}
      {uiState !== 'selection' && qrData && (
        <QR
          isWalletConnect={uiState === 'walletconnect'}
          isMobile={true}
          walletName={'AirGap'}
          code={qrData}
          onClickLearnMore={props.onClickLearnMore}
        />
      )}
      {uiState !== 'selection' && !qrData && (
        <span style={{ color: '#FF4136' }} className="pair-other-info">
          Not connected.
        </span>
      )}
    </>
  )
}
