import SignClient from '@walletconnect/sign-client'
import { SignClientTypes } from '@walletconnect/types'

export { WalletConnectTransport } from './WalletConnectTransport'
export { WalletConnectCommunicationClient } from './communication-client/WalletConnectCommunicationClient'
export {
  BEACON_JSON_RPC_ERROR_CODES,
  serializeBeaconErrorToJsonRpcError,
  parseJsonRpcErrorToBeaconError,
  type BeaconJsonRpcError,
  type BeaconJsonRpcErrorData,
  type ParsedBeaconJsonRpcError
} from './error-wire-mapping'

export const initWalletConnectSignClient = (options: SignClientTypes.Options) =>
  SignClient.init(options)
