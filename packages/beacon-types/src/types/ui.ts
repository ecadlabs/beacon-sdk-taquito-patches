import { NetworkType } from './beacon/NetworkType'

export interface AppBase {
  key: string
  name: string
  shortName: string
  color: string
  logo: string
  supportedInteractionStandards?: ('wallet_connect' | 'beacon')[] // 'wallet_connect' or 'beacon'
}

export interface ExtensionApp extends AppBase {
  id: string
  link: string
}

export interface WebApp extends AppBase {
  links: {
    [NetworkType.MAINNET]: string
    [NetworkType.GHOSTNET]?: string
    [NetworkType.WEEKLYNET]?: string
    [NetworkType.DAILYNET]?: string
    [NetworkType.SEOULNET]?: string
    [NetworkType.SHADOWNET]?: string
    [NetworkType.TALLINNNET]?: string
    [NetworkType.TEZLINK_SHADOWNET]?: string
    [NetworkType.TEZOSX_PREVIEWNET]?: string
    [NetworkType.USHUAIANET]?: string
    [NetworkType.CUSTOM]?: string
  }
}

export interface DesktopApp extends AppBase {
  deepLink: string
  downloadLink: string
}

export interface App extends AppBase {
  universalLink: string
  deepLink?: string
}
