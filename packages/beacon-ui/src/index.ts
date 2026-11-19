export { openAlert, closeAlert, closeAlerts } from './ui/alert'
export type { AlertButton, AlertConfig, ToastAction } from './ui/common'

export {
  Pairing,
  setDesktopList,
  setExtensionList,
  setWebList,
  setiOSList,
  getDesktopList,
  getExtensionList,
  getWebList,
  getiOSList
} from './components/pairing'

export { closeToast, openToast } from './ui/toast'

export { getColorMode, setColorMode, subscribeColorMode } from './utils/colorMode'

export {
  isMobile,
  isMobileOS,
  isBrowser,
  isDesktop,
  isAndroid,
  isIOS,
  currentBrowser,
  currentOS
} from './utils/platform'

export {
  configureBeaconI18n,
  detectBrowserLocale,
  hasBuiltInLocale,
  normalizeLocaleTag,
  resolveBuiltInLocaleCatalog,
  setBeaconLocale,
  getBeaconLocale,
  resolveBeaconLang,
  setBeaconDirection,
  getBeaconDirection,
  setBeaconTranslations,
  getBeaconTranslations,
  getBeaconMessages,
  getBeaconErrorCopy,
  interpolateBeaconMessage,
  resetBeaconI18n,
  subscribeBeaconI18n,
  builtInLocales,
  frMessages,
  esMessages,
  deMessages,
  jaMessages,
  arMessages,
  plMessages
} from './i18n/messages'
export type {
  DisplayableWalletConnectFailureReason,
  WalletConnectErrorCopy,
  BeaconErrorCopy,
  BeaconI18nConfig,
  BeaconLocaleMetadata,
  BeaconLocaleStatus,
  BeaconResolvedDirection,
  BeaconTextDirection,
  BeaconLocaleMessages,
  BeaconTranslationOverrides,
  BeaconDAppMessages,
  BeaconUIMessages,
  BeaconAriaMessages,
  BeaconWalletTypeMessages,
  DeepPartial
} from './i18n/messages'
