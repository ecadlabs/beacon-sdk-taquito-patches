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
  TransportStatus
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

function localError(id: string, errorType: BeaconErrorType): ErrorResponse {
  return { id, type: BeaconMessageType.Error, errorType, senderId: '', version: '2' }
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
      const error = { ...localError(pending.id, BeaconErrorType.ABORTED_ERROR), senderId: 'wallet' }
      await receiveWallet(error)
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({ error })
      expect(bus.endpoints[0].sent).toEqual([
        { type: 'RESPONSE', id: pending.id, data: { message: error, connectionInfo } }
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
      expect(bus.endpoints[0].sent).toHaveLength(1)
      expect(followerFailed).toHaveBeenCalledTimes(1)
    }
  )
})
