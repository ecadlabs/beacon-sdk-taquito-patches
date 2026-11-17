import React from 'react'
import {
  getBeaconMessages,
  interpolateBeaconMessage,
  resolveBeaconLang
} from '@ecadlabs/beacon-types'
import { TopWalletsProps } from 'src/ui/common'
import { Wallet } from '../wallet'

interface IntlWithListFormat {
  ListFormat?: new (
    locales?: string | string[],
    options?: { style?: 'long' | 'short' | 'narrow'; type?: 'conjunction' | 'disjunction' | 'unit' }
  ) => { format: (list: string[]) => string }
}

const formatWalletDescriptions = (descriptions: string[]): string => {
  if (descriptions.length <= 1) {
    return descriptions[0] ?? ''
  }
  const lang = resolveBeaconLang()
  const intlWithListFormat = (typeof Intl !== 'undefined' ? Intl : undefined) as
    IntlWithListFormat | undefined
  if (!lang.toLowerCase().startsWith('en') && intlWithListFormat?.ListFormat) {
    try {
      return new intlWithListFormat.ListFormat(lang, {
        style: 'short',
        type: 'conjunction'
      }).format(descriptions)
    } catch {
      // Fall back to default joiner
    }
  }

  return descriptions.join(' & ')
}

const TopWallets: React.FC<TopWalletsProps> = (props: TopWalletsProps) => {
  const { ui, aria } = getBeaconMessages()

  return (
    <div className="top-wallets-wrapper">
      <div className="top-wallets-info">
        <h3>{ui.connectWallet}</h3>
      </div>
      <div
        style={props.wallets.length === 1 ? { gridTemplateColumns: '1fr' } : undefined}
        className="top-wallets-wallets-main"
      >
        {props.wallets.map((wallet) => (
          <Wallet
            key={wallet.id}
            disabled={props.disabled}
            mobile={props.isMobile}
            name={wallet.name}
            description={formatWalletDescriptions(wallet.descriptions)}
            image={wallet.image}
            onClick={() => props.onClickWallet(wallet.id)}
            tags={wallet.tags}
          />
        ))}
        {props.otherWallets && (
          <div className="top-wallets-other-wallets" onClick={props.otherWallets.onClick}>
            <div className="top-wallets-other-wallets-left">
              <h3>{ui.otherWallets}</h3>
              <p>{ui.otherWalletsDescription}</p>
            </div>
            <div className="top-wallets-other-wallets-right">
              <img
                src={props.otherWallets.images[0]}
                alt={interpolateBeaconMessage(aria.otherWalletLogoAlt, { index: 1 })}
              />
              <img
                className="top-wallets-other-wallets-center-wallet"
                src={props.otherWallets.images[1]}
                alt={interpolateBeaconMessage(aria.otherWalletLogoAlt, { index: 2 })}
              />
              <img
                src={props.otherWallets.images[2]}
                alt={interpolateBeaconMessage(aria.otherWalletLogoAlt, { index: 3 })}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export { TopWallets }
