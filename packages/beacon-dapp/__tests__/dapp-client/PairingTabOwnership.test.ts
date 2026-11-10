import { LocalStorage, Serializer } from '@ecadlabs/beacon-core'
import {
  BeaconErrorType,
  BeaconMessageType,
  ExtendedWalletConnectPairingResponse,
  NetworkType,
  Origin,
  PermissionScope,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { PostMessageTransport } from '@ecadlabs/beacon-transport-postmessage'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { DappPostMessageTransport } from '../../src/transports/DappPostMessageTransport'
import { BeaconEvent } from '../../src/events'

const boundary = vi.hoisted(() => ({
  channel: {
    onmessage: null as null | ((message: unknown) => Promise<void>),
    postMessage: vi.fn<(message: unknown) => void>(),
    removeEventListener: vi.fn(),
    close: vi.fn(async () => {})
  },
  elector: {
    isLeader: true,
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
  ...(await import('../../../beacon-core/src/utils/multi-tab-channel')),
  StorageValidator: class {
    async validate() {
      return true
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

const peer: ExtendedWalletConnectPairingResponse = {
  id: 'paired-topic',
  name: 'Paired wallet',
  publicKey: 'paired-topic',
  senderId: 'paired-wallet',
  type: 'walletconnect-pairing-response',
  version: '3',
  extensionId: 'walletconnect'
}
const connectionInfo = { origin: Origin.WALLETCONNECT, id: peer.publicKey }
let client: DAppClient
let wc: DappWalletConnectTransport
const paired = vi.fn()

beforeEach(async () => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  localStorage.clear()
  boundary.channel.onmessage = null
  boundary.elector.isLeader = false
  boundary.elector.hasLeader.mockImplementation(async () => boundary.elector.isLeader)
  boundary.elector.awaitLeadership.mockImplementation(async () => {
    boundary.elector.isLeader = true
  })
  boundary.elector.die.mockImplementation(async () => {
    boundary.elector.isLeader = false
  })
  const storage = new LocalStorage('pairing-tab')
  const keys = await getKeypairFromSeed('pairing-tab')
  const p2p = new DappP2PTransport('Pairing tab', keys, storage, {})
  const post = new DappPostMessageTransport('Pairing tab', keys, storage)
  wc = new DappWalletConnectTransport(
    'Pairing tab',
    keys,
    storage,
    { network: NetworkType.MAINNET, opts: { projectId: 'offline' } },
    async () => boundary.elector.isLeader
  )
  for (const adapter of [p2p, post, wc]) {
    vi.spyOn(adapter, 'connect').mockImplementation(async () => {
      adapter['_isConnected'] = TransportStatus.CONNECTED
    })
    vi.spyOn(adapter, 'disconnect').mockResolvedValue(undefined)
    vi.spyOn(adapter, 'getPeers').mockResolvedValue([])
    vi.spyOn(adapter, 'removeAllPeers').mockResolvedValue(undefined)
    vi.spyOn(adapter, 'stopListeningForNewPeers').mockResolvedValue(undefined)
  }
  vi.spyOn(wc, 'release').mockResolvedValue(undefined)
  vi.spyOn(wc, 'doClientCleanup').mockResolvedValue(undefined)
  vi.spyOn(wc, 'waitForResolution').mockResolvedValue(true)
  vi.spyOn(wc, 'send').mockResolvedValue(undefined)
  vi.spyOn(wc, 'cancelRequest').mockImplementation(() => {})
  let accept: Parameters<DappWalletConnectTransport['listenForNewPeer']>[0] | undefined
  vi.spyOn(wc, 'listenForNewPeer').mockImplementation(async (callback) => {
    accept = callback
  })
  vi.spyOn(p2p, 'listenForNewPeer').mockResolvedValue(undefined)
  vi.spyOn(post, 'listenForNewPeer').mockResolvedValue(undefined)
  const fields = { id: 'pairing-tab', publicKey: '22'.repeat(32), name: 'DApp', version: '3' }
  vi.spyOn(p2p, 'getPairingRequestInfo').mockResolvedValue({
    ...fields,
    type: 'p2p-pairing-request',
    relayServer: 'relay.example'
  })
  vi.spyOn(post, 'getPairingRequestInfo').mockResolvedValue({
    ...fields,
    type: 'postmessage-pairing-request'
  })
  vi.spyOn(wc, 'getPairingRequestInfo').mockResolvedValue({
    ...fields,
    type: 'walletconnect-pairing-request',
    senderId: 'dapp',
    uri: 'wc:pairing-tab'
  })
  vi.spyOn(PostMessageTransport, 'getAvailableExtensions').mockResolvedValue([])
  class PairingClient extends DAppClient {
    public async initInternalTransports(): Promise<void> {
      this.p2pTransport = p2p
      this.postMessageTransport = post
      this.walletConnectTransport = wc
      await Promise.all([this.addListener(p2p), this.addListener(post), this.addListener(wc)])
    }
  }
  client = new PairingClient({
    name: 'Pairing tab',
    storage,
    disableDefaultEvents: true,
    enableAppSwitching: false,
    requestTimeoutMs: 0,
    eventHandlers: {
      [BeaconEvent.PAIR_INIT]: {
        handler: (event) => {
          void event.p2pPeerInfo.catch(() => {})
          void event.postmessagePeerInfo.catch(() => {})
          void Promise.resolve(event.walletConnectPeerInfo).catch(() => {})
        }
      },
      [BeaconEvent.PAIR_SUCCESS]: { handler: paired }
    }
  })
  vi.spyOn(client, 'getWalletInfo').mockResolvedValue({ name: peer.name })
  await client.getActiveAccount()
  const pending = client.init()
  void pending.catch(() => {})
  await vi.advanceTimersByTimeAsync(0)
  if (!accept) throw new Error('Pairing listener is not registered')
  // The adapter checks leadership before invoking the captured candidate callback.
  expect(await client['checkIfBCLeaderExists']()).toBe(true)
  wc['_isConnected'] = TransportStatus.CONNECTED
  expect(boundary.elector.awaitLeadership).toHaveBeenCalledTimes(1)
  expect(boundary.elector.isLeader).toBe(true)
  await expect(accept(peer)).resolves.toBe(true)
  await expect(pending).resolves.toBe(TransportType.WALLETCONNECT)
  expect(paired).toHaveBeenCalledExactlyOnceWith(peer, undefined)
  expect(wc.send).not.toHaveBeenCalled()
})

afterEach(async () => {
  await client.destroy()
  await vi.advanceTimersByTimeAsync(0)
  vi.restoreAllMocks()
  await wc.release()
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('forwards a permission request after fresh pairing before any local request', async () => {
  const id = 'follower-permission'
  const data = {
    type: BeaconMessageType.PermissionRequest,
    appMetadata: { name: 'Follower', senderId: 'follower' },
    network: { type: NetworkType.MAINNET },
    scopes: [PermissionScope.SIGN]
  }
  await boundary.channel.onmessage?.({ type: data.type, id, data })
  await vi.advanceTimersByTimeAsync(0)
  expect(wc.send).toHaveBeenCalledTimes(1)
  const [payload, recipient] = vi.mocked(wc.send).mock.calls[0]
  expect(recipient).toEqual(peer)
  await expect(new Serializer().deserialize(payload)).resolves.toMatchObject({ id, ...data })
  const message = {
    id,
    version: '2',
    senderId: peer.senderId,
    type: BeaconMessageType.Error,
    errorType: BeaconErrorType.NOT_GRANTED_ERROR
  }
  await wc['notifyListeners'](await new Serializer().serialize(message), connectionInfo)
  await vi.advanceTimersByTimeAsync(0)
  // The leader marks the wallet's error before forwarding it to the follower.
  expect(boundary.channel.postMessage).toHaveBeenCalledExactlyOnceWith({
    type: 'RESPONSE',
    id,
    data: { message: { ...message, errorOrigin: 'wallet' }, connectionInfo }
  })
})

it('announces leader departure after fresh pairing without a local request', async () => {
  window.dispatchEvent(new Event('beforeunload'))
  await vi.advanceTimersByTimeAsync(0)
  expect(boundary.elector.die).toHaveBeenCalledTimes(1)
  expect(boundary.channel.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'LEADER_DEAD' })
})
