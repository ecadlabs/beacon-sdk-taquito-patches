import { reportDiagnostic } from '@ecadlabs/beacon-core'
import React, { useState, useLayoutEffect, useRef } from 'react'
import { QR } from '../qr'

import { PairOtherProps } from '../../ui/common'

export const PairOther: React.FC<PairOtherProps> = (props: PairOtherProps) => {
  const { p2pPayload, wcPayload } = props
  const [availability, setAvailability] = useState({
    p2pPayload,
    wcPayload,
    beacon: false,
    walletConnect: false
  })
  const [selection, setSelection] = useState<{
    p2pPayload: PairOtherProps['p2pPayload']
    wcPayload: PairOtherProps['wcPayload']
    kind: 'p2p' | 'walletconnect'
    code: string
  }>()
  const clickGeneration = useRef(0)

  useLayoutEffect(() => {
    let current = true
    clickGeneration.current += 1
    setAvailability({ p2pPayload, wcPayload, beacon: false, walletConnect: false })
    setSelection(undefined)
    const updateBeacon = (beacon: boolean) => {
      if (current) {
        setAvailability((previous) => ({ ...previous, beacon }))
      }
    }
    const updateWalletConnect = (walletConnect: boolean) => {
      if (current) {
        setAvailability((previous) => ({ ...previous, walletConnect }))
      }
    }
    p2pPayload.then(
      (payload) => updateBeacon(Boolean(payload.length)),
      () => updateBeacon(false)
    )
    Promise.resolve(wcPayload).then(
      (payload) => updateWalletConnect(Boolean(payload.length)),
      () => updateWalletConnect(false)
    )

    return () => {
      current = false
      clickGeneration.current += 1
    }
  }, [p2pPayload, wcPayload])

  const hasCurrentSources =
    availability.p2pPayload === p2pPayload && availability.wcPayload === wcPayload
  const hasBeacon = hasCurrentSources && availability.beacon
  const hasWalletConnect = hasCurrentSources && availability.walletConnect
  const currentSelection =
    selection?.p2pPayload === p2pPayload && selection?.wcPayload === wcPayload
      ? selection
      : undefined
  const uiState = currentSelection?.kind ?? 'selection'
  const qrData = currentSelection?.code ?? ''

  const buttonClickHandler = async (kind: 'p2p' | 'walletconnect') => {
    const generation = ++clickGeneration.current
    try {
      const code = await (kind === 'p2p' ? p2pPayload : wcPayload)
      if (generation === clickGeneration.current) {
        setSelection({ p2pPayload, wcPayload, kind, code })
      }
    } catch (error: unknown) {
      if (generation === clickGeneration.current) {
        reportDiagnostic({
          level: 'error',
          service: 'PairOther',
          method: 'selectQR',
          args: [error]
        })
      }
    }
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
