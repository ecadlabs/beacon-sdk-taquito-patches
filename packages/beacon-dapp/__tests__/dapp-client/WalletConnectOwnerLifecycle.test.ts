import { EventEmitter } from 'node:events'
import 'fake-indexeddb/auto'
import { LocalStorage } from '@ecadlabs/beacon-core'
import { NetworkType, TransportStatus } from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { SessionTypes, SignClientTypes } from '@walletconnect/types'
import { WalletConnectCommunicationClient } from '../../../beacon-transport-walletconnect/src/communication-client/WalletConnectCommunicationClient'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'

vi.mock('@ecadlabs/beacon-transport-walletconnect', async () =>
  vi.importActual<typeof import('../../../beacon-transport-walletconnect/src')>(
    '../../../beacon-transport-walletconnect/src'
  )
)
vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  ...(await vi.importActual<
    typeof import('../../../beacon-core/src/transports/clients/ClientEvents')
  >('../../../beacon-core/src/transports/clients/ClientEvents')),
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

const initialize = vi.hoisted(() => vi.fn<(options: SignClientTypes.Options) => Promise<Remote>>())
vi.mock('@walletconnect/sign-client', () => ({ default: { init: initialize } }))
vi.mock('@walletconnect/utils', () => ({
  getSdkError: () => ({ code: 6000, message: 'User disconnected.' })
}))

class LocalBroadcastChannel {
  static readonly channels: LocalBroadcastChannel[] = []
  onmessage: ((event: MessageEvent<{ type: string }>) => void) | undefined
  onmessageerror: unknown
  constructor(readonly name: string) {
    LocalBroadcastChannel.channels.push(this)
  }
  postMessage(_message: unknown): void {}
  close(): void {}
}

const metadata = { name: 'wallet', description: '', url: 'https://wallet.example', icons: [] }
const publicKey = 'edpkv3Nf62TZxR1XwzKRteLTh1SmXLmr8cGEwHRSNoiUV3oiBrDbFX'

function session(topic: string): SessionTypes.Struct {
  return {
    topic,
    pairingTopic: `pairing-${topic}`,
    relay: { protocol: 'irn' },
    expiry: Math.floor(Date.now() / 1000) + 172800,
    acknowledged: true,
    controller: 'wallet',
    namespaces: {
      tezos: {
        accounts: [`tezos:mainnet:${publicKey}`],
        methods: ['tezos_getAccounts', 'tezos_send', 'tezos_sign'],
        events: []
      }
    },
    requiredNamespaces: {},
    optionalNamespaces: {},
    self: { publicKey: 'dapp-key', metadata },
    peer: { publicKey: `wallet-${topic}`, metadata }
  }
}

function remote(restored?: SessionTypes.Struct) {
  const sessions = new Map(restored ? [[restored.topic, restored]] : [])
  const events = new EventEmitter()
  const approval = new ExposedPromise<SessionTypes.Struct>()
  return {
    session: {
      get keys() {
        return [...sessions.keys()]
      },
      get: (topic: string) => sessions.get(topic),
      getAll: () => [...sessions.values()]
    },
    pairing: { getAll: () => [] },
    ping: vi.fn(async () => {}),
    extend: vi.fn(async () => {}),
    disconnect: vi.fn(async ({ topic }: { topic: string }) => {
      sessions.delete(topic)
    }),
    connect: vi.fn(async (_options: unknown) => ({
      uri: 'wc:next-pairing@2?symKey=key',
      approval: () => approval.promise
    })),
    approve: (approved: SessionTypes.Struct) => {
      sessions.set(approved.topic, approved)
      approval.resolve(approved)
    },
    emit: events.emit.bind(events),
    on: events.on.bind(events),
    off: events.off.bind(events),
    removeListener: events.removeListener.bind(events),
    removeAllListeners: events.removeAllListeners.bind(events),
    core: {
      events: new EventEmitter(),
      heartbeat: { stop: vi.fn() },
      pairing: {
        events: new EventEmitter(),
        ping: vi.fn(async () => {}),
        disconnect: vi.fn(async () => {})
      },
      relayer: {
        onProviderErrorHandler: (_error: Error) => {},
        transportClose: vi.fn(async () => {}),
        events: new EventEmitter(),
        provider: { events: new EventEmitter(), connection: { events: new EventEmitter() } },
        subscriber: { events: new EventEmitter() }
      }
    }
  }
}

type Remote = ReturnType<typeof remote>
type OwnedTransport = DappWalletConnectTransport

describe('WalletConnect transport ownership', () => {
  const clients = new Map<OwnedTransport, DAppClient>()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', LocalBroadcastChannel)
    localStorage.clear()
    LocalBroadcastChannel.channels.length = 0
    // Each test starts a process lifetime; scenarios never reset the shared instance.
    Reflect.deleteProperty(WalletConnectCommunicationClient, 'instance')
    initialize.mockReset()
    Object.defineProperty(window, 'beaconCreatedClientInstance', {
      value: false,
      writable: true,
      configurable: true
    })
  })

  afterEach(async () => {
    for (const dapp of clients.values()) {
      await dapp.destroy()
    }
    clients.clear()
    Reflect.deleteProperty(WalletConnectCommunicationClient, 'instance')
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function create(
    projectId: string,
    leader = vi.fn(() => true),
    network = NetworkType.MAINNET
  ) {
    const dapp = new DAppClient({
      name: projectId,
      storage: new LocalStorage(projectId),
      network: { type: network },
      walletConnectOptions: { projectId },
      disableDefaultEvents: true,
      enableAppSwitching: false
    })
    vi.spyOn(dapp['multiTabChannel'], 'isLeader').mockImplementation(leader)
    await dapp.getActiveAccount()
    await dapp.initInternalTransports()
    const transport = dapp['walletConnectTransport']
    if (!transport) {
      throw new Error('WalletConnect transport was not initialized')
    }
    clients.set(transport, dapp)
    return transport
  }

  async function release(transport: OwnedTransport): Promise<void> {
    const dapp = clients.get(transport)
    if (!dapp) {
      throw new Error('Missing transport owner')
    }
    await dapp.destroy()
  }

  it('uses the next project options after the final transport is released', async () => {
    const firstRemote = remote(session('first'))
    const nextRemote = remote(session('next'))
    initialize.mockResolvedValueOnce(firstRemote).mockResolvedValueOnce(nextRemote)
    const first = await create('first-project')
    await first.connect()
    await release(first)
    await first.getPeers()
    const next = await create('next-project')
    await next.connect()

    expect(initialize).toHaveBeenCalledTimes(2)
    expect(initialize.mock.calls[1][0]).toEqual(
      expect.objectContaining({ projectId: 'next-project' })
    )
    expect((await next.getPeers()).map((peer) => peer.senderId)).toEqual(['next'])
  })

  it('uses the next network when creating a proposal after final release', async () => {
    initialize.mockResolvedValueOnce(remote(session('first')))
    const first = await create('first-project')
    await first.connect()
    await release(first)
    const nextRemote = remote()
    initialize.mockResolvedValueOnce(nextRemote)
    const next = await create(
      'next-project',
      vi.fn(() => true),
      NetworkType.GHOSTNET
    )
    await next.connect()

    expect(nextRemote.connect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requiredNamespaces: expect.objectContaining({
          tezos: expect.objectContaining({ chains: ['tezos:ghostnet'] })
        })
      })
    )
  })

  it.each([true, false])(
    'uses the next leader callback after approval when leader is %s',
    async (nextIsLeader) => {
      const firstLeader = vi.fn(() => true)
      initialize.mockResolvedValueOnce(remote(session('first')))
      const first = await create('first-project', firstLeader)
      await first.connect()
      await release(first)
      firstLeader.mockReturnValue(!nextIsLeader)
      firstLeader.mockClear()
      const nextLeader = vi.fn(() => true)
      const nextRemote = remote()
      initialize.mockResolvedValueOnce(nextRemote)
      const next = await create('next-project', nextLeader)
      await next.connect()
      await next['client'].listenForChannelOpening(async () => true)
      nextLeader.mockReturnValue(nextIsLeader)
      nextLeader.mockClear()
      nextRemote.approve(session('next'))
      await vi.advanceTimersByTimeAsync(0)

      expect.soft(nextLeader).toHaveBeenCalledTimes(1)
      expect.soft(firstLeader).not.toHaveBeenCalled()
      expect
        .soft(nextRemote.core.relayer.transportClose)
        .toHaveBeenCalledTimes(nextIsLeader ? 0 : 1)
    }
  )

  it('keeps the next session when a released transport disconnects again', async () => {
    initialize.mockResolvedValueOnce(remote(session('first')))
    const first = await create('first-project')
    await first.connect()
    await release(first)
    const nextRemote = remote(session('next'))
    initialize.mockResolvedValueOnce(nextRemote)
    const next = await create('next-project')
    await next.connect()
    await first.disconnect()

    expect.soft(nextRemote.disconnect).not.toHaveBeenCalled()
    expect.soft(nextRemote.core.relayer.transportClose).not.toHaveBeenCalled()
    expect.soft((await next.getPeers()).map((peer) => peer.senderId)).toEqual(['next'])
    expect(next.connectionStatus).toBe(TransportStatus.CONNECTED)
  })

  it('keeps another client session when one shared owner is destroyed', async () => {
    const sharedRemote = remote(session('shared'))
    initialize.mockResolvedValueOnce(sharedRemote)
    const first = await create('shared-project')
    const second = await create('shared-project')
    await first.connect()
    await second.connect()
    await release(first)

    expect.soft(sharedRemote.disconnect).not.toHaveBeenCalled()
    expect.soft(sharedRemote.core.relayer.transportClose).not.toHaveBeenCalled()
    expect.soft((await second.getPeers()).map((peer) => peer.senderId)).toEqual(['shared'])
    await release(second)
    expect(sharedRemote.core.relayer.transportClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the next client listener when an old transport cleanup runs again', async () => {
    initialize.mockResolvedValueOnce(remote(session('first')))
    const first = await create('first-project')
    await first.connect()
    await release(first)
    const nextSession = session('next')
    const nextRemote = remote(nextSession)
    initialize.mockResolvedValueOnce(nextRemote)
    const next = await create('next-project')
    const received = vi.fn()
    await next.addListener(received)
    await next.connect()
    await first.doClientCleanup()
    nextRemote.emit('session_update', {
      topic: nextSession.topic,
      params: { namespaces: nextSession.namespaces }
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(received).toHaveBeenCalledTimes(1)
    expect((await next.getPeers()).map((peer) => peer.senderId)).toEqual(['next'])
  })

  it('ignores a prior storage notification after the final owner is destroyed', async () => {
    initialize.mockResolvedValueOnce(remote(session('first')))
    const first = await create('first-project')
    await first.connect()
    const oldChannel = LocalBroadcastChannel.channels.find(
      (channel) => channel.name === 'WALLET_CONNECT_V2_INDEXED_DB'
    )
    const notify = oldChannel?.onmessage
    expect(notify).toBeDefined()
    await release(first)
    const nextRemote = remote(session('next'))
    initialize.mockResolvedValue(nextRemote)
    const next = await create('next-project')
    await next.connect()
    const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone')
    notify?.(new MessageEvent('message', { data: { type: 'INIT' } }))
    await vi.advanceTimersByTimeAsync(0)
    userAgent.mockRestore()

    expect.soft(initialize).toHaveBeenCalledTimes(2)
    expect.soft(nextRemote.core.relayer.transportClose).not.toHaveBeenCalled()
    expect.soft((await next.getPeers()).map((peer) => peer.senderId)).toEqual(['next'])
  })

  it('shares the current session and initial project options between live transports', async () => {
    const sharedRemote = remote(session('shared'))
    initialize.mockResolvedValueOnce(sharedRemote)
    const first = await create('first-project')
    const second = await create('second-project')
    await first.connect()
    await second.connect()

    expect(initialize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ projectId: 'first-project' })
    )
    expect(await first.getPeers()).toEqual(await second.getPeers())
    expect((await second.getPeers()).map((peer) => peer.senderId)).toEqual(['shared'])
  })

  it('closes an established session when its sole transport disconnects', async () => {
    const ownedRemote = remote(session('only'))
    initialize.mockResolvedValueOnce(ownedRemote)
    const transport = await create('only-project')
    await transport.connect()
    await transport.disconnect()

    expect(ownedRemote.disconnect).toHaveBeenCalledTimes(1)
    expect(ownedRemote.core.relayer.transportClose).toHaveBeenCalledTimes(1)
    expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
  })
})
