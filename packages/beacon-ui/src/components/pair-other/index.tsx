import { reportDiagnostic } from '@ecadlabs/beacon-core'
import { WalletConnectPairingFailureReason } from '@ecadlabs/beacon-types'
import React, { useState, useLayoutEffect, useRef } from 'react'
import { QR } from '../qr'
import { WCInitError } from '../../ui/alert/components/pairing-alert/components/wc-init-error'

import { PairOtherProps, WalletConnectSyncCode } from '../../ui/common'
import { unwrapWalletConnectResult } from '../../utils/walletconnect'

interface PairOtherSelection {
  payload: PairOtherProps['p2pPayload'] | PairOtherProps['wcPayload']
  kind: 'p2p' | 'walletconnect'
  code: string
  failureReason?: WalletConnectPairingFailureReason
}

const isWalletConnectOptionAvailable = (payload: WalletConnectSyncCode): boolean => {
  const result = unwrapWalletConnectResult(payload)

  return (
    (result.ok && Boolean(result.uri.length)) ||
    (typeof payload !== 'string' && !result.ok && result.reason !== 'superseded')
  )
}

const isSelectionCurrent = (
  selection: PairOtherSelection | undefined,
  p2pPayload: PairOtherProps['p2pPayload'],
  wcPayload: PairOtherProps['wcPayload']
): selection is PairOtherSelection =>
  Boolean(selection && selection.payload === (selection.kind === 'p2p' ? p2pPayload : wcPayload))

export const PairOther: React.FC<PairOtherProps> = (props: PairOtherProps) => {
  const { p2pPayload, wcPayload } = props
  const [beaconAvailability, setBeaconAvailability] = useState({
    payload: p2pPayload,
    available: false
  })
  const [wcAvailability, setWcAvailability] = useState({
    payload: wcPayload,
    available: false
  })
  const [selection, setSelection] = useState<PairOtherSelection>()
  const clickGeneration = useRef(0)
  const latestPayloads = useRef({ p2pPayload, wcPayload })
  const mounted = useRef(true)

  useLayoutEffect(() => {
    latestPayloads.current = { p2pPayload, wcPayload }
  }, [p2pPayload, wcPayload])

  useLayoutEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
      clickGeneration.current += 1
    }
  }, [])

  useLayoutEffect(() => {
    let current = true
    setBeaconAvailability({ payload: p2pPayload, available: false })
    setSelection((prev) => (prev?.kind === 'p2p' && prev.payload !== p2pPayload ? undefined : prev))
    p2pPayload.then(
      (payload) => {
        if (current) {
          setBeaconAvailability({ payload: p2pPayload, available: Boolean(payload.length) })
        }
      },
      () => {
        if (current) {
          setBeaconAvailability({ payload: p2pPayload, available: false })
        }
      }
    )

    return () => {
      current = false
    }
  }, [p2pPayload])

  useLayoutEffect(() => {
    let current = true
    setWcAvailability({ payload: wcPayload, available: false })
    setSelection((prev) =>
      prev?.kind === 'walletconnect' && prev.payload !== wcPayload ? undefined : prev
    )
    Promise.resolve(wcPayload).then(
      (payload) => {
        if (current) {
          setWcAvailability({
            payload: wcPayload,
            available: isWalletConnectOptionAvailable(payload)
          })
        }
      },
      () => {
        if (current) {
          setWcAvailability({ payload: wcPayload, available: false })
        }
      }
    )

    return () => {
      current = false
    }
  }, [wcPayload])

  const hasBeacon = beaconAvailability.payload === p2pPayload && beaconAvailability.available
  const hasWalletConnect = wcAvailability.payload === wcPayload && wcAvailability.available
  const currentSelection = isSelectionCurrent(selection, p2pPayload, wcPayload)
    ? selection
    : undefined

  const buttonClickHandler = async (kind: 'p2p' | 'walletconnect') => {
    const generation = ++clickGeneration.current
    const targetPayload = kind === 'p2p' ? p2pPayload : wcPayload
    const isStillCurrent = () =>
      mounted.current &&
      generation === clickGeneration.current &&
      (kind === 'p2p'
        ? latestPayloads.current.p2pPayload === targetPayload
        : latestPayloads.current.wcPayload === targetPayload)
    try {
      let code: string
      let failureReason: WalletConnectPairingFailureReason | undefined
      if (kind === 'p2p') {
        code = await p2pPayload
      } else {
        const result = unwrapWalletConnectResult(await wcPayload)
        code = result.ok ? result.uri : ''
        failureReason = result.ok ? undefined : result.reason
      }
      if (isStillCurrent()) {
        setSelection({ payload: targetPayload, kind, code, failureReason })
      }
    } catch (error: unknown) {
      if (isStillCurrent()) {
        reportDiagnostic({
          level: 'error',
          service: 'PairOther',
          method: 'selectQR',
          args: [error]
        })
      }
    }
  }

  if (!currentSelection) {
    return (
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
    )
  }

  if (currentSelection.code) {
    return (
      <QR
        isWalletConnect={currentSelection.kind === 'walletconnect'}
        isMobile={true}
        walletName={'AirGap'}
        code={currentSelection.code}
        onClickLearnMore={props.onClickLearnMore}
      />
    )
  }

  if (currentSelection.failureReason) {
    return <WCInitError title="Scan QR code" reason={currentSelection.failureReason} />
  }

  return (
    <span style={{ color: '#FF4136' }} className="pair-other-info">
      Not connected.
    </span>
  )
}
