import { WalletP2PTransport } from '../../src/transports/WalletP2PTransport'
import { WalletPostMessageTransport } from '../../src/transports/WalletPostMessageTransport'
import { LocalStorage, windowRef } from '@ecadlabs/beacon-core'
import { getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { Origin, StorageKey, TransportStatus } from '@ecadlabs/beacon-types'

let windowListeners: ReturnType<typeof observeWindowListeners>
function observeWindowListeners() {
  return vi.spyOn(windowRef, 'addEventListener')
}
beforeEach(() => {
  localStorage.clear()
  windowListeners = observeWindowListeners()
})
afterEach(() => {
  for (const [type, listener] of windowListeners.mock.calls)
    windowRef.removeEventListener(type, listener)
  vi.restoreAllMocks()
})
const peer = {
  id: 'peer',
  name: 'Dapp',
  senderId: 'sender',
  publicKey: 'public-key',
  version: '2',
  type: 'p2p-pairing-request',
  relayServer: 'relay'
}
it('wires wallet P2P storage, connects known peers, routes messages and responds to pairing', async () => {
  const storage = new LocalStorage()
  await storage.set(StorageKey.TRANSPORT_P2P_PEERS_WALLET, [peer])
  const transport = new WalletP2PTransport(
    'Wallet',
    await getKeypairFromSeed('phase2a'),
    storage,
    {},
    'icon',
    'app'
  )
  const client = transport['client']
  vi.spyOn(client, 'start').mockResolvedValue(undefined)
  vi.spyOn(client, 'stop').mockResolvedValue(undefined)
  const listen = vi.spyOn(client, 'listenForEncryptedMessage').mockResolvedValue(undefined)
  const pairing = vi.spyOn(client, 'sendPairingResponse').mockResolvedValue(undefined)
  vi.spyOn(client, 'unsubscribeFromEncryptedMessage').mockResolvedValue(undefined)
  await transport.connect()
  await transport.connect()
  expect(client.start).toHaveBeenCalledTimes(1)
  expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
  const listener = vi.fn()
  await transport.addListener(listener)
  await listen.mock.calls[0][1]('encrypted-payload')
  expect(listener).toHaveBeenCalledWith('encrypted-payload', {
    origin: Origin.P2P,
    id: peer.publicKey
  })
  await transport.addPeer(peer)
  expect(pairing).toHaveBeenCalledExactlyOnceWith(peer)
  await transport.addPeer(peer, false)
  expect(pairing).toHaveBeenCalledTimes(1)
  expect(await storage.get(StorageKey.TRANSPORT_P2P_PEERS_WALLET)).toEqual([peer])
  await transport.removePeer(peer)
  expect(await transport.getPeers()).toEqual([])
  expect(client.unsubscribeFromEncryptedMessage).toHaveBeenCalledWith(peer.publicKey)
  await transport.disconnect()
  expect(client.stop).toHaveBeenCalledTimes(1)
  expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
})
it('wires wallet extension storage and routes encrypted messages with extension context', async () => {
  const storage = new LocalStorage()
  const request = { ...peer, type: 'postmessage-pairing-request', extensionId: 'extension' }
  await storage.set(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET, [request])
  const transport = new WalletPostMessageTransport(
    'Wallet',
    await getKeypairFromSeed('phase2a'),
    storage
  )
  const client = transport['client']
  const listen = vi.spyOn(client, 'listenForEncryptedMessage').mockResolvedValue(undefined)
  vi.spyOn(client, 'unsubscribeFromEncryptedMessage').mockResolvedValue(undefined)
  await transport.connect()
  expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
  const listener = vi.fn()
  await transport.addListener(listener)
  await listen.mock.calls[0][1]('payload', { origin: Origin.EXTENSION, id: 'extension' })
  expect(listener).toHaveBeenCalledWith('payload', { origin: Origin.EXTENSION, id: 'extension' })
  await transport.addPeer(request)
  expect(await storage.get(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET)).toEqual([request])
  await transport.removePeer(request)
  expect(client.unsubscribeFromEncryptedMessage).toHaveBeenCalledWith(peer.publicKey)
  expect(await transport.getPeers()).toEqual([])
  await transport.disconnect()
  expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
})
