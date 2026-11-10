import { LocalStorage, Serializer } from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessageType,
  ExtendedWalletConnectPairingResponse,
  NetworkType,
  Origin,
  PermissionScope,
  SigningType,
  StorageKey,
  TransportStatus
} from '@ecadlabs/beacon-types'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'

const boundary = vi.hoisted(() => ({
  channel: {
    onmessage: null as null | ((message: unknown) => Promise<void>),
    postMessage: vi.fn<(message: unknown) => void>(),
    removeEventListener: vi.fn(),
    close: vi.fn(async () => {})
  },
  elector: {
    isLeader: false,
    hasLeader: vi.fn(async () => true),
    awaitLeadership: vi.fn(async () => {}),
    die: vi.fn(async () => {})
  }
}))
vi.mock('broadcast-channel', () => ({
  BroadcastChannel: class {
    constructor() {
      return boundary.channel
    }
  },
  createLeaderElection: () => boundary.elector
}))
vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  ...(await vi.importActual<typeof import('../../../beacon-core/src/utils/multi-tab-channel')>(
    '../../../beacon-core/src/utils/multi-tab-channel'
  )),
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

const peer: ExtendedWalletConnectPairingResponse = {
  id: 'current-topic',
  extensionId: '',
  type: 'walletconnect-pairing-response',
  name: 'Wallet',
  publicKey: 'current-topic',
  senderId: 'wallet',
  version: '2'
}
const account: AccountInfo = {
  accountIdentifier: 'current-account',
  senderId: peer.senderId,
  address: 'tz1TGu6TN5GSez2ndXXeDX6LgUDvLzPLqgYV',
  network: { type: NetworkType.MAINNET },
  scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST],
  origin: { type: Origin.WALLETCONNECT, id: peer.publicKey },
  connectedAt: 1,
  walletType: 'implicit'
}
const connectionInfo = { origin: Origin.WALLETCONNECT, id: peer.publicKey }

const forwarded = (id: string) => ({
  id,
  type: BeaconMessageType.SignPayloadRequest,
  data: {
    type: BeaconMessageType.SignPayloadRequest,
    payload: 'aa',
    signingType: SigningType.RAW,
    sourceAddress: account.address
  }
})
const success = (id: string) => ({
  id,
  type: BeaconMessageType.SignPayloadResponse,
  version: '2',
  senderId: peer.senderId,
  signature: 'completed-signature',
  signingType: SigningType.RAW
})

describe('Leader proxy ownership', () => {
  let client: DAppClient
  let transport: DappWalletConnectTransport
  let storage: LocalStorage
  let reconnect: ExposedPromise<void> | undefined
  const connectionStarted = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    vi.clearAllMocks()
    boundary.channel.onmessage = null
    boundary.elector.isLeader = true
    boundary.elector.hasLeader.mockResolvedValue(true)
    boundary.elector.awaitLeadership.mockImplementation(async () => {
      boundary.elector.isLeader = true
    })
    reconnect = undefined
    Object.defineProperty(window, 'beaconCreatedClientInstance', {
      value: false,
      writable: true,
      configurable: true
    })
  })

  afterEach(async () => {
    reconnect?.resolve()
    if (client) await client.destroy()
    await vi.advanceTimersByTimeAsync(0)
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function create(source: 'local' | 'restored' = 'local') {
    storage = new LocalStorage('leader-proxy')
    if (source === 'restored') {
      await storage.set(StorageKey.ACCOUNTS, [account])
      await storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
    }
    transport = new DappWalletConnectTransport(
      'Wallet',
      await getKeypairFromSeed('leader-proxy'),
      storage,
      { network: NetworkType.MAINNET, opts: { projectId: 'offline' } },
      async () => boundary.elector.isLeader
    )
    vi.spyOn(transport, 'connect').mockImplementation(async () => {
      // Match the adapter's existing connecting fast path and retained readiness promise.
      if (
        [TransportStatus.CONNECTED, TransportStatus.CONNECTING].includes(transport.connectionStatus)
      ) {
        return
      }
      transport['_isConnected'] = TransportStatus.CONNECTING
      connectionStarted()
      const leader = await client['checkIfBCLeaderExists']()
      if (reconnect) await reconnect.promise
      transport['_isConnected'] = leader
        ? TransportStatus.CONNECTED
        : TransportStatus.SECONDARY_TAB_CONNECTED
      transport['isReady'].resolve(true)
    })
    vi.spyOn(transport, 'getPeers').mockResolvedValue([peer])
    vi.spyOn(transport, 'send').mockResolvedValue(undefined)
    vi.spyOn(transport, 'cancelRequest').mockImplementation(() => {})
    vi.spyOn(transport, 'disconnect').mockResolvedValue(undefined)
    vi.spyOn(transport, 'doClientCleanup').mockResolvedValue(undefined)
    vi.spyOn(transport, 'removeAllPeers').mockResolvedValue(undefined)
    vi.spyOn(transport, 'forceUpdate').mockImplementation(() => {})
    vi.spyOn(DAppClient.prototype, 'initInternalTransports').mockImplementation(async function (
      this: DAppClient
    ) {
      if (this['walletConnectTransport'] !== transport) {
        this['walletConnectTransport'] = transport
        await this['addListener'](transport)
      }
    })
    client = new DAppClient({
      name: 'Leader proxy',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      requestTimeoutMs: 50
    })
    await client.getActiveAccount()
    vi.spyOn(client, 'getWalletInfo').mockResolvedValue({ name: 'Wallet' })
    if (source === 'local') await client.setActiveAccount(account)
    await vi.advanceTimersByTimeAsync(0)
  }

  async function receive(message: unknown) {
    await boundary.channel.onmessage?.(message)
    await vi.advanceTimersByTimeAsync(0)
  }

  async function walletResponse(id: string) {
    await transport['notifyListeners'](
      await new Serializer().serialize(success(id)),
      connectionInfo
    )
    await vi.advanceTimersByTimeAsync(0)
  }

  function replies(id: string) {
    return boundary.channel.postMessage.mock.calls
      .map(([message]) => message)
      .filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'RESPONSE' &&
          'id' in message &&
          message.id === id
      )
  }

  function expectAborted(id: string) {
    expect(replies(id)).toEqual([
      {
        type: 'RESPONSE',
        id,
        data: {
          message: {
            id,
            type: BeaconMessageType.Error,
            errorType: BeaconErrorType.ABORTED_ERROR,
            senderId: '',
            version: '2',
            origin: 'local'
          },
          connectionInfo: { origin: Origin.WALLETCONNECT, id: '' }
        }
      }
    ])
  }

  it.each(['local', 'restored'] as const)(
    'receives follower traffic after %s account selection without a local request',
    async (source) => {
      await create(source)
      await receive(forwarded('first-forwarded'))
      expect(transport.send).toHaveBeenCalledTimes(1)
      const payload = vi.mocked(transport.send).mock.calls[0][0]
      expect(await new Serializer().deserialize(payload)).toMatchObject({
        id: 'first-forwarded',
        type: BeaconMessageType.SignPayloadRequest,
        payload: 'aa'
      })
      await walletResponse('first-forwarded')
      expect(replies('first-forwarded')).toEqual([
        {
          type: 'RESPONSE',
          id: 'first-forwarded',
          data: { message: success('first-forwarded'), connectionInfo }
        }
      ])
    }
  )

  it.each(['local', 'restored'] as const)(
    'receives election signals after %s follower selection without a local request',
    async (source) => {
      boundary.elector.isLeader = false
      await create(source)
      expect(transport.connectionStatus).toBe(TransportStatus.SECONDARY_TAB_CONNECTED)
      const starts = connectionStarted.mock.calls.length
      await receive({ type: 'LEADER_DEAD' })
      expect(connectionStarted).toHaveBeenCalledTimes(starts + 1)
      expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
      await receive(forwarded('first-promoted'))
      expect(transport.send).toHaveBeenCalledTimes(1)
      await walletResponse('first-promoted')
      expect(replies('first-promoted')).toEqual([
        {
          type: 'RESPONSE',
          id: 'first-promoted',
          data: { message: success('first-promoted'), connectionInfo }
        }
      ])
    }
  )

  it('announces departure after restored leadership without a local request', async () => {
    boundary.elector.isLeader = false
    boundary.elector.hasLeader.mockResolvedValue(false)
    await create('restored')
    expect(boundary.elector.isLeader).toBe(true)
    window.dispatchEvent(new Event('beforeunload'))
    await vi.advanceTimersByTimeAsync(0)
    expect(boundary.channel.postMessage).toHaveBeenCalledWith({ type: 'LEADER_DEAD' })
  })

  it('waits for promoted connection completion before sending a forwarded request', async () => {
    boundary.elector.isLeader = false
    await create()
    await client['multiTabChannel'].init()
    reconnect = new ExposedPromise<void>()
    await receive({ type: 'LEADER_DEAD' })
    await receive(forwarded('during-reconnect'))
    expect(transport.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(replies('during-reconnect')).toEqual([])
    reconnect.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.send).toHaveBeenCalledTimes(1)
    await walletResponse('during-reconnect')
    expect(replies('during-reconnect')).toHaveLength(1)
  })

  it('settles admitted proxy ownership during reconnect teardown and does not send later', async () => {
    boundary.elector.isLeader = false
    await create()
    await client['multiTabChannel'].init()
    reconnect = new ExposedPromise<void>()
    await receive({ type: 'LEADER_DEAD' })
    await receive(forwarded('cancel-reconnect'))
    const closed = client.disconnect({ notifyPeers: false })
    await vi.advanceTimersByTimeAsync(0)
    expectAborted('cancel-reconnect')
    expect(transport.send).not.toHaveBeenCalled()
    reconnect.resolve()
    await closed
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.send).not.toHaveBeenCalled()
    expectAborted('cancel-reconnect')
  })

  it.each([
    ['2', 'readiness'],
    ['2', 'wallet details'],
    ['3', 'readiness'],
    ['3', 'wallet details']
  ] as const)(
    'rechecks elector ownership for V%s after awaiting %s before proxy dispatch',
    async (version, boundaryName) => {
      await create()
      await client['multiTabChannel'].init()
      const gate = new ExposedPromise<void>()
      const entered = vi.fn()
      if (boundaryName === 'readiness') {
        vi.spyOn(transport, 'waitForResolution').mockImplementation(async () => {
          entered()
          await gate.promise
          return true
        })
      } else {
        vi.mocked(client['getWalletInfo']).mockImplementation(async () => {
          entered()
          await gate.promise
          return { name: 'Wallet' }
        })
      }
      await receive(
        version === '2'
          ? forwarded('previous-leader')
          : {
              id: 'previous-leader',
              type: BeaconMessageType.BlockchainRequest,
              data: {
                type: BeaconMessageType.BlockchainRequest,
                blockchainIdentifier: 'tezos',
                blockchainData: { type: 'sign', payload: 'aa' }
              }
            }
      )
      expect(entered).toHaveBeenCalled()
      boundary.elector.isLeader = false
      gate.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.send).not.toHaveBeenCalled()
      expectAborted('previous-leader')
      await walletResponse('previous-leader')
      expectAborted('previous-leader')
    }
  )

  it('waits for a pending account write before choosing a promoted transport', async () => {
    boundary.elector.isLeader = false
    await create()
    await client['multiTabChannel'].init()
    const p2p = new DappP2PTransport(
      'Next route',
      await getKeypairFromSeed('next-route'),
      storage,
      {}
    )
    client['p2pTransport'] = p2p
    p2p['_isConnected'] = TransportStatus.CONNECTED
    vi.spyOn(p2p, 'getPeers').mockResolvedValue([])
    vi.spyOn(p2p, 'disconnect').mockResolvedValue(undefined)
    const write = new ExposedPromise<void>()
    const entered = vi.fn()
    const set = storage.set.bind(storage)
    vi.spyOn(storage, 'set').mockImplementation(async (key, value) => {
      if (key === StorageKey.ACTIVE_ACCOUNT && value === 'next-account') {
        entered()
        await write.promise
      }
      return set(key, value)
    })
    const next: AccountInfo = {
      ...account,
      accountIdentifier: 'next-account',
      origin: { type: Origin.P2P, id: 'next-peer' }
    }
    const selection = client.setActiveAccount(next)
    await vi.advanceTimersByTimeAsync(0)
    expect(entered).toHaveBeenCalledTimes(1)
    try {
      await receive({ type: 'LEADER_DEAD' })
      expect(connectionStarted).toHaveBeenCalledTimes(1)
      write.resolve()
      await selection
      await vi.advanceTimersByTimeAsync(0)
      expect(await client.getActiveAccount()).toEqual(next)
      expect(await client['transport']).toBe(p2p)
      expect(connectionStarted).toHaveBeenCalledTimes(1)
    } finally {
      write.resolve()
      await selection
    }
  })

  it('reconnects and forwards after a pending account write selects a WalletConnect account', async () => {
    boundary.elector.isLeader = false
    await create()
    await client['multiTabChannel'].init()
    const write = new ExposedPromise<void>()
    const entered = vi.fn()
    const set = storage.set.bind(storage)
    vi.spyOn(storage, 'set').mockImplementation(async (key, value) => {
      if (key === StorageKey.ACTIVE_ACCOUNT && value === 'next-wallet-account') {
        entered()
        await write.promise
      }
      return set(key, value)
    })
    const next: AccountInfo = {
      ...account,
      accountIdentifier: 'next-wallet-account',
      address: 'tz1burnburnburnburnburnburnburjAYjjX'
    }
    const selection = client.setActiveAccount(next)
    await vi.advanceTimersByTimeAsync(0)
    expect(entered).toHaveBeenCalledTimes(1)
    try {
      await receive({ type: 'LEADER_DEAD' })
      expect(connectionStarted).toHaveBeenCalledTimes(1)
      expect(transport.send).not.toHaveBeenCalled()
      write.resolve()
      await selection
      await vi.advanceTimersByTimeAsync(0)
      expect(await client.getActiveAccount()).toEqual(next)
      expect(connectionStarted).toHaveBeenCalledTimes(2)
      expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
      await receive({
        ...forwarded('next-account-request'),
        data: { ...forwarded('next-account-request').data, sourceAddress: next.address }
      })
      expect(transport.send).toHaveBeenCalledTimes(1)
      const payload = vi.mocked(transport.send).mock.calls[0][0]
      expect(await new Serializer().deserialize(payload)).toMatchObject({
        id: 'next-account-request',
        type: BeaconMessageType.SignPayloadRequest,
        sourceAddress: next.address
      })
      await walletResponse('next-account-request')
      expect(replies('next-account-request')).toEqual([
        {
          type: 'RESPONSE',
          id: 'next-account-request',
          data: { message: success('next-account-request'), connectionInfo }
        }
      ])
      expect(connectionStarted).toHaveBeenCalledTimes(2)
    } finally {
      write.resolve()
      await selection
    }
  })

  it('does not reconnect from an election completion after destroy', async () => {
    boundary.elector.isLeader = false
    await create()
    await client['multiTabChannel'].init()
    const election = new ExposedPromise<void>()
    boundary.elector.awaitLeadership.mockImplementation(async () => {
      await election.promise
      boundary.elector.isLeader = true
    })
    const received = boundary.channel.onmessage?.({ type: 'LEADER_DEAD' })
    await client.destroy()
    const starts = connectionStarted.mock.calls.length
    election.resolve()
    await received
    await vi.advanceTimersByTimeAsync(0)
    expect(connectionStarted).toHaveBeenCalledTimes(starts)
  })

  it('keeps a live proxy request when a repeated departure hint leaves the elector unchanged', async () => {
    await create()
    await client['multiTabChannel'].init()
    await receive(forwarded('current-leader'))
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(replies('current-leader')).toEqual([])
    const starts = connectionStarted.mock.calls.length
    await receive({ type: 'LEADER_DEAD' })
    expect(connectionStarted).toHaveBeenCalledTimes(starts)
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(replies('current-leader')).toEqual([])
    await walletResponse('current-leader')
    await walletResponse('current-leader')
    expect(replies('current-leader')).toEqual([
      {
        type: 'RESPONSE',
        id: 'current-leader',
        data: { message: success('current-leader'), connectionInfo }
      }
    ])
  })

  it('keeps a repeated live request and repeated election notification to one wallet send', async () => {
    boundary.elector.isLeader = false
    await create()
    await client['multiTabChannel'].init()
    reconnect = new ExposedPromise<void>()
    await receive({ type: 'LEADER_DEAD' })
    await receive({ type: 'LEADER_DEAD' })
    reconnect.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await receive(forwarded('repeated-live'))
    await receive(forwarded('repeated-live'))
    expect(connectionStarted).toHaveBeenCalledTimes(2)
    expect(transport.send).toHaveBeenCalledTimes(1)
    await walletResponse('repeated-live')
    await walletResponse('repeated-live')
    expect(replies('repeated-live')).toHaveLength(1)
  })
})
