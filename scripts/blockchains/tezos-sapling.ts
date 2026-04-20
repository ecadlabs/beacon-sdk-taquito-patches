import { App, DesktopApp, ExtensionApp, WebApp } from 'packages/beacon-types/src/types/ui'
// import { NetworkType } from 'packages/beacon-types/src/types'
// TODO: Temporary build fix
export enum NetworkType {
  MAINNET = 'mainnet',
  /** @deprecated Ghostnet is succeeded by shadownet. */
  GHOSTNET = 'ghostnet',
  WEEKLYNET = 'weeklynet', // Testnet, resets every week
  DAILYNET = 'dailynet', // Testnet, resets every day
  /** @deprecated Seoulnet is succeeded by tallinnnet. */
  SEOULNET = 'seoulnet',
  SHADOWNET = 'shadownet',
  TALLINNNET = 'tallinnnet',
  TEZLINK_SHADOWNET = 'tezlink-shadownet',
  TEZOSX_PREVIEWNET = 'tezosx-previewnet',
  USHUAIANET = 'ushuaianet',
  CUSTOM = 'custom'
}

export const tezosSaplingExtensionList: ExtensionApp[] = []

export const tezosSaplingWebList: WebApp[] = []

export const tezosSaplingDesktopList: DesktopApp[] = []

export const tezosSaplingIosList: App[] = [
  {
    key: 'airgap_ios',
    name: 'AirGap Wallet',
    shortName: 'AirGap',
    color: 'rgb(4, 235, 204)',
    logo: 'ios-airgap.png',
    universalLink: 'https://wallet.airgap.it',
    deepLink: 'airgap-wallet://'
  }
]
