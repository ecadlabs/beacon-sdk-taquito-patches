import {
  WalletConnectPairingFailureReason,
  DisplayableWalletConnectFailureReason,
  WalletConnectErrorCopy,
  enMessages as rootEnMessages,
  getBeaconMessages,
  configureBeaconI18n,
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
  BeaconI18nConfig,
  BeaconResolvedDirection,
  BeaconTextDirection,
  BeaconLocaleMessages,
  BeaconTranslationOverrides
} from '@ecadlabs/beacon-types'

export {
  configureBeaconI18n,
  setBeaconLocale,
  getBeaconLocale,
  resolveBeaconLang,
  setBeaconDirection,
  getBeaconDirection,
  setBeaconTranslations,
  getBeaconTranslations,
  getBeaconMessages,
  interpolateBeaconMessage,
  resetBeaconI18n,
  subscribeBeaconI18n,
  builtInLocales
}

export type {
  DisplayableWalletConnectFailureReason,
  WalletConnectErrorCopy,
  BeaconI18nConfig,
  BeaconResolvedDirection,
  BeaconTextDirection,
  BeaconLocaleMessages,
  BeaconTranslationOverrides
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
