import {
  WalletConnectPairingFailureReason,
  DisplayableWalletConnectFailureReason,
  WalletConnectErrorCopy,
  enMessages as rootEnMessages,
  frMessages,
  esMessages,
  deMessages,
  jaMessages,
  arMessages,
  getBeaconMessages,
  getBeaconErrorCopy,
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
  interpolateBeaconMessage,
  resetBeaconI18n,
  subscribeBeaconI18n,
  builtInLocales,
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
} from '@ecadlabs/beacon-types'

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
  arMessages
}

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
}

export interface BeaconUIMessageCatalog {
  readonly walletConnectPairingErrors: Readonly<
    Record<DisplayableWalletConnectFailureReason, WalletConnectErrorCopy>
  >
}

export const enMessages: BeaconUIMessageCatalog = {
  walletConnectPairingErrors: rootEnMessages.ui.walletConnectErrors
}

export const getWalletConnectErrorCopy = (
  reason?: WalletConnectPairingFailureReason
): WalletConnectErrorCopy => {
  const key: DisplayableWalletConnectFailureReason =
    reason && reason !== 'superseded' ? reason : 'relay-unreachable'

  return getBeaconMessages().ui.walletConnectErrors[key]
}
