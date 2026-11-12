import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from 'vitest'
import { getSenderId, LocalStorage, Serializer, Transport } from '@ecadlabs/beacon-core'
import { getAddressFromPublicKey, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import {
  BeaconMessageType,
  BeaconRequestMessage,
  BeaconMessageEnvelopeV3,
  BlockchainMessage,
  ChangeAccountInput,
  ChangeAccountRequest,
  ConnectionContext,
  ConnectionInfo,
  ExtendedP2PPairingRequest,
  ExtendedPeerInfo,
  Network,
  NetworkType,
  Origin,
  PeerInfo,
  PermissionScope,
  Regions,
  Storage,
  StorageKey,
  TransportStatus,
  TransportStatusChangedInfo,
  TransportType,
  WalletPeerEvent,
  WalletPendingRequestEvent,
  WalletPendingRequestInfo
} from '@ecadlabs/beacon-types'
import {
  WalletClient,
  type ChangeAccountInput as WalletChangeAccountInput,
  type WalletPeerEvent as WalletClientPeerEvent,
  type WalletPendingRequestEvent as WalletClientPendingRequestEvent,
  type WalletPendingRequestInfo as WalletClientPendingRequestInfo
} from '../../src'
import { WalletP2PTransport } from '../../src/transports/WalletP2PTransport'

type StorageListener = Parameters<Storage['subscribeToStorageChanged']>[0]

class TabStorage extends LocalStorage {
  private readonly storageListeners: StorageListener[] = []

  public override async subscribeToStorageChanged(callback: StorageListener): Promise<void> {
    this.storageListeners.push(callback)
  }

  public async notifyStorageChanged(event: Parameters<StorageListener>[0]): Promise<void> {
    for (const listener of [...this.storageListeners]) {
      await listener(event)
    }
  }
}

class TestWallet extends WalletClient {
  public attach(transport: WalletP2PTransport): Promise<void> {
    return this.setTransport(transport)
  }
}

class DeliveryTransport extends WalletP2PTransport {
  public sentMessages: Array<{ message: string; peer?: ExtendedPeerInfo }> = []
  public addPeerCalls: Array<{ peer: ExtendedP2PPairingRequest; sendPairingResponse: boolean }> = []
  private customRelayServer: string | undefined

  public override get relayServer(): string | undefined {
    return this.customRelayServer
  }

  public setRelayServer(server: string | undefined): void {
    this.customRelayServer = server
  }

  public override async connect(): Promise<void> {
    await Transport.prototype.connect.call(this)
  }

  public override async disconnect(): Promise<void> {
    await Transport.prototype.disconnect.call(this)
  }

  public override async send(message: string, peer?: ExtendedPeerInfo): Promise<void> {
    this.sentMessages.push({ message, peer })
  }

  public override async listen(_publicKey: string): Promise<void> {
    return
  }

  public override async addPeer(
    newPeer: ExtendedP2PPairingRequest,
    sendPairingResponse: boolean = true
  ): Promise<void> {
    this.addPeerCalls.push({ peer: newPeer, sendPairingResponse })
    await Transport.prototype.addPeer.call(this, newPeer)
  }

  public async emitStatus(update: {
    status?: TransportStatus
    health?: 'ok' | 'degraded'
    reason?: TransportStatusChangedInfo['reason']
    relayServer?: string
  }): Promise<void> {
    await this.updateConnectionStatus(update)
  }

  public async deliver(
    message: BeaconRequestMessage | BeaconMessageEnvelopeV3 | Record<string, unknown>,
    context: ConnectionContext = { origin: Origin.P2P, id: 'peer-pk-1' }
  ): Promise<void> {
    await this.notifyListeners(await new Serializer().serialize(message), context)
  }
}

const validEdpk = 'edpktpzo8UZieYaJZgCHP6M6hKHPdWBSNqxvmEt6dwWRgxDh1EAFw9'
const validEdpkAlt = 'edpkuBknW28nW72KG6RoHtYW7p12T6GKc7nAbwYX5m8Wd9sDVC9yav'
const validContractAddress = 'KT1TxqZ8QtKvLu3V3JH7Gx58n7Co8pgtpQU5'
const network: Network = { type: NetworkType.MAINNET }

const makePeer = (overrides: Partial<ExtendedP2PPairingRequest> = {}): ExtendedP2PPairingRequest => ({
  id: 'peer-id-1',
  name: 'DApp One',
  publicKey: 'peer-pk-1',
  version: '2',
  relayServer: 'beacon-node-1.octez.io',
  senderId: 'sender-1',
  type: 'p2p-pairing-request',
  ...overrides
})

const makePermissionRequest = (
  id: string,
  senderId: string = 'sender-1'
): BeaconRequestMessage => ({
  id,
  senderId,
  version: '2',
  type: BeaconMessageType.PermissionRequest,
  appMetadata: { senderId, name: 'DApp One' },
  network,
  scopes: [PermissionScope.SIGN]
})

const makeOperationRequest = (
  id: string,
  senderId: string = 'sender-1'
): BeaconRequestMessage => ({
  id,
  senderId,
  version: '2',
  type: BeaconMessageType.OperationRequest,
  network,
  operationDetails: [],
  sourceAddress: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb'
})

interface V3SignPayloadMessage extends BlockchainMessage {
  accountId: string
}

const makeV3SignPayloadEnvelope = (
  id: string,
  senderId: string = 'sender-1'
): BeaconMessageEnvelopeV3<V3SignPayloadMessage> => ({
  id,
  version: '3',
  senderId,
  message: {
    type: BeaconMessageType.SignPayloadRequest,
    blockchainIdentifier: 'tezos',
    accountId: 'account-1',
    blockchainData: {
      signingType: 'raw' as never,
      payload: '050100000004abcd'
    }
  }
})

describe('WalletClient observability, pending requests, changeAccount, and lifecycle (Issue #145)', () => {
  const wallets: TestWallet[] = []

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(async () => {
    await Promise.allSettled(wallets.splice(0).map((wallet) => wallet.destroy()))
    vi.restoreAllMocks()
    localStorage.clear()
  })

  const createWallet = async (options?: {
    matrixNodes?: Record<string, string[]>
    attachTransport?: boolean
    customStorage?: TabStorage
  }) => {
    const storage = options?.customStorage ?? new TabStorage('wallet-obs-test')
    const wallet = new TestWallet({
      name: 'Observability Wallet',
      storage,
      ...(options?.matrixNodes ? { matrixNodes: options.matrixNodes } : {})
    })
    wallets.push(wallet)
    await wallet.beaconId
    const keys = await getKeypairFromSeed('wallet-observability-seed')
    const transport = new DeliveryTransport('Observability Wallet', keys, storage, {})
    if (options?.attachTransport !== false) {
      await wallet.attach(transport)
    }
    return { wallet, storage, transport, keys }
  }

  describe('Type exports and shapes', () => {
    it('exports WalletPendingRequestInfo, WalletPendingRequestEvent, WalletPeerEvent, ChangeAccountInput from both beacon-types and beacon-wallet', () => {
      expectTypeOf<WalletClientPendingRequestInfo>().toEqualTypeOf<WalletPendingRequestInfo>()
      expectTypeOf<WalletClientPendingRequestEvent>().toEqualTypeOf<WalletPendingRequestEvent>()
      expectTypeOf<WalletClientPeerEvent>().toEqualTypeOf<WalletPeerEvent>()
      expectTypeOf<WalletChangeAccountInput>().toEqualTypeOf<ChangeAccountInput>()
    })

    it('enforces expected property shapes on exported types', () => {
      expectTypeOf<WalletPendingRequestInfo>().toMatchTypeOf<{
        id: string
        type: BeaconMessageType
        version: string
        transport: TransportType
        senderId: string
        receivedAt: number
        connectionContext: ConnectionContext
        request: BeaconRequestMessage | BeaconMessageEnvelopeV3
      }>()

      expectTypeOf<
        Extract<WalletPendingRequestEvent, { type: 'request_received' }>
      >().toMatchTypeOf<{
        type: 'request_received'
        request: WalletPendingRequestInfo
      }>()

      expectTypeOf<
        Extract<WalletPendingRequestEvent, { type: 'request_removed' }>
      >().toMatchTypeOf<{
        type: 'request_removed'
        request: WalletPendingRequestInfo
        reason: 'responded' | 'dismissed' | 'peer_disconnected'
      }>()

      expectTypeOf<WalletPeerEvent>().toMatchTypeOf<{
        type: 'peer_added' | 'peer_removed'
        peer: ExtendedPeerInfo
        source: 'local' | 'storage'
      }>()

      const implicitInput = {
        publicKey: validEdpk,
        network,
        scopes: [PermissionScope.SIGN]
      }
      expectTypeOf(implicitInput).toMatchTypeOf<ChangeAccountInput>()

      const abstractedInput = {
        walletType: 'abstracted_account' as const,
        address: validContractAddress,
        network,
        scopes: [PermissionScope.SIGN]
      }
      expectTypeOf(abstractedInput).toMatchTypeOf<ChangeAccountInput>()
    })
  })

  describe('Pending request management', () => {
    it('returns a frozen array of WalletPendingRequestInfo with mapped transport and V3 envelope type', async () => {
      const { wallet, transport } = await createWallet()
      await wallet.connect(vi.fn())

      const p2pReq = makePermissionRequest('req-p2p', 'sender-1')
      const extReq = makeOperationRequest('req-ext', 'sender-2')
      const wcV3Req = makeV3SignPayloadEnvelope('req-wc-v3', 'sender-3')

      const p2pCtx: ConnectionContext = { origin: Origin.P2P, id: 'peer-pk-1' }
      const extCtx: ConnectionContext = { origin: Origin.EXTENSION, id: 'ext-1' }
      const wcCtx: ConnectionContext = { origin: Origin.WALLETCONNECT, id: 'wc-topic-1' }

      await transport.deliver(p2pReq, p2pCtx)
      await transport.deliver(extReq, extCtx)
      await transport.deliver(wcV3Req, wcCtx)

      const pending = wallet.getPendingRequests()
      expect(Object.isFrozen(pending)).toBe(true)
      expect(pending).toHaveLength(3)

      expect(pending[0]).toMatchObject({
        id: 'req-p2p',
        type: BeaconMessageType.PermissionRequest,
        version: '2',
        transport: TransportType.P2P,
        senderId: 'sender-1',
        connectionContext: p2pCtx,
        request: p2pReq
      })
      expect(typeof pending[0]?.receivedAt).toBe('number')

      expect(pending[1]).toMatchObject({
        id: 'req-ext',
        type: BeaconMessageType.OperationRequest,
        version: '2',
        transport: TransportType.POST_MESSAGE,
        senderId: 'sender-2',
        connectionContext: extCtx,
        request: extReq
      })

      expect(pending[2]).toMatchObject({
        id: 'req-wc-v3',
        type: BeaconMessageType.SignPayloadRequest,
        version: '3',
        transport: TransportType.WALLETCONNECT,
        senderId: 'sender-3',
        connectionContext: wcCtx,
        request: wcV3Req
      })
    })

    it('dismissPendingRequest removes without sending a wire response and notifies listeners with reason dismissed', async () => {
      const { wallet, transport } = await createWallet()
      const events: WalletPendingRequestEvent[] = []
      wallet.subscribeToPendingRequests((event) => {
        events.push(event)
      })
      await wallet.connect(vi.fn())

      const req = makePermissionRequest('req-dismiss-1')
      await transport.deliver(req)
      transport.sentMessages.length = 0

      expect(wallet.dismissPendingRequest('non-existent-id')).toBe(false)
      expect(wallet.dismissPendingRequest('req-dismiss-1')).toBe(true)
      expect(wallet.dismissPendingRequest('req-dismiss-1')).toBe(false)

      expect(wallet.getPendingRequests()).toHaveLength(0)
      expect(transport.sentMessages).toHaveLength(0)

      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({
        type: 'request_received',
        request: { id: 'req-dismiss-1' }
      })
      expect(events[1]).toMatchObject({
        type: 'request_removed',
        reason: 'dismissed',
        request: { id: 'req-dismiss-1' }
      })
    })

    it('respond removes the pending request and notifies listeners with reason responded', async () => {
      const { wallet, transport } = await createWallet()
      const events: WalletPendingRequestEvent[] = []
      wallet.subscribeToPendingRequests((event) => {
        events.push(event)
      })
      await wallet.connect(vi.fn())

      const req = makePermissionRequest('req-respond-1')
      await transport.deliver(req)

      await wallet.respond({
        id: 'req-respond-1',
        type: BeaconMessageType.PermissionResponse,
        publicKey: validEdpk,
        network,
        scopes: [PermissionScope.SIGN]
      })

      expect(wallet.getPendingRequests()).toHaveLength(0)
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({
        type: 'request_removed',
        reason: 'responded',
        request: { id: 'req-respond-1' }
      })
    })

    it('does NOT remove pending request or emit request_removed when respond() fails in transport/interceptor', async () => {
      const { wallet, transport } = await createWallet()
      const events: WalletPendingRequestEvent[] = []
      wallet.subscribeToPendingRequests((event) => {
        events.push(event)
      })
      await wallet.connect(vi.fn())

      const req = makePermissionRequest('req-fail-respond-1')
      await transport.deliver(req)
      expect(wallet.getPendingRequests()).toHaveLength(1)

      vi.spyOn(transport, 'send').mockRejectedValueOnce(new Error('transport send failed'))

      await expect(
        wallet.respond({
          id: 'req-fail-respond-1',
          type: BeaconMessageType.PermissionResponse,
          publicKey: validEdpk,
          network,
          scopes: [PermissionScope.SIGN]
        })
      ).rejects.toThrow('transport send failed')

      expect(wallet.getPendingRequests()).toHaveLength(1)
      expect(wallet.getPendingRequests()[0].id).toBe('req-fail-respond-1')
      expect(events.filter((e) => e.type === 'request_removed')).toHaveLength(0)
    })

    it('evicts matching pending requests on inbound Disconnect, removePeer, and removeAllPeers with reason peer_disconnected', async () => {
      const { wallet, transport } = await createWallet()
      const peer1 = makePeer({ id: 'p1', publicKey: 'pk-1', senderId: 'sender-1' })
      const peer2 = makePeer({ id: 'p2', publicKey: 'pk-2', senderId: 'sender-2' })
      const peer3 = makePeer({ id: 'p3', publicKey: 'pk-3', senderId: 'sender-3' })
      await wallet.addPeer(peer1, false)
      await wallet.addPeer(peer2, false)
      await wallet.addPeer(peer3, false)

      const events: WalletPendingRequestEvent[] = []
      wallet.subscribeToPendingRequests((event) => {
        events.push(event)
      })
      await wallet.connect(vi.fn())

      await transport.deliver(makePermissionRequest('req-p1', 'sender-1'), {
        origin: Origin.P2P,
        id: 'pk-1'
      })
      await transport.deliver(makePermissionRequest('req-p2', 'sender-2'), {
        origin: Origin.P2P,
        id: 'pk-2'
      })
      await transport.deliver(makePermissionRequest('req-p3', 'sender-3'), {
        origin: Origin.P2P,
        id: 'pk-3'
      })

      // 1. Inbound Disconnect evicts peer1's pending request
      await transport.deliver(
        {
          id: 'disconnect-1',
          type: BeaconMessageType.Disconnect,
          version: '2',
          senderId: 'sender-1'
        },
        { origin: Origin.P2P, id: 'pk-1' }
      )
      expect(wallet.getPendingRequests().map((r) => r.id)).toEqual(['req-p2', 'req-p3'])

      // 2. removePeer evicts peer2's pending request
      await wallet.removePeer(peer2)
      expect(wallet.getPendingRequests().map((r) => r.id)).toEqual(['req-p3'])

      // 3. removeAllPeers evicts remaining pending requests
      await wallet.removeAllPeers()
      expect(wallet.getPendingRequests()).toEqual([])

      const removedEvents = events.filter((e) => e.type === 'request_removed')
      expect(removedEvents).toHaveLength(3)
      expect(removedEvents.map((e) => [e.request.id, e.reason])).toEqual([
        ['req-p1', 'peer_disconnected'],
        ['req-p2', 'peer_disconnected'],
        ['req-p3', 'peer_disconnected']
      ])
    })

    it('evicts pending request when matching ONLY by senderId (connectionContext.id differs from peer.publicKey)', async () => {
      const { wallet, transport } = await createWallet()
      const peer = makePeer({
        id: 'p-sender-only',
        publicKey: 'pk-sender-only',
        senderId: 'sender-only'
      })
      await wallet.addPeer(peer, false)

      const events: WalletPendingRequestEvent[] = []
      wallet.subscribeToPendingRequests((event) => {
        events.push(event)
      })
      await wallet.connect(vi.fn())

      // Matches ONLY by senderId; connectionContext.id differs from peer.publicKey
      await transport.deliver(makePermissionRequest('req-sender-only', 'sender-only'), {
        origin: Origin.P2P,
        id: 'unrelated-context-id'
      })

      expect(wallet.getPendingRequests()).toHaveLength(1)

      await wallet.removePeer(peer)
      expect(wallet.getPendingRequests()).toEqual([])

      const removed = events.filter((e) => e.type === 'request_removed')
      expect(removed).toHaveLength(1)
      expect(removed[0]).toMatchObject({
        type: 'request_removed',
        reason: 'peer_disconnected',
        request: { id: 'req-sender-only' }
      })
    })

    it('evicts pending request when matching ONLY by publicKey/connectionContext.id (request.senderId differs or peer lacks senderId)', async () => {
      const { wallet, transport } = await createWallet()
      const peer = makePeer({
        id: 'p-pk-only',
        publicKey: 'pk-only',
        senderId: 'peer-sender-id'
      })
      await wallet.addPeer(peer, false)

      const events: WalletPendingRequestEvent[] = []
      wallet.subscribeToPendingRequests((event) => {
        events.push(event)
      })
      await wallet.connect(vi.fn())

      // Matches ONLY by connectionContext.id === peer.publicKey; request.senderId differs
      await transport.deliver(makePermissionRequest('req-pk-only', 'different-sender-id'), {
        origin: Origin.P2P,
        id: 'pk-only'
      })

      expect(wallet.getPendingRequests()).toHaveLength(1)

      // Remove using a PeerInfo without senderId (only publicKey matches connectionContext.id)
      const peerWithoutSenderId: PeerInfo = {
        id: 'p-pk-only',
        name: 'DApp One',
        publicKey: 'pk-only',
        version: '2',
        type: 'p2p-pairing-request'
      }
      await wallet.removePeer(peerWithoutSenderId)
      expect(wallet.getPendingRequests()).toEqual([])

      const removed = events.filter((e) => e.type === 'request_removed')
      expect(removed).toHaveLength(1)
      expect(removed[0]).toMatchObject({
        type: 'request_removed',
        reason: 'peer_disconnected',
        request: { id: 'req-pk-only' }
      })
    })

    it('ignores duplicate incoming request IDs without adding duplicate entries or events', async () => {
      const { wallet, transport } = await createWallet()
      const events: WalletPendingRequestEvent[] = []
      wallet.subscribeToPendingRequests((event) => {
        events.push(event)
      })
      const onMessage = vi.fn()
      await wallet.connect(onMessage)

      const req = makePermissionRequest('req-dup-1')
      await transport.deliver(req)
      await transport.deliver(req)

      expect(wallet.getPendingRequests()).toHaveLength(1)
      expect(events).toHaveLength(1)
      expect(onMessage).toHaveBeenCalledTimes(1)
    })

    it('provides idempotent unsubscribe and isolates listener errors for subscribeToPendingRequests', async () => {
      const { wallet, transport } = await createWallet()
      const throwingListener = vi.fn(() => {
        throw new Error('listener boom')
      })
      const healthyListener = vi.fn()

      const unsubThrowing = wallet.subscribeToPendingRequests(throwingListener)
      const unsubHealthy = wallet.subscribeToPendingRequests(healthyListener)
      const dupHealthy = wallet.subscribeToPendingRequests(healthyListener)
      expect(unsubHealthy).toBe(dupHealthy)

      await wallet.connect(vi.fn())
      await transport.deliver(makePermissionRequest('req-sub-1'))

      expect(throwingListener).toHaveBeenCalledTimes(1)
      expect(healthyListener).toHaveBeenCalledTimes(1)

      unsubThrowing()
      unsubThrowing()
      unsubHealthy()

      await transport.deliver(makePermissionRequest('req-sub-2'))
      expect(throwingListener).toHaveBeenCalledTimes(1)
      expect(healthyListener).toHaveBeenCalledTimes(1)
    })
  })

  describe('Transport and connection observability', () => {
    it('getConnectionInfo() is non-blocking when no transport is initialized and returns active info when attached', async () => {
      const { wallet: uninitializedWallet } = await createWallet({ attachTransport: false })
      const initialInfo: ConnectionInfo = await uninitializedWallet.getConnectionInfo()
      expect(initialInfo).toEqual({
        status: TransportStatus.NOT_CONNECTED,
        health: 'ok'
      })

      const { wallet, transport } = await createWallet()
      transport.setRelayServer('beacon-node-2.octez.io')
      await wallet.connect(vi.fn())

      const activeInfo = await wallet.getConnectionInfo()
      expect(activeInfo).toEqual({
        transport: TransportType.P2P,
        status: TransportStatus.CONNECTED,
        health: 'ok',
        relayServer: 'beacon-node-2.octez.io'
      })
    })

    it('getSelectedMatrixNode() returns active relayServer, falls back to validated storage without blocking, and returns undefined for unconfigured stored node', async () => {
      const { wallet: uninit, storage: uninitStorage } = await createWallet({
        attachTransport: false,
        matrixNodes: { [Regions.EUROPE_WEST]: ['beacon-node-1.octez.io', 'beacon-node-2.octez.io'] }
      })

      // Stored node in configured matrixNodes
      await uninitStorage.set(StorageKey.MATRIX_SELECTED_NODE, 'beacon-node-2.octez.io')
      await expect(uninit.getSelectedMatrixNode()).resolves.toBe('beacon-node-2.octez.io')

      // Stored node NOT in configured matrixNodes -> undefined
      await uninitStorage.set(StorageKey.MATRIX_SELECTED_NODE, 'stale-node.example.com')
      await expect(uninit.getSelectedMatrixNode()).resolves.toBeUndefined()

      // Stored node when matrixNodes is empty/unconfigured -> returns stored node
      const { wallet: emptyNodesWallet, storage: emptyNodesStorage } = await createWallet({
        attachTransport: false,
        matrixNodes: {}
      })
      await emptyNodesStorage.set(StorageKey.MATRIX_SELECTED_NODE, 'stored-default.example.com')
      await expect(emptyNodesWallet.getSelectedMatrixNode()).resolves.toBe(
        'stored-default.example.com'
      )

      // Stored node when matrixNodes is completely omitted/default -> returns stored node
      const { wallet: omittedNodesWallet, storage: omittedNodesStorage } = await createWallet({
        attachTransport: false
      })
      await omittedNodesStorage.set(
        StorageKey.MATRIX_SELECTED_NODE,
        'omitted-stored-node.example.com'
      )
      await expect(omittedNodesWallet.getSelectedMatrixNode()).resolves.toBe(
        'omitted-stored-node.example.com'
      )

      // Stored node with multi-region matrixNodes where node is in non-first region
      const { wallet: multiRegionWallet, storage: multiRegionStorage } = await createWallet({
        attachTransport: false,
        matrixNodes: {
          [Regions.EUROPE_WEST]: ['eu-node-1.octez.io'],
          [Regions.NORTH_AMERICA_EAST]: ['na-node-1.octez.io', 'na-node-2.octez.io'],
          [Regions.ASIA_EAST]: ['asia-node-1.octez.io']
        }
      })
      await multiRegionStorage.set(StorageKey.MATRIX_SELECTED_NODE, 'na-node-2.octez.io')
      await expect(multiRegionWallet.getSelectedMatrixNode()).resolves.toBe('na-node-2.octez.io')

      // Stored node with multi-region matrixNodes where node is not in any region -> undefined
      await multiRegionStorage.set(StorageKey.MATRIX_SELECTED_NODE, 'stale-multi.example.com')
      await expect(multiRegionWallet.getSelectedMatrixNode()).resolves.toBeUndefined()

      // Stored node with matrixNodes containing undefined region value -> returns stored node
      const { wallet: undefinedRegionWallet, storage: undefinedRegionStorage } = await createWallet({
        attachTransport: false,
        matrixNodes: { [Regions.EUROPE_WEST]: undefined as unknown as string[] }
      })
      await undefinedRegionStorage.set(StorageKey.MATRIX_SELECTED_NODE, 'undefined-region.example.com')
      await expect(undefinedRegionWallet.getSelectedMatrixNode()).resolves.toBe(
        'undefined-region.example.com'
      )

      // Active connected transport relayServer takes precedence
      const { wallet, storage, transport } = await createWallet({
        matrixNodes: { [Regions.EUROPE_WEST]: ['beacon-node-1.octez.io'] }
      })
      await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'beacon-node-1.octez.io')
      transport.setRelayServer('beacon-node-active.octez.io')
      await wallet.connect(vi.fn())
      await expect(wallet.getSelectedMatrixNode()).resolves.toBe('beacon-node-active.octez.io')
    })

    it('subscribeToTransportStatus forwards transitions, deduplicates identical listeners, isolates errors, isolates stale unsubscribes, and cleans up on destroy', async () => {
      const { wallet, transport } = await createWallet()
      const events: TransportStatusChangedInfo[] = []
      const listener = vi.fn((info: TransportStatusChangedInfo) => {
        events.push(info)
      })
      const failingListener = vi.fn(() => {
        throw new Error('status listener failure')
      })

      const unsub1 = wallet.subscribeToTransportStatus(listener)
      const unsub2 = wallet.subscribeToTransportStatus(listener)
      wallet.subscribeToTransportStatus(failingListener)
      expect(unsub1).toBe(unsub2)

      await transport.emitStatus({
        status: TransportStatus.CONNECTING,
        relayServer: 'beacon-node-1.octez.io'
      })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        transport: TransportType.P2P,
        status: TransportStatus.CONNECTING,
        previous: TransportStatus.NOT_CONNECTED,
        health: 'ok',
        relayServer: 'beacon-node-1.octez.io'
      })
      expect(failingListener).toHaveBeenCalledTimes(1)

      // Unsubscribe, re-subscribe, and verify stale cleanup is isolated
      unsub1()
      unsub1()
      const currentUnsub = wallet.subscribeToTransportStatus(listener)
      unsub2()

      await transport.emitStatus({
        status: TransportStatus.CONNECTED,
        health: 'degraded',
        reason: 'sync_failing'
      })
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({
        status: TransportStatus.CONNECTED,
        previous: TransportStatus.CONNECTING,
        health: 'degraded',
        reason: 'sync_failing'
      })

      await wallet.destroy()
      currentUnsub()

      await transport.emitStatus({
        status: TransportStatus.NOT_CONNECTED
      })
      expect(events).toHaveLength(2)
    })

    it('subscribeToTransportStatus works when subscribed before transport initialization (late transport binding)', async () => {
      const { wallet, storage, keys } = await createWallet({ attachTransport: false })
      const events: TransportStatusChangedInfo[] = []
      const unsub = wallet.subscribeToTransportStatus((info) => {
        events.push(info)
      })

      await expect(wallet.getConnectionInfo()).resolves.toEqual({
        status: TransportStatus.NOT_CONNECTED,
        health: 'ok'
      })

      const lateTransport = new DeliveryTransport('Observability Wallet', keys, storage, {})
      await wallet.attach(lateTransport)

      await lateTransport.emitStatus({
        status: TransportStatus.CONNECTING,
        relayServer: 'beacon-node-late.octez.io'
      })
      await lateTransport.emitStatus({
        status: TransportStatus.CONNECTED
      })

      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({
        transport: TransportType.P2P,
        status: TransportStatus.CONNECTING,
        relayServer: 'beacon-node-late.octez.io'
      })
      expect(events[1]).toMatchObject({
        transport: TransportType.P2P,
        status: TransportStatus.CONNECTED,
        previous: TransportStatus.CONNECTING
      })

      unsub()
      await lateTransport.emitStatus({
        status: TransportStatus.NOT_CONNECTED
      })
      expect(events).toHaveLength(2)
    })
  })

  describe('changeAccount()', () => {
    it('validates address/publicKey and walletType, rejecting missing credentials, invalid addresses, and non-KT1 abstracted accounts', async () => {
      const { wallet } = await createWallet()
      const peer = makePeer()
      await wallet.addPeer(peer, false)

      await expect(
        wallet.changeAccount(peer.senderId, {
          network,
          scopes: [PermissionScope.SIGN]
        } as ChangeAccountInput)
      ).rejects.toThrow()

      await expect(
        wallet.changeAccount(peer.senderId, {
          address: 'not-a-valid-tezos-address',
          network,
          scopes: [PermissionScope.SIGN]
        })
      ).rejects.toThrow()

      await expect(
        wallet.changeAccount(peer.senderId, {
          walletType: 'abstracted_account',
          address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
          network,
          scopes: [PermissionScope.SIGN]
        })
      ).rejects.toThrow()

      await expect(
        wallet.changeAccount(peer.senderId, {
          publicKey: 'invalid-public-key',
          network,
          scopes: [PermissionScope.SIGN]
        })
      ).rejects.toThrow()

      await expect(
        wallet.changeAccount(peer.senderId, {
          publicKey: '',
          network,
          scopes: [PermissionScope.SIGN]
        })
      ).rejects.toThrow()
    })

    it('throws a descriptive error when no paired peer matches peerSenderId', async () => {
      const { wallet } = await createWallet()
      await expect(
        wallet.changeAccount('unknown-sender-id', {
          publicKey: validEdpk,
          network,
          scopes: [PermissionScope.SIGN]
        })
      ).rejects.toThrow(/unknown-sender-id|peer/i)
    })

    it('updates stored PermissionInfo when AppMetadata exists and sends serialized ChangeAccountRequest over transport.send', async () => {
      const { wallet, storage, transport } = await createWallet()
      const peer = makePeer({ senderId: 'dapp-sender-1', publicKey: 'peer-pk-1' })
      await wallet.addPeer(peer, false)
      await storage.set(StorageKey.APP_METADATA_LIST, [
        { senderId: 'dapp-sender-1', name: 'DApp One' }
      ])

      const derivedAddress = await getAddressFromPublicKey(validEdpk)

      await wallet.changeAccount('dapp-sender-1', {
        publicKey: validEdpk,
        network,
        scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST]
      })

      expect(transport.sentMessages).toHaveLength(1)
      const sent = transport.sentMessages[0]!
      expect(sent.peer?.publicKey).toBe('peer-pk-1')

      const deserialized = (await new Serializer().deserialize(
        sent.message
      )) as ChangeAccountRequest
      expect(deserialized).toMatchObject({
        version: '2',
        type: BeaconMessageType.ChangeAccountRequest,
        walletType: 'implicit',
        publicKey: validEdpk,
        address: derivedAddress,
        network,
        scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST]
      })
      const expectedSenderId = await getSenderId(await wallet.beaconId)
      expect(typeof deserialized.id).toBe('string')
      expect(deserialized.senderId).toBe(expectedSenderId)

      const permissions = await wallet.getPermissions()
      expect(permissions).toHaveLength(1)
      expect(permissions[0]).toMatchObject({
        senderId: 'dapp-sender-1',
        address: derivedAddress,
        publicKey: validEdpk,
        network,
        scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST]
      })

      // Switching to a second implicit account updates the existing PermissionInfo for this peer
      const derivedAddressAlt = await getAddressFromPublicKey(validEdpkAlt)
      await wallet.changeAccount('dapp-sender-1', {
        publicKey: validEdpkAlt,
        network,
        scopes: [PermissionScope.SIGN]
      })

      const updatedPermissions = await wallet.getPermissions()
      expect(updatedPermissions).toHaveLength(1)
      expect(updatedPermissions[0]).toMatchObject({
        senderId: 'dapp-sender-1',
        address: derivedAddressAlt,
        publicKey: validEdpkAlt,
        scopes: [PermissionScope.SIGN]
      })

      // Switching to an abstracted_account when AppMetadata exists updates PermissionInfo with KT1 address
      await wallet.changeAccount('dapp-sender-1', {
        walletType: 'abstracted_account',
        address: validContractAddress,
        network,
        scopes: [PermissionScope.SIGN]
      })

      const abstractedPermissions = await wallet.getPermissions()
      expect(abstractedPermissions).toHaveLength(1)
      expect(abstractedPermissions[0]).toMatchObject({
        senderId: 'dapp-sender-1',
        address: validContractAddress,
        walletType: 'abstracted_account',
        scopes: [PermissionScope.SIGN]
      })

      // Switching to an implicit account with address only when AppMetadata exists updates PermissionInfo
      await wallet.changeAccount('dapp-sender-1', {
        walletType: 'implicit',
        address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        network,
        scopes: [PermissionScope.SIGN]
      })

      const addressOnlyPermissions = await wallet.getPermissions()
      expect(addressOnlyPermissions).toHaveLength(1)
      expect(addressOnlyPermissions[0]).toMatchObject({
        senderId: 'dapp-sender-1',
        address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        walletType: 'implicit',
        scopes: [PermissionScope.SIGN]
      })
    })

    it('supports implicit account with address only (no publicKey)', async () => {
      const { wallet, transport } = await createWallet()
      const peer = makePeer({ senderId: 'dapp-addr-only', publicKey: 'peer-pk-addr-only' })
      await wallet.addPeer(peer, false)

      await wallet.changeAccount('dapp-addr-only', {
        walletType: 'implicit',
        address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        network,
        scopes: [PermissionScope.SIGN]
      })

      expect(transport.sentMessages).toHaveLength(1)
      const deserialized = (await new Serializer().deserialize(
        transport.sentMessages[0]!.message
      )) as ChangeAccountRequest
      const expectedSenderId = await getSenderId(await wallet.beaconId)
      expect(deserialized).toMatchObject({
        version: '2',
        type: BeaconMessageType.ChangeAccountRequest,
        walletType: 'implicit',
        address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        network,
        scopes: [PermissionScope.SIGN]
      })
      expect(typeof deserialized.id).toBe('string')
      expect(deserialized.senderId).toBe(expectedSenderId)
    })

    it('still sends ChangeAccountRequest when AppMetadata is missing for peerSenderId without touching permissions', async () => {
      const { wallet, transport } = await createWallet()
      const peer = makePeer({ senderId: 'dapp-no-meta', publicKey: 'peer-pk-no-meta' })
      await wallet.addPeer(peer, false)

      await wallet.changeAccount('dapp-no-meta', {
        walletType: 'abstracted_account',
        address: validContractAddress,
        network,
        scopes: [PermissionScope.SIGN]
      })

      expect(transport.sentMessages).toHaveLength(1)
      const deserialized = (await new Serializer().deserialize(
        transport.sentMessages[0]!.message
      )) as ChangeAccountRequest
      const expectedSenderId = await getSenderId(await wallet.beaconId)
      expect(deserialized).toMatchObject({
        version: '2',
        type: BeaconMessageType.ChangeAccountRequest,
        walletType: 'abstracted_account',
        address: validContractAddress,
        network,
        scopes: [PermissionScope.SIGN]
      })
      expect(typeof deserialized.id).toBe('string')
      expect(deserialized.senderId).toBe(expectedSenderId)
      await expect(wallet.getPermissions()).resolves.toEqual([])

      // Also supports implicit account with explicit publicKey when switching again
      await wallet.changeAccount('dapp-no-meta', {
        publicKey: validEdpkAlt,
        network,
        scopes: [PermissionScope.SIGN]
      })
      expect(transport.sentMessages).toHaveLength(2)
      const deserializedAlt = (await new Serializer().deserialize(
        transport.sentMessages[1]!.message
      )) as ChangeAccountRequest
      expect(deserializedAlt.senderId).toBe(expectedSenderId)
      await expect(wallet.getPermissions()).resolves.toEqual([])

      // Also supports implicit account with address only when switching again
      await wallet.changeAccount('dapp-no-meta', {
        walletType: 'implicit',
        address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        network,
        scopes: [PermissionScope.SIGN]
      })
      expect(transport.sentMessages).toHaveLength(3)
      const deserializedAddrOnly = (await new Serializer().deserialize(
        transport.sentMessages[2]!.message
      )) as ChangeAccountRequest
      expect(deserializedAddrOnly.senderId).toBe(expectedSenderId)
      await expect(wallet.getPermissions()).resolves.toEqual([])
    })
  })

  describe('Typed peer lifecycle subscriptions and cross-tab storage sync', () => {
    it('provides listener error isolation, duplicate listener deduplication, idempotent unsubscribe, and cleanup on wallet.destroy() for subscribeToPeers', async () => {
      const { wallet } = await createWallet()
      const throwingListener = vi.fn(() => {
        throw new Error('peer listener boom')
      })
      const healthyListener = vi.fn()

      const unsubThrowing = wallet.subscribeToPeers(throwingListener)
      const unsubHealthy1 = wallet.subscribeToPeers(healthyListener)
      const unsubHealthy2 = wallet.subscribeToPeers(healthyListener)
      expect(unsubHealthy1).toBe(unsubHealthy2)

      const peer1 = makePeer({ id: 'p1', publicKey: 'pk-1', senderId: 'sender-1' })
      await wallet.addPeer(peer1, false)

      expect(throwingListener).toHaveBeenCalledTimes(1)
      expect(healthyListener).toHaveBeenCalledTimes(1)

      unsubThrowing()
      unsubThrowing()
      unsubHealthy1()

      const peer2 = makePeer({ id: 'p2', publicKey: 'pk-2', senderId: 'sender-2' })
      await wallet.addPeer(peer2, false)

      expect(throwingListener).toHaveBeenCalledTimes(1)
      expect(healthyListener).toHaveBeenCalledTimes(1)

      const reconnectedListener = vi.fn()
      wallet.subscribeToPeers(reconnectedListener)
      await wallet.destroy()

      const peer3 = makePeer({ id: 'p3', publicKey: 'pk-3', senderId: 'sender-3' })
      await wallet.addPeer(peer3, false)
      expect(reconnectedListener).not.toHaveBeenCalled()
    })

    it('emits local peer_added and peer_removed events on addPeer, removePeer, removeAllPeers, and inbound Disconnect', async () => {
      const { wallet, transport } = await createWallet()
      const events: WalletPeerEvent[] = []
      const unsub = wallet.subscribeToPeers((event) => {
        events.push(event)
      })

      const peer1 = makePeer({ id: 'p1', publicKey: 'pk-1', senderId: 'sender-1' })
      const peer2 = makePeer({ id: 'p2', publicKey: 'pk-2', senderId: 'sender-2' })
      const peer3 = makePeer({ id: 'p3', publicKey: 'pk-3', senderId: 'sender-3' })

      await wallet.addPeer(peer1, false)
      await wallet.addPeer(peer2, false)
      await wallet.addPeer(peer3, false)

      await wallet.removePeer(peer1)

      await wallet.connect(vi.fn())
      await transport.deliver(
        {
          id: 'disconnect-p2',
          type: BeaconMessageType.Disconnect,
          version: '2',
          senderId: 'sender-2'
        },
        { origin: Origin.P2P, id: 'pk-2' }
      )

      await wallet.removeAllPeers()

      expect(events.map((e) => [e.type, e.peer.senderId, e.source])).toEqual([
        ['peer_added', 'sender-1', 'local'],
        ['peer_added', 'sender-2', 'local'],
        ['peer_added', 'sender-3', 'local'],
        ['peer_removed', 'sender-1', 'local'],
        ['peer_removed', 'sender-2', 'local'],
        ['peer_removed', 'sender-3', 'local']
      ])

      unsub()
      await wallet.addPeer(peer1, false)
      expect(events).toHaveLength(6)
    })

    it('emits storage peer_added and peer_removed events on cross-tab storage changes, deduplicates known peers, and reconciles new P2P peers without sending pairing response', async () => {
      const { wallet, storage, transport } = await createWallet()
      const events: WalletPeerEvent[] = []
      wallet.subscribeToPeers((event) => {
        events.push(event)
      })

      const peerFromOtherTab = makePeer({
        id: 'tab-p2p-1',
        publicKey: 'tab-pk-1',
        senderId: 'tab-sender-1'
      })

      // 1. Storage notification adds peerFromOtherTab
      await storage.notifyStorageChanged({
        eventType: 'entryModified',
        key: storage.getPrefixedKey(StorageKey.TRANSPORT_P2P_PEERS_WALLET),
        oldValue: JSON.stringify([]),
        newValue: JSON.stringify([peerFromOtherTab])
      })

      expect(events).toEqual([
        {
          type: 'peer_added',
          peer: expect.objectContaining({ publicKey: 'tab-pk-1', senderId: 'tab-sender-1' }),
          source: 'storage'
        }
      ])
      expect(transport.addPeerCalls).toEqual([
        {
          peer: expect.objectContaining({ publicKey: 'tab-pk-1', senderId: 'tab-sender-1' }),
          sendPairingResponse: false
        }
      ])

      // 2. Duplicate storage event containing already-known peer does NOT emit duplicate peer_added or call transport.addPeer again
      await storage.notifyStorageChanged({
        eventType: 'entryModified',
        key: storage.getPrefixedKey(StorageKey.TRANSPORT_P2P_PEERS_WALLET),
        oldValue: JSON.stringify([peerFromOtherTab]),
        newValue: JSON.stringify([peerFromOtherTab])
      })
      expect(events).toHaveLength(1)
      expect(transport.addPeerCalls).toHaveLength(1)

      // 3. Local peer added via wallet.addPeer is also deduplicated on subsequent storage event
      const localPeer = makePeer({
        id: 'local-p2p-2',
        publicKey: 'local-pk-2',
        senderId: 'local-sender-2'
      })
      await wallet.addPeer(localPeer, false)
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({
        type: 'peer_added',
        peer: expect.objectContaining({ publicKey: 'local-pk-2' }),
        source: 'local'
      })

      // Storage event with both peers does NOT re-emit peer_added for either peer
      await storage.notifyStorageChanged({
        eventType: 'entryModified',
        key: storage.getPrefixedKey(StorageKey.TRANSPORT_P2P_PEERS_WALLET),
        oldValue: JSON.stringify([peerFromOtherTab]),
        newValue: JSON.stringify([peerFromOtherTab, localPeer])
      })
      expect(events).toHaveLength(2)

      // 4. Storage event removing peerFromOtherTab emits peer_removed with source: 'storage'
      await storage.notifyStorageChanged({
        eventType: 'entryModified',
        key: storage.getPrefixedKey(StorageKey.TRANSPORT_P2P_PEERS_WALLET),
        oldValue: JSON.stringify([peerFromOtherTab, localPeer]),
        newValue: JSON.stringify([localPeer])
      })
      expect(events).toHaveLength(3)
      expect(events[2]).toEqual({
        type: 'peer_removed',
        peer: expect.objectContaining({ publicKey: 'tab-pk-1', senderId: 'tab-sender-1' }),
        source: 'storage'
      })

      // 5. PostMessage peer added and removed from another tab
      const pmPeer = {
        id: 'pm-1',
        name: 'PM App',
        publicKey: 'pm-pk-1',
        version: '2',
        senderId: 'pm-sender-1',
        type: 'postmessage-pairing-request'
      }
      await storage.notifyStorageChanged({
        eventType: 'entryModified',
        key: storage.getPrefixedKey(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET),
        oldValue: JSON.stringify([]),
        newValue: JSON.stringify([pmPeer])
      })
      await storage.notifyStorageChanged({
        eventType: 'entryModified',
        key: storage.getPrefixedKey(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET),
        oldValue: JSON.stringify([pmPeer]),
        newValue: JSON.stringify([])
      })

      expect(events.slice(3).map((e) => [e.type, e.peer.publicKey, e.source])).toEqual([
        ['peer_added', 'pm-pk-1', 'storage'],
        ['peer_removed', 'pm-pk-1', 'storage']
      ])
    })

    it('handles cross-tab storage peer_added for TRANSPORT_P2P_PEERS_WALLET before init() without hanging and emits peer_added', async () => {
      const { wallet, storage } = await createWallet({ attachTransport: false })
      const events: WalletPeerEvent[] = []
      wallet.subscribeToPeers((event) => {
        events.push(event)
      })

      const peerBeforeInit = makePeer({
        id: 'tab-p2p-pre-init',
        publicKey: 'tab-pk-pre-init',
        senderId: 'tab-sender-pre-init'
      })

      await storage.notifyStorageChanged({
        eventType: 'entryModified',
        key: storage.getPrefixedKey(StorageKey.TRANSPORT_P2P_PEERS_WALLET),
        oldValue: JSON.stringify([]),
        newValue: JSON.stringify([peerBeforeInit])
      })

      expect(events).toEqual([
        {
          type: 'peer_added',
          peer: expect.objectContaining({
            publicKey: 'tab-pk-pre-init',
            senderId: 'tab-sender-pre-init'
          }),
          source: 'storage'
        }
      ])
    })

    it('seeds pre-existing peers from storage on startup so cross-tab removal emits peer_removed with source: storage', async () => {
      const preExistingPeer = makePeer({
        id: 'pre-existing-1',
        publicKey: 'pre-existing-pk-1',
        senderId: 'pre-existing-sender-1'
      })
      const storage = new TabStorage('pre-seed-test')
      await storage.set(StorageKey.TRANSPORT_P2P_PEERS_WALLET, [preExistingPeer])

      const { wallet } = await createWallet({ customStorage: storage, attachTransport: false })
      const events: WalletPeerEvent[] = []
      wallet.subscribeToPeers((event) => {
        events.push(event)
      })

      await storage.notifyStorageChanged({
        eventType: 'entryModified',
        key: storage.getPrefixedKey(StorageKey.TRANSPORT_P2P_PEERS_WALLET),
        oldValue: JSON.stringify([preExistingPeer]),
        newValue: JSON.stringify([])
      })

      expect(events).toEqual([
        {
          type: 'peer_removed',
          peer: expect.objectContaining({
            publicKey: 'pre-existing-pk-1',
            senderId: 'pre-existing-sender-1'
          }),
          source: 'storage'
        }
      ])
    })

    it('handles storageCleared event by emitting peer_removed with source: storage for known peers and evicting pending requests', async () => {
      const { wallet, storage, transport } = await createWallet()
      const peerEvents: WalletPeerEvent[] = []
      wallet.subscribeToPeers((event) => {
        peerEvents.push(event)
      })
      const reqEvents: WalletPendingRequestEvent[] = []
      wallet.subscribeToPendingRequests((event) => {
        reqEvents.push(event)
      })

      const peer = makePeer({
        id: 'cleared-peer-1',
        publicKey: 'cleared-pk-1',
        senderId: 'cleared-sender-1'
      })
      await wallet.addPeer(peer, false)

      await wallet.connect(vi.fn())
      await transport.deliver(makePermissionRequest('req-cleared-1', 'cleared-sender-1'), {
        origin: Origin.P2P,
        id: 'cleared-pk-1'
      })
      expect(wallet.getPendingRequests()).toHaveLength(1)

      await storage.notifyStorageChanged({
        eventType: 'storageCleared',
        key: null,
        oldValue: null,
        newValue: null
      })

      expect(wallet.getPendingRequests()).toEqual([])
      expect(reqEvents.filter((e) => e.type === 'request_removed')).toEqual([
        expect.objectContaining({
          type: 'request_removed',
          reason: 'peer_disconnected',
          request: expect.objectContaining({ id: 'req-cleared-1' })
        })
      ])
      expect(peerEvents.filter((e) => e.type === 'peer_removed')).toEqual([
        expect.objectContaining({
          type: 'peer_removed',
          peer: expect.objectContaining({ publicKey: 'cleared-pk-1' }),
          source: 'storage'
        })
      ])
    })
  })
})
