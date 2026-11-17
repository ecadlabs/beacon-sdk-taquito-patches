import React, { useState, useEffect } from 'react'
import { getBeaconMessages, interpolateBeaconMessage } from '@ecadlabs/beacon-types'
import { CloseIcon } from '../icons'
import { Loader } from '../loader'
import { isMobileOS } from '../../utils/platform'
import { ToastProps } from '../../ui/common'
import { runUICallback } from '../../utils/callback'
import { ButtonIcon } from '../button-icon/button-icon'
import { useDrag } from './hooks/useDrag'

function parseWallet(
  inputString: string,
  walletInfo: {
    deeplink?: string
    icon?: string
    name: string
    type?: string
  }
) {
  const { aria } = getBeaconMessages()
  const regex = /({{\s*wallet\s*}})/g
  const parts = inputString.split(regex)

  return parts.map((part, index) => {
    if (part.match(regex)) {
      return (
        <span key={index} className="toast-wallet-inline">
          {walletInfo.icon && (
            <img
              draggable={false}
              src={walletInfo.icon}
              alt={interpolateBeaconMessage(aria.walletIconAlt, { wallet: walletInfo.name })}
            />
          )}
          <h3>
            <bdi>{walletInfo.name}</bdi>
          </h3>
        </span>
      )
    } else if (part.length > 0) {
      return (
        <p key={index} className="toast-label">
          {part}
        </p>
      )
    }

    return null
  })
}

export const Toast: React.FC<ToastProps> = (props: ToastProps) => {
  const { ui, dapp, aria } = getBeaconMessages()
  const [showMoreInfo, setShowMoreInfo] = useState<boolean>(true)
  const hasWalletObject = /\{\{\s*wallet\s*\}\}/.test(props.label) && Boolean(props.walletInfo)
  const localizedSentPrefix = dapp.requestSent.replace(/\{\{\s*wallet\s*\}\}/g, '').trim()
  const isRequestSentToast =
    props.state === 'loading' ||
    props.label.includes('Request sent to') ||
    (localizedSentPrefix.length > 0 && props.label.includes(localizedSentPrefix))

  // Track the toast position (x, y)
  const [[x, y], setPosition] = useState<[number, number]>([0, 0])
  // Track if the entrance animation (toastIn) has ended
  const [animationEnded, setAnimationEnded] = useState(false)

  const bindDrag = useDrag(({ offset: [mx, my] }) => {
    setPosition([mx, my])
  }, props.open)

  const isMobile = isMobileOS(window)

  useEffect(() => {
    if (!isRequestSentToast) {
      setShowMoreInfo(true)

      return
    }
    setShowMoreInfo(false)
    const timer = setTimeout(() => {
      setShowMoreInfo(true)
    }, 3000)

    return () => clearTimeout(timer)
  }, [isRequestSentToast])

  // Reset the animation and drag state when the toast opens or closes
  useEffect(() => {
    setPosition([0, 0])
    if (props.open) {
      setAnimationEnded(false)
    }
  }, [props.open])

  // When an animation ends, only update state if the toast is open (i.e. toastIn just finished)
  const handleAnimationEnd = () => {
    if (props.open) {
      setAnimationEnded(true)
    }
  }

  const resolvedAnnouncement = [
    hasWalletObject && props.walletInfo
      ? props.label.replace(/\{\{\s*wallet\s*\}\}/g, props.walletInfo.name)
      : props.label,
    ...(props.actions && showMoreInfo ? props.actions.map((a) => a.text) : [])
  ]
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
    .join('. ')

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={resolvedAnnouncement}
      onAnimationEnd={handleAnimationEnd}
      style={{
        transform: `translate3d(${x}px, ${y}px, 0)`,
        touchAction: 'none',
        // If the toast is open and the entrance animation is complete, remove inline animation
        // so that drag transforms take effect. Otherwise (e.g. toast is closing) let CSS handle it.
        animation: props.open && animationEnded ? 'none' : undefined
      }}
      className={props.open ? 'toast-wrapper-show' : 'toast-wrapper-hide'}
      {...(isMobile ? undefined : bindDrag())}
    >
      <div className="toast-header">
        <Loader />
        {hasWalletObject && props.walletInfo ? (
          <div className="toast-content">{parseWallet(props.label, props.walletInfo)}</div>
        ) : (
          <p className="toast-label toast-content">{props.label}</p>
        )}

        {!isMobileOS(window) && props.openWalletAction && (
          <div
            className="toast-action-button"
            role="button"
            tabIndex={0}
            onClick={() =>
              runUICallback(() => props.openWalletAction?.(), 'Toast', 'openWalletAction')
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                runUICallback(() => props.openWalletAction?.(), 'Toast', 'openWalletAction')
              }
            }}
          >
            {ui.openWallet}
          </div>
        )}

        <ButtonIcon ariaLabel={aria.closeToast} onClick={props.onClickClose}>
          <CloseIcon />
        </ButtonIcon>
      </div>

      {props.actions && showMoreInfo && (
        <div className="toast-body">
          {props.actions.map((action, index) => (
            <div key={index} className="toast-action-wrapper">
              <p className={`toast-action-label ${action.isBold ? 'toast-action-bold' : ''}`}>
                {action.text}
              </p>
              {action.actionText && (
                <div
                  className="toast-action-button"
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    runUICallback(() => action.actionCallback?.(), 'Toast', 'actionCallback')
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      runUICallback(() => action.actionCallback?.(), 'Toast', 'actionCallback')
                    }
                  }}
                >
                  {action.actionText}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
