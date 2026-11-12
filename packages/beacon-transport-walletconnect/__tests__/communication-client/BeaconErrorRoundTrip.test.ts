import { Serializer } from '@ecadlabs/beacon-core'
import {
  BeaconErrorType,
  BeaconMessageType,
  ErrorResponse,
  NetworkType,
  SigningType,
  TezosRpcError
} from '@ecadlabs/beacon-types'
import { WalletConnectCommunicationClient } from '../../src/communication-client/WalletConnectCommunicationClient'
import { serializeBeaconErrorToJsonRpcError } from '../../src/error-wire-mapping'

import {
  mockRemote,
  mockRequests,
  resetWire,
  restoreSession,
  holdPings,
  flush,
  installLocalChannel
} from '../helpers/controlled-sign-client'

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  ...(await vi.importActual<
    typeof import('../../../beacon-core/src/transports/clients/ClientEvents')
  >('../../../beacon-core/src/transports/clients/ClientEvents'))
}))

vi.mock('@walletconnect/sign-client', () => ({ default: { init: async () => mockRemote } }))
vi.mock('@walletconnect/utils', () => ({
  getSdkError: () => ({ code: 6000, message: 'User disconnected.' })
}))

describe('WalletConnectCommunicationClient BeaconErrorType round-trip', () => {
  installLocalChannel()
  const serializer = new Serializer()
  let client: WalletConnectCommunicationClient
  let responses: unknown[]

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resetWire()
    responses = []
    client = new WalletConnectCommunicationClient(
      { network: NetworkType.MAINNET, opts: { projectId: 'offline' } },
      async () => true
    )
    await client.init()
    await client.listenForEncryptedMessage('wallet', (encoded) => {
      void serializer.deserialize(encoded).then((response) => {
        responses.push(response)
      })
    })
    holdPings()
  })

  afterEach(async () => {
    await client.close()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('preserves BeaconErrorType when wallet rejects with a serialized Beacon JSON-RPC error', async () => {
    await restoreSession(client, 'current')

    const serializedReq = await serializer.serialize({
      id: 'req-params-invalid',
      version: '2',
      senderId: 'dapp',
      type: BeaconMessageType.OperationRequest,
      network: { type: NetworkType.MAINNET },
      operationDetails: [],
      sourceAddress: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb'
    })

    await client.sendMessage(serializedReq)
    await flush()

    mockRequests[0].reply.reject(serializeBeaconErrorToJsonRpcError(BeaconErrorType.PARAMETERS_INVALID_ERROR))
    await flush()

    expect(responses).toHaveLength(1)
    const errorResponse = responses[0] as ErrorResponse
    expect(errorResponse.type).toBe(BeaconMessageType.Error)
    expect(errorResponse.id).toBe('req-params-invalid')
    expect(errorResponse.errorType).toBe(BeaconErrorType.PARAMETERS_INVALID_ERROR)
  })

  it('preserves TRANSACTION_INVALID_ERROR and TezosRpcError[] errorData', async () => {
    await restoreSession(client, 'current')

    const rpcErrors: TezosRpcError[] = [
      { kind: 'temporary', id: 'proto.021-PsQuebec.contract.balance_too_low' }
    ]

    const serializedReq = await serializer.serialize({
      id: 'req-tx-invalid',
      version: '2',
      senderId: 'dapp',
      type: BeaconMessageType.SignPayloadRequest,
      signingType: SigningType.RAW,
      payload: '0xdeadbeef',
      sourceAddress: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb'
    })

    await client.sendMessage(serializedReq)
    await flush()

    mockRequests[0].reply.reject(
      serializeBeaconErrorToJsonRpcError(BeaconErrorType.TRANSACTION_INVALID_ERROR, rpcErrors)
    )
    await flush()

    expect(responses).toHaveLength(1)
    const errorResponse = responses[0] as ErrorResponse
    expect(errorResponse.type).toBe(BeaconMessageType.Error)
    expect(errorResponse.id).toBe('req-tx-invalid')
    expect(errorResponse.errorType).toBe(BeaconErrorType.TRANSACTION_INVALID_ERROR)
    expect(errorResponse.errorData).toEqual(rpcErrors)
  })

  it('falls back to ABORTED_ERROR for legacy wallet JSON-RPC errors', async () => {
    await restoreSession(client, 'current')

    const serializedReq = await serializer.serialize({
      id: 'req-legacy-reject',
      version: '2',
      senderId: 'dapp',
      type: BeaconMessageType.SignPayloadRequest,
      signingType: SigningType.RAW,
      payload: '0xdeadbeef',
      sourceAddress: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb'
    })

    await client.sendMessage(serializedReq)
    await flush()

    mockRequests[0].reply.reject({ code: 4001, message: 'User rejected' })
    await flush()

    expect(responses).toHaveLength(1)
    const errorResponse = responses[0] as ErrorResponse
    expect(errorResponse.type).toBe(BeaconMessageType.Error)
    expect(errorResponse.id).toBe('req-legacy-reject')
    expect(errorResponse.errorType).toBe(BeaconErrorType.ABORTED_ERROR)
  })
})
