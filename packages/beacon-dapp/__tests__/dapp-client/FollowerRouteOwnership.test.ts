import { LocalStorage, Serializer } from '@ecadlabs/beacon-core'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessageType,
  Blockchain,
  ExtendedP2PPairingResponse,
  NetworkType,
  Origin,
  PermissionScope,
  SigningType,
  StorageKey,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { BeaconEvent } from '../../src/events'

const bus = vi.hoisted(() => ({
  endpoints: [] as {
    onmessage: null | ((message: unknown) => void | Promise<void>)
    sent: unknown[]
    elector: {
      isLeader: boolean
      hasLeader: () => Promise<boolean>
      awaitLeadership: () => Promise<void>
      die: () => Promise<void>
    }
    promote: () => void
  }[],
  errors: [] as unknown[]
}))

vi.mock('broadcast-channel', () => ({
  BroadcastChannel: class {
    readonly endpoint: (typeof bus.endpoints)[number]
    constructor() {
      let resolveElection = () => {}
      const election = new Promise<void>((resolve) => {
        resolveElection = resolve
      })
      const endpoint: (typeof bus.endpoints)[number] = {
        onmessage: null,
        sent: [],
        elector: {
          isLeader: bus.endpoints.length === 0,
          hasLeader: async () => true,
          awaitLeadership: () => election,
          die: async () => {
            endpoint.elector.isLeader = false
          }
        },
        promote: () => {
          endpoint.elector.isLeader = true
          resolveElection()
        }
      }
      this.endpoint = endpoint
      bus.endpoints.push(endpoint)
    }
    get onmessage() {
      return this.endpoint.onmessage
    }
    set onmessage(receive: (typeof this.endpoint)['onmessage']) {
      this.endpoint.onmessage = receive
    }
    postMessage(message: unknown) {
      this.endpoint.sent.push(message)
    }
    removeEventListener() {}
    async close() {}
  },
  createLeaderElection: (channel: { endpoint: (typeof bus.endpoints)[number] }) =>
    channel.endpoint.elector
}))
vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  ...(await import('../../../beacon-core/src/utils/multi-tab-channel')),
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

const account: AccountInfo = {
  accountIdentifier: 'follower-account',
  senderId: 'wallet',
  address: 'tz1TGu6TN5GSez2ndXXeDX6LgUDvLzPLqgYV',
  network: { type: NetworkType.MAINNET },
  scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST],
  origin: { type: Origin.WALLETCONNECT, id: 'current-topic' },
  connectedAt: 1,
  walletType: 'implicit'
}
const connectionInfo = { origin: Origin.WALLETCONNECT, id: 'current-topic' }
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

function deliver(index: number, message: unknown) {
  const receive = bus.endpoints[index].onmessage
  if (!receive) throw new Error('Missing channel listener')
  void Promise.resolve(receive(message)).catch((error: unknown) => bus.errors.push(error))
}

function response(id: string) {
  return {
    type: 'RESPONSE',
    id,
    data: {
      message: {
        id,
        type: BeaconMessageType.SignPayloadResponse,
        version: '2',
        senderId: 'wallet',
        signature: 'completed-signature',
        signingType: SigningType.RAW
      },
      connectionInfo
    }
  }
}

describe('Follower route ownership', () => {
  const tabs: { client: DAppClient; transport: DappWalletConnectTransport }[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    tabs.length = 0
    bus.endpoints.length = 0
    bus.errors.length = 0
  })

  afterEach(async () => {
    for (const { client } of tabs) await client.destroy()
    await vi.advanceTimersByTimeAsync(0)
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    expect(bus.errors).toEqual([])
  })

  async function create(timeout = 0) {
    const index = tabs.length
    const name = `follower-tab-${index}`
    const storage = new LocalStorage(name)
    const client = new DAppClient({
      name,
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      requestTimeoutMs: timeout
    })
    await client.getActiveAccount()
    const transport = new DappWalletConnectTransport(
      name,
      await getKeypairFromSeed(name),
      storage,
      { network: NetworkType.MAINNET, opts: { projectId: 'offline' } },
      async () => bus.endpoints[index].elector.isLeader
    )
    transport['_isConnected'] =
      index === 0 ? TransportStatus.CONNECTED : TransportStatus.SECONDARY_TAB_CONNECTED
    vi.spyOn(transport, 'connect').mockResolvedValue(undefined)
    vi.spyOn(transport, 'waitForResolution').mockResolvedValue(true)
    vi.spyOn(transport, 'send').mockResolvedValue(undefined)
    vi.spyOn(transport, 'disconnect').mockResolvedValue(undefined)
    vi.spyOn(transport, 'removeAllPeers').mockResolvedValue(undefined)
    vi.spyOn(transport, 'getPeers').mockResolvedValue([])
    client['_transport'] = ExposedPromise.resolve<Awaited<DAppClient['transport']>>(transport)
    client['_activeAccount'] = ExposedPromise.resolve<AccountInfo | undefined>(account)
    vi.spyOn(client, 'getWalletInfo').mockResolvedValue({ name: 'Wallet' })
    vi.spyOn(client, 'init').mockResolvedValue(transport.type)
    client.addBlockchain(blockchain)
    // These cases begin with installed channel listeners. Role setup has separate coverage.
    await client['multiTabChannel'].init()
    const tab = { client, transport, storage }
    tabs.push(tab)
    return tab
  }

  async function begin(index: number, version: '2' | '3' = '2') {
    const pending = observe(
      version === '2'
        ? tabs[index].client.requestSignPayload({ payload: 'aa', signingType: SigningType.RAW })
        : tabs[index].client.request({
            type: BeaconMessageType.BlockchainRequest,
            blockchainIdentifier: 'tezos',
            accountId: account.accountIdentifier,
            blockchainData: { type: 'sign', scope: 'sign' }
          })
    )
    await vi.advanceTimersByTimeAsync(0)
    const sent = bus.endpoints[index].sent.at(-1)
    if (!sent || typeof sent !== 'object' || !('id' in sent) || typeof sent.id !== 'string') {
      throw new Error('Missing forwarded request ID')
    }
    const data =
      version === '2'
        ? {
            type: BeaconMessageType.SignPayloadRequest,
            payload: 'aa',
            signingType: SigningType.RAW,
            sourceAddress: account.address
          }
        : {
            type: BeaconMessageType.BlockchainRequest,
            blockchainIdentifier: 'tezos',
            accountId: account.accountIdentifier,
            blockchainData: { type: 'sign', scope: 'sign' }
          }
    expect(sent).toEqual({ type: data.type, id: sent.id, data })
    expect(pending.settled).not.toHaveBeenCalled()
    return { ...pending, id: sent.id }
  }

  async function loseLeader() {
    bus.endpoints[0].elector.isLeader = false
    for (let index = 1; index < tabs.length; index++) deliver(index, { type: 'LEADER_DEAD' })
    await vi.advanceTimersByTimeAsync(0)
  }

  it.each(['2', '3'] as const)(
    'does not report V%s inter-tab forwarding as wire messages (#149)',
    async (version) => {
      await create()
      const follower = await create()
      const observed = vi.fn()
      follower.client.subscribeToMessages(observed)
      const pending = await begin(1, version)
      expect(observed).not.toHaveBeenCalled()
      const forwarded = response(pending.id)
      deliver(
        1,
        version === '2'
          ? forwarded
          : {
              type: 'RESPONSE',
              id: pending.id,
              data: {
                connectionInfo,
                message: {
                  id: pending.id,
                  version: '3',
                  senderId: 'wallet',
                  message: {
                    type: BeaconMessageType.BlockchainResponse,
                    blockchainIdentifier: 'tezos',
                    blockchainData: { signature: 'completed-signature' }
                  }
                }
              }
            }
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(await pending.outcome).toHaveProperty('value')
      expect(observed).not.toHaveBeenCalled()
      expect(follower.transport.send).not.toHaveBeenCalled()
    }
  )

  it.each(['2', '3'] as const)(
    'labels V%s follower SENT as forwarding, not transport dispatch (#148)',
    async (version) => {
      await create()
      const follower = await create()
      const sent = vi.fn()
      await follower.client.subscribeToEvent(
        version === '2' ? BeaconEvent.SIGN_REQUEST_SENT : BeaconEvent.OPERATION_REQUEST_SENT,
        sent
      )
      const forwardedAt = 1_800_000_000_000
      vi.setSystemTime(forwardedAt)
      follower.client['getWalletInfo'] = async () => {
        vi.setSystemTime(forwardedAt + 1000)
        return { name: 'Wallet' }
      }
      const pending = await begin(1, version)
      expect(sent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          requestId: pending.id,
          requestType:
            version === '2'
              ? BeaconMessageType.SignPayloadRequest
              : BeaconMessageType.BlockchainRequest,
          transport: TransportType.WALLETCONNECT,
          dispatchStage: 'forwarded',
          forwardedAt
        }),
        undefined
      )
      expect(sent.mock.calls[0][0]).not.toHaveProperty('sentAt')
      expect(follower.transport.send).not.toHaveBeenCalled()
    }
  )

  it.each(['2', '3'] as const)(
    'aborts both V%s followers before election and leaves the third tab a follower',
    async (version) => {
      await create()
      const successor = await create()
      const remaining = await create()
      const first = await begin(1, version)
      const second = await begin(2, version)
      await loseLeader()
      expect(first.settled).toHaveBeenCalledWith({
        error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR, id: first.id })
      })
      expect(second.settled).toHaveBeenCalledWith({
        error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR, id: second.id })
      })
      expect(successor.transport.connect).not.toHaveBeenCalled()
      expect(remaining.transport.connect).not.toHaveBeenCalled()
      bus.endpoints[1].promote()
      await vi.advanceTimersByTimeAsync(0)
      expect(successor.transport.connect).toHaveBeenCalledTimes(1)
      expect(remaining.transport.connect).not.toHaveBeenCalled()
      expect(successor.transport.send).not.toHaveBeenCalled()
      expect(remaining.transport.send).not.toHaveBeenCalled()
      expect(bus.endpoints[1].sent).toHaveLength(1)
      expect(bus.endpoints[2].sent).toHaveLength(1)
      expect(await remaining.client.getActiveAccount()).toEqual(account)
    }
  )

  it('ignores old responses after turnover and allows a fresh follower request', async () => {
    await create()
    await create()
    const follower = await create()
    const succeeded = vi.fn()
    await follower.client.subscribeToEvent(BeaconEvent.SIGN_REQUEST_SUCCESS, succeeded)
    const previous = await begin(2)
    await loseLeader()
    bus.endpoints[1].promote()
    await vi.advanceTimersByTimeAsync(0)
    const current = await begin(2)
    expect(current.id).not.toBe(previous.id)
    deliver(2, response(previous.id))
    deliver(2, response(previous.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(previous.settled).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
    expect(current.settled).not.toHaveBeenCalled()
    expect(succeeded).not.toHaveBeenCalled()
    deliver(2, response(current.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(await current.outcome).toMatchObject({ value: { signature: 'completed-signature' } })
    expect(succeeded).toHaveBeenCalledTimes(1)
    expect(follower.transport.send).not.toHaveBeenCalled()
    expect(bus.endpoints[2].sent).toHaveLength(2)
  })

  it('retires a follower request already acknowledged when leader departure is observed', async () => {
    await create()
    const follower = await create(25)
    const acknowledged = vi.fn()
    await follower.client.subscribeToEvent(BeaconEvent.ACKNOWLEDGE_RECEIVED, acknowledged)
    const pending = await begin(1)
    deliver(1, {
      type: 'RESPONSE',
      id: pending.id,
      data: {
        message: {
          id: pending.id,
          type: BeaconMessageType.Acknowledge,
          version: '2',
          senderId: 'wallet'
        },
        connectionInfo
      }
    })
    await vi.advanceTimersByTimeAsync(30)
    expect(acknowledged).toHaveBeenCalledTimes(1)
    expect(pending.settled).not.toHaveBeenCalled()
    await loseLeader()
    expect(pending.settled).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
  })

  it('does not publish a follower request whose admission wait crosses leader departure', async () => {
    await create()
    const follower = await create()
    const ready = new ExposedPromise<boolean>()
    vi.spyOn(
      follower.client as unknown as {
        addRequestAndCheckIfRateLimited: (typeof follower.client)['addRequestAndCheckIfRateLimited']
      },
      'addRequestAndCheckIfRateLimited'
    ).mockImplementation(() => ready.promise)
    const pending = observe(follower.client.requestSignPayload({ payload: 'aa' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(bus.endpoints[1].sent).toEqual([])
    await loseLeader()
    ready.resolve(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(bus.endpoints[1].sent).toEqual([])
    expect(pending.settled).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
  })

  it('suppresses the sent event when follower metadata finishes after departure', async () => {
    await create()
    const follower = await create()
    const metadata = new ExposedPromise<{ name: string }>()
    const entered = vi.fn()
    vi.mocked(follower.client['getWalletInfo']).mockImplementationOnce(() => {
      entered()
      return metadata.promise
    })
    const sent = vi.fn()
    await follower.client.subscribeToEvent(BeaconEvent.SIGN_REQUEST_SENT, sent)
    const pending = await begin(1)
    expect(entered).toHaveBeenCalledTimes(1)
    expect(sent).not.toHaveBeenCalled()
    await loseLeader()
    metadata.resolve({ name: 'Wallet' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).not.toHaveBeenCalled()
    expect(pending.settled).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
  })

  it('accepts the existing response envelope once and ignores unrelated IDs', async () => {
    await create()
    const follower = await create()
    const succeeded = vi.fn()
    await follower.client.subscribeToEvent(BeaconEvent.SIGN_REQUEST_SUCCESS, succeeded)
    const pending = await begin(1)
    deliver(1, response('other-request'))
    await vi.advanceTimersByTimeAsync(0)
    expect(pending.settled).not.toHaveBeenCalled()
    deliver(1, response(pending.id))
    deliver(1, response(pending.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(await pending.outcome).toMatchObject({ value: { signature: 'completed-signature' } })
    expect(pending.settled).toHaveBeenCalledTimes(1)
    expect(succeeded).toHaveBeenCalledTimes(1)
    expect(bus.endpoints[1].sent).toHaveLength(1)
    expect(follower.transport.send).not.toHaveBeenCalled()
  })

  it('preserves a direct P2P request when another tab reports leader departure', async () => {
    await create()
    const direct = await create()
    const peer: ExtendedP2PPairingResponse = {
      id: 'direct-peer',
      name: 'Direct wallet',
      publicKey: '33'.repeat(32),
      senderId: account.senderId,
      type: 'p2p-pairing-response',
      version: '2',
      relayServer: 'relay.example'
    }
    const transport = new DappP2PTransport(
      'Direct tab',
      await getKeypairFromSeed('direct-tab'),
      direct.storage,
      {}
    )
    transport['_isConnected'] = TransportStatus.CONNECTED
    vi.spyOn(transport, 'connect').mockResolvedValue(undefined)
    vi.spyOn(transport, 'disconnect').mockResolvedValue(undefined)
    vi.spyOn(transport, 'getPeers').mockResolvedValue([peer])
    vi.spyOn(transport, 'send').mockResolvedValue(undefined)
    vi.spyOn(transport['client'], 'unsubscribeFromEncryptedMessages').mockResolvedValue(undefined)
    direct.client['p2pTransport'] = transport
    direct.client['_activeAccount'] = ExposedPromise.resolve<AccountInfo | undefined>({
      ...account,
      origin: { type: Origin.P2P, id: peer.publicKey }
    })
    await direct.client['setTransport'](transport)
    await direct.client['addListener'](transport)
    vi.mocked(direct.client.init).mockResolvedValue(transport.type)
    const pending = observe(direct.client.requestSignPayload({ payload: 'aa' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.send).toHaveBeenCalledTimes(1)
    const [payload, recipient] = vi.mocked(transport.send).mock.calls[0]
    const request = await new Serializer().deserialize(payload)
    expect(recipient).toEqual(peer)
    expect(request).toMatchObject({ type: BeaconMessageType.SignPayloadRequest })
    if (
      !request ||
      typeof request !== 'object' ||
      !('id' in request) ||
      typeof request.id !== 'string'
    ) {
      throw new Error('Missing direct request ID')
    }
    expect(bus.endpoints[1].sent).toEqual([])
    await loseLeader()
    expect(pending.settled).not.toHaveBeenCalled()
    expect(transport.connect).not.toHaveBeenCalled()
    bus.endpoints[1].promote()
    await vi.advanceTimersByTimeAsync(0)
    expect(pending.settled).not.toHaveBeenCalled()
    expect(transport.connect).not.toHaveBeenCalled()
    expect(direct.transport.connect).not.toHaveBeenCalled()
    await transport['notifyListeners'](
      await new Serializer().serialize(response(request.id).data.message),
      { origin: Origin.P2P, id: peer.publicKey }
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(await pending.outcome).toMatchObject({ value: { signature: 'completed-signature' } })
    expect(pending.settled).toHaveBeenCalledTimes(1)
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(bus.endpoints[1].sent).toEqual([])
  })

  it('preserves a received follower permission result while its account write finishes after departure', async () => {
    await create()
    const follower = await create()
    await follower.storage.set(StorageKey.ACCOUNTS, [account])
    await follower.storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
    follower.client['walletConnectTransport'] = follower.transport
    vi.spyOn(follower.client, 'initInternalTransports').mockResolvedValue(undefined)
    const succeeded = vi.fn()
    const failed = vi.fn()
    const selected = vi.fn()
    await follower.client.subscribeToEvent(BeaconEvent.PERMISSION_REQUEST_SUCCESS, succeeded)
    await follower.client.subscribeToEvent(BeaconEvent.PERMISSION_REQUEST_ERROR, failed)
    await follower.client.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, selected)
    const pending = observe(follower.client.requestPermissions())
    await vi.advanceTimersByTimeAsync(0)
    const sent = bus.endpoints[1].sent.at(-1)
    if (!sent || typeof sent !== 'object' || !('id' in sent) || typeof sent.id !== 'string') {
      throw new Error('Missing forwarded permission ID')
    }
    const id = sent.id
    expect(sent).toEqual({
      type: BeaconMessageType.PermissionRequest,
      id,
      data: expect.objectContaining({ type: BeaconMessageType.PermissionRequest })
    })
    const entered = new ExposedPromise<void>()
    const released = new ExposedPromise<void>()
    const write = follower.storage.set.bind(follower.storage)
    let holdAccountWrite = true
    vi.spyOn(follower.storage, 'set').mockImplementation(async (key, value) => {
      if (key === StorageKey.ACCOUNTS && holdAccountWrite) {
        holdAccountWrite = false
        entered.resolve()
        await released.promise
      }
      await write(key, value)
    })
    try {
      deliver(1, {
        type: 'RESPONSE',
        id,
        data: {
          message: {
            id,
            type: BeaconMessageType.PermissionResponse,
            version: '2',
            senderId: account.senderId,
            address: account.address,
            network: account.network,
            scopes: account.scopes,
            appMetadata: { name: 'Wallet', senderId: account.senderId },
            walletType: 'implicit'
          },
          connectionInfo
        }
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(entered.isResolved()).toBe(true)
      expect(pending.settled).not.toHaveBeenCalled()
      await loseLeader()
      expect(pending.settled).not.toHaveBeenCalled()
      expect(failed).not.toHaveBeenCalled()
      expect(succeeded).not.toHaveBeenCalled()
      expect(selected).not.toHaveBeenCalled()
      released.resolve()
      await vi.advanceTimersByTimeAsync(0)
      const accounts = await follower.storage.get(StorageKey.ACCOUNTS)
      expect(accounts).toEqual([
        account,
        expect.objectContaining({
          address: account.address,
          senderId: account.senderId,
          origin: account.origin,
          network: account.network,
          scopes: account.scopes
        })
      ])
      const granted = accounts[1]
      await expect(pending.outcome).resolves.toMatchObject({
        value: { id, address: account.address, accountInfo: granted }
      })
      expect(pending.settled).toHaveBeenCalledTimes(1)
      expect(failed).not.toHaveBeenCalled()
      expect(succeeded).toHaveBeenCalledTimes(1)
      expect(selected).toHaveBeenCalledExactlyOnceWith(granted, undefined)
      expect(await follower.client.getActiveAccount()).toEqual(granted)
      expect(await follower.storage.get(StorageKey.ACTIVE_ACCOUNT)).toBe(granted.accountIdentifier)
      expect(
        vi.mocked(follower.storage.set).mock.calls.filter(([key]) => key === StorageKey.ACCOUNTS)
      ).toHaveLength(1)
      expect(bus.endpoints[1].sent).toHaveLength(1)
      expect(follower.transport.connect).not.toHaveBeenCalled()
      expect(follower.transport.send).not.toHaveBeenCalled()
    } finally {
      released.resolve()
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it('uses the configured deadline when the leader departure hint is missing', async () => {
    await create()
    const follower = await create(25)
    const closed = vi.fn()
    await follower.client.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, closed)
    const pending = await begin(1)
    bus.endpoints[0].elector.isLeader = false
    await vi.advanceTimersByTimeAsync(24)
    expect(pending.settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending.outcome).toMatchObject({
      error: { errorType: BeaconErrorType.PEER_UNREACHABLE }
    })
    deliver(1, response(pending.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(pending.settled).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(bus.endpoints[1].sent).toHaveLength(1)
  })

  it('keeps the disabled-deadline policy when no departure signal is observed', async () => {
    await create()
    const follower = await create()
    const closed = vi.fn()
    await follower.client.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, closed)
    const pending = await begin(1)
    bus.endpoints[0].elector.isLeader = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pending.settled).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
    expect(bus.endpoints[1].sent).toHaveLength(1)
    deliver(1, response(pending.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(await pending.outcome).toMatchObject({ value: { signature: 'completed-signature' } })
  })
  // A leader always marks forwarded errors. An unmarked one did not come from this SDK's
  // leader logic, so the follower must not treat it as a local timeout or abort.
  it('treats a forwarded error without an errorOrigin as a wallet error', async () => {
    await create()
    await create()
    const pending = await begin(1)
    deliver(1, {
      type: 'RESPONSE',
      id: pending.id,
      data: {
        message: {
          id: pending.id,
          type: BeaconMessageType.Error,
          errorType: BeaconErrorType.PEER_UNREACHABLE,
          senderId: 'wallet',
          version: '2'
        },
        connectionInfo
      }
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await pending.outcome).toEqual({
      error: expect.objectContaining({
        errorType: BeaconErrorType.PEER_UNREACHABLE,
        errorOrigin: 'wallet'
      })
    })
  })
  it.each([0, -1])(
    'never times out a forwarded permission request when requestTimeoutMs is %s',
    async (timeout) => {
      await create(timeout)
      const follower = await create(timeout)
      const pending = observe(
        follower.client['makeRequestBC']({
          type: BeaconMessageType.PermissionRequest,
          appMetadata: { name: 'Dapp', senderId: 'dapp' },
          network: { type: NetworkType.MAINNET },
          scopes: []
        })
      )
      await vi.advanceTimersByTimeAsync(600_000)
      expect(pending.settled).not.toHaveBeenCalled()
    }
  )
})
