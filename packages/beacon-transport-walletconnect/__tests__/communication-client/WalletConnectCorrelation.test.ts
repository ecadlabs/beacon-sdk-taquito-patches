import { ClientEvents, Serializer } from '@ecadlabs/beacon-core'
import {
  BeaconErrorType,
  BeaconMessageType,
  NetworkType,
  SigningType
} from '@ecadlabs/beacon-types'
import { WalletConnectCommunicationClient } from '../../src/communication-client/WalletConnectCommunicationClient'

import {
  mockRemote,
  mockApprovals,
  session,
  mockRequests,
  mockPings,
  mockHandlers,
  resetWire,
  restoreSession,
  holdPings,
  flush,
  installLocalChannel
} from '../helpers/controlled-sign-client'

// Babel does not inline const enums from built dependencies. Load the source enum.
vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  ...(await vi.importActual<
    typeof import('../../../beacon-core/src/transports/clients/ClientEvents')
  >('../../../beacon-core/src/transports/clients/ClientEvents'))
}))

type Kind = 'sign' | 'operation'
vi.mock('@walletconnect/sign-client', () => ({ default: { init: async () => mockRemote } }))
vi.mock('@walletconnect/utils', () => ({
  getSdkError: () => ({ code: 6000, message: 'User disconnected.' })
}))
// Only SignClient is controlled. Restoration, close, serialization and delivery
// use public adapter APIs; tests do not clear or inject the pending-request queue.
describe('WalletConnect request ownership (#102)', () => {
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
    expect(client.currentSession()?.topic).toBe('current')
    await listen()
    holdPings()
  })
  afterEach(async () => {
    await client.close()
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  async function listen() {
    await client.listenForEncryptedMessage('wallet', (encoded) => {
      void serializer.deserialize(encoded).then((response) => {
        responses.push(response)
      })
    })
  }
  async function send(id: string, kind: Kind) {
    const body =
      kind === 'sign'
        ? { type: BeaconMessageType.SignPayloadRequest, signingType: SigningType.RAW, payload: id }
        : {
            type: BeaconMessageType.OperationRequest,
            network: { type: NetworkType.MAINNET },
            operationDetails: []
          }
    await client.sendMessage(
      await serializer.serialize({ id, version: '2', senderId: 'dapp', ...body })
    )
    await flush()
  }
  function expected(id: string, kind: Kind, rejected: boolean, topic = 'current') {
    const body = rejected
      ? { type: BeaconMessageType.Error, errorType: BeaconErrorType.ABORTED_ERROR }
      : kind === 'sign'
        ? {
            type: BeaconMessageType.SignPayloadResponse,
            signingType: SigningType.RAW,
            signature: `signature-${id}`
          }
        : { type: BeaconMessageType.OperationResponse, transactionHash: `hash-${id}` }
    return { id, version: '2', senderId: topic, ...body }
  }
  async function complete(index: number, id: string, kind: Kind, rejected: boolean) {
    const request = mockRequests[index]
    expect(request).toBeDefined()
    if (rejected) request.reply.reject(new Error(`rejected-${id}`))
    else
      request.reply.resolve(
        kind === 'sign' ? { signature: `signature-${id}` } : { operationHash: `hash-${id}` }
      )
    await flush()
  }
  // Rows are request kinds and outcomes; each runs in both completion orders.
  const cases: Array<[Kind, Kind, boolean]> = [
    ['sign', 'sign', false],
    ['sign', 'sign', true],
    ['operation', 'operation', false],
    ['operation', 'operation', true],
    ['sign', 'operation', false],
    ['sign', 'operation', true],
    ['operation', 'sign', false],
    ['operation', 'sign', true]
  ]
  describe.each(cases)('%s / %s, second rejects: %s', (first, second, rejectSecond) => {
    it.each([
      [0, 1],
      [1, 0]
    ])('completion order %s then %s', async (firstIndex, secondIndex) => {
      await send('a', first)
      await send('b', second)
      expect(mockRequests.map(({ input }) => input.request.method)).toEqual([
        first === 'sign' ? 'tezos_sign' : 'tezos_send',
        second === 'sign' ? 'tezos_sign' : 'tezos_send'
      ])
      const requests: Array<[string, Kind, boolean]> = [
        ['a', first, false],
        ['b', second, rejectSecond]
      ]
      await complete(firstIndex, ...requests[firstIndex])
      await complete(secondIndex, ...requests[secondIndex])
      expect(responses).toEqual([
        expected(...requests[firstIndex]),
        expected(...requests[secondIndex])
      ])
    })
  })
  for (const close of [false, true]) {
    for (const rejected of [false, true]) {
      it(`ignores old ${rejected ? 'error' : 'response'} after ${close ? 'public close/reconnect' : 'public init replacement'}`, async () => {
        await send('old', 'sign')
        if (close) await client.close()
        restoreSession('replacement')
        await client.init()
        holdPings()
        await listen()
        expect(client.currentSession()?.topic).toBe('replacement')
        await send('new', 'operation')
        expect(responses).toEqual([expected('old', 'sign', true)])
        const before = responses.length
        await complete(0, 'old', 'sign', rejected)
        expect(responses.slice(before)).toEqual([])
        await complete(1, 'new', 'operation', false)
        expect(responses.slice(before)).toEqual([
          expected('new', 'operation', false, 'replacement')
        ])
      })
    }
  }
  for (const replace of [false, true]) {
    it(`ping success is reachability, not an ACK (${replace ? 'replacement' : 'current'} session)`, async () => {
      await send('a', 'sign')
      expect(mockPings).toHaveLength(1)
      if (replace) {
        restoreSession('replacement')
        await client.init()
        holdPings()
        await send('b', 'operation')
      }
      mockPings[0].resolve()
      await flush()
      const revoked = replace ? [expected('a', 'sign', true)] : []
      expect(responses).toEqual(revoked)
      await complete(replace ? 1 : 0, replace ? 'b' : 'a', replace ? 'operation' : 'sign', false)
      expect(responses).toEqual([
        ...revoked,
        expected(
          replace ? 'b' : 'a',
          replace ? 'operation' : 'sign',
          false,
          replace ? 'replacement' : 'current'
        )
      ])
    })
  }
  it.each([
    ['obsolete topic', 'obsolete', {}],
    ['uncorrelated current topic', 'current', {}],
    ['completed payload ID', 'current', { id: 'a' }],
    ['unknown payload ID', 'current', { id: 'unknown' }],
    ['unnegotiated matching payload ID', 'current', { id: 'b' }]
  ])('ignores legacy ACKs: %s', async (_name, topic, data) => {
    await send('a', 'sign')
    await complete(0, 'a', 'sign', false)
    await send('b', 'operation')
    const handler = mockHandlers.get('session_event')
    if (!handler) throw new Error('Missing session_event registration')
    // The outer event ID is not a Beacon request ID. Repetition cannot establish ownership.
    const event = { id: 'b', topic, params: { event: { name: 'requestAcknowledged', data } } }
    handler(event)
    handler(event)
    await flush()
    expect(responses).toEqual([expected('a', 'sign', false)])
    await complete(1, 'b', 'operation', false)
    expect(responses).toEqual([expected('a', 'sign', false), expected('b', 'operation', false)])
  })
  it('keeps permission IDs through reconnect, rejection, and a later sign request', async () => {
    const permission = (id: string) =>
      serializer.serialize({
        id,
        type: BeaconMessageType.PermissionRequest,
        version: '2',
        senderId: 'dapp',
        network: { type: NetworkType.MAINNET },
        appMetadata: { name: 'dapp', senderId: 'dapp' }
      })
    await client.sendMessage(await permission('permission-a'))
    await flush()
    expect(mockApprovals).toHaveLength(1)
    mockApprovals[0].resolve(session('current'))
    await flush()
    expect(responses).toEqual([
      expect.objectContaining({ id: 'permission-a', type: BeaconMessageType.PermissionResponse })
    ])
    await client.sendMessage(await permission('permission-b'))
    await flush()
    mockApprovals[1].reject(new Error('wallet rejected'))
    await flush()
    expect(responses[1]).toEqual(expected('permission-b', 'sign', true))
    await send('sign-after-permissions', 'sign')
    await complete(0, 'sign-after-permissions', 'sign', false)
    expect(responses[2]).toEqual(expected('sign-after-permissions', 'sign', false))
  })

  it('discards a permission approval after public close without resurrecting the session', async () => {
    await client.sendMessage(
      await serializer.serialize({
        id: 'permission',
        type: BeaconMessageType.PermissionRequest,
        version: '2',
        senderId: 'dapp',
        network: { type: NetworkType.MAINNET },
        appMetadata: { name: 'dapp', senderId: 'dapp' }
      })
    )
    await flush()
    expect(mockApprovals).toHaveLength(1)
    await client.close()
    mockApprovals[0].resolve(session('late-permission'))
    await flush()
    expect(client.currentSession()).toBeUndefined()
    expect(mockRemote.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'late-permission' })
    )
    expect(responses).toEqual([expected('permission', 'sign', true)])
  })

  it('does not duplicate an in-flight request or retain state after repeated public cancellations', async () => {
    for (let index = 0; index < 5; index++) {
      await send(`cancel-${index}`, 'operation')
      await send(`cancel-${index}`, 'operation')
      expect(mockRequests).toHaveLength(index + 1)
      client.cancelRequest(`cancel-${index}`)
      client.cancelRequest(`cancel-${index}`)
      client.cancelRequest('unknown')
    }
    const pending: unknown = Reflect.get(client, 'pendingRequests')
    if (!(pending instanceof Map)) throw new Error('Missing pending ownership map')
    expect(pending.size).toBe(0)
    for (const request of mockRequests) request.reply.reject(new Error('late error'))
    await flush()
    expect(responses).toEqual([])
    await send('live', 'sign')
    await complete(5, 'live', 'sign', false)
    expect(responses).toEqual([expected('live', 'sign', false)])
    expect(pending.size).toBe(0)
  })

  it('cleans up a permission approval that arrives after its adapter deadline', async () => {
    await client.sendMessage(
      await serializer.serialize({
        id: 'permission-timeout',
        type: BeaconMessageType.PermissionRequest,
        version: '2',
        senderId: 'dapp',
        network: { type: NetworkType.MAINNET },
        appMetadata: { name: 'dapp', senderId: 'dapp' }
      })
    )
    await flush()
    expect(mockApprovals).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_001)
    expect(responses).toEqual([expected('permission-timeout', 'sign', true)])
    mockApprovals[0].resolve(session('late-after-timeout'))
    await flush()
    expect(mockRemote.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'late-after-timeout' })
    )
    expect(client.currentSession()?.topic).toBe('current')
    expect(responses).toHaveLength(1)
  })
  it('adopts a newly approved permission session even when the wallet controller is unchanged', async () => {
    await client.sendMessage(
      await serializer.serialize({
        id: 'permission-replace',
        type: BeaconMessageType.PermissionRequest,
        version: '2',
        senderId: 'dapp',
        network: { type: NetworkType.MAINNET },
        appMetadata: { name: 'dapp', senderId: 'dapp' }
      })
    )
    await flush()
    mockApprovals[0].resolve(session('new-topic-same-controller'))
    await flush()
    expect(client.currentSession()?.topic).toBe('new-topic-same-controller')
    expect(responses).toEqual([
      expect.objectContaining({
        id: 'permission-replace',
        senderId: 'new-topic-same-controller',
        type: BeaconMessageType.PermissionResponse
      })
    ])
  })

  it('closing the SignClient invalidates old requests even when restoration keeps the same topic', async () => {
    await send('old-client', 'sign')
    await client.closeSignClient()
    restoreSession('current')
    await client.init()
    await send('new-client', 'sign')
    await complete(0, 'old-client', 'sign', false)
    expect(responses).toEqual([expected('old-client', 'sign', true)])
    await complete(1, 'new-client', 'sign', false)
    expect(responses).toEqual([
      expected('old-client', 'sign', true),
      expected('new-client', 'sign', false)
    ])
  })

  it('an obsolete session-delete event does not mark the replacement as disconnected', async () => {
    restoreSession('replacement')
    await client.init()
    const deleted = mockHandlers.get('session_delete')
    if (!deleted) throw new Error('Missing session-delete handler')
    deleted({ topic: 'current' })
    await flush()
    expect(client.disconnectionEvents.size).toBe(0)
    await send('live', 'sign')
    await complete(0, 'live', 'sign', false)
    expect(responses).toEqual([expected('live', 'sign', false, 'replacement')])
  })

  it('rejects an invalid permission approval with its own ID and preserves the active session', async () => {
    await client.sendMessage(
      await serializer.serialize({
        id: 'invalid-permission',
        type: BeaconMessageType.PermissionRequest,
        version: '2',
        senderId: 'dapp',
        network: { type: NetworkType.MAINNET },
        appMetadata: { name: 'dapp', senderId: 'dapp' }
      })
    )
    await flush()
    const invalid = session('invalid-topic')
    invalid.controller = 'new-controller'
    invalid.namespaces.tezos.methods = []
    mockApprovals[0].resolve(invalid)
    await flush()
    expect(responses).toEqual([expected('invalid-permission', 'sign', true)])
    expect(client.currentSession()?.topic).toBe('current')
    expect(mockRemote.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'invalid-topic' })
    )
  })
  it('ignores getAccounts completion after its permission request is cancelled', async () => {
    await client.sendMessage(
      await serializer.serialize({
        id: 'permission-fetch',
        type: BeaconMessageType.PermissionRequest,
        version: '2',
        senderId: 'dapp',
        network: { type: NetworkType.MAINNET },
        appMetadata: { name: 'dapp', senderId: 'dapp' }
      })
    )
    await flush()
    const approved = session('current')
    delete approved.sessionProperties
    mockApprovals[0].resolve(approved)
    await flush()
    expect(mockRequests[0].input.request.method).toBe('tezos_getAccounts')
    client.cancelRequest('permission-fetch')
    await send('live-after-fetch', 'sign')
    mockRequests[0].reply.resolve([{ algo: 'ed25519', address: 'tz1-test', pubkey: 'edpk-test' }])
    await flush()
    expect(responses).toEqual([])
    await complete(1, 'live-after-fetch', 'sign', false)
    expect(responses).toEqual([expected('live-after-fetch', 'sign', false)])
  })

  it.each<Kind>(['sign', 'operation'])(
    'keeps an older %s rejection separate from a newer success',
    async (kind) => {
      await send('older', kind)
      await send('newer', kind)
      await complete(1, 'newer', kind, false)
      await complete(0, 'older', kind, true)
      expect(responses).toEqual([expected('newer', kind, false), expected('older', kind, true)])
    }
  )

  it('does not admit a decoded request after close has already invalidated ownership', async () => {
    const encoded = await serializer.serialize({
      id: 'decoding',
      type: BeaconMessageType.SignPayloadRequest,
      version: '2',
      senderId: 'dapp',
      payload: 'aa',
      signingType: SigningType.RAW
    })
    const sending = client.sendMessage(encoded)
    const closing = client.close()
    await Promise.all([sending, closing])
    await flush()
    expect(mockRequests).toHaveLength(0)
    expect(responses).toEqual([expected('decoding', 'sign', true)])
  })

  it('does not admit an old decoded request while relayer close is waiting', async () => {
    const encoded = await serializer.serialize({
      id: 'decoding-client',
      type: BeaconMessageType.SignPayloadRequest,
      version: '2',
      senderId: 'dapp',
      payload: 'aa',
      signingType: SigningType.RAW
    })
    mockRemote.core.relayer.transportClose.mockImplementationOnce(() => new Promise<void>(() => {}))
    const sending = client.sendMessage(encoded)
    const closing = client.closeSignClient()
    try {
      await sending
      await flush()
      expect(mockRequests).toHaveLength(0)
    } finally {
      await vi.advanceTimersByTimeAsync(10_001)
      await closing
    }
    expect(responses).toEqual([expected('decoding-client', 'sign', true)])
  })

  it('retains a validated permission approval when closing the old remote session fails', async () => {
    await client.sendMessage(
      await serializer.serialize({
        id: 'permission-old-close-fails',
        type: BeaconMessageType.PermissionRequest,
        version: '2',
        senderId: 'dapp',
        network: { type: NetworkType.MAINNET },
        appMetadata: { name: 'dapp', senderId: 'dapp' }
      })
    )
    await flush()
    mockRemote.disconnect.mockRejectedValueOnce(new Error('old session already deleted'))
    mockApprovals[0].resolve(session('approved-new-topic'))
    await flush()
    expect(client.currentSession()?.topic).toBe('approved-new-topic')
    expect(responses).toEqual([
      expect.objectContaining({
        id: 'permission-old-close-fails',
        senderId: 'approved-new-topic',
        type: BeaconMessageType.PermissionResponse
      })
    ])
    expect(mockRemote.disconnect).not.toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'approved-new-topic' })
    )
  })

  it('does not reset pairing when a selected session closes', async () => {
    const reset = vi.fn()
    client.eventHandlers.set(ClientEvents.RESET_STATE, reset)
    const handler = mockHandlers.get('session_delete')
    if (!handler) throw new Error('Missing session_delete registration')
    handler({ topic: 'current' })
    await flush()
    expect(reset).not.toHaveBeenCalled()
    expect(client.currentSession()).toBeUndefined()
    expect(responses).toEqual([
      expect.objectContaining({ type: BeaconMessageType.Disconnect, senderId: 'current' })
    ])
  })

  it('resets pairing state when the current session closes before account selection', async () => {
    await client.listenForChannelOpening(() => true)
    await client.init(true)
    mockApprovals[0].resolve(session('initial-pairing'))
    await flush()
    expect(client.currentSession()?.topic).toBe('initial-pairing')
    const reset = vi.fn()
    client.eventHandlers.set(ClientEvents.RESET_STATE, reset)
    const handler = mockHandlers.get('session_delete')
    if (!handler) throw new Error('Missing session_delete registration')
    handler({ topic: 'initial-pairing' })
    await flush()
    expect(reset).toHaveBeenCalledTimes(1)
    expect(client.currentSession()).toBeUndefined()
  })

  it('discards invalid initial approval and permits a later valid pairing', async () => {
    const closeAlert = vi.fn()
    client.eventHandlers.set(ClientEvents.CLOSE_ALERT, closeAlert)
    await client.listenForChannelOpening(() => true)
    await client.init(true)
    const invalid = session('invalid-initial')
    invalid.namespaces.tezos.methods = []
    mockApprovals[0].resolve(invalid)
    await flush()
    expect(client.currentSession()).toBeUndefined()
    expect(closeAlert).not.toHaveBeenCalled()
    expect(mockRemote.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'invalid-initial' })
    )
    await client.init(true)
    mockApprovals[1].resolve(session('valid-initial'))
    await flush()
    expect(client.currentSession()?.topic).toBe('valid-initial')
    expect(responses).toEqual([])
  })
})
