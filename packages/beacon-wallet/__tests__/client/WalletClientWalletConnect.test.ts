import { LocalStorage } from '@ecadlabs/beacon-core'
import {
  BeaconErrorType,
  BeaconMessageType,
  NetworkType,
  OperationRequestOutput,
  PermissionRequestOutput,
  SignPayloadRequestOutput,
  TezosOperationType,
  TezosRpcError,
  TransportType
} from '@ecadlabs/beacon-types'
import { serializeBeaconErrorToJsonRpcError } from '@ecadlabs/beacon-transport-walletconnect'
import { WalletClient } from '../../src/client/WalletClient'
import type { WalletRequestOutputMessage } from '../../src/types/WalletRequestOutputMessage'

type EventHandler = (event: unknown) => void | Promise<void>
const DAPP_WC_PK = '1111111111111111111111111111111111111111111111111111111111111111'

const createMockSignClient = () => {
  const handlers = new Map<string, Set<EventHandler>>()
  const sessions = new Map<string, Record<string, unknown>>()

  return {
    on: vi.fn((event: string, handler: EventHandler) => {
      if (!handlers.has(event)) {
        handlers.set(event, new Set())
      }
      handlers.get(event)?.add(handler)
    }),
    off: vi.fn((event: string, handler: EventHandler) => {
      handlers.get(event)?.delete(handler)
    }),
    pair: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockImplementation(async ({ id, namespaces, sessionProperties }) => {
      const topic = `topic-${id}`
      const session = {
        topic,
        namespaces,
        sessionProperties,
        peer: {
          publicKey: DAPP_WC_PK,
          metadata: {
            name: 'WC dApp',
            url: 'https://wc-dapp.example',
            icons: ['https://wc-dapp.example/icon.png']
          }
        }
      }
      sessions.set(topic, session)

      return { topic, acknowledged: vi.fn().mockResolvedValue(session) }
    }),
    reject: vi.fn().mockResolvedValue(undefined),
    respond: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({ acknowledged: vi.fn().mockResolvedValue(undefined) }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    session: {
      getAll: vi.fn(() => [...sessions.values()]),
      get: vi.fn((topic: string) => sessions.get(topic))
    },
    trigger: async (event: string, payload: unknown) => {
      for (const handler of [...(handlers.get(event) ?? [])]) {
        await handler(payload)
      }
    }
  }
}

let currentSignClient = createMockSignClient()

vi.mock('@walletconnect/sign-client', () => ({
  default: {
    init: vi.fn(async () => currentSignClient)
  }
}))

vi.mock('@ecadlabs/beacon-transport-walletconnect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-transport-walletconnect')>()),
  initWalletConnectSignClient: vi.fn(async () => currentSignClient)
}))

describe('WalletClient with walletConnectOptions', () => {
  const pkh = 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb'
  const pk = 'edpkuSLWfVU1Vq7Jg9FucPyKmma6otcMHac9zG4oU1KMHSTBpJuGQ2'

  beforeEach(() => {
    localStorage.clear()
    currentSignClient = createMockSignClient()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('initializes WalletWalletConnectTransport, delivers typed requests, preserves BeaconErrorType, and destroys cleanly', async () => {
    const walletClient = new WalletClient({
      name: 'My WC Wallet',
      storage: new LocalStorage(),
      walletConnectOptions: {
        projectId: 'test-project-id'
      }
    })

    const transportType = await walletClient.init()
    expect(transportType).toBe(TransportType.WALLETCONNECT)

    const delivered: WalletRequestOutputMessage[] = []
    await walletClient.connect((message) => {
      delivered.push(message)
    })

    // 1. session_proposal -> PermissionRequestOutput -> respondPermission -> approve
    await currentSignClient.trigger('session_proposal', {
      id: 11,
      params: {
        id: 11,
        proposer: {
          publicKey: DAPP_WC_PK,
          metadata: {
            name: 'WC dApp',
            url: 'https://wc-dapp.example',
            icons: ['https://wc-dapp.example/icon.png']
          }
        },
        requiredNamespaces: {
          tezos: {
            chains: ['tezos:mainnet'],
            methods: ['tezos_getAccounts', 'tezos_send', 'tezos_sign'],
            events: ['requestAcknowledged']
          }
        },
        sessionProperties: {
          beacon_sdk_version: '4.9.0-ecad-beta.0'
        }
      }
    })

    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const permRequest = delivered[0] as PermissionRequestOutput
    expect(permRequest.type).toBe(BeaconMessageType.PermissionRequest)

    await walletClient.respondPermission(permRequest, { publicKey: pk })
    expect(currentSignClient.approve).toHaveBeenCalledTimes(1)

    // 2. tezos_send -> OperationRequestOutput -> respondError(BROADCAST_ERROR)
    await currentSignClient.trigger('session_request', {
      id: 12,
      topic: 'topic-11',
      params: {
        chainId: 'tezos:mainnet',
        request: {
          method: 'tezos_send',
          params: {
            account: pkh,
            operations: [
              { kind: TezosOperationType.TRANSACTION, amount: '500', destination: pkh }
            ]
          }
        }
      }
    })

    await vi.waitFor(() => expect(delivered).toHaveLength(2))
    const opRequest = delivered[1] as OperationRequestOutput
    expect(opRequest.type).toBe(BeaconMessageType.OperationRequest)

    await walletClient.respondError(opRequest, BeaconErrorType.BROADCAST_ERROR)
    expect(currentSignClient.respond).toHaveBeenCalledWith({
      topic: 'topic-11',
      response: {
        id: 12,
        jsonrpc: '2.0',
        error: serializeBeaconErrorToJsonRpcError(BeaconErrorType.BROADCAST_ERROR)
      }
    })

    // 3. tezos_sign -> SignPayloadRequestOutput -> respondError(TRANSACTION_INVALID_ERROR, rpcErrors)
    await currentSignClient.trigger('session_request', {
      id: 13,
      topic: 'topic-11',
      params: {
        chainId: 'tezos:mainnet',
        request: {
          method: 'tezos_sign',
          params: {
            account: pkh,
            payload: '05010000000474657374'
          }
        }
      }
    })

    await vi.waitFor(() => expect(delivered).toHaveLength(3))
    const signRequest = delivered[2] as SignPayloadRequestOutput
    expect(signRequest.type).toBe(BeaconMessageType.SignPayloadRequest)

    const rpcErrors: TezosRpcError[] = [
      { kind: 'permanent', id: 'proto.021-PsQuebec.michelson_v1.script_rejected' }
    ]
    await walletClient.respondError(signRequest, BeaconErrorType.TRANSACTION_INVALID_ERROR, rpcErrors)
    expect(currentSignClient.respond).toHaveBeenLastCalledWith({
      topic: 'topic-11',
      response: {
        id: 13,
        jsonrpc: '2.0',
        error: serializeBeaconErrorToJsonRpcError(
          BeaconErrorType.TRANSACTION_INVALID_ERROR,
          rpcErrors
        )
      }
    })

    await expect(walletClient.destroy()).resolves.toBeUndefined()
  })
})
