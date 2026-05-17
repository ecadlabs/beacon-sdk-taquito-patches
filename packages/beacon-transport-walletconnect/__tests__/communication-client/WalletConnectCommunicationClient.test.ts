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

jest.mock('@ecadlabs/beacon-core', () => {
  const actual = jest.requireActual('@ecadlabs/beacon-core')
  return {
    ...actual,
    Logger: jest.fn().mockImplementation(() => ({
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      log: jest.fn()
    })),
    ClientEvents: {
      WC_ACK_NOTIFICATION: 'WC_ACK_NOTIFICATION',
      CLOSE_ALERT: 'CLOSE_ALERT'
    },
    WCStorage: jest.fn().mockImplementation(() => ({
      onMessageHandler: undefined,
      onErrorHandler: undefined,
      backup: jest.fn(),
      resetState: jest.fn(),
      notify: jest.fn()
    })),
    Serializer: jest.fn().mockImplementation(() => ({
      serialize: jest.fn((x) => Promise.resolve(JSON.stringify(x))),
      deserialize: jest.fn((x) => Promise.resolve(JSON.parse(x)))
    }))
  }
})

jest.mock('@walletconnect/sign-client', () => ({
  init: jest.fn(() =>
    Promise.resolve({
      session: { keys: [], get: jest.fn(), getAll: jest.fn(() => []) },
      core: {
        pairing: { getPairings: jest.fn(() => []) },
        events: { removeAllListeners: jest.fn() },
        relayer: {
          transportClose: jest.fn(),
          events: { removeAllListeners: jest.fn() },
          provider: { events: { removeAllListeners: jest.fn() } },
          subscriber: { events: { removeAllListeners: jest.fn() } }
        },
        heartbeat: { stop: jest.fn() }
      },
      request: jest.fn()
    })
  )
}))

jest.mock('@walletconnect/utils', () => ({
  getSdkError: jest.fn((code: string) => ({ code }))
}))

jest.mock('@ecadlabs/beacon-utils', () => ({
  generateGUID: jest.fn().mockResolvedValue('guid'),
  getAddressFromPublicKey: jest.fn().mockResolvedValue('tz1address'),
  isPublicKeySC: jest.fn().mockReturnValue(true)
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
  on: jest.fn(),
  session: { keys: [], get: jest.fn(), getAll: jest.fn(() => []) },
  pairing: { getAll: jest.fn(() => []) },
  core: {
    pairing: {
      getPairings: jest.fn(() => []),
      ping: jest.fn().mockResolvedValue(undefined),
      events: { on: jest.fn(), removeAllListeners: jest.fn() }
    },
    events: { removeAllListeners: jest.fn() },
    relayer: {
      transportClose: jest.fn(),
      events: { removeAllListeners: jest.fn() },
      provider: {
        events: { removeAllListeners: jest.fn() },
        connection: { events: { removeAllListeners: jest.fn() } }
      },
      subscriber: { events: { removeAllListeners: jest.fn() } }
    },
    heartbeat: { stop: jest.fn() }
  },
  request: jest.fn()
})

const createPairingSignClient = () => {
  const approval = jest.fn(() => new Promise<SessionTypes.Struct>(() => {}))
  const connect = jest.fn(() => {
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
  const isLeader = jest.fn().mockResolvedValue(true)
  let client: WalletConnectCommunicationClient

  beforeEach(() => {
    jest.clearAllMocks()
    client = new WalletConnectCommunicationClient(wcOptions, isLeader)
  })

  it('is a singleton via getInstance()', () => {
    const same = WalletConnectCommunicationClient.getInstance(wcOptions, isLeader)
    expect(same).toBe(WalletConnectCommunicationClient.getInstance(wcOptions, isLeader))
  })

  it('listenForEncryptedMessage adds and dedups listeners', async () => {
    const cb = jest.fn()
    await client.listenForEncryptedMessage('key1', cb)
    expect((client as any).activeListeners.has('key1')).toBe(true)
    await client.listenForEncryptedMessage('key1', cb)
    expect((client as any).activeListeners.size).toBe(1)
  })

  it('listenForChannelOpening adds a channel listener', async () => {
    const cb = jest.fn()
    await client.listenForChannelOpening(cb)
    expect((client as any).channelOpeningListeners.has('channelOpening')).toBe(true)
  })

  it('tries fallback relayers when earlier relayer init attempts fail', async () => {
    const signClient = SignClient as unknown as { init: jest.Mock }
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
    jest.useFakeTimers()
    const signClient = SignClient as unknown as { init: jest.Mock }
    const resolvedClient = createResolvedSignClient()

    signClient.init
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(resolvedClient)

    const relayer = (client as any).tryConnectToRelayer()
    await Promise.resolve()

    jest.advanceTimersByTime(15000)
    await Promise.resolve()

    await expect(relayer).resolves.toBe(resolvedClient)
    expect(signClient.init).toHaveBeenCalledTimes(2)
    jest.useRealTimers()
  })

  it('coalesces concurrent SignClient initialization', async () => {
    const signClient = SignClient as unknown as { init: jest.Mock }
    const resolvedClient = createResolvedSignClient()
    signClient.init.mockResolvedValueOnce(resolvedClient)

    const first = (client as any).getSignClient()
    const second = (client as any).getSignClient()

    await expect(first).resolves.toBe(resolvedClient)
    await expect(second).resolves.toBe(resolvedClient)
    expect(signClient.init).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent pairing request creation', async () => {
    const init = jest
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
    const signClient = SignClient as unknown as { init: jest.Mock }
    const approval = jest.fn(() => new Promise<never>(() => {}))
    const resolvedClient = {
      ...createResolvedSignClient(),
      connect: jest.fn().mockResolvedValue({
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
    const signClient = SignClient as unknown as { init: jest.Mock }
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
    const approval = jest.fn().mockResolvedValue(restoredSession)
    const resolvedClient = {
      ...createResolvedSignClient(),
      session: {
        keys: ['old-session'],
        get: jest.fn(() => restoredSession),
        getAll: jest.fn(() => [restoredSession])
      },
      connect: jest.fn().mockResolvedValue({
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
    jest.useFakeTimers()
    const restoredSession = {
      topic: 'old-session',
      expiry: Math.floor(Date.now() / 1000) + 3600
    }
    ;(client as any).signClient = {
      ...createResolvedSignClient(),
      ping: jest.fn(() => new Promise(() => {}))
    }

    const validation = (client as any).isSessionValid(restoredSession)
    await Promise.resolve()
    jest.advanceTimersByTime(5000)
    await Promise.resolve()

    await expect(validation).resolves.toBe(false)
    jest.useRealTimers()
  })

  it('continues local SignClient cleanup when relayer transport close times out', async () => {
    jest.useFakeTimers()
    const resolvedClient = createResolvedSignClient()
    resolvedClient.core.relayer.transportClose.mockImplementation(() => new Promise(() => {}))
    ;(client as any).signClient = resolvedClient

    const close = client.closeSignClient()
    await Promise.resolve()
    jest.advanceTimersByTime(10000)

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
    jest.useRealTimers()
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
  const isLeader = jest.fn().mockResolvedValue(true)
  let client: WalletConnectCommunicationClient

  beforeEach(() => {
    jest.clearAllMocks()
    client = new WalletConnectCommunicationClient(wcOptions, isLeader)
  })

  it('sendMessage no-op on unknown type', async () => {
    const raw = JSON.stringify({ id: '1', type: 'Foo' })
    await client.sendMessage(raw)
    // no errors
  })

  it('sendMessage dispatches PermissionRequest', async () => {
    const msg = { id: '1', type: BeaconMessageType.PermissionRequest, network: 'mainnet' }
    jest.spyOn(client, 'requestPermissions').mockImplementationOnce(() => Promise.resolve())
    await client.sendMessage(JSON.stringify(msg))
    expect(client.requestPermissions).toHaveBeenCalled()
  })

  it('sendMessage dispatches OperationRequest', async () => {
    const msg = { id: '2', type: BeaconMessageType.OperationRequest, operationDetails: [] }
    jest.spyOn(client, 'sendOperations').mockImplementationOnce(() => Promise.resolve())
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
    jest.spyOn(client, 'signPayload').mockImplementationOnce(() => Promise.resolve())
    await client.sendMessage(JSON.stringify(msg))
    expect(client.signPayload).toHaveBeenCalled()
  })
})
