import React from 'react'
import { WalletsProps } from 'src/ui/common'
import { Wallet } from '../wallet'

const Wallets: React.FC<WalletsProps> = (props: WalletsProps) => (
  <div className="wallets-list-main-wrapper">
    <div className="wallets-list-wrapper">
      {props.wallets.map((wallet) => (
        <Wallet
          key={wallet.id}
          disabled={props.disabled}
          name={wallet.name}
          description={wallet.descriptions.join(' & ')}
          image={wallet.image}
          small={props.small}
          onClick={() => props.onClickWallet(wallet.id)}
        />
      ))}
    </div>
    <button className="wallets-button" onClick={props.onClickOther}>
      {props.isMobile ? 'Pair wallet on another device' : 'Show QR code'}
    </button>
  </div>
)

export { Wallets }
