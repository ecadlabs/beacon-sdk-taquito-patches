import React from 'react'
import { getBeaconMessages, resolveBeaconLang } from '@ecadlabs/beacon-types'
import { WalletsProps } from 'src/ui/common'
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

const Wallets: React.FC<WalletsProps> = (props: WalletsProps) => {
  const { ui } = getBeaconMessages()

  return (
    <div className="wallets-list-main-wrapper">
      <div className="wallets-list-wrapper">
        {props.wallets.map((wallet) => (
          <Wallet
            key={wallet.id}
            disabled={props.disabled}
            name={wallet.name}
            description={formatWalletDescriptions(wallet.descriptions)}
            image={wallet.image}
            small={props.small}
            onClick={() => props.onClickWallet(wallet.id)}
          />
        ))}
      </div>
      <button type="button" className="wallets-button" onClick={props.onClickOther}>
        {props.isMobile ? ui.pairWalletOnAnotherDevice : ui.showQrCode}
      </button>
    </div>
  )
}

export { Wallets }
