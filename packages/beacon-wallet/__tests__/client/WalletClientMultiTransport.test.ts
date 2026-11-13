import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getSenderId, LocalStorage, Serializer, Transport } from '@ecadlabs/beacon-core'
import {
  BeaconMessageType,
  BeaconRequestMessage,
  ConnectionContext,
  ExtendedP2PPairingRequest,
  ExtendedPeerInfo,
  ExtendedWalletConnectPairingRequest,
  Network,
  NetworkType,
  Origin,
  P2PPairingRequest,
  PermissionScope,
  TransportStatus,
  TransportStatusChangedInfo,
  TransportType,
  WalletConnectPairingRequest
} from '@ecadlabs/beacon-types'
import { WalletClient } from '../../src/client/WalletClient'
import { WalletP2PTransport } from '../../src/transports/WalletP2PTransport'
import { WalletWalletConnectTransport } from '../../src/transports/WalletWalletConnectTransport'
import type { WalletRequestOutputMessage } from '../../src/types/WalletRequestOutputMessage'

const validEdpk = 'edpktpzo8UZieYaJZgCHP6M6hKHPdWBSNqxvmEt6dwWRgxDh1EAFw9'
const network: Network = { type: NetworkType.MAINNET }

const p2pPublicKey = 'aa'.repeat(32)
const wcPublicKey = 'bb'.repeat(32)

describe('WalletClient simultaneous P2P and WalletConnect transports', () => {
  let walletClient: WalletClient | undefined

  beforeEach(() => {
    localStorage.clear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    if (walletClient) {
      await walletClient.destroy()
      walletClient = undefined
    }
    vi.restoreAllMocks()
    localStorage.clear()
  })

  const setupMultiTransportSpies = () => {
    const p2pPeers: ExtendedP2PPairingRequest[] = []
    const wcPeers: ExtendedWalletConnectPairingRequest[] = []

    const p2pConnectSpy = vi
      .spyOn(WalletP2PTransport.prototype, 'connect')
      .mockImplementation(async function (this: WalletP2PTransport) {
        await Transport.prototype.connect.call(this)
      })
    const p2pDisconnectSpy = vi
      .spyOn(WalletP2PTransport.prototype, 'disconnect')
      .mockImplementation(async function (this: WalletP2PTransport) {
        await Transport.prototype.disconnect.call(this)
      })
    const p2pAddListenerSpy = vi.spyOn(WalletP2PTransport.prototype, 'addListener')
    const p2pSendSpy = vi
      .spyOn(WalletP2PTransport.prototype, 'send')
      .mockResolvedValue(undefined)
    const p2pGetPeersSpy = vi
      .spyOn(WalletP2PTransport.prototype, 'getPeers')
      .mockImplementation(async () => [...p2pPeers])
    const p2pAddPeerSpy = vi
      .spyOn(WalletP2PTransport.prototype, 'addPeer')
      .mockImplementation(async (peer: ExtendedP2PPairingRequest) => {
        const idx = p2pPeers.findIndex((p) => p.publicKey === peer.publicKey)
        if (idx >= 0) {
          p2pPeers[idx] = peer
        } else {
          p2pPeers.push(peer)
        }
      })
    const p2pRemovePeerSpy = vi
      .spyOn(WalletP2PTransport.prototype, 'removePeer')
      .mockImplementation(async (peer: ExtendedP2PPairingRequest) => {
        const idx = p2pPeers.findIndex((p) => p.publicKey === peer.publicKey)
        if (idx >= 0) {
          p2pPeers.splice(idx, 1)
        }
      })
    const p2pRemoveAllPeersSpy = vi
      .spyOn(WalletP2PTransport.prototype, 'removeAllPeers')
      .mockImplementation(async () => {
        p2pPeers.length = 0
      })

    const wcConnectSpy = vi
      .spyOn(WalletWalletConnectTransport.prototype, 'connect')
      .mockImplementation(async function (this: WalletWalletConnectTransport) {
        await Transport.prototype.connect.call(this)
      })
    const wcDisconnectSpy = vi
      .spyOn(WalletWalletConnectTransport.prototype, 'disconnect')
      .mockImplementation(async function (this: WalletWalletConnectTransport) {
        await Transport.prototype.disconnect.call(this)
      })
    const wcCleanupSpy = vi
      .spyOn(WalletWalletConnectTransport.prototype, 'doClientCleanup')
      .mockResolvedValue(undefined)
    const wcAddListenerSpy = vi.spyOn(WalletWalletConnectTransport.prototype, 'addListener')
    const wcSendSpy = vi
      .spyOn(WalletWalletConnectTransport.prototype, 'send')
      .mockResolvedValue(undefined)
    const wcGetPeersSpy = vi
      .spyOn(WalletWalletConnectTransport.prototype, 'getPeers')
      .mockImplementation(async () => [...wcPeers])
    const wcAddPeerSpy = vi
      .spyOn(WalletWalletConnectTransport.prototype, 'addPeer')
      .mockImplementation(async (peer: ExtendedWalletConnectPairingRequest) => {
        const idx = wcPeers.findIndex((p) => p.publicKey === peer.publicKey)
        if (idx >= 0) {
          wcPeers[idx] = peer
        } else {
          wcPeers.push(peer)
        }
      })
    const wcRemovePeerSpy = vi
      .spyOn(WalletWalletConnectTransport.prototype, 'removePeer')
      .mockImplementation(async (peer: ExtendedWalletConnectPairingRequest) => {
        const idx = wcPeers.findIndex((p) => p.publicKey === peer.publicKey)
        if (idx >= 0) {
          wcPeers.splice(idx, 1)
        }
      })
    const wcRemoveAllPeersSpy = vi
      .spyOn(WalletWalletConnectTransport.prototype, 'removeAllPeers')
      .mockImplementation(async () => {
        wcPeers.length = 0
      })

    return {
      p2pPeers,
      wcPeers,
      p2pConnectSpy,
      p2pDisconnectSpy,
      p2pAddListenerSpy,
      p2pSendSpy,
      p2pGetPeersSpy,
      p2pAddPeerSpy,
      p2pRemovePeerSpy,
      p2pRemoveAllPeersSpy,
      wcConnectSpy,
      wcDisconnectSpy,
      wcCleanupSpy,
      wcAddListenerSpy,
      wcSendSpy,
      wcGetPeersSpy,
      wcAddPeerSpy,
      wcRemovePeerSpy,
      wcRemoveAllPeersSpy
    }
  }

  it('initializes and connects both WalletP2PTransport and WalletWalletConnectTransport when walletConnectOptions is provided', async () => {
    const spies = setupMultiTransportSpies()
    walletClient = new WalletClient({
      name: 'Dual Transport Wallet',
      storage: new LocalStorage('dual-init'),
      walletConnectOptions: { projectId: 'test-project-id' }
    })

    await walletClient.init()
    const received: Array<{ message: WalletRequestOutputMessage; context: ConnectionContext }> = []
    await walletClient.connect((message, context) => {
      received.push({ message, context })
    })

    expect(spies.p2pAddListenerSpy).toHaveBeenCalledTimes(1)
    expect(spies.wcAddListenerSpy).toHaveBeenCalledTimes(1)
    expect(spies.p2pConnectSpy).toHaveBeenCalledTimes(1)
    expect(spies.wcConnectSpy).toHaveBeenCalledTimes(1)

    const p2pListener = spies.p2pAddListenerSpy.mock.calls[0]?.[0]
    const wcListener = spies.wcAddListenerSpy.mock.calls[0]?.[0]
    expect(p2pListener).toBeTypeOf('function')
    expect(wcListener).toBeTypeOf('function')

    const p2pSenderId = await getSenderId(p2pPublicKey)
    const wcSenderId = await getSenderId(wcPublicKey)

    const p2pReq: BeaconRequestMessage = {
      id: 'req-from-p2p',
      version: '2',
      senderId: p2pSenderId,
      type: BeaconMessageType.PermissionRequest,
      appMetadata: { senderId: p2pSenderId, name: 'P2P DApp' },
      network,
      scopes: [PermissionScope.SIGN]
    }
    const wcReq: BeaconRequestMessage = {
      id: 'req-from-wc',
      version: '2',
      senderId: wcSenderId,
      type: BeaconMessageType.PermissionRequest,
      appMetadata: { senderId: wcSenderId, name: 'WC DApp' },
      network,
      scopes: [PermissionScope.OPERATION_REQUEST]
    }

    const serializer = new Serializer()
    await p2pListener!(await serializer.serialize(p2pReq), {
      origin: Origin.P2P,
      id: p2pPublicKey
    })
    await wcListener!(await serializer.serialize(wcReq), {
      origin: Origin.WALLETCONNECT,
      id: wcPublicKey
    })

    expect(received).toHaveLength(2)
    expect(received[0]?.message.id).toBe('req-from-p2p')
    expect(received[0]?.context.origin).toBe(Origin.P2P)
    expect(received[1]?.message.id).toBe('req-from-wc')
    expect(received[1]?.context.origin).toBe(Origin.WALLETCONNECT)

    const pending = walletClient.getPendingRequests()
    expect(pending).toHaveLength(2)
    expect(pending[0]?.transport).toBe(TransportType.P2P)
    expect(pending[1]?.transport).toBe(TransportType.WALLETCONNECT)

    await walletClient.destroy()
    walletClient = undefined
    expect(spies.p2pDisconnectSpy).toHaveBeenCalled()
    expect(spies.wcDisconnectSpy).toHaveBeenCalled()
  })

  it('routes addPeer, getPeers, removePeer, and removeAllPeers across P2P and WalletConnect transports', async () => {
    const spies = setupMultiTransportSpies()
    walletClient = new WalletClient({
      name: 'Dual Peer Wallet',
      storage: new LocalStorage('dual-peers'),
      walletConnectOptions: { projectId: 'test-project-id' }
    })

    await walletClient.init()
    await walletClient.connect(vi.fn())

    const p2pPairing = new P2PPairingRequest(
      'p2p-id-1',
      'Matrix DApp',
      p2pPublicKey,
      '2',
      'beacon-node-1.octez.io'
    )
    const wcPairing = new WalletConnectPairingRequest(
      'wc-id-1',
      'WC DApp',
      wcPublicKey,
      '2',
      'wc:topic-1@2?relay-protocol=irn&symKey=deadbeef'
    )

    await walletClient.addPeer(p2pPairing, true)
    expect(spies.p2pAddPeerSpy).toHaveBeenCalledTimes(1)
    expect(spies.wcAddPeerSpy).not.toHaveBeenCalled()
    expect(spies.p2pAddPeerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'p2p-id-1',
        publicKey: p2pPublicKey,
        relayServer: 'beacon-node-1.octez.io'
      }),
      true
    )

    await walletClient.addPeer(wcPairing, false)
    expect(spies.wcAddPeerSpy).toHaveBeenCalledTimes(1)
    expect(spies.p2pAddPeerSpy).toHaveBeenCalledTimes(1)
    expect(spies.wcAddPeerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'wc-id-1',
        publicKey: wcPublicKey,
        uri: 'wc:topic-1@2?relay-protocol=irn&symKey=deadbeef'
      }),
      false
    )

    // Combined getPeers() returns peers from both transports
    const allPeers: ExtendedPeerInfo[] = await walletClient.getPeers()
    expect(allPeers).toHaveLength(2)
    expect(allPeers.map((p) => p.publicKey)).toEqual([p2pPublicKey, wcPublicKey])

    // removePeer routes to the matching transport and sends disconnect via that transport
    await walletClient.removePeer(allPeers[0]!, true)
    expect(spies.p2pRemovePeerSpy).toHaveBeenCalledTimes(1)
    expect(spies.wcRemovePeerSpy).not.toHaveBeenCalled()
    expect(spies.p2pSendSpy).toHaveBeenCalledTimes(1)
    expect(spies.wcSendSpy).not.toHaveBeenCalled()

    // Re-add P2P peer and test removeAllPeers(true) across both transports
    await walletClient.addPeer(p2pPairing, false)
    spies.p2pSendSpy.mockClear()
    spies.wcSendSpy.mockClear()

    await walletClient.removeAllPeers(true)
    expect(spies.p2pRemoveAllPeersSpy).toHaveBeenCalledTimes(1)
    expect(spies.wcRemoveAllPeersSpy).toHaveBeenCalledTimes(1)
    expect(spies.p2pSendSpy).toHaveBeenCalledTimes(1)
    expect(spies.wcSendSpy).toHaveBeenCalledTimes(1)
    await expect(walletClient.getPeers()).resolves.toEqual([])
  })

  it('routes ACK and respond() to the transport matching ConnectionContext.origin', async () => {
    const spies = setupMultiTransportSpies()
    walletClient = new WalletClient({
      name: 'Dual Respond Wallet',
      storage: new LocalStorage('dual-respond'),
      walletConnectOptions: { projectId: 'test-project-id' }
    })

    await walletClient.init()
    const delivered: WalletRequestOutputMessage[] = []
    await walletClient.connect((message) => {
      delivered.push(message)
    })

    const p2pSenderId = await getSenderId(p2pPublicKey)
    const wcSenderId = await getSenderId(wcPublicKey)

    await walletClient.addPeer(
      new ExtendedP2PPairingRequest(
        'p2p-peer',
        'Matrix DApp',
        p2pPublicKey,
        '2',
        'beacon-node-1.octez.io',
        p2pSenderId
      ),
      false
    )
    await walletClient.addPeer(
      new ExtendedWalletConnectPairingRequest(
        'wc-peer',
        'WC DApp',
        wcPublicKey,
        '2',
        wcSenderId,
        'wc:topic@2'
      ),
      false
    )

    const p2pListener = spies.p2pAddListenerSpy.mock.calls[0]?.[0]
    const wcListener = spies.wcAddListenerSpy.mock.calls[0]?.[0]
    const serializer = new Serializer()

    const p2pReq: BeaconRequestMessage = {
      id: 'p2p-perm-1',
      version: '2',
      senderId: p2pSenderId,
      type: BeaconMessageType.PermissionRequest,
      appMetadata: { senderId: p2pSenderId, name: 'Matrix DApp' },
      network,
      scopes: [PermissionScope.SIGN]
    }
    const wcReq: BeaconRequestMessage = {
      id: 'wc-perm-1',
      version: '2',
      senderId: wcSenderId,
      type: BeaconMessageType.PermissionRequest,
      appMetadata: { senderId: wcSenderId, name: 'WC DApp' },
      network,
      scopes: [PermissionScope.SIGN]
    }

    await p2pListener!(await serializer.serialize(p2pReq), {
      origin: Origin.P2P,
      id: p2pPublicKey
    })
    await vi.waitFor(() => expect(spies.p2pSendSpy).toHaveBeenCalledTimes(1))
    expect(spies.wcSendSpy).not.toHaveBeenCalled()

    await wcListener!(await serializer.serialize(wcReq), {
      origin: Origin.WALLETCONNECT,
      id: wcPublicKey
    })
    await vi.waitFor(() => expect(spies.wcSendSpy).toHaveBeenCalledTimes(1))
    expect(spies.p2pSendSpy).toHaveBeenCalledTimes(1)

    spies.p2pSendSpy.mockClear()
    spies.wcSendSpy.mockClear()

    // Respond to P2P request -> routes ONLY to WalletP2PTransport.send
    await walletClient.respond({
      id: 'p2p-perm-1',
      type: BeaconMessageType.PermissionResponse,
      publicKey: validEdpk,
      network,
      scopes: [PermissionScope.SIGN]
    })
    expect(spies.p2pSendSpy).toHaveBeenCalledTimes(1)
    expect(spies.p2pSendSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ publicKey: p2pPublicKey })
    )
    expect(spies.wcSendSpy).not.toHaveBeenCalled()

    // Respond to WC request -> routes ONLY to WalletWalletConnectTransport.send
    await walletClient.respond({
      id: 'wc-perm-1',
      type: BeaconMessageType.PermissionResponse,
      publicKey: validEdpk,
      network,
      scopes: [PermissionScope.SIGN]
    })
    expect(spies.wcSendSpy).toHaveBeenCalledTimes(1)
    expect(spies.wcSendSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ publicKey: wcPublicKey })
    )
    expect(spies.p2pSendSpy).toHaveBeenCalledTimes(1)
  })

  it('routes inbound Disconnect, changeAccount, and transport status notifications across both transports', async () => {
    const spies = setupMultiTransportSpies()
    walletClient = new WalletClient({
      name: 'Dual Lifecycle Wallet',
      storage: new LocalStorage('dual-lifecycle'),
      walletConnectOptions: { projectId: 'test-project-id' }
    })

    const statusEvents: TransportStatusChangedInfo[] = []
    walletClient.subscribeToTransportStatus((info) => {
      statusEvents.push(info)
    })

    await walletClient.init()
    await walletClient.connect(vi.fn())

    expect(statusEvents.map((e) => [e.transport, e.status])).toEqual(
      expect.arrayContaining([
        [TransportType.P2P, TransportStatus.CONNECTED],
        [TransportType.WALLETCONNECT, TransportStatus.CONNECTED]
      ])
    )

    const p2pSenderId = await getSenderId(p2pPublicKey)
    const wcSenderId = await getSenderId(wcPublicKey)

    await walletClient.addPeer(
      new ExtendedP2PPairingRequest(
        'p2p-peer',
        'Matrix DApp',
        p2pPublicKey,
        '2',
        'beacon-node-1.octez.io',
        p2pSenderId
      ),
      false
    )
    await walletClient.addPeer(
      new ExtendedWalletConnectPairingRequest(
        'wc-peer',
        'WC DApp',
        wcPublicKey,
        '2',
        wcSenderId,
        'wc:topic@2'
      ),
      false
    )

    // changeAccount for P2P peer routes to WalletP2PTransport
    await walletClient.changeAccount(p2pSenderId, {
      publicKey: validEdpk,
      network,
      scopes: [PermissionScope.SIGN]
    })
    expect(spies.p2pSendSpy).toHaveBeenCalledTimes(1)
    expect(spies.wcSendSpy).not.toHaveBeenCalled()

    // changeAccount for WC peer routes to WalletWalletConnectTransport
    await walletClient.changeAccount(wcSenderId, {
      publicKey: validEdpk,
      network,
      scopes: [PermissionScope.SIGN]
    })
    expect(spies.wcSendSpy).toHaveBeenCalledTimes(1)

    // Inbound Disconnect from P2P peer removes it from WalletP2PTransport
    const p2pListener = spies.p2pAddListenerSpy.mock.calls[0]?.[0]
    const serializer = new Serializer()
    await p2pListener!(
      await serializer.serialize({
        id: 'disc-p2p-1',
        version: '2',
        senderId: p2pSenderId,
        type: BeaconMessageType.Disconnect
      }),
      { origin: Origin.P2P, id: p2pPublicKey }
    )
    expect(spies.p2pRemovePeerSpy).toHaveBeenCalledTimes(1)
    expect(spies.wcRemovePeerSpy).not.toHaveBeenCalled()
  })
})
