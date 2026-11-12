import { BeaconErrorType, TezosRpcError } from '@ecadlabs/beacon-types'
import {
  BEACON_JSON_RPC_ERROR_CODES,
  parseJsonRpcErrorToBeaconError,
  serializeBeaconErrorToJsonRpcError
} from '../src/error-wire-mapping'

describe('BeaconErrorType WalletConnect JSON-RPC wire mapping', () => {
  const allErrorTypes = Object.values(BeaconErrorType)

  it('assigns a unique deterministic JSON-RPC error code to every BeaconErrorType', () => {
    const codes = allErrorTypes.map((errorType) => BEACON_JSON_RPC_ERROR_CODES[errorType])

    expect(codes.every((code) => typeof code === 'number' && Number.isInteger(code))).toBe(true)
    expect(new Set(codes).size).toBe(allErrorTypes.length)
  })

  it.each(allErrorTypes)('round-trips %s through JSON-RPC serialization and parsing', (errorType) => {
    const jsonRpcError = serializeBeaconErrorToJsonRpcError(errorType)
    expect(jsonRpcError.code).toBe(BEACON_JSON_RPC_ERROR_CODES[errorType])
    expect(typeof jsonRpcError.message).toBe('string')
    expect(jsonRpcError.message.length).toBeGreaterThan(0)

    const parsed = parseJsonRpcErrorToBeaconError(jsonRpcError)
    expect(parsed).toEqual({ errorType })
  })

  it('round-trips TRANSACTION_INVALID_ERROR with TezosRpcError[] errorData', () => {
    const rpcErrors: TezosRpcError[] = [
      {
        kind: 'temporary',
        id: 'proto.021-PsQuebec.contract.balance_too_low'
      },
      {
        kind: 'permanent',
        id: 'proto.021-PsQuebec.gas_exhausted.operation'
      }
    ]

    const jsonRpcError = serializeBeaconErrorToJsonRpcError(
      BeaconErrorType.TRANSACTION_INVALID_ERROR,
      rpcErrors
    )
    const parsed = parseJsonRpcErrorToBeaconError(jsonRpcError)

    expect(parsed).toEqual({
      errorType: BeaconErrorType.TRANSACTION_INVALID_ERROR,
      errorData: rpcErrors
    })
  })

  it('ignores malformed errorData entries when parsing JSON-RPC errors', () => {
    const jsonRpcError = serializeBeaconErrorToJsonRpcError(
      BeaconErrorType.TRANSACTION_INVALID_ERROR,
      [{ invalid: true }, 'not-an-error']
    )
    const parsed = parseJsonRpcErrorToBeaconError(jsonRpcError)

    expect(parsed).toEqual({
      errorType: BeaconErrorType.TRANSACTION_INVALID_ERROR
    })
  })

  it('preserves BeaconErrorType by code even when data is stripped by a relay or wallet', () => {
    const jsonRpcError = serializeBeaconErrorToJsonRpcError(BeaconErrorType.NETWORK_NOT_SUPPORTED)
    const stripped = { code: jsonRpcError.code, message: jsonRpcError.message }

    expect(parseJsonRpcErrorToBeaconError(stripped)).toEqual({
      errorType: BeaconErrorType.NETWORK_NOT_SUPPORTED
    })
  })

  it.each([
    ['EIP-1193 user rejection 4001', { code: 4001, message: 'User rejected' }],
    ['WalletConnect USER_REJECTED 5000', { code: 5000, message: 'User rejected.' }],
    ['unrecognized JSON-RPC error -32603', { code: -32603, message: 'Internal error' }]
  ])('falls back to ABORTED_ERROR for legacy wallet error: %s', (_label, walletError) => {
    expect(parseJsonRpcErrorToBeaconError(walletError)).toEqual({
      errorType: BeaconErrorType.ABORTED_ERROR
    })
  })
})
