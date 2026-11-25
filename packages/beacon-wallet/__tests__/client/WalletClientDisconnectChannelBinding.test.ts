import {
  BeaconMessageType,
  ConnectionContext,
  DisconnectMessage,
  ExtendedP2PPairingRequest,
  Origin
} from '@ecadlabs/beacon-types'
import { LocalStorage, Transport } from '@ecadlabs/beacon-core'
import { WalletClient } from '../../src/client/WalletClient'
import { WalletP2PTransport } from '../../src/transports/WalletP2PTransport'

type HandleResponse = (
  message: DisconnectMessage | Record<string, unknown>,
  connectionContext: ConnectionContext
) => Promise<void>

describe('WalletClient disconnect channel binding', () => {
  const peerA: ExtendedP2PPairingRequest = {
    id: 'peer-a',
    type: 'p2p-pairing-request',
    name: 'dApp A',
    version: '2',
    publicKey: 'pubkey-a',
    relayServer: 'matrix.example.org',
    senderId: 'sender-a'
  }
  const peerB: ExtendedP2PPairingRequest = {
    id: 'peer-b',
    type: 'p2p-pairing-request',
    name: 'dApp B',
    version: '2',
    publicKey: 'pubkey-b',
    relayServer: 'matrix.example.org',
    senderId: 'sender-b'
  }

  let client: WalletClient | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    if (client) {
      await client.destroy().catch(() => undefined)
      client = undefined
    }
  })

  async function setupWalletClient(peers: ExtendedP2PPairingRequest[]) {
    const activePeers = [...peers]
    vi.spyOn(WalletP2PTransport.prototype, 'connect').mockImplementation(async function (
      this: WalletP2PTransport
    ) {
      await Transport.prototype.connect.call(this)
    })
    vi.spyOn(WalletP2PTransport.prototype, 'disconnect').mockImplementation(async function (
      this: WalletP2PTransport
    ) {
      await Transport.prototype.disconnect.call(this)
    })
    vi.spyOn(WalletP2PTransport.prototype, 'addListener').mockResolvedValue(undefined)

    const wallet = new WalletClient({
      name: 'Test Wallet',
      storage: new LocalStorage(`wallet-disconnect-${Math.random()}`)
    })
    client = wallet

    vi.spyOn(wallet, 'getPeers').mockImplementation(async () => [...activePeers])
    const removePeerSpy = vi.spyOn(wallet, 'removePeer').mockImplementation(async (peer) => {
      const index = activePeers.findIndex((p) => p.publicKey === peer.publicKey)
      if (index >= 0) {
        activePeers.splice(index, 1)
      }
    })

    const onDisconnect = vi.fn()
    wallet.subscribeToDisconnect(onDisconnect)
    await wallet.init()
    await wallet.connect(() => undefined)

    const handleResponse = (wallet as unknown as { handleResponse: HandleResponse }).handleResponse

    return { wallet, activePeers, removePeerSpy, onDisconnect, handleResponse }
  }

  it.each([Origin.P2P, Origin.WALLETCONNECT] as const)(
    'ignores spoofed %s disconnect naming another peer senderId (V2 and V3)',
    async (origin) => {
      const { activePeers, removePeerSpy, onDisconnect, handleResponse } = await setupWalletClient([
        peerA,
        peerB
      ])

      const spoofedV2: DisconnectMessage = {
        id: 'disc-v2',
        version: '2',
        type: BeaconMessageType.Disconnect,
        senderId: peerA.senderId
      }
      await handleResponse(spoofedV2, { origin, id: peerB.publicKey })

      const spoofedV3Wrapped = {
        id: 'disc-v3-wrapped',
        version: '3',
        senderId: peerA.senderId,
        message: { type: BeaconMessageType.Disconnect }
      }
      await handleResponse(spoofedV3Wrapped, { origin, id: peerB.publicKey })

      const spoofedV3Flat: DisconnectMessage = {
        id: 'disc-v3-flat',
        version: '3',
        type: BeaconMessageType.Disconnect,
        senderId: peerA.senderId
      }
      await handleResponse(spoofedV3Flat, { origin, id: peerB.publicKey })

      expect(removePeerSpy).not.toHaveBeenCalled()
      expect(onDisconnect).not.toHaveBeenCalled()
      expect(activePeers).toHaveLength(2)
    }
  )

  it.each([Origin.P2P, Origin.WALLETCONNECT] as const)(
    'disconnects %s peer when connectionContext.id matches the peer publicKey',
    async (origin) => {
      const { activePeers, removePeerSpy, onDisconnect, handleResponse } = await setupWalletClient([
        peerA,
        peerB
      ])

      const validDisconnect: DisconnectMessage = {
        id: 'disc-valid',
        version: '2',
        type: BeaconMessageType.Disconnect,
        senderId: peerA.senderId
      }
      await handleResponse(validDisconnect, { origin, id: peerA.publicKey })

      expect(removePeerSpy).toHaveBeenCalledTimes(1)
      expect(removePeerSpy).toHaveBeenCalledWith(peerA)
      expect(onDisconnect).toHaveBeenCalledWith(peerA.senderId)
      expect(activePeers).toEqual([peerB])
    }
  )

  it('allows extension disconnect by senderId when connectionContext.id is an extension id', async () => {
    const { activePeers, removePeerSpy, onDisconnect, handleResponse } = await setupWalletClient([
      peerA
    ])

    const extDisconnect: DisconnectMessage = {
      id: 'disc-ext',
      version: '2',
      type: BeaconMessageType.Disconnect,
      senderId: peerA.senderId
    }
    await handleResponse(extDisconnect, { origin: Origin.EXTENSION, id: 'chrome-ext-id-123' })

    expect(removePeerSpy).toHaveBeenCalledTimes(1)
    expect(removePeerSpy).toHaveBeenCalledWith(peerA)
    expect(onDisconnect).toHaveBeenCalledWith(peerA.senderId)
    expect(activePeers).toEqual([])
  })
})
