import 'fake-indexeddb/auto'
import { LocalStorage } from '@ecadlabs/beacon-core'
import {
  BeaconMessageType,
  ExtendedWalletConnectPairingResponse,
  NetworkType,
  StorageKey,
  TransportStatus
} from '@ecadlabs/beacon-types'
import { WalletConnectCommunicationClient } from '../../../beacon-transport-walletconnect/src/communication-client/WalletConnectCommunicationClient'
import {
  flush,
  installLocalChannel,
  mockApprovals,
  mockRemote,
  resetWire,
  session
} from '../../../beacon-transport-walletconnect/__tests__/helpers/controlled-sign-client'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'

vi.mock(
  '@ecadlabs/beacon-transport-walletconnect',
  async () =>
    await vi.importActual<typeof import('../../../beacon-transport-walletconnect/src')>(
      '../../../beacon-transport-walletconnect/src'
    )
)
vi.mock('@walletconnect/sign-client', () => ({ default: { init: async () => remote } }))
vi.mock('@walletconnect/utils', () => ({
  getSdkError: () => ({ code: 6000, message: 'User disconnected.' })
}))

let listSession = true
const remote = {
  ...mockRemote,
  session: {
    get: mockRemote.session.get,
    getAll: mockRemote.session.getAll,
    get keys() {
      return listSession ? mockRemote.session.keys : []
    }
  }
}

class PairingClient extends WalletConnectCommunicationClient {
  listenerKeys(): string[] {
    return [...this.activeListeners.keys()]
  }
}

const retainedPeer: ExtendedWalletConnectPairingResponse = {
  id: 'current',
  senderId: 'current',
  publicKey: 'wallet-key',
  name: 'Retained wallet',
  type: 'walletconnect-pairing-response',
  version: '3',
  extensionId: 'Retained wallet'
}

describe('WalletConnect pairing session ownership', () => {
  installLocalChannel()
  const options = { network: NetworkType.MAINNET, opts: { projectId: 'pairing-session' } }
  let client: PairingClient
  let transport: DappWalletConnectTransport
  let storage: LocalStorage

  beforeEach(async () => {
    vi.useFakeTimers()
    localStorage.clear()
    vi.clearAllMocks()
    resetWire()
    listSession = true
    const leader = async () => true
    client = new PairingClient(options, leader)
    vi.spyOn(WalletConnectCommunicationClient, 'getInstance').mockReturnValue(client)
    storage = new LocalStorage('pairing-session')
    transport = new DappWalletConnectTransport(
      'Pairing session',
      { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
      storage,
      options,
      leader
    )
    await transport.addPeer(retainedPeer)
    await transport.connect()
    expect(client.currentSession()?.topic).toBe('current')
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await client.close()
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    localStorage.clear()
  })

  async function propose(paired: Parameters<DappWalletConnectTransport['listenForNewPeer']>[0]) {
    await transport.listenForNewPeer(paired)
    listSession = false
    await client.init()
    expect(mockApprovals).toHaveLength(1)
  }

  it('keeps a retained topic when a fresh approval with that topic is declined', async () => {
    const retained = client.currentSession()
    const peers = await transport.getPeers()
    const paired = vi.fn(async () => false)
    await propose(paired)
    mockApprovals[0].resolve(session('current'))
    await flush()

    expect(paired).toHaveBeenCalledTimes(1)
    expect(client.currentSession()).toBe(retained)
    expect(await transport.getPeers()).toEqual(peers)
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([retainedPeer])
    expect(client.listenerKeys()).toEqual(['wallet-key'])
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    expect(mockRemote.disconnect).not.toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'current' })
    )
  })

  it('disposes a distinct late approval while retaining the established session', async () => {
    const retained = client.currentSession()
    const peers = await transport.getPeers()
    const paired = vi.fn(async () => true)
    await propose(paired)
    await transport.stopListeningForNewPeers()
    mockApprovals[0].resolve(session('later-topic'))
    await flush()

    expect(paired).not.toHaveBeenCalled()
    expect(client.currentSession()).toBe(retained)
    expect(await transport.getPeers()).toEqual(peers)
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([retainedPeer])
    expect(client.listenerKeys()).toEqual(['wallet-key'])
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    expect(mockRemote.disconnect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ topic: 'later-topic' })
    )
    expect(mockRemote.disconnect).not.toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'current' })
    )
  })

  it('keeps the active topic when a cancelled permission renewal returns the same topic', async () => {
    const retained = client.currentSession()
    const peers = await transport.getPeers()
    const paired = vi.fn(async () => true)
    const delivered = vi.fn()
    await transport.listenForNewPeer(paired)
    await transport.addListener(delivered)
    const pending = client.requestPermissions({
      id: 'permission-renewal',
      type: BeaconMessageType.PermissionRequest,
      version: '2',
      senderId: 'dapp',
      network: { type: NetworkType.MAINNET },
      scopes: [],
      appMetadata: { name: 'Pairing session', senderId: 'dapp' }
    })
    await flush()
    expect(mockApprovals).toHaveLength(1)
    client.cancelRequest('permission-renewal')
    mockApprovals[0].resolve(session('current'))
    await pending
    await flush()

    expect(paired).not.toHaveBeenCalled()
    expect(delivered).not.toHaveBeenCalled()
    expect(client.currentSession()).toBe(retained)
    expect(await transport.getPeers()).toEqual(peers)
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([retainedPeer])
    expect(client.listenerKeys()).toEqual(['wallet-key'])
    expect(mockRemote.disconnect).not.toHaveBeenCalled()
  })
})
