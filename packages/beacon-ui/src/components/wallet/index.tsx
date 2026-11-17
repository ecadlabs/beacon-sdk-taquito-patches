import React from 'react'
import { getBeaconMessages, interpolateBeaconMessage } from '@ecadlabs/beacon-types'
import { WalletProps } from 'src/ui/common'

const Wallet: React.FC<WalletProps> = (props: WalletProps) => {
  const { aria } = getBeaconMessages()
  const logoAlt = interpolateBeaconMessage(aria.walletLogoAlt, { wallet: props.name })
  const tileLabel = [props.name, props.description, ...(props.tags ?? [])]
    .filter((segment): segment is string => Boolean(segment && segment.length > 0))
    .join(', ')
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (props.disabled) {
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      props.onClick()
    }
  }

  return (
    <div
      style={{ pointerEvents: props.disabled ? 'none' : 'auto' }}
      className={props.disabled ? 'wallet-disabled' : ''}
    >
      {!props.small && (
        <div
          className={`wallet-main ${props.mobile ? 'wallet-main-mobile' : ''}`}
          role="button"
          tabIndex={props.disabled ? -1 : 0}
          aria-label={tileLabel}
          aria-disabled={props.disabled ? 'true' : undefined}
          onClick={props.disabled ? undefined : props.onClick}
          onKeyDown={handleKeyDown}
        >
          <div className={`wallet-main-left ${props.mobile ? 'wallet-main-left-mobile' : ''}`}>
            <h3>{props.name}</h3>
            {props.description && <p>{props.description}</p>}
            {props.tags && props.tags.length > 0 && (
              <div className="wallet-main-tags">
                {props.tags.map((tag, index) => (
                  <span key={index} className="wallet-main-tag">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="wallet-main-right">
            <img src={props.image} alt={logoAlt} />
          </div>
        </div>
      )}
      {props.small && (
        <div
          className="wallet-small"
          role="button"
          tabIndex={props.disabled ? -1 : 0}
          aria-label={props.name}
          aria-disabled={props.disabled ? 'true' : undefined}
          onClick={props.disabled ? undefined : props.onClick}
          onKeyDown={handleKeyDown}
        >
          <img src={props.image} alt={logoAlt} />
          <h3>{props.name}</h3>
        </div>
      )}
    </div>
  )
}

export { Wallet }
