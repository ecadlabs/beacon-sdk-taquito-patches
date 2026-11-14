import { DesktopApp, App, ExtensionApp, WebApp } from '@ecadlabs/beacon-types'
import { desktopList, extensionList, iOSList, webList } from '../ui/alert/wallet-lists'

/**
 * Initialize with tezos wallets for backwards compatibility
 */
let localDesktopList: DesktopApp[] = desktopList
let localExtensionList: ExtensionApp[] = extensionList
let localWebList: WebApp[] = webList
let localiOSList: App[] = iOSList

export const getDesktopList = (): DesktopApp[] => localDesktopList

export const setDesktopList = (wallets: DesktopApp[]): void => {
  localDesktopList = wallets
}

export const getExtensionList = (): ExtensionApp[] => localExtensionList

export const setExtensionList = (wallets: ExtensionApp[]): void => {
  localExtensionList = wallets
}

export const getWebList = (): WebApp[] => localWebList

export const setWebList = (wallets: WebApp[]): void => {
  localWebList = wallets
}

export const getiOSList = (): App[] => localiOSList

export const setiOSList = (iosList: App[]): void => {
  localiOSList = iosList
}

export enum Platform {
  DESKTOP,
  IOS,
  ANDROID
}

export enum WalletType {
  IOS = 'ios',
  ANDROID = 'android',
  EXTENSION = 'extension',
  DESKTOP = 'desktop',
  WEB = 'web'
}

export interface PairingAlertWallet {
  key: string
  name: string
  shortName?: string
  color?: string
  logo?: string
  enabled: boolean
  clickHandler(): void
}

export interface PairingAlertButton {
  title: string
  text: string
  clickHandler(): void
}

export interface PairingAlertList {
  title: string
  type: WalletType
  wallets: PairingAlertWallet[]
}

export interface PairingAlertInfo {
  walletLists: PairingAlertList[]
  buttons: PairingAlertButton[]
}

export type StatusUpdateHandler = (
  walletType: WalletType,
  app?: PairingAlertWallet,
  keepOpen?: boolean
) => void

/**
 * @internalapi
 *
 */
export class Pairing {}
