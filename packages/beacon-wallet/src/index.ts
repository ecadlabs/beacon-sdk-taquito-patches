export * from '@ecadlabs/beacon-core'
export * from '@ecadlabs/beacon-transport-matrix'
export * from '@ecadlabs/beacon-types'
export * from '@ecadlabs/beacon-utils'

import { WalletClient } from './client/WalletClient'
import { WalletClientOptions } from './client/WalletClientOptions'
import {
  WalletWalletConnectTransport,
  type WalletConnectAccountEntry
} from './transports/WalletWalletConnectTransport'

export { WalletClient, WalletClientOptions, WalletWalletConnectTransport, type WalletConnectAccountEntry }
export { createErrorResponseInput } from './interceptors/createErrorResponseInput'
export {
  buildPermissionResponse,
  buildOperationResponse,
  buildSignPayloadResponse,
  buildBroadcastResponse,
  buildErrorResponse,
  type BasePermissionResponseBuilderOptions,
  type PermissionResponseBuilderOptions,
  type ImplicitPermissionResponseBuilderOptions,
  type AbstractedPermissionResponseBuilderOptions
} from './interceptors/buildResponseInput'
export { isBeaconMessageType, isV3Envelope } from './utils/message-guards'

export type { WalletRequestOutputMessage } from './types/WalletRequestOutputMessage'

export type {
  WalletResponseInputMessage,
  WalletResponseOutputMessage
} from './types/WalletResponseMessage'
