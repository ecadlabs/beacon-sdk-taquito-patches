import type { Mock } from 'vitest'
// __tests__/WalletConnectCommunicationClient.test.ts

import { SessionTypes, SignClientTypes } from '@walletconnect/types'
import {
  BeaconMessageType,
  SignPayloadRequest,
  NetworkType,
  SigningType
} from '@ecadlabs/beacon-types'
import SignClient from '@walletconnect/sign-client'
import { WalletConnectCommunicationClient } from '../../src/communication-client/WalletConnectCommunicationClient'

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecadlabs/beacon-core')>()
  return {
    ...actual,
    Logger: vi.fn().mockImplementation(function () {
      return {
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        log: vi.fn()
      }
    }),
    ClientEvents: {
      WC_ACK_NOTIFICATION: 'WC_ACK_NOTIFICATION',
      CLOSE_ALERT: 'CLOSE_ALERT'
    },
    WCStorage: vi.fn().mockImplementation(function () {
      return {
        onMessageHandler: undefined,
        onErrorHandler: undefined,
        resetState: vi.fn(),
        notify: vi.fn()
      }
    }),
    Serializer: vi.fn().mockImplementation(function () {
      return {
        serialize: vi.fn((x) => Promise.resolve(JSON.stringify(x))),
        deserialize: vi.fn((x) => Promise.resolve(JSON.parse(x)))
      }
    })
  }
})

vi.mock('@walletconnect/sign-client', () => ({
  default: {
    init: vi.fn(() =>
      Promise.resolve({
        session: { keys: [], get: vi.fn(), getAll: vi.fn(() => []) },
        core: {
          pairing: { getPairings: vi.fn(() => []) },
          events: { removeAllListeners: vi.fn() },
          relayer: {
            transportClose: vi.fn(),
            events: { removeAllListeners: vi.fn() },
            provider: { events: { removeAllListeners: vi.fn() } },
            subscriber: { events: { removeAllListeners: vi.fn() } }
          },
          heartbeat: { stop: vi.fn() }
        },
        request: vi.fn()
      })
    )
  }
}))

vi.mock('@walletconnect/utils', () => ({
  getSdkError: vi.fn((code: string) => ({ code }))
}))

vi.mock('@ecadlabs/beacon-utils', () => ({
  generateGUID: vi.fn().mockResolvedValue('guid'),
  getAddressFromPublicKey: vi.fn().mockResolvedValue('tz1address'),
  isPublicKeySC: vi.fn().mockReturnValue(true)
}))

function getStringBetween(str: string | undefined, startChar: string, endChar: string): string {
  if (!str || !startChar || !endChar) {
    return ''
  }

  const startIndex = str.indexOf(startChar)
  const endIndex = str.indexOf(endChar, startIndex + 1)

  if (startIndex === -1 || endIndex === -1) {
    throw new Error('String not found')
  }

  return str.substring(startIndex + 1, endIndex)
}

const createResolvedSignClient = () => ({
  on: vi.fn(),
  session: { keys: [], get: vi.fn(), getAll: vi.fn(() => []) },
  pairing: { getAll: vi.fn(() => []) },
  core: {
    pairing: {
      getPairings: vi.fn(() => []),
      ping: vi.fn().mockResolvedValue(undefined),
      events: { on: vi.fn(), removeAllListeners: vi.fn() }
    },
    events: { removeAllListeners: vi.fn() },
    relayer: {
      transportClose: vi.fn(),
      events: { removeAllListeners: vi.fn() },
      provider: {
        events: { removeAllListeners: vi.fn() },
        connection: { events: { removeAllListeners: vi.fn() } }
      },
      subscriber: { events: { removeAllListeners: vi.fn() } }
    },
    heartbeat: { stop: vi.fn() }
  },
  request: vi.fn()
})

const createPairingSignClient = () => {
  const approval = vi.fn(() => new Promise<SessionTypes.Struct>(() => {}))
  const connect = vi.fn(() => {
    const topic = `topic-${connect.mock.calls.length}`

    return Promise.resolve({
      uri: `wc:${topic}@2?symKey=key-${connect.mock.calls.length}`,
      approval
    })
  })

  return {
    ...createResolvedSignClient(),
    connect
  }
}

describe('getStringBetween', () => {
  it('returns substring between two chars', () => {
    expect(getStringBetween('wc:topic@2', ':', '@')).toBe('topic')
  })

  it('returns empty string if inputs missing', () => {
    expect(getStringBetween(undefined, ':', '@')).toBe('')
    expect(getStringBetween('abc', '', '@')).toBe('')
    expect(getStringBetween('abc', ':', '')).toBe('')
  })

  it('throws if start or end not found', () => {
    expect(() => getStringBetween('abc', 'x', 'y')).toThrow('String not found')
  })
})

describe('WalletConnectCommunicationClient basics', () => {
  const wcOptions = { network: 'mainnet' as NetworkType, opts: {} as SignClientTypes.Options }
  const isLeader = vi.fn().mockResolvedValue(true)
  let client: WalletConnectCommunicationClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new WalletConnectCommunicationClient(wcOptions, isLeader)
  })

  it('is a singleton via getInstance()', () => {
    const same = WalletConnectCommunicationClient.getInstance(wcOptions, isLeader)
    expect(same).toBe(WalletConnectCommunicationClient.getInstance(wcOptions, isLeader))
  })

  it('listenForEncryptedMessage adds and dedups listeners', async () => {
    const cb = vi.fn()
    await client.listenForEncryptedMessage('key1', cb)
    expect((client as any).activeListeners.has('key1')).toBe(true)
    await client.listenForEncryptedMessage('key1', cb)
    expect((client as any).activeListeners.size).toBe(1)
  })

  it('listenForChannelOpening adds a channel listener', async () => {
    const cb = vi.fn()
    await client.listenForChannelOpening(cb)
    expect((client as any).channelOpeningListeners.has('channelOpening')).toBe(true)
  })

  it('tries fallback relayers when earlier relayer init attempts fail', async () => {
    const signClient = SignClient as unknown as { init: Mock }
    const configuredRelay = 'wss://configured-relay.example.com'
    const resolvedClient = createResolvedSignClient()
    const clientWithRelay = new WalletConnectCommunicationClient(
      {
        network: 'mainnet' as NetworkType,
        opts: { relayUrl: configuredRelay } as SignClientTypes.Options
      },
      isLeader
    )

    signClient.init
      .mockRejectedValueOnce(new Error('configured relay failed'))
      .mockRejectedValueOnce(new Error('default relay failed'))
      .mockResolvedValueOnce(resolvedClient)

    await expect((clientWithRelay as any).tryConnectToRelayer()).resolves.toBe(resolvedClient)
    expect(signClient.init).toHaveBeenCalledTimes(3)
    expect(signClient.init).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        relayUrl: configuredRelay
      })
    )
    expect(signClient.init).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        relayUrl: undefined
      })
    )
    expect(signClient.init).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        relayUrl: 'wss://relay.walletconnect.com'
      })
    )
  })

  it('times out a hung SignClient init attempt and tries the next relayer', async () => {
    vi.useFakeTimers()
    const signClient = SignClient as unknown as { init: Mock }
    const resolvedClient = createResolvedSignClient()

    signClient.init
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(resolvedClient)

    const relayer = (client as any).tryConnectToRelayer()
    await Promise.resolve()

    vi.advanceTimersByTime(15000)
    await Promise.resolve()

    await expect(relayer).resolves.toBe(resolvedClient)
    expect(signClient.init).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('coalesces concurrent SignClient initialization', async () => {
    const signClient = SignClient as unknown as { init: Mock }
    const resolvedClient = createResolvedSignClient()
    signClient.init.mockResolvedValueOnce(resolvedClient)

    const first = (client as any).getSignClient()
    const second = (client as any).getSignClient()

    await expect(first).resolves.toBe(resolvedClient)
    await expect(second).resolves.toBe(resolvedClient)
    expect(signClient.init).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent pairing request creation', async () => {
    const init = vi
      .spyOn(client as any, 'init')
      .mockResolvedValue({ uri: 'wc:topic@2?symKey=abc', topic: 'topic' })

    const first = client.getPairingRequestInfo()
    const second = client.getPairingRequestInfo()

    await expect(first).resolves.toMatchObject({
      uri: 'wc:topic@2?symKey=abc',
      id: 'topic'
    })
    await expect(second).resolves.toMatchObject({
      uri: 'wc:topic@2?symKey=abc',
      id: 'topic'
    })
    expect(init).toHaveBeenCalledTimes(1)
  })

  it('mints distinct pairing topics for sequential pairing request creation', async () => {
    const resolvedClient = createPairingSignClient()
    Object.defineProperty(client, 'signClient', { value: resolvedClient })

    const first = await client.getPairingRequestInfo()
    const second = await client.getPairingRequestInfo()

    expect(first.id).toBe('topic-1')
    expect(second.id).toBe('topic-2')
    expect(first.id).not.toBe(second.id)
    expect(first.uri).not.toBe(second.uri)
    expect(resolvedClient.connect).toHaveBeenCalledTimes(2)
  })

  it('mints a distinct pairing topic after no-op forced pairing cleanup', async () => {
    const resolvedClient = createPairingSignClient()
    Object.defineProperty(client, 'signClient', { value: resolvedClient })

    const first = await client.getPairingRequestInfo()
    await client.close()
    const second = await client.getPairingRequestInfo()

    expect(first.id).toBe('topic-1')
    expect(second.id).toBe('topic-2')
    expect(first.id).not.toBe(second.id)
    expect(first.uri).not.toBe(second.uri)
    expect(resolvedClient.connect).toHaveBeenCalledTimes(2)
    expect(resolvedClient.core.relayer.transportClose).not.toHaveBeenCalled()
  })

  it('reuses an initialized SignClient when creating the first force-new pairing request', async () => {
    const signClient = SignClient as unknown as { init: Mock }
    const approval = vi.fn(() => new Promise<never>(() => {}))
    const resolvedClient = {
      ...createResolvedSignClient(),
      connect: vi.fn().mockResolvedValue({
        uri: 'wc:fresh-topic@2?symKey=fresh',
        approval
      })
    }
    ;(client as any).signClient = resolvedClient

    await expect(client.getPairingRequestInfo()).resolves.toMatchObject({
      uri: 'wc:fresh-topic@2?symKey=fresh',
      id: 'fresh-topic'
    })

    expect(signClient.init).not.toHaveBeenCalled()
    expect(resolvedClient.connect).toHaveBeenCalledTimes(1)
    expect(resolvedClient.core.relayer.transportClose).not.toHaveBeenCalled()
  })

  it('puts Tezos methods only in required namespace for WalletConnect 2.18 compatibility', () => {
    const required = (client as any).permissionScopeParamsToNamespaces(
      (client as any).getRequiredPermissionScopeParams()
    )
    const optional = (client as any).permissionScopeParamsToNamespaces(
      (client as any).getOptionalPermissionScopeParams()
    )

    expect(required.chains).toEqual(['tezos:mainnet'])
    expect(optional.chains).toEqual(['tezos:mainnet'])
    expect(required.methods).toEqual(['tezos_getAccounts', 'tezos_send', 'tezos_sign'])
    expect(optional.methods).toEqual([])
    expect(required.events).toEqual([])
    expect(optional.events).toEqual(['requestAcknowledged'])
  })

  it('creates a fresh pairing URI instead of restoring a persisted session for pairing requests', async () => {
    const signClient = SignClient as unknown as { init: Mock }
    const restoredSession = {
      topic: 'old-session',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      namespaces: {
        tezos: {
          accounts: ['tezos:mainnet:tz1old'],
          methods: ['tezos_getAccounts', 'tezos_send', 'tezos_sign'],
          events: []
        }
      }
    }
    const approval = vi.fn().mockResolvedValue(restoredSession)
    const resolvedClient = {
      ...createResolvedSignClient(),
      session: {
        keys: ['old-session'],
        get: vi.fn(() => restoredSession),
        getAll: vi.fn(() => [restoredSession])
      },
      connect: vi.fn().mockResolvedValue({
        uri: 'wc:fresh-topic@2?symKey=fresh',
        approval
      })
    }
    signClient.init.mockResolvedValueOnce(resolvedClient)

    await expect(client.getPairingRequestInfo()).resolves.toMatchObject({
      uri: 'wc:fresh-topic@2?symKey=fresh',
      id: 'fresh-topic'
    })

    expect(resolvedClient.connect).toHaveBeenCalledTimes(1)
    expect(resolvedClient.core.pairing.ping).toHaveBeenCalledWith({ topic: 'fresh-topic' })
  })

  it('marks a restored session stale when validation ping hangs', async () => {
    vi.useFakeTimers()
    const restoredSession = {
      topic: 'old-session',
      expiry: Math.floor(Date.now() / 1000) + 3600
    }
    ;(client as any).signClient = {
      ...createResolvedSignClient(),
      ping: vi.fn(() => new Promise(() => {}))
    }

    const validation = (client as any).isSessionValid(restoredSession)
    await Promise.resolve()
    vi.advanceTimersByTime(5000)
    await Promise.resolve()

    await expect(validation).resolves.toBe(false)
    vi.useRealTimers()
  })

  it('continues local SignClient cleanup when relayer transport close times out', async () => {
    vi.useFakeTimers()
    const resolvedClient = createResolvedSignClient()
    resolvedClient.core.relayer.transportClose.mockImplementation(() => new Promise(() => {}))
    ;(client as any).signClient = resolvedClient

    const close = client.closeSignClient()
    await Promise.resolve()
    vi.advanceTimersByTime(10000)

    await expect(close).resolves.toBeUndefined()
    expect(resolvedClient.core.events.removeAllListeners).toHaveBeenCalledTimes(1)
    expect(resolvedClient.core.relayer.events.removeAllListeners).toHaveBeenCalledTimes(1)
    expect(resolvedClient.core.heartbeat.stop).toHaveBeenCalledTimes(1)
    expect(resolvedClient.core.relayer.provider.events.removeAllListeners).toHaveBeenCalledTimes(1)
    expect(resolvedClient.core.relayer.subscriber.events.removeAllListeners).toHaveBeenCalledTimes(
      1
    )
    expect(
      resolvedClient.core.relayer.provider.connection.events.removeAllListeners
    ).toHaveBeenCalledTimes(1)
    expect((client as any).signClient).toBeUndefined()
    expect((client as any).signClientPromise).toBeUndefined()
    expect((client as any).pairingRequestPromise).toBeUndefined()
    vi.useRealTimers()
  })

  it('notifies listeners immediately when an inbound session_delete has a hung pairing disconnect', async () => {
    vi.useFakeTimers()
    const resolvedClient = createResolvedSignClient()
    const session = {
      topic: 'session-topic',
      pairingTopic: 'pairing-topic',
      namespaces: {},
      peer: { metadata: { name: '', icons: [], redirect: {} } },
      sessionProperties: {}
    } as SessionTypes.Struct
    resolvedClient.core.pairing.disconnect = vi.fn(() => new Promise(() => {}))
    Reflect.set(client, 'signClient', resolvedClient)
    ;(client as any).session = session
    const notifyListeners = vi.spyOn(client as any, 'notifyListeners')

    const disconnect = (client as any).disconnect(resolvedClient, {
      type: 'session',
      topic: session.topic
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(notifyListeners).toHaveBeenCalledWith(session.topic, {
      id: 'guid',
      type: BeaconMessageType.Disconnect
    })
    vi.advanceTimersByTime(10000)
    await Promise.resolve()
    await Promise.resolve()
    await expect(disconnect).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('unsubscribeFromEncryptedMessages clears all listeners', async () => {
    await client.listenForEncryptedMessage('k', () => {})
    await client.listenForChannelOpening(() => {})
    await client.unsubscribeFromEncryptedMessages()
    expect((client as any).activeListeners.size).toBe(0)
    expect((client as any).channelOpeningListeners.size).toBe(0)
  })

  it('getTopicFromSession returns session.topic', () => {
    const dummy: SessionTypes.Struct = {
      topic: 't1',
      namespaces: {},
      pairingTopic: '',
      peer: { metadata: { name: '', icons: [], redirect: {} } },
      sessionProperties: {}
    } as any
    expect((client as any).getTopicFromSession(dummy)).toBe('t1')
  })
})

describe('String message dispatching', () => {
  const wcOptions = { network: 'mainnet' as NetworkType, opts: {} as SignClientTypes.Options }
  const isLeader = vi.fn().mockResolvedValue(true)
  let client: WalletConnectCommunicationClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new WalletConnectCommunicationClient(wcOptions, isLeader)
  })

  it('sendMessage no-op on unknown type', async () => {
    const raw = JSON.stringify({ id: '1', type: 'Foo' })
    await client.sendMessage(raw)
    // no errors
  })

  it('sendMessage dispatches PermissionRequest', async () => {
    const msg = { id: '1', type: BeaconMessageType.PermissionRequest, network: 'mainnet' }
    vi.spyOn(client, 'requestPermissions').mockImplementationOnce(() => Promise.resolve())
    await client.sendMessage(JSON.stringify(msg))
    expect(client.requestPermissions).toHaveBeenCalled()
  })

  it('sendMessage dispatches OperationRequest', async () => {
    const msg = { id: '2', type: BeaconMessageType.OperationRequest, operationDetails: [] }
    vi.spyOn(client, 'sendOperations').mockImplementationOnce(() => Promise.resolve())
    await client.sendMessage(JSON.stringify(msg))
    expect(client.sendOperations).toHaveBeenCalled()
  })

  it('sendMessage dispatches SignPayloadRequest', async () => {
    const msg: SignPayloadRequest = {
      id: '3',
      type: BeaconMessageType.SignPayloadRequest,
      payload: 'p',
      signingType: SigningType.RAW,
      senderId: '',
      sourceAddress: 'tz1test',
      version: '3'
    }
    vi.spyOn(client, 'signPayload').mockImplementationOnce(() => Promise.resolve())
    await client.sendMessage(JSON.stringify(msg))
    expect(client.signPayload).toHaveBeenCalled()
  })

  const createApprovedSession = (topic: string, publicKey: string): SessionTypes.Struct =>
    ({
      topic,
      pairingTopic: `pairing-${topic}`,
      controller: publicKey,
      expiry: Math.floor(Date.now() / 1000) + 7 * 86400,
      namespaces: {
        tezos: {
          accounts: [`tezos:mainnet:${publicKey}`],
          methods: ['tezos_getAccounts', 'tezos_send', 'tezos_sign'],
          events: []
        }
      },
      peer: {
        publicKey,
        metadata: {
          name: 'Test Wallet',
          description: 'Test Wallet',
          url: 'https://wallet.example.com',
          icons: ['https://wallet.example.com/icon.png'],
          redirect: {}
        }
      },
      sessionProperties: {
        pubkey: publicKey,
        algo: 'ed25519',
        address: 'tz1address'
      }
    }) as unknown as SessionTypes.Struct

  it('correlates a reconnect PermissionResponse to the new PermissionRequest after close and Disconnect', async () => {
    const firstSession = createApprovedSession(
      'session-topic-1',
      'edpktp3QT23n223n223n223n223n223n223n223n223n223n223n1'
    )
    const secondSession = createApprovedSession(
      'session-topic-2',
      'edpktp3QT23n223n223n223n223n223n223n223n223n223n223n2'
    )
    const signClient = SignClient as unknown as { init: Mock }
    const firstSignClient = {
      ...createResolvedSignClient(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue({
        uri: 'wc:pairing-topic-1@2?symKey=key-1',
        approval: () => Promise.resolve(firstSession)
      })
    }
    const secondSignClient = {
      ...createResolvedSignClient(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue({
        uri: 'wc:pairing-topic-2@2?symKey=key-2',
        approval: () => Promise.resolve(secondSession)
      })
    }
    signClient.init.mockResolvedValueOnce(firstSignClient).mockResolvedValueOnce(secondSignClient)

    const receivedMessages: Array<Record<string, unknown>> = []
    await client.listenForEncryptedMessage('dapp-listener', (serialized) => {
      receivedMessages.push(JSON.parse(serialized) as Record<string, unknown>)
    })

    await client.listenForChannelOpening(() => true)
    await client.getPairingRequestInfo()
    await new Promise((resolve) => setTimeout(resolve, 0))

    await client.sendMessage(
      JSON.stringify({
        id: 'permission-request-1',
        version: '2',
        senderId: 'dapp-sender',
        type: BeaconMessageType.PermissionRequest,
        appMetadata: { senderId: 'dapp-sender', name: 'Test DApp' },
        network: { type: NetworkType.MAINNET }
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0]).toMatchObject({
      type: BeaconMessageType.PermissionResponse,
      id: 'permission-request-1',
      senderId: 'session-topic-1'
    })

    // Simulate DAppClient.disconnect(): transport close followed by outgoing Disconnect message
    firstSignClient.session.getAll = vi.fn(() => [firstSession])
    await client.close()
    await client.sendMessage(
      JSON.stringify({
        id: 'disconnect-message-1',
        version: '2',
        senderId: 'dapp-sender',
        type: BeaconMessageType.Disconnect
      })
    )

    // Reconnect with a fresh session approval and second PermissionRequest
    await client.listenForEncryptedMessage('dapp-listener', (serialized) => {
      receivedMessages.push(JSON.parse(serialized) as Record<string, unknown>)
    })
    await client.listenForChannelOpening(() => true)
    await client.getPairingRequestInfo()
    await new Promise((resolve) => setTimeout(resolve, 0))

    await client.sendMessage(
      JSON.stringify({
        id: 'permission-request-2',
        version: '2',
        senderId: 'dapp-sender',
        type: BeaconMessageType.PermissionRequest,
        appMetadata: { senderId: 'dapp-sender', name: 'Test DApp' },
        network: { type: NetworkType.MAINNET }
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(receivedMessages).toHaveLength(2)
    expect(receivedMessages[1]).toMatchObject({
      type: BeaconMessageType.PermissionResponse,
      id: 'permission-request-2',
      senderId: 'session-topic-2'
    })
  })

  it('does not let an outbound Disconnect message poison correlation of a subsequent SignPayloadResponse', async () => {
    const publicKey = 'edpktp3QT23n223n223n223n223n223n223n223n223n223n223n1'
    const session = createApprovedSession('session-topic-1', publicKey)

    const resolvedClient = {
      ...createResolvedSignClient(),
      ping: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockResolvedValue({ signature: 'edsig-valid' })
    }
    ;(client as any).signClient = resolvedClient
    ;(client as any).session = session
    ;(client as any).activeAccountOrPbk = publicKey
    ;(client as any).activeNetwork = NetworkType.MAINNET

    const receivedMessages: Array<Record<string, unknown>> = []
    await client.listenForEncryptedMessage('dapp-listener', (serialized) => {
      receivedMessages.push(JSON.parse(serialized) as Record<string, unknown>)
    })

    try {
      await client.sendMessage(
        JSON.stringify({
          id: 'disconnect-message-id',
          version: '2',
          senderId: 'dapp-sender',
          type: BeaconMessageType.Disconnect
        })
      )

      const signRequest: SignPayloadRequest = {
        id: 'sign-request-id',
        type: BeaconMessageType.SignPayloadRequest,
        payload: '050100',
        signingType: SigningType.RAW,
        senderId: 'dapp-sender',
        sourceAddress: 'tz1address',
        version: '2'
      }
      await client.sendMessage(JSON.stringify(signRequest))
      await new Promise((resolve) => setTimeout(resolve, 0))

      const signPayloadResponses = receivedMessages.filter(
        (message) => message.type === BeaconMessageType.SignPayloadResponse
      )
      expect(signPayloadResponses).toHaveLength(1)
      expect(signPayloadResponses[0]).toMatchObject({
        type: BeaconMessageType.SignPayloadResponse,
        id: 'sign-request-id',
        signature: 'edsig-valid'
      })
      expect(receivedMessages.map((message) => message.id)).not.toContain('disconnect-message-id')
    } finally {
      clearInterval((client as any).pingInterval)
      ;(client as any).pingInterval = undefined
    }
  })
})
