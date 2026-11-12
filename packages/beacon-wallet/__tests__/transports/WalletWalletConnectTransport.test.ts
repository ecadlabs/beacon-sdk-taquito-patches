import { LocalStorage, Serializer, getSenderId } from '@ecadlabs/beacon-core'
import {
  AcknowledgeResponse,
  BeaconErrorType,
  BeaconMessageType,
  DisconnectMessage,
  ErrorResponse,
  ExtendedWalletConnectPairingRequest,
  NetworkType,
  OperationRequest,
  OperationResponse,
  PermissionRequest,
  PermissionResponse,
  PermissionScope,
  SignPayloadRequest,
  SignPayloadResponse,
  SigningType,
  TezosOperationType,
  TezosRpcError,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { serializeBeaconErrorToJsonRpcError } from '@ecadlabs/beacon-transport-walletconnect'
import { WalletWalletConnectTransport } from '../../src/transports/WalletWalletConnectTransport'
import { WalletWalletConnectTransport as ExportedTransport } from '../../src/index'

type EventHandler = (event: unknown) => void | Promise<void>
const hexPk = (fill: string): string => fill.repeat(64).slice(0, 64)

const createMockSignClient = () => {
  const handlers = new Map<string, Set<EventHandler>>()
  const sessions = new Map<string, Record<string, unknown>>()

  const mockSignClient = {
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
          publicKey: hexPk('a'),
          metadata: {
            name: 'Test dApp',
            url: 'https://dapp.example',
            icons: ['https://dapp.example/icon.png']
          }
        }
      }
      sessions.set(topic, session)

      return {
        topic,
        acknowledged: vi.fn().mockResolvedValue(session)
      }
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
    },
    seedSession: (topic: string, session: Record<string, unknown>) => {
      sessions.set(topic, session)
    }
  }

  return mockSignClient
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

describe('WalletWalletConnectTransport', () => {
  const serializer = new Serializer()
  const pkh = 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb'
  const pk = 'edpkuSLWfVU1Vq7Jg9FucPyKmma6otcMHac9zG4oU1KMHSTBpJuGQ2'

  beforeEach(() => {
    localStorage.clear()
    currentSignClient = createMockSignClient()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const createTransport = async () => {
    const keyPair = await getKeypairFromSeed('wallet-wc-test')
    const storage = new LocalStorage()

    return new WalletWalletConnectTransport(
      'Test Wallet',
      keyPair,
      storage,
      { projectId: 'test-project-id' },
      'https://wallet.example/icon.png',
      'https://wallet.example'
    )
  }

  it('is exported from @ecadlabs/beacon-wallet and reports WALLETCONNECT type', async () => {
    expect(ExportedTransport).toBe(WalletWalletConnectTransport)
    const transport = await createTransport()
    expect(transport.type).toBe(TransportType.WALLETCONNECT)
    await transport.doClientCleanup()
  })

  it('pairs using signClient.pair when addPeer is called with a WalletConnect URI', async () => {
    const transport = await createTransport()
    await transport.connect()
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)

    const peer = new ExtendedWalletConnectPairingRequest(
      'peer-1',
      'Test dApp',
      hexPk('b'),
      '2',
      'sender-1',
      'wc:test-topic@2?relay-protocol=irn&symKey=abc'
    )
    await transport.addPeer(peer)

    expect(currentSignClient.pair).toHaveBeenCalledWith({ uri: peer.uri })
    await transport.doClientCleanup()
  })

  it('translates session_proposal to PermissionRequest and approves with unioned namespaces and dual accounts when beacon_sdk_version is present', async () => {
    const transport = await createTransport()
    const received: { message: unknown; id: string }[] = []
    await transport.addListener((message, context) => {
      received.push({ message, id: context.id })
    })
    await transport.connect()

    await currentSignClient.trigger('session_proposal', {
      id: 101,
      params: {
        id: 101,
        proposer: {
          publicKey: hexPk('a'),
          metadata: {
            name: 'Example dApp',
            url: 'https://dapp.example',
            icons: ['https://dapp.example/icon.png']
          }
        },
        requiredNamespaces: {
          tezos: {
            chains: ['tezos:mainnet'],
            methods: ['tezos_getAccounts', 'tezos_sign'],
            events: ['chainChanged']
          }
        },
        optionalNamespaces: {
          tezos: {
            chains: ['tezos:shadownet'],
            methods: ['tezos_send'],
            events: ['accountsChanged', 'requestAcknowledged']
          }
        },
        sessionProperties: {
          beacon_sdk_version: '4.9.0-ecad-beta.0'
        }
      }
    })

    expect(received).toHaveLength(1)
    const permReq = (await serializer.deserialize(received[0].message as string)) as PermissionRequest
    expect(permReq.type).toBe(BeaconMessageType.PermissionRequest)
    expect(permReq.network.type).toBe(NetworkType.MAINNET)
    expect(permReq.appMetadata.name).toBe('Example dApp')

    const permResp: PermissionResponse = {
      id: permReq.id,
      version: '2',
      senderId: 'wallet-sender',
      type: BeaconMessageType.PermissionResponse,
      publicKey: pk,
      address: pkh,
      network: { type: NetworkType.MAINNET },
      scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST],
      walletType: 'implicit',
      appMetadata: { senderId: 'wallet-sender', name: 'Test Wallet' }
    }

    await transport.send(await serializer.serialize(permResp), {
      id: 'peer',
      name: 'Example dApp',
      publicKey: received[0].id,
      version: '2'
    })

    expect(currentSignClient.approve).toHaveBeenCalledTimes(1)
    const approveArg = currentSignClient.approve.mock.calls[0][0]
    expect(approveArg.id).toBe(101)
    expect(approveArg.namespaces.tezos.methods).toEqual(
      expect.arrayContaining(['tezos_getAccounts', 'tezos_sign', 'tezos_send'])
    )
    expect(approveArg.namespaces.tezos.events).toEqual(
      expect.arrayContaining(['chainChanged', 'accountsChanged', 'requestAcknowledged'])
    )
    expect(approveArg.namespaces.tezos.accounts).toEqual(
      expect.arrayContaining([
        `tezos:mainnet:${pkh}`,
        `tezos:mainnet:${pk}`,
        `tezos:shadownet:${pkh}`,
        `tezos:shadownet:${pk}`
      ])
    )
    await transport.doClientCleanup()
  })

  it('omits public key entries from approved accounts when beacon_sdk_version is absent', async () => {
    const transport = await createTransport()
    const received: { message: unknown; id: string }[] = []
    await transport.addListener((message, context) => {
      received.push({ message, id: context.id })
    })
    await transport.connect()

    await currentSignClient.trigger('session_proposal', {
      id: 102,
      params: {
        id: 102,
        proposer: {
          publicKey: hexPk('c'),
          metadata: { name: 'Legacy dApp', url: 'https://legacy.example', icons: [] }
        },
        requiredNamespaces: {
          tezos: {
            chains: ['tezos:mainnet'],
            methods: ['tezos_getAccounts', 'tezos_send', 'tezos_sign'],
            events: []
          }
        }
      }
    })

    const permReq = (await serializer.deserialize(received[0].message as string)) as PermissionRequest
    const permResp: PermissionResponse = {
      id: permReq.id,
      version: '2',
      senderId: 'wallet-sender',
      type: BeaconMessageType.PermissionResponse,
      publicKey: pk,
      address: pkh,
      network: { type: NetworkType.MAINNET },
      scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST],
      walletType: 'implicit',
      appMetadata: { senderId: 'wallet-sender', name: 'Test Wallet' }
    }

    await transport.send(await serializer.serialize(permResp), {
      id: 'peer',
      name: 'Legacy dApp',
      publicKey: received[0].id,
      version: '2'
    })

    const approveArg = currentSignClient.approve.mock.calls[0][0]
    expect(approveArg.namespaces.tezos.accounts).toEqual([`tezos:mainnet:${pkh}`])
    await transport.doClientCleanup()
  })

  it('rejects session_proposal with serialized BeaconErrorType JSON-RPC error', async () => {
    const transport = await createTransport()
    const received: { message: unknown; id: string }[] = []
    await transport.addListener((message, context) => {
      received.push({ message, id: context.id })
    })
    await transport.connect()

    await currentSignClient.trigger('session_proposal', {
      id: 103,
      params: {
        id: 103,
        proposer: {
          publicKey: hexPk('d'),
          metadata: { name: 'dApp', url: 'https://dapp.example', icons: [] }
        },
        requiredNamespaces: {
          tezos: { chains: ['tezos:mainnet'], methods: ['tezos_getAccounts'], events: [] }
        }
      }
    })

    const permReq = (await serializer.deserialize(received[0].message as string)) as PermissionRequest
    const errResp: ErrorResponse = {
      id: permReq.id,
      version: '2',
      senderId: 'wallet-sender',
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.NETWORK_NOT_SUPPORTED
    }

    await transport.send(await serializer.serialize(errResp), {
      id: 'peer',
      name: 'dApp',
      publicKey: received[0].id,
      version: '2'
    })

    expect(currentSignClient.reject).toHaveBeenCalledWith({
      id: 103,
      reason: serializeBeaconErrorToJsonRpcError(BeaconErrorType.NETWORK_NOT_SUPPORTED)
    })
    await transport.doClientCleanup()
  })

  it('handles tezos_getAccounts, tezos_send, tezos_sign, ACK events, error responses with errorData, and deduplication', async () => {
    const transport = await createTransport()
    const received: { message: unknown; id: string }[] = []
    await transport.addListener((message, context) => {
      received.push({ message, id: context.id })
    })
    await transport.connect()

    currentSignClient.seedSession('topic-active', {
      topic: 'topic-active',
      namespaces: {
        tezos: {
          accounts: [`tezos:mainnet:${pkh}`, `tezos:mainnet:${pk}`],
          methods: ['tezos_getAccounts', 'tezos_send', 'tezos_sign'],
          events: ['requestAcknowledged']
        }
      },
      sessionProperties: { beacon_sdk_version: '4.9.0-ecad-beta.0' },
      peer: {
        publicKey: hexPk('e'),
        metadata: { name: 'Active dApp', url: 'https://dapp.example', icons: [] }
      }
    })

    // 1. Duplicate session_request (same topic + id) should be delivered only once
    const opEvent = {
      id: 201,
      topic: 'topic-active',
      params: {
        chainId: 'tezos:mainnet',
        request: {
          method: 'tezos_send',
          params: {
            account: pkh,
            operations: [
              { kind: TezosOperationType.TRANSACTION, amount: '1000', destination: pkh }
            ]
          }
        }
      }
    }
    await currentSignClient.trigger('session_request', opEvent)
    await currentSignClient.trigger('session_request', opEvent)
    expect(received).toHaveLength(1)

    const opReq = (await serializer.deserialize(received[0].message as string)) as OperationRequest
    expect(opReq.type).toBe(BeaconMessageType.OperationRequest)
    expect(opReq.sourceAddress).toBe(pkh)

    // 2. Acknowledge emits correlated requestAcknowledged session_event
    const ack: AcknowledgeResponse = {
      id: opReq.id,
      version: '2',
      senderId: 'wallet-sender',
      type: BeaconMessageType.Acknowledge
    }
    await transport.send(await serializer.serialize(ack))
    expect(currentSignClient.emit).toHaveBeenCalledWith({
      topic: 'topic-active',
      event: { name: 'requestAcknowledged', data: { id: opReq.id } },
      chainId: 'tezos:mainnet'
    })

    // 3. OperationResponse responds via JSON-RPC
    const opResp: OperationResponse = {
      id: opReq.id,
      version: '2',
      senderId: 'wallet-sender',
      type: BeaconMessageType.OperationResponse,
      transactionHash: 'ooHash123'
    }
    await transport.send(await serializer.serialize(opResp))
    expect(currentSignClient.respond).toHaveBeenCalledWith({
      topic: 'topic-active',
      response: {
        id: 201,
        jsonrpc: '2.0',
        result: { operationHash: 'ooHash123' }
      }
    })

    // 4. tezos_sign + ErrorResponse with TRANSACTION_INVALID_ERROR & errorData
    await currentSignClient.trigger('session_request', {
      id: 202,
      topic: 'topic-active',
      params: {
        chainId: 'tezos:mainnet',
        request: {
          method: 'tezos_sign',
          params: { account: pkh, payload: '05010000000474657374' }
        }
      }
    })
    const signReq = (await serializer.deserialize(
      received[1].message as string
    )) as SignPayloadRequest
    expect(signReq.type).toBe(BeaconMessageType.SignPayloadRequest)

    const rpcErrors: TezosRpcError[] = [
      { kind: 'temporary', id: 'proto.021-PsQuebec.contract.balance_too_low' }
    ]
    const errResp: ErrorResponse = {
      id: signReq.id,
      version: '2',
      senderId: 'wallet-sender',
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.TRANSACTION_INVALID_ERROR,
      errorData: rpcErrors
    }
    await transport.send(await serializer.serialize(errResp))
    expect(currentSignClient.respond).toHaveBeenLastCalledWith({
      topic: 'topic-active',
      response: {
        id: 202,
        jsonrpc: '2.0',
        error: serializeBeaconErrorToJsonRpcError(
          BeaconErrorType.TRANSACTION_INVALID_ERROR,
          rpcErrors
        )
      }
    })

    // 5. tezos_sign success
    await currentSignClient.trigger('session_request', {
      id: 203,
      topic: 'topic-active',
      params: {
        chainId: 'tezos:mainnet',
        request: {
          method: 'tezos_sign',
          params: { account: pkh, payload: '05010000000474657374' }
        }
      }
    })
    const signReq2 = (await serializer.deserialize(
      received[2].message as string
    )) as SignPayloadRequest
    const signResp: SignPayloadResponse = {
      id: signReq2.id,
      version: '2',
      senderId: 'wallet-sender',
      type: BeaconMessageType.SignPayloadResponse,
      signingType: SigningType.RAW,
      signature: 'edsigTestSig'
    }
    await transport.send(await serializer.serialize(signResp))
    expect(currentSignClient.respond).toHaveBeenLastCalledWith({
      topic: 'topic-active',
      response: {
        id: 203,
        jsonrpc: '2.0',
        result: { signature: 'edsigTestSig' }
      }
    })

    // 6. tezos_getAccounts
    await currentSignClient.trigger('session_request', {
      id: 204,
      topic: 'topic-active',
      params: {
        chainId: 'tezos:mainnet',
        request: {
          method: 'tezos_getAccounts',
          params: {}
        }
      }
    })
    const getAccReq = (await serializer.deserialize(
      received[3].message as string
    )) as PermissionRequest
    expect(getAccReq.type).toBe(BeaconMessageType.PermissionRequest)

    const getAccResp: PermissionResponse = {
      id: getAccReq.id,
      version: '2',
      senderId: 'wallet-sender',
      type: BeaconMessageType.PermissionResponse,
      publicKey: pk,
      address: pkh,
      network: { type: NetworkType.MAINNET },
      scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST],
      walletType: 'implicit',
      appMetadata: { senderId: 'wallet-sender', name: 'Test Wallet' }
    }
    await transport.send(await serializer.serialize(getAccResp))
    expect(currentSignClient.respond).toHaveBeenLastCalledWith({
      topic: 'topic-active',
      response: {
        id: 204,
        jsonrpc: '2.0',
        result: [{ algo: 'ed25519', address: pkh, pubkey: pk }]
      }
    })

    await transport.doClientCleanup()
  })

  it('updates session accounts with dual format when beacon_sdk_version is present and emits DisconnectMessage on session_delete', async () => {
    const transport = await createTransport()
    const received: unknown[] = []
    await transport.addListener((message) => {
      received.push(message)
    })
    await transport.connect()

    currentSignClient.seedSession('topic-update', {
      topic: 'topic-update',
      namespaces: {
        tezos: {
          accounts: [`tezos:mainnet:${pkh}`, `tezos:mainnet:${pk}`],
          methods: ['tezos_getAccounts', 'tezos_send', 'tezos_sign'],
          events: ['accountsChanged']
        }
      },
      sessionProperties: { beacon_sdk_version: '4.9.0-ecad-beta.0' },
      peer: {
        publicKey: hexPk('f'),
        metadata: { name: 'Update dApp', url: 'https://dapp.example', icons: [] }
      }
    })

    const nextPkh = 'tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6'
    const nextPk = 'edpktpzo8UZieYaJZgCHP6M6hKHPdWBSNqxvmEt6dwWRgxDh1EAFw9'
    await transport.updateSessionAccounts('topic-update', [
      { network: NetworkType.MAINNET, address: nextPkh, publicKey: nextPk }
    ])

    expect(currentSignClient.update).toHaveBeenCalledWith({
      topic: 'topic-update',
      namespaces: {
        tezos: {
          accounts: [`tezos:mainnet:${nextPkh}`, `tezos:mainnet:${nextPk}`],
          methods: ['tezos_getAccounts', 'tezos_send', 'tezos_sign'],
          events: ['accountsChanged']
        }
      }
    })

    await currentSignClient.trigger('session_delete', { topic: 'topic-update' })
    expect(received).toHaveLength(1)
    const disconnectMsg = (await serializer.deserialize(received[0] as string)) as DisconnectMessage
    expect(disconnectMsg.type).toBe(BeaconMessageType.Disconnect)
    expect(disconnectMsg.senderId).toBe(await getSenderId(hexPk('f')))

    await transport.disconnect()
    expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
    await transport.doClientCleanup()
  })

  it('handles optionalNamespaces-only session_proposal, session_expire, and outbound DisconnectMessage', async () => {
    const transport = await createTransport()
    const received: unknown[] = []
    await transport.addListener((message) => {
      received.push(message)
    })
    await transport.connect()

    await currentSignClient.trigger('session_proposal', {
      id: 109,
      params: {
        id: 109,
        proposer: {
          publicKey: hexPk('1'),
          metadata: { name: 'Optional dApp', url: 'https://opt.example', icons: [] }
        },
        requiredNamespaces: {},
        optionalNamespaces: {
          tezos: {
            chains: ['tezos:shadownet'],
            methods: ['tezos_getAccounts', 'tezos_sign'],
            events: ['accountsChanged']
          }
        }
      }
    })

    const permReq = (await serializer.deserialize(received[0] as string)) as PermissionRequest
    expect(permReq.network.type).toBe(NetworkType.SHADOWNET)

    const permResp: PermissionResponse = {
      id: permReq.id,
      version: '2',
      senderId: 'wallet-sender',
      type: BeaconMessageType.PermissionResponse,
      publicKey: pk,
      address: pkh,
      network: { type: NetworkType.SHADOWNET },
      scopes: [PermissionScope.SIGN],
      walletType: 'implicit',
      appMetadata: { senderId: 'wallet-sender', name: 'Test Wallet' }
    }

    await transport.send(await serializer.serialize(permResp), {
      id: 'peer',
      name: 'Optional dApp',
      publicKey: hexPk('1'),
      version: '2'
    })
    expect(currentSignClient.approve).toHaveBeenCalledTimes(1)

    const disconnectOut: DisconnectMessage = {
      id: 'disc-out-1',
      version: '2',
      senderId: 'wallet-sender',
      type: BeaconMessageType.Disconnect
    }
    await transport.send(await serializer.serialize(disconnectOut), {
      id: 'peer',
      name: 'Optional dApp',
      publicKey: hexPk('1'),
      version: '2'
    })
    expect(currentSignClient.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'topic-109' })
    )

    currentSignClient.seedSession('topic-expired', {
      topic: 'topic-expired',
      namespaces: { tezos: { accounts: [`tezos:mainnet:${pkh}`], methods: [], events: [] } },
      peer: {
        publicKey: hexPk('2'),
        metadata: { name: 'Expired dApp', url: 'https://exp.example', icons: [] }
      }
    })
    await currentSignClient.trigger('session_expire', { topic: 'topic-expired' })
    expect(received).toHaveLength(2)
    const expMsg = (await serializer.deserialize(received[1] as string)) as DisconnectMessage
    expect(expMsg.type).toBe(BeaconMessageType.Disconnect)
    expect(expMsg.senderId).toBe(await getSenderId(hexPk('2')))

    await transport.doClientCleanup()
  })
})
