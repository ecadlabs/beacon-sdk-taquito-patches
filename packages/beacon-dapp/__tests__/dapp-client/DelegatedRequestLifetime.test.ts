import { LocalStorage } from '@ecadlabs/beacon-core'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessageType,
  Blockchain,
  ConnectionContext,
  ErrorResponse,
  NetworkType,
  Origin,
  PermissionScope,
  SigningType,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'
import { BeaconEvent } from '../../src/events'

const bus = vi.hoisted(() => ({
  endpoints: [] as {
    leader: boolean
    receive: (message: unknown) => Promise<void>
    sent: unknown[]
  }[]
}))

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  MultiTabChannel: class {
    readonly endpoint: (typeof bus.endpoints)[number]
    constructor(_name: string, receive: (message: unknown) => Promise<void>) {
      this.endpoint = { leader: bus.endpoints.length === 0, receive, sent: [] }
      bus.endpoints.push(this.endpoint)
    }
    async init() {}
    isLeader() {
      return this.endpoint.leader
    }
    async hasLeader() {
      return true
    }
    async getLeadership() {}
    async close() {}
    postMessage(message: unknown) {
      this.endpoint.sent.push(message)
    }
  },
  IndexedDBStorage: class {
    async get() {
      return undefined
    }
  }
}))
vi.mock('@ecadlabs/beacon-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-ui')>()),
  isMobileOS: () => false,
  isDesktop: () => true
}))

const connectionInfo: ConnectionContext = { origin: Origin.WALLETCONNECT, id: 'current-topic' }
const account: AccountInfo = {
  accountIdentifier: 'delegated-account',
  senderId: 'wallet',
  address: 'tz1TGu6TN5GSez2ndXXeDX6LgUDvLzPLqgYV',
  network: { type: NetworkType.MAINNET },
  scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST],
  origin: { type: connectionInfo.origin, id: connectionInfo.id },
  connectedAt: 1,
  walletType: 'implicit'
}
const blockchain: Blockchain = {
  identifier: 'tezos',
  async validateRequest() {},
  async handleResponse() {},
  async getAccountInfosFromPermissionResponse() {
    return []
  },
  async getWalletLists() {
    return { extensionList: [], desktopList: [], webList: [], iOSList: [] }
  }
}

function observe(promise: Promise<unknown>) {
  const settled = vi.fn()
  const outcome = promise.then(
    (value) => {
      settled({ value })
      return { value }
    },
    (error: unknown) => {
      settled({ error })
      return { error }
    }
  )
  return { settled, outcome }
}

function localError(
  id: string,
  errorType: BeaconErrorType
): ErrorResponse & { errorOrigin: 'wallet' | 'local' } {
  return {
    id,
    type: BeaconMessageType.Error,
    errorType,
    senderId: '',
    version: '2',
    errorOrigin: 'local'
  }
}

function walletSuccess(version: '2' | '3', id: string) {
  return version === '2'
    ? {
        id,
        version,
        senderId: 'wallet',
        type: BeaconMessageType.SignPayloadResponse,
        signature: 'completed-signature',
        signingType: SigningType.RAW
      }
    : {
        id,
        version,
        senderId: 'wallet',
        message: {
          type: BeaconMessageType.BlockchainResponse,
          blockchainIdentifier: 'tezos',
          blockchainData: { signature: 'completed-signature' }
        }
      }
}

describe('Delegated request lifetime', () => {
  let leader: DAppClient
  let follower: DAppClient
  let transport: DappWalletConnectTransport
  let ready: ExposedPromise<boolean>
  const leaderSent = vi.fn()
  const internalError = vi.fn()
  const followerFailed = vi.fn()
  const acknowledged = vi.fn()
  const delivered = new Set<unknown>()
  const deliveryErrors: unknown[] = []

  beforeEach(async () => {
    vi.useFakeTimers()
    localStorage.clear()
    bus.endpoints.length = 0
    delivered.clear()
    deliveryErrors.length = 0
    ready = new ExposedPromise<boolean>()
    Object.defineProperty(window, 'beaconCreatedClientInstance', {
      value: false,
      writable: true,
      configurable: true
    })
    async function create(name: string, isLeader: boolean) {
      const storage = new LocalStorage(name)
      const client = new DAppClient({
        name,
        storage,
        disableDefaultEvents: true,
        enableAppSwitching: false,
        requestTimeoutMs: isLeader ? 25 : 0
      })
      await client.getActiveAccount()
      const adapter = new DappWalletConnectTransport(
        name,
        await getKeypairFromSeed(name),
        storage,
        { network: NetworkType.MAINNET, opts: { projectId: 'offline' } },
        async () => isLeader
      )
      adapter['_isConnected'] = isLeader
        ? TransportStatus.CONNECTED
        : TransportStatus.SECONDARY_TAB_CONNECTED
      vi.spyOn(adapter, 'waitForResolution').mockImplementation(() => ready.promise)
      vi.spyOn(adapter, 'send').mockResolvedValue(undefined)
      vi.spyOn(adapter, 'cancelRequest').mockImplementation(() => {})
      vi.spyOn(adapter, 'disconnect').mockResolvedValue(undefined)
      vi.spyOn(adapter, 'doClientCleanup').mockResolvedValue(undefined)
      vi.spyOn(adapter, 'removeAllPeers').mockResolvedValue(undefined)
      vi.spyOn(adapter, 'getPeers').mockResolvedValue([])
      client['_transport'] = ExposedPromise.resolve<Awaited<DAppClient['transport']>>(adapter)
      client['_activeAccount'] = ExposedPromise.resolve<AccountInfo | undefined>(account)
      vi.spyOn(client, 'getWalletInfo').mockResolvedValue({ name: 'Wallet' })
      vi.spyOn(client, 'init').mockResolvedValue(adapter.type)
      client.addBlockchain(blockchain)
      return { client, adapter }
    }
    const primary = await create('delegated-leader', true)
    leader = primary.client
    transport = primary.adapter
    follower = (await create('delegated-follower', false)).client
    await leader.subscribeToEvent(BeaconEvent.SIGN_REQUEST_SENT, leaderSent)
    await leader.subscribeToEvent(BeaconEvent.OPERATION_REQUEST_SENT, leaderSent)
    await leader.subscribeToEvent(BeaconEvent.INTERNAL_ERROR, internalError)
    await follower.subscribeToEvent(BeaconEvent.SIGN_REQUEST_ERROR, followerFailed)
    await follower.subscribeToEvent(BeaconEvent.OPERATION_REQUEST_ERROR, followerFailed)
    await follower.subscribeToEvent(BeaconEvent.ACKNOWLEDGE_RECEIVED, acknowledged)
    vi.clearAllMocks()
  })

  afterEach(async () => {
    ready.resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    await leader.destroy()
    await follower.destroy()
    await vi.advanceTimersByTimeAsync(0)
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    expect(deliveryErrors).toEqual([])
  })

  function deliverTo(endpoint: number, message: unknown) {
    void bus.endpoints[endpoint].receive(message).catch((error: unknown) => {
      deliveryErrors.push(error)
    })
  }

  async function begin(version: '2' | '3', holdReady = false) {
    if (!holdReady) ready.resolve(true)
    const pending = observe(
      version === '2'
        ? follower.requestSignPayload({ payload: 'aa', signingType: SigningType.RAW })
        : follower.request({
            type: BeaconMessageType.BlockchainRequest,
            blockchainIdentifier: 'tezos',
            accountId: account.accountIdentifier,
            blockchainData: { type: 'sign', scope: 'sign' }
          })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(bus.endpoints[1].sent).toHaveLength(1)
    const request = bus.endpoints[1].sent[0]
    if (
      !request ||
      typeof request !== 'object' ||
      !('id' in request) ||
      typeof request.id !== 'string'
    ) {
      throw new Error('Missing delegated request ID')
    }
    deliverTo(0, request)
    await vi.advanceTimersByTimeAsync(0)
    expect(pending.settled).not.toHaveBeenCalled()
    return { ...pending, request, id: request.id }
  }

  async function deliverResponses() {
    for (const message of bus.endpoints[0].sent) {
      if (delivered.has(message)) continue
      delivered.add(message)
      deliverTo(1, message)
    }
    await vi.advanceTimersByTimeAsync(0)
  }

  async function receiveWallet(message: unknown) {
    deliverTo(0, { type: 'RESPONSE', data: { message, connectionInfo } })
    await vi.advanceTimersByTimeAsync(0)
    await deliverResponses()
  }

  it.each(['2', '3'] as const)(
    'finishes a V%s proxy task after forwarding a wallet response',
    async (version) => {
      // Observe the existing dispatch task without replacing its implementation.
      const v2 = vi.spyOn(
        leader as unknown as { makeRequest: (typeof leader)['makeRequest'] },
        'makeRequest'
      )
      const v3 = vi.spyOn(
        leader as unknown as { makeRequestV3: (typeof leader)['makeRequestV3'] },
        'makeRequestV3'
      )
      const pending = await begin(version)
      expect(transport.send).toHaveBeenCalledTimes(1)
      const dispatched = version === '2' ? v2.mock.results[0].value : v3.mock.results[0].value
      const task = observe(dispatched)
      const response = walletSuccess(version, pending.id)
      await receiveWallet(response)
      expect(pending.settled).toHaveBeenCalledTimes(1)
      await expect(pending.outcome).resolves.toEqual({
        value: 'message' in response ? response.message : response
      })
      expect(bus.endpoints[0].sent).toEqual([
        { type: 'RESPONSE', id: pending.id, data: { message: response, connectionInfo } }
      ])
      expect(task.settled).toHaveBeenCalledTimes(1)
      expect(leaderSent).not.toHaveBeenCalled()
      await receiveWallet(response)
      expect(bus.endpoints[0].sent).toHaveLength(1)
      expect(task.settled).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['2', '3'] as const)(
    'forwards a V%s wallet error once with its original connection',
    async (version) => {
      const v2 = vi.spyOn(
        leader as unknown as { makeRequest: (typeof leader)['makeRequest'] },
        'makeRequest'
      )
      const v3 = vi.spyOn(
        leader as unknown as { makeRequestV3: (typeof leader)['makeRequestV3'] },
        'makeRequestV3'
      )
      const pending = await begin(version)
      const task = observe(version === '2' ? v2.mock.results[0].value : v3.mock.results[0].value)
      const error: ErrorResponse = {
        id: pending.id,
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.ABORTED_ERROR,
        senderId: 'wallet',
        version: '2'
      }
      await receiveWallet(error)
      // The leader marks the wallet's error before forwarding; the follower keeps that mark.
      const forwarded = { ...error, errorOrigin: 'wallet' }
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: forwarded })
      expect(bus.endpoints[0].sent).toEqual([
        { type: 'RESPONSE', id: pending.id, data: { message: forwarded, connectionInfo } }
      ])
      expect(task.settled).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(bus.endpoints[0].sent).toHaveLength(1)
      expect(internalError).not.toHaveBeenCalled()
    }
  )

  it.each(['2', '3'] as const)(
    'accepts a V%s forwarded response while follower wallet details are pending',
    async (version) => {
      const details = new ExposedPromise<Awaited<ReturnType<DAppClient['getWalletInfo']>>>()
      vi.mocked(follower['getWalletInfo']).mockReturnValueOnce(details.promise)
      try {
        const pending = await begin(version)
        expect(transport.send).toHaveBeenCalledTimes(1)
        const response = walletSuccess(version, pending.id)
        await receiveWallet(response)
        expect(bus.endpoints[0].sent).toEqual([
          { type: 'RESPONSE', id: pending.id, data: { message: response, connectionInfo } }
        ])

        details.resolve({ name: 'Wallet' })
        await vi.advanceTimersByTimeAsync(0)
        expect(pending.settled).toHaveBeenCalledExactlyOnceWith({
          value: 'message' in response ? response.message : response
        })
        await vi.advanceTimersByTimeAsync(100)
        expect(pending.settled).toHaveBeenCalledTimes(1)
        expect(followerFailed).not.toHaveBeenCalled()
      } finally {
        details.resolve({ name: 'Wallet' })
      }
    }
  )

  it.each(['2', '3'] as const)(
    'dispatches a repeated live V%s delegated request once',
    async (version) => {
      const pending = await begin(version)
      deliverTo(0, pending.request)
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.send).toHaveBeenCalledTimes(1)
      await receiveWallet(walletSuccess(version, pending.id))
      expect(pending.settled).toHaveBeenCalledTimes(1)
      expect(bus.endpoints[0].sent).toHaveLength(1)
    }
  )

  it.each(['2', '3'] as const)(
    'forwards a V%s ACK once and keeps waiting past the deadline',
    async (version) => {
      const pending = await begin(version)
      const ack = {
        id: pending.id,
        type: BeaconMessageType.Acknowledge,
        version: '2',
        senderId: 'wallet'
      }
      await receiveWallet(ack)
      await receiveWallet(ack)
      await vi.advanceTimersByTimeAsync(100)
      expect(acknowledged).toHaveBeenCalledTimes(1)
      expect(pending.settled).not.toHaveBeenCalled()
      expect(bus.endpoints[0].sent).toHaveLength(1)
      await receiveWallet(walletSuccess(version, pending.id))
      expect(pending.settled).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['2', '3'] as const)(
    'revokes a V%s delegated request while transport readiness is pending',
    async (version) => {
      const pending = await begin(version, true)
      await vi.advanceTimersByTimeAsync(100)
      expect(transport.send).not.toHaveBeenCalled()
      expect(bus.endpoints[0].sent).toEqual([])
      expect(pending.settled).not.toHaveBeenCalled()
      await leader.disconnect({ notifyPeers: false })
      await deliverResponses()
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({
        error: localError(pending.id, BeaconErrorType.ABORTED_ERROR)
      })
      ready.resolve(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.send).not.toHaveBeenCalled()
      expect(bus.endpoints[0].sent).toHaveLength(1)
    }
  )

  it.each(['2', '3'] as const)(
    'forwards a V%s local send failure to a follower with no deadline',
    async (version) => {
      vi.mocked(transport.send).mockRejectedValueOnce(new Error('Send failed'))
      const pending = await begin(version)
      await deliverResponses()
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({
        error: localError(pending.id, BeaconErrorType.UNKNOWN_ERROR)
      })
      expect(bus.endpoints[0].sent).toHaveLength(1)
      expect(followerFailed).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    ['2', 'plain'],
    ['3', 'plain'],
    ['2', 'typed'],
    ['3', 'typed']
  ] as const)('forwards a V%s %s initialization failure before sending', async (version, kind) => {
    const error =
      kind === 'typed'
        ? localError('initialization', BeaconErrorType.ABORTED_ERROR)
        : new Error('Initialization failed')
    vi.mocked(leader.init).mockRejectedValueOnce(error)
    const pending = await begin(version)
    await deliverResponses()
    const errorType =
      kind === 'typed' ? BeaconErrorType.ABORTED_ERROR : BeaconErrorType.UNKNOWN_ERROR
    expect(pending.settled).toHaveBeenCalledExactlyOnceWith({
      error: localError(pending.id, errorType)
    })
    expect(transport.send).not.toHaveBeenCalled()
    expect(bus.endpoints[0].sent).toEqual([
      {
        type: 'RESPONSE',
        id: pending.id,
        data: {
          message: localError(pending.id, errorType),
          connectionInfo: { origin: Origin.WALLETCONNECT, id: '' }
        }
      }
    ])
    expect(followerFailed).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['2', 'timeout'],
    ['3', 'timeout'],
    ['2', 'abort'],
    ['3', 'abort']
  ] as const)(
    'forwards a V%s leader %s to a follower with no deadline',
    async (version, ending) => {
      const pending = await begin(version)
      if (ending === 'timeout') await vi.advanceTimersByTimeAsync(25)
      else await leader.disconnect({ notifyPeers: false })
      await deliverResponses()
      const errorType =
        ending === 'timeout' ? BeaconErrorType.PEER_UNREACHABLE : BeaconErrorType.ABORTED_ERROR
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({
        error: localError(pending.id, errorType)
      })
      await receiveWallet(walletSuccess(version, pending.id))
      expect(pending.settled).toHaveBeenCalledTimes(1)
      // After a timeout the leader forwards the late answer for the follower to report. An
      // abort forgets the request, so nothing more is sent.
      expect(bus.endpoints[0].sent).toHaveLength(ending === 'timeout' ? 2 : 1)
      expect(followerFailed).toHaveBeenCalledTimes(1)
    }
  )
  // The follower receives forwarded results on the same path the leader uses for wallet
  // messages, so `errorOrigin` cannot be trusted by message shape. The leader marks every
  // forwarded wallet error itself; only the follower trusts the mark it gets from the leader.
  it.each(['2', '3'] as const)(
    'forwards a V%s wallet error that claims to be local as errorOrigin wallet',
    async (version) => {
      const pending = await begin(version)
      const spoofed = {
        id: pending.id,
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.PEER_UNREACHABLE,
        senderId: 'wallet',
        version: '2',
        errorOrigin: 'local'
      }
      await receiveWallet(spoofed)
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({
        error: { ...spoofed, errorOrigin: 'wallet' }
      })
      expect(bus.endpoints[0].sent).toEqual([
        {
          type: 'RESPONSE',
          id: pending.id,
          data: { message: { ...spoofed, errorOrigin: 'wallet' }, connectionInfo }
        }
      ])
    }
  )

  // The user sees "did not respond" in the tab that made the request, so that tab is where a
  // late answer has to be reported. The leader forwards it instead of reporting it itself.
  it.each(['2', '3'] as const)(
    'reports a V%s wallet response that reaches the leader after its deadline in the follower',
    async (version) => {
      const late = vi.fn()
      const followerLate = vi.fn()
      await leader.subscribeToEvent(BeaconEvent.LATE_RESPONSE_RECEIVED, (info) => late(info))
      await follower.subscribeToEvent(BeaconEvent.LATE_RESPONSE_RECEIVED, (info) =>
        followerLate(info)
      )
      const pending = await begin(version)
      await vi.advanceTimersByTimeAsync(25)
      await deliverResponses()
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({
        error: localError(pending.id, BeaconErrorType.PEER_UNREACHABLE)
      })

      const response = walletSuccess(version, pending.id)
      await receiveWallet(response)

      expect(followerLate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          kind: 'success',
          requestId: pending.id,
          requestType:
            version === '2'
              ? BeaconMessageType.SignPayloadRequest
              : BeaconMessageType.BlockchainRequest,
          message: response,
          output: 'message' in response ? response.message : response,
          connectionInfo
        })
      )
      expect(late).not.toHaveBeenCalled()
      expect(pending.settled).toHaveBeenCalledTimes(1)
      expect(bus.endpoints[0].sent).toEqual([
        expect.objectContaining({ type: 'RESPONSE', id: pending.id }),
        { type: 'RESPONSE', id: pending.id, data: { message: response, connectionInfo } }
      ])
    }
  )

  it.each(['2', '3'] as const)(
    'forwards a late V%s wallet error to the follower stamped as origin wallet',
    async (version) => {
      const followerLate = vi.fn()
      await follower.subscribeToEvent(BeaconEvent.LATE_RESPONSE_RECEIVED, (info) =>
        followerLate(info)
      )
      const pending = await begin(version)
      await vi.advanceTimersByTimeAsync(25)
      await deliverResponses()

      const inner = {
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.ABORTED_ERROR,
        errorOrigin: 'local'
      }
      await receiveWallet(
        version === '2'
          ? { id: pending.id, version, senderId: 'wallet', ...inner }
          : { id: pending.id, version, senderId: 'wallet', message: inner }
      )

      expect(followerLate).toHaveBeenCalledTimes(1)
      expect(followerLate).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'error',
          error: expect.objectContaining({
            errorType: BeaconErrorType.ABORTED_ERROR,
            errorOrigin: 'wallet'
          })
        })
      )
    }
  )

  // V3 responses carry the error inside the wrapper; the leader must mark that inner error.
  it('forwards a V3-wrapped wallet error that claims to be local as errorOrigin wallet', async () => {
    const pending = await begin('3')
    const spoofed = {
      id: pending.id,
      version: '3',
      senderId: 'wallet',
      message: {
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.PEER_UNREACHABLE,
        errorOrigin: 'local'
      }
    }
    await receiveWallet(spoofed)
    expect(await pending.outcome).toEqual({
      error: expect.objectContaining({
        errorType: BeaconErrorType.PEER_UNREACHABLE,
        errorOrigin: 'wallet'
      })
    })
  })

  // Both tabs run the same options. When the follower's own deadline fires first, the
  // leader's later timeout reaches it as a forwarded local error, which is not a late answer.
  // It must not use up the follower's record either: the wallet's real answer comes later.
  it.each(['2', '3'] as const)(
    'reports a late V%s response in a follower that timed out before the leader',
    async (version) => {
      Object.defineProperty(follower, 'requestTimeoutMs', { value: 20 })
      const late = vi.fn()
      const followerLate = vi.fn()
      await leader.subscribeToEvent(BeaconEvent.LATE_RESPONSE_RECEIVED, (info) => late(info))
      await follower.subscribeToEvent(BeaconEvent.LATE_RESPONSE_RECEIVED, (info) =>
        followerLate(info)
      )
      const pending = await begin(version)
      await vi.advanceTimersByTimeAsync(25)
      await deliverResponses()
      expect(await pending.outcome).toEqual({
        error: expect.objectContaining({
          errorType: BeaconErrorType.PEER_UNREACHABLE,
          errorOrigin: 'local'
        })
      })
      expect(followerLate).not.toHaveBeenCalled()

      await receiveWallet(walletSuccess(version, pending.id))
      expect(followerLate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ kind: 'success', requestId: pending.id })
      )
      expect(late).not.toHaveBeenCalled()
    }
  )

  // The other order: the follower's deadline fires, then the wallet answers before the leader's
  // deadline. The leader forwards a normal response, which reaches the follower late.
  it.each(['2', '3'] as const)(
    'reports a V%s response the leader forwards after only the follower timed out',
    async (version) => {
      Object.defineProperty(follower, 'requestTimeoutMs', { value: 20 })
      const late = vi.fn()
      const followerLate = vi.fn()
      await leader.subscribeToEvent(BeaconEvent.LATE_RESPONSE_RECEIVED, (info) => late(info))
      await follower.subscribeToEvent(BeaconEvent.LATE_RESPONSE_RECEIVED, (info) =>
        followerLate(info)
      )
      const pending = await begin(version)
      await vi.advanceTimersByTimeAsync(22)
      expect(await pending.outcome).toEqual({
        error: expect.objectContaining({ errorType: BeaconErrorType.PEER_UNREACHABLE })
      })

      await receiveWallet(walletSuccess(version, pending.id))
      await vi.advanceTimersByTimeAsync(10)
      await deliverResponses()

      expect(followerLate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ kind: 'success', requestId: pending.id })
      )
      expect(late).not.toHaveBeenCalled()
      expect(pending.settled).toHaveBeenCalledTimes(1)
    }
  )

  // Routing on a string errorType let these resolve as successes in the follower too.
  it.each(['2', '3'] as const)(
    'rejects a forwarded V%s wallet error with no errorType instead of resolving',
    async (version) => {
      const pending = await begin(version)
      await receiveWallet(
        version === '2'
          ? { id: pending.id, version, senderId: 'wallet', type: BeaconMessageType.Error }
          : {
              id: pending.id,
              version,
              senderId: 'wallet',
              message: { type: BeaconMessageType.Error }
            }
      )

      const outcome = await pending.outcome
      expect(outcome).not.toHaveProperty('value')
      expect(outcome).toEqual({
        error: expect.objectContaining({
          type: BeaconMessageType.Error,
          errorType: BeaconErrorType.UNKNOWN_ERROR
        })
      })
      expect(outcome).toEqual({ error: expect.objectContaining({ errorOrigin: 'wallet' }) })
    }
  )

  // The leader stamps by message type. If it only stamped errors with a string errorType, this
  // one would reach the follower unstamped and the follower would trust its claim.
  it.each(['2', '3'] as const)(
    'forwards a V%s wallet error with no errorType that claims to be local as origin wallet',
    async (version) => {
      const pending = await begin(version)
      const inner = { type: BeaconMessageType.Error, errorOrigin: 'local' }
      await receiveWallet(
        version === '2'
          ? { id: pending.id, version, senderId: 'wallet', ...inner }
          : { id: pending.id, version, senderId: 'wallet', message: inner }
      )

      const outcome = await pending.outcome
      expect(outcome).not.toHaveProperty('value')
      expect(outcome).toEqual({ error: expect.objectContaining({ errorOrigin: 'wallet' }) })
    }
  )

  // The WalletConnect adapter builds every message it delivers, so its own local stamp (the
  // sign-client request expiry) is trusted and survives forwarding. The same message arriving
  // on the tab channel is not trusted; see the spoof tests above.
  it.each(['2', '3'] as const)(
    'forwards a V%s WalletConnect expiry from the leader adapter as origin local',
    async (version) => {
      const pending = await begin(version)
      const expiry = {
        id: pending.id,
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.PEER_UNREACHABLE,
        errorOrigin: 'local',
        senderId: 'current-topic',
        version: '2'
      }
      const fromAdapter = leader['handleResponse'] as (
        message: unknown,
        context: ConnectionContext,
        transportType: TransportType
      ) => Promise<void>
      await fromAdapter(expiry, connectionInfo, TransportType.WALLETCONNECT)
      await deliverResponses()

      expect(await pending.outcome).toEqual({
        error: expect.objectContaining({ errorType: BeaconErrorType.PEER_UNREACHABLE })
      })
      expect(await pending.outcome).toEqual({
        error: expect.objectContaining({ errorOrigin: 'local' })
      })
    }
  )
})
