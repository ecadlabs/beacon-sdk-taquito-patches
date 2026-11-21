export * from '@ecadlabs/beacon-core'
export * from '@ecadlabs/beacon-transport-matrix'
export * from '@ecadlabs/beacon-transport-postmessage'
export * from '@ecadlabs/beacon-types'
export * from '@ecadlabs/beacon-utils'
export * from '@ecadlabs/beacon-ui'

export {
  activateBeaconClientI18n,
  arMessages,
  builtInLocales,
  configureBeaconI18n,
  deMessages,
  detectBrowserLocale,
  enMessages,
  esMessages,
  frMessages,
  getBeaconDirection,
  getBeaconErrorCopy,
  getBeaconLocale,
  getBeaconMessages,
  getBeaconTranslations,
  hasBuiltInLocale,
  interpolateBeaconMessage,
  jaMessages,
  normalizeLocaleTag,
  plMessages,
  registerBeaconClientI18n,
  resetBeaconI18n,
  resolveBeaconLang,
  resolveBuiltInLocaleCatalog,
  setBeaconDirection,
  setBeaconLocale,
  setBeaconTranslations,
  subscribeBeaconI18n,
  unregisterBeaconClientI18n,
  type BeaconAriaMessages,
  type BeaconDAppMessages,
  type BeaconErrorCopy,
  type BeaconI18nConfig,
  type BeaconLocaleMessages,
  type BeaconLocaleMetadata,
  type BeaconLocaleStatus,
  type BeaconResolvedDirection,
  type BeaconTextDirection,
  type BeaconTranslationOverrides,
  type BeaconUIMessages,
  type BeaconWalletTypeMessages,
  type DeepPartial,
  type DisplayableWalletConnectFailureReason,
  type WalletConnectErrorCopy
} from '@ecadlabs/beacon-types'

import type { ConnectionInfo, PendingRequestInfo } from '@ecadlabs/beacon-types'
import {
  DAppClient,
  type DAppClientDisconnectOptions,
  type DAppClientRemoveAllPeersOptions
} from './dapp-client/DAppClient'
import { DAppClientOptions } from './dapp-client/DAppClientOptions'
import {
  BeaconEvent,
  BeaconEventHandler,
  defaultEventCallbacks,
  type BeaconEventType,
  type RequestSentInfo,
  type RequestResponseInfo,
  type AcknowledgeInfo,
  type ActiveTransportInfo,
  type TransportStatusChangedInfo,
  type WaitingForWalletAckInfo,
  type InvalidAccountDeactivatedEvent,
  type InvalidAccountDeactivatedReason
} from './events'
import { BlockExplorer } from './utils/block-explorer'
import { TzktBlockExplorer } from './utils/tzkt-blockexplorer'
import { getDAppClientInstance } from './utils/get-instance'

export { DAppClient, DAppClientOptions, getDAppClientInstance }
export type {
  DAppClientDisconnectOptions,
  DAppClientRemoveAllPeersOptions,
  ConnectionInfo,
  PendingRequestInfo
}

// Events
export { BeaconEvent, BeaconEventHandler, defaultEventCallbacks }
export type {
  BeaconEventType,
  RequestSentInfo,
  RequestResponseInfo,
  AcknowledgeInfo,
  ActiveTransportInfo,
  TransportStatusChangedInfo,
  WaitingForWalletAckInfo,
  InvalidAccountDeactivatedEvent,
  InvalidAccountDeactivatedReason
}
export type {
  ErrorOrigin,
  LateErrorResponseInfo,
  LateResponseInfo,
  LateSuccessResponseInfo,
  RequestErrorResponse,
  ResponseMessage,
  ResponseOutput,
  TezosRpcError,
  V3ResponsePayload,
  WireErrorMessage,
  WireErrorPayload,
  WireRequestErrorResponse
} from './dapp-client/request-error'
export {
  isBeaconError,
  isErrorOrigin,
  isErrorResponse,
  isRequestErrorResponse,
  isTezosRpcError,
  toBeaconError
} from './dapp-client/request-error'

// BlockExplorer
export { BlockExplorer, TzktBlockExplorer, TzktBlockExplorer as TezblockBlockExplorer }

export type { BeaconMessageDisposition, BeaconMessageRecord } from './dapp-client/message-observer'
