export * from '@ecadlabs/beacon-core'
export * from '@ecadlabs/beacon-transport-matrix'
export * from '@ecadlabs/beacon-types'
export * from '@ecadlabs/beacon-utils'

import { WalletClient } from './client/WalletClient'
import { WalletClientOptions } from './client/WalletClientOptions'

export { WalletClient, WalletClientOptions }
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

export type { WalletRequestOutputMessage } from './types/WalletRequestOutputMessage'

export type {
  WalletResponseInputMessage,
  WalletResponseOutputMessage
} from './types/WalletResponseMessage'
