export * from '@ecadlabs/beacon-core'
export * from '@ecadlabs/beacon-transport-matrix'
export * from '@ecadlabs/beacon-transport-postmessage'
export * from '@ecadlabs/beacon-types'
export * from '@ecadlabs/beacon-utils'
export * from '@ecadlabs/beacon-ui'

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
  type InvalidAccountDeactivatedEvent,
  type InvalidAccountDeactivatedReason
} from './events'
import { BlockExplorer } from './utils/block-explorer'
import { TzktBlockExplorer } from './utils/tzkt-blockexplorer'
import { getDAppClientInstance } from './utils/get-instance'

export { DAppClient, DAppClientOptions, getDAppClientInstance }
export type { DAppClientDisconnectOptions, DAppClientRemoveAllPeersOptions }

// Events
export { BeaconEvent, BeaconEventHandler, defaultEventCallbacks }
export type {
  BeaconEventType,
  RequestSentInfo,
  RequestResponseInfo,
  AcknowledgeInfo,
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
  V3ResponsePayload,
  WireErrorMessage,
  WireErrorPayload
} from './dapp-client/request-error'

// BlockExplorer
export { BlockExplorer, TzktBlockExplorer, TzktBlockExplorer as TezblockBlockExplorer }
