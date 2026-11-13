import {
  CommunicationClient,
  LocalStorage,
  PeerManager,
  Serializer,
  Transport
} from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessageType,
  ConnectionContext,
  ExtendedPostMessagePairingResponse,
  NetworkType,
  Origin,
  PeerInfoType,
  PermissionScope,
  SigningType,
  StorageKey,
  TransportType
} from '@ecadlabs/beacon-types'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { BeaconEvent } from '../../src/events'
import type { BeaconMessageDisposition, BeaconMessageRecord } from '../../src'

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  ...(await import('../../../beacon-core/src/transports/clients/ClientEvents')),
  MultiTabChannel: class {
    async init() {}
    isLeader() {
      return true
    }
    async hasLeader() {
      return true
    }
    async getLeadership() {}
    postMessage() {}
    async close() {}
  }
}))
vi.mock('@ecadlabs/beacon-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-ui')>()),
  isMobileOS: () => false,
  isDesktop: () => true
}))

class ControlledClient extends CommunicationClient {
  readonly sent: string[] = []
  async sendMessage(message: string): Promise<void> {
    this.sent.push(message)
  }
  async unsubscribeFromEncryptedMessages(): Promise<void> {}
  async unsubscribeFromEncryptedMessage(): Promise<void> {}
}

class ControlledTransport extends Transport<
  PeerInfoType,
  StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP,
  ControlledClient
> {
  readonly sent: string[]
  constructor(
    storage: LocalStorage,
    readonly type: TransportType,
    readonly context: ConnectionContext
  ) {
    const client = new ControlledClient()
    super(
      'Observer test',
      client,
      new PeerManager(storage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
    )
    this.sent = client.sent
  }
  async listen(): Promise<void> {}
  async receive(message: unknown): Promise<void> {
    await this.notifyListeners(await new Serializer().serialize(message), this.context)
  }
}

const peer: ExtendedPostMessagePairingResponse = {
  type: 'postmessage-pairing-response',
  id: 'observer-peer',
  name: 'Observer wallet',
  publicKey: '22'.repeat(32),
  senderId: 'wallet-sender',
  extensionId: 'observer-extension',
  version: '3'
}
const account: AccountInfo = {
  accountIdentifier: 'observer-account',
  senderId: peer.senderId,
  origin: { type: Origin.EXTENSION, id: peer.extensionId },
  address: 'tz1TGu6TN5GSez2ndXXeDX6LgUDvLzPLqgYV',
  network: { type: NetworkType.MAINNET },
  scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST],
  connectedAt: 1,
  walletType: 'implicit'
}
const epoch = 1_800_000_000_000
const transports = [
  {
    transportType: TransportType.POST_MESSAGE,
    origin: Origin.EXTENSION,
    connectionId: peer.extensionId
  },
  { transportType: TransportType.P2P, origin: Origin.P2P, connectionId: peer.publicKey }
]

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object')
  return Object.fromEntries(Object.entries(value))
}
function messageId(value: unknown): string {
  const id = object(value).id
  if (typeof id !== 'string') throw new Error('Missing Beacon message ID')
  return id
}
function signature(id: string) {
  return {
    id,
    version: '2',
    senderId: peer.senderId,
    type: BeaconMessageType.SignPayloadResponse,
    signingType: SigningType.RAW,
    signature: 'wallet-signature'
  }
}
function observe(pending: Promise<unknown>) {
  return pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
}

describe('DAppClient plaintext message observers (#149)', () => {
  let dapp: DAppClient
  let transport: ControlledTransport
  const records: BeaconMessageRecord[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    records.length = 0
  })
  afterEach(async () => {
    await dapp?.destroy()
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function start(config = transports[0], requestTimeoutMs = 0) {
    const storage = new LocalStorage('message-observer')
    transport = new ControlledTransport(storage, config.transportType, {
      origin: config.origin,
      id: config.connectionId
    })
    dapp = new DAppClient({
      name: 'Message observer',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      requestTimeoutMs
    })
    await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    await dapp.getActiveAccount()
    await transport.addPeer(peer)
    await transport.connect()
    await dapp.init(transport)
    dapp['resolveActivePeer'](peer)
    // A caller-supplied transport is not one of the built-in per-origin transport slots.
    dapp['getPeer'] = async () => peer
    vi.spyOn(dapp, 'getActiveAccount').mockResolvedValue({
      ...account,
      origin: { type: config.origin, id: config.connectionId }
    })
    vi.spyOn(dapp, 'checkPermissions').mockResolvedValue(true)
    dapp.addBlockchain({
      identifier: 'tezos',
      async validateRequest() {},
      async handleResponse() {},
      async getAccountInfosFromPermissionResponse() {
        return []
      },
      async getWalletLists() {
        return { extensionList: [], desktopList: [], webList: [], iOSList: [] }
      }
    })
    vi.setSystemTime(epoch)
  }
  function subscribe() {
    return dapp.subscribeToMessages((record) => {
      records.push(record)
    })
  }
  async function sign() {
    const outcome = observe(
      dapp.requestSignPayload({ payload: 'aa', signingType: SigningType.RAW })
    )
    await vi.advanceTimersByTimeAsync(0)
    const wire = await new Serializer().deserialize(transport.sent[transport.sent.length - 1])
    return { outcome, wire, id: messageId(wire) }
  }

  it.each(transports.flatMap((config) => ['2', '3'].map((version) => ({ ...config, version }))))(
    'observes V$version plaintext requests and responses over $transportType',
    async ({ version, ...config }) => {
      await start(config)
      subscribe()
      const sequence: string[] = []
      dapp.subscribeToMessages((record) => sequence.push(record.direction))
      const serialize = Serializer.prototype.serialize
      vi.spyOn(Serializer.prototype, 'serialize').mockImplementation(function (message) {
        sequence.push('serialize')
        return serialize.call(this, message)
      })
      const outcome = observe(
        version === '2'
          ? dapp.requestSignPayload({ payload: 'aa', signingType: SigningType.RAW })
          : dapp.request({
              type: BeaconMessageType.BlockchainRequest,
              blockchainIdentifier: 'tezos',
              accountId: account.accountIdentifier,
              blockchainData: { type: 'sign', scope: 'sign', payload: 'aa' }
            })
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.sent).toHaveLength(1)
      const wire = await new Serializer().deserialize(transport.sent[0])
      const id = messageId(wire)
      expect(sequence.slice(0, 2)).toEqual(['outgoing', 'serialize'])
      expect(records).toEqual([
        {
          direction: 'outgoing',
          transport: config.transportType,
          senderId: peer.senderId,
          ts: epoch,
          message: wire
        }
      ])
      vi.setSystemTime(epoch + 100)
      const reply =
        version === '2'
          ? signature(id)
          : {
              id,
              version: '3',
              senderId: peer.senderId,
              message: {
                type: BeaconMessageType.BlockchainResponse,
                blockchainIdentifier: 'tezos',
                blockchainData: { signature: 'wallet-signature' }
              }
            }
      await transport.receive(reply)
      await vi.advanceTimersByTimeAsync(0)
      expect(await outcome).toHaveProperty('value')
      expect(records).toHaveLength(3)
      expect(records[1]).toEqual({
        direction: 'incoming',
        transport: config.transportType,
        senderId: peer.senderId,
        ts: epoch + 100,
        message: reply
      })
      expect(records[2]).toEqual({
        direction: 'incoming',
        transport: config.transportType,
        senderId: peer.senderId,
        ts: epoch + 100,
        message: reply,
        disposition: 'handled'
      })
      expect(messageId(records[0].message)).toBe(messageId(records[1].message))
    }
  )

  it('delivers incoming records synchronously before asynchronous response enrichment', async () => {
    await start()
    subscribe()
    const outcome = observe(
      dapp.request({
        type: BeaconMessageType.BlockchainRequest,
        blockchainIdentifier: 'tezos',
        accountId: account.accountIdentifier,
        blockchainData: { type: 'sign', scope: 'sign' }
      })
    )
    await vi.advanceTimersByTimeAsync(0)
    const wire = await new Serializer().deserialize(transport.sent[0])
    const gate = new ExposedPromise<{ name: string }>()
    const metadataLookup = vi.fn(() => gate.promise)
    dapp['getWalletInfo'] = metadataLookup
    vi.setSystemTime(epoch + 100)
    const reply = {
      id: messageId(wire),
      version: '3',
      senderId: peer.senderId,
      message: {
        type: BeaconMessageType.BlockchainResponse,
        blockchainIdentifier: 'tezos',
        blockchainData: { signature: 'completed' }
      }
    }
    const handling = transport.receive(reply)
    await vi.advanceTimersByTimeAsync(0)
    try {
      expect(metadataLookup).toHaveBeenCalled()
      expect(records).toHaveLength(2)
      expect(records[1]).toMatchObject({ direction: 'incoming', ts: epoch + 100, message: reply })
      expect(records[1].disposition).toBeUndefined()
    } finally {
      vi.setSystemTime(epoch + 1000)
      gate.resolve({ name: peer.name })
    }
    await handling
    await vi.advanceTimersByTimeAsync(0)
    expect(await outcome).toHaveProperty('value')
    expect(records).toHaveLength(3)
    expect(records[2]).toMatchObject({
      direction: 'incoming',
      ts: epoch + 1000,
      message: reply,
      disposition: 'handled'
    })
  })

  it('labels an incoming message with its delivering transport, not the selected transport', async () => {
    await start()
    subscribe()
    const other = new ControlledTransport(
      new LocalStorage('other-observer-transport'),
      TransportType.P2P,
      { origin: Origin.P2P, id: 'other-peer' }
    )
    await dapp['setTransport'](other)
    await transport.receive(signature('unknown'))
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      direction: 'incoming',
      transport: TransportType.POST_MESSAGE
    })
    expect(records[0].disposition).toBeUndefined()
    expect(records[1]).toMatchObject({
      direction: 'incoming',
      transport: TransportType.POST_MESSAGE,
      disposition: 'unknown-request'
    })
  })

  it('gives all observers a deeply frozen detached snapshot without freezing the SDK message', async () => {
    await start()
    subscribe()
    const pending = await sign()
    const reply = { ...signature(pending.id), extension: { values: ['original'] } }
    vi.spyOn(Serializer.prototype, 'deserialize').mockResolvedValueOnce(reply)
    const mutationAttempts = vi.fn()
    dapp.subscribeToMessages((record) => {
      if (record.direction !== 'incoming') return
      const payload = record.message
      expect(payload).not.toBe(reply)
      expect(Object.isFrozen(record)).toBe(true)
      expect(Object.isFrozen(payload)).toBe(true)
      if (!payload || typeof payload !== 'object' || !('extension' in payload))
        throw new Error('Missing extension')
      const nested = payload.extension
      if (
        !nested ||
        typeof nested !== 'object' ||
        !('values' in nested) ||
        !Array.isArray(nested.values)
      )
        throw new Error('Missing nested array')
      expect(Object.isFrozen(nested)).toBe(true)
      expect(Object.isFrozen(nested.values)).toBe(true)
      expect(() => Object.assign(record, { ts: 0 })).toThrow(TypeError)
      expect(() => Object.assign(payload, { signature: 'mutated' })).toThrow(TypeError)
      const values = nested.values
      expect(() => values.push('mutated')).toThrow(TypeError)
      mutationAttempts()
    })
    const next = vi.fn()
    dapp.subscribeToMessages(next)
    await transport.receive(reply)
    await vi.advanceTimersByTimeAsync(0)
    expect(mutationAttempts).toHaveBeenCalledTimes(2)
    expect(await pending.outcome).toMatchObject({
      value: { signature: 'wallet-signature', extension: { values: ['original'] } }
    })
    expect(next).toHaveBeenCalledTimes(2)
    expect(next).toHaveBeenNthCalledWith(1, records[1])
    expect(next).toHaveBeenNthCalledWith(2, records[2])
    expect(Object.isFrozen(reply)).toBe(false)
    expect(Object.isFrozen(reply.extension.values)).toBe(false)
    reply.extension.values.push('later')
    expect(records[1].message).toMatchObject({ extension: { values: ['original'] } })
    expect(records[2].message).toMatchObject({ extension: { values: ['original'] } })
  })

  it('detaches and freezes outgoing nested data before serialization without freezing caller input', async () => {
    await start()
    const blockchainData = { type: 'sign', scope: 'sign', details: { values: ['original'] } }
    const attempts = vi.fn()
    dapp.subscribeToMessages((record) => {
      if (record.direction !== 'outgoing') return
      const envelope = object(record.message)
      const message = object(envelope.message)
      const data = object(message.blockchainData)
      const details = object(data.details)
      const values = details.values
      if (!Array.isArray(values)) throw new Error('Missing nested array')
      expect(data.details).not.toBe(blockchainData.details)
      expect(Object.isFrozen(data.details)).toBe(true)
      expect(Object.isFrozen(details.values)).toBe(true)
      expect(() => values.push('mutated')).toThrow(TypeError)
      attempts()
    })
    subscribe()
    const outcome = observe(
      dapp.request({
        type: BeaconMessageType.BlockchainRequest,
        blockchainIdentifier: 'tezos',
        accountId: account.accountIdentifier,
        blockchainData
      })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toHaveBeenCalledTimes(1)
    const wire = await new Serializer().deserialize(transport.sent[0])
    expect(wire).toMatchObject({ message: { blockchainData } })
    expect(Object.isFrozen(blockchainData)).toBe(false)
    expect(Object.isFrozen(blockchainData.details.values)).toBe(false)
    blockchainData.details.values.push('later')
    expect(records[0].message).toMatchObject({
      message: { blockchainData: { details: { values: ['original'] } } }
    })
    await transport.receive({
      id: messageId(wire),
      version: '3',
      senderId: peer.senderId,
      message: {
        type: BeaconMessageType.BlockchainResponse,
        blockchainIdentifier: 'tezos',
        blockchainData: { signature: 'completed' }
      }
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await outcome).toHaveProperty('value')
  })

  it('isolates throwing and rejected-promise observers from request settlement and other listeners', async () => {
    await start()
    dapp.subscribeToMessages(() => {
      throw new Error('sync observer failed')
    })
    dapp.subscribeToMessages(async () => {
      throw new Error('async observer failed')
    })
    subscribe()
    const pending = await sign()
    await transport.receive(signature(pending.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(await pending.outcome).toHaveProperty('value')
    expect(records.map((record) => [record.direction, record.disposition])).toEqual([
      ['outgoing', undefined],
      ['incoming', undefined],
      ['incoming', 'handled']
    ])
  })

  it('deduplicates listeners, removes them idempotently, and preserves a later subscription', async () => {
    await start()
    const listener = vi.fn()
    const other = vi.fn()
    const first = dapp.subscribeToMessages(listener)
    const duplicate = dapp.subscribeToMessages(listener)
    dapp.subscribeToMessages(other)
    await transport.receive(signature('unknown-1'))
    expect(listener).toHaveBeenCalledTimes(2)
    duplicate()
    duplicate()
    await transport.receive(signature('unknown-2'))
    expect(listener).toHaveBeenCalledTimes(2)
    const current = dapp.subscribeToMessages(listener)
    first()
    duplicate()
    await transport.receive(signature('unknown-3'))
    expect(listener).toHaveBeenCalledTimes(4)
    current()
    await transport.receive(signature('unknown-4'))
    expect(listener).toHaveBeenCalledTimes(4)
    expect(other).toHaveBeenCalledTimes(8)
  })

  it('allows self-unsubscription without skipping another observer', async () => {
    await start()
    let stop = () => {}
    const first = vi.fn(() => stop())
    const second = vi.fn()
    stop = dapp.subscribeToMessages(first)
    dapp.subscribeToMessages(second)
    await transport.receive(signature('unknown-1'))
    await transport.receive(signature('unknown-2'))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(4)
  })

  it.each(
    [
      null,
      42,
      'malformed',
      [],
      { unexpected: { nested: true } },
      { id: 'unknown', type: 'not-a-beacon-type', senderId: 42 }
    ].map((malformed) => ({ malformed }))
  )('observes malformed deserialized input before routing: $malformed', async ({ malformed }) => {
    await start()
    subscribe()
    // The observer must expose the value at the boundary and then report disposition: 'invalid'.
    await transport.receive(malformed)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      direction: 'incoming',
      transport: TransportType.POST_MESSAGE,
      ts: epoch
    })
    expect(records[0].disposition).toBeUndefined()
    expect(records[0].message).toEqual(malformed)
    expect(records[0].senderId).toBeUndefined()
    expect(records[1]).toMatchObject({
      direction: 'incoming',
      transport: TransportType.POST_MESSAGE,
      ts: epoch,
      disposition: 'invalid'
    })
    expect(records[1].message).toEqual(malformed)
    expect(records[1].senderId).toBeUndefined()
  })

  it('observes a stale response after timeout without emitting success', async () => {
    await start(transports[0], 25)
    subscribe()
    const succeeded = vi.fn()
    await dapp.subscribeToEvent(BeaconEvent.SIGN_REQUEST_SUCCESS, succeeded)
    const pending = await sign()
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending.outcome).toMatchObject({
      error: { errorType: BeaconErrorType.PEER_UNREACHABLE }
    })
    await transport.receive(signature(pending.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(records).toHaveLength(3)
    expect(records[1].message).toEqual(signature(pending.id))
    expect(records[1].disposition).toBeUndefined()
    expect(records[2].message).toEqual(signature(pending.id))
    expect(records[2].disposition).toBe('stale')
    expect(succeeded).not.toHaveBeenCalled()
  })

  it('emits boundary record followed by disposition record across handled, stale, unknown-request, and invalid outcomes', async () => {
    await start(transports[0], 25)
    subscribe()

    // 1. handled (Acknowledge + SignPayloadResponse)
    const pendingHandled = await sign()
    const ackMsg = {
      id: pendingHandled.id,
      version: '2',
      senderId: peer.senderId,
      type: BeaconMessageType.Acknowledge
    }
    await transport.receive(ackMsg)
    await vi.advanceTimersByTimeAsync(0)
    await transport.receive(signature(pendingHandled.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(await pendingHandled.outcome).toHaveProperty('value')

    // 2. stale (timed out request)
    const pendingStale = await sign()
    await vi.advanceTimersByTimeAsync(25)
    expect(await pendingStale.outcome).toMatchObject({
      error: { errorType: BeaconErrorType.PEER_UNREACHABLE }
    })
    await transport.receive(signature(pendingStale.id))
    await vi.advanceTimersByTimeAsync(0)

    // 3. unknown-request (never sent request ID)
    await transport.receive(signature('never-sent-request-id'))
    await vi.advanceTimersByTimeAsync(0)

    // 4. invalid (malformed message)
    await transport.receive({ id: 'bad-msg', version: '2', senderId: peer.senderId, type: 'unknown_type' })
    await vi.advanceTimersByTimeAsync(0)

    const incomingDispositions: Array<BeaconMessageDisposition | undefined> = records
      .filter((r) => r.direction === 'incoming')
      .map((r) => r.disposition)

    expect(incomingDispositions).toEqual([
      undefined,
      'handled',
      undefined,
      'handled',
      undefined,
      'stale',
      undefined,
      'unknown-request',
      undefined,
      'invalid'
    ])
  })

  it.each(['serialization', 'send'])(
    'records an outgoing attempt when %s fails without a SENT event',
    async (failure) => {
      await start()
      subscribe()
      const sent = vi.fn()
      await dapp.subscribeToEvent(BeaconEvent.SIGN_REQUEST_SENT, sent)
      const error = new Error('Dispatch failed')
      if (failure === 'serialization')
        vi.spyOn(Serializer.prototype, 'serialize').mockRejectedValueOnce(error)
      else vi.spyOn(transport, 'send').mockRejectedValueOnce(error)
      const outcome = observe(
        dapp.requestSignPayload({ payload: 'aa', signingType: SigningType.RAW })
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(await outcome).toEqual({ error })
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        direction: 'outgoing',
        transport: TransportType.POST_MESSAGE,
        message: { type: BeaconMessageType.SignPayloadRequest, payload: 'aa' }
      })
      expect(sent).not.toHaveBeenCalled()
      expect(transport.sent).toEqual([])
    }
  )

  it.each([false, true])(
    'does not traverse incoming payload fields without observers (previously subscribed=%s)',
    async (previouslySubscribed) => {
      await start()
      if (previouslySubscribed) subscribe()()
      const pending = await sign()
      const readExtension = vi.fn(() => ({ value: 'untouched' }))
      const reply = Object.defineProperty(signature(pending.id), 'extension', {
        enumerable: true,
        get: readExtension
      })
      vi.spyOn(Serializer.prototype, 'deserialize').mockResolvedValueOnce(reply)
      // Serialize a plain equivalent so only observer-side traversal can touch the accessor.
      await transport.receive(signature(pending.id))
      await vi.advanceTimersByTimeAsync(0)
      expect(await pending.outcome).toHaveProperty('value')
      expect(readExtension).not.toHaveBeenCalled()
      expect(Object.isFrozen(reply)).toBe(false)
      expect(records).toEqual([])
    }
  )

  it.each([false, true])(
    'does no extra outgoing traversal without observers (previously subscribed=%s)',
    async (previouslySubscribed) => {
      await start()
      if (previouslySubscribed) subscribe()()
      const readDetails = vi.fn(() => ({ values: ['original'] }))
      const blockchainData = Object.defineProperty({ type: 'sign', scope: 'sign' }, 'details', {
        enumerable: true,
        get: readDetails
      })
      const outcome = observe(
        dapp.request({
          type: BeaconMessageType.BlockchainRequest,
          blockchainIdentifier: 'tezos',
          accountId: account.accountIdentifier,
          blockchainData
        })
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.sent).toHaveLength(1)
      // The required wire serialization reads it once. An observer copy must add no traversal.
      expect(readDetails).toHaveBeenCalledTimes(1)
      expect(Object.isFrozen(blockchainData)).toBe(false)
      const wire = await new Serializer().deserialize(transport.sent[0])
      await transport.receive({
        id: messageId(wire),
        version: '3',
        senderId: peer.senderId,
        message: {
          type: BeaconMessageType.BlockchainResponse,
          blockchainIdentifier: 'tezos',
          blockchainData: { signature: 'completed' }
        }
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(await outcome).toHaveProperty('value')
      expect(records).toEqual([])
    }
  )

  it('records disconnect protocol messages without exposing SDK state', async () => {
    await start()
    subscribe()
    await dapp.removePeer(peer, true)
    expect(transport.sent).toHaveLength(1)
    const wire = await new Serializer().deserialize(transport.sent[0])
    expect(object(wire).type).toBe(BeaconMessageType.Disconnect)
    expect(records).toEqual([
      {
        direction: 'outgoing',
        transport: TransportType.POST_MESSAGE,
        senderId: peer.senderId,
        ts: epoch,
        message: wire
      }
    ])
    expect(Object.keys(object(records[0].message)).sort()).toEqual([
      'id',
      'senderId',
      'type',
      'version'
    ])
  })

  it('does not dispatch a request after an observer synchronously destroys the client', async () => {
    await start()
    let destroyed: Promise<void> | undefined
    dapp.subscribeToMessages(() => {
      destroyed = dapp.destroy()
    })
    const outcome = observe(
      dapp.requestSignPayload({ payload: 'aa', signingType: SigningType.RAW })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(destroyed).toBeDefined()
    await destroyed
    expect(await outcome).toMatchObject({ error: { errorType: BeaconErrorType.ABORTED_ERROR } })
    expect(transport.sent).toEqual([])
  })
})
