import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { LocalStorage } from '@ecadlabs/beacon-core'
import { getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { ExtendedP2PPairingResponse, StorageKey, TransportStatus } from '@ecadlabs/beacon-types'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())
const peer: ExtendedP2PPairingResponse = {
  id: 'peer',
  name: 'Wallet',
  publicKey: 'public-key',
  version: '2',
  type: 'p2p-pairing-response',
  senderId: 'sender',
  relayServer: 'relay'
}
async function setup() {
  const transport = new DappP2PTransport(
    'Dapp',
    await getKeypairFromSeed('phase2a'),
    new LocalStorage(),
    {}
  )
  const client = transport['client']
  vi.spyOn(client, 'listenForEncryptedMessage').mockResolvedValue(undefined)
  vi.spyOn(client, 'unsubscribeFromEncryptedMessage').mockResolvedValue(undefined)
  vi.spyOn(client, 'unsubscribeFromEncryptedMessages').mockResolvedValue(undefined)
  vi.spyOn(client, 'stop').mockResolvedValue(undefined)
  return { transport, client }
}
it('registers an opening listener, persists a peer and consumes the new-peer callback once', async () => {
  const { transport, client } = await setup()
  const opening = vi.spyOn(client, 'listenForChannelOpening').mockResolvedValue(undefined)
  const listener = vi.fn()
  await transport.listenForNewPeer(listener)
  await transport.startOpenChannelListener()
  const callback = opening.mock.calls[0][0]
  await callback(peer)
  expect(await transport.getPeers()).toEqual([peer])
  expect(await new LocalStorage().get(StorageKey.TRANSPORT_P2P_PEERS_DAPP)).toEqual([peer])
  expect(client.listenForEncryptedMessage).toHaveBeenCalledWith(
    peer.publicKey,
    expect.any(Function)
  )
  expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
  expect(listener).toHaveBeenCalledExactlyOnceWith(peer)
  await callback(peer)
  expect(listener).toHaveBeenCalledTimes(1)
  await transport.removePeer(peer)
  expect(client.unsubscribeFromEncryptedMessage).toHaveBeenCalledWith(peer.publicKey)
  await transport.disconnect()
  expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
})
it('cancels new-peer notifications and removes peer subscriptions explicitly on teardown', async () => {
  const { transport, client } = await setup()
  const opening = vi.spyOn(client, 'listenForChannelOpening').mockResolvedValue(undefined)
  const listener = vi.fn()
  await transport.startOpenChannelListener()
  await transport.listenForNewPeer(listener)
  await transport.stopListeningForNewPeers()
  await opening.mock.calls[0][0](peer)
  expect(listener).not.toHaveBeenCalled()
  await transport.removeAllPeers()
  expect(client.unsubscribeFromEncryptedMessages).toHaveBeenCalledTimes(1)
  expect(await transport.getPeers()).toEqual([])
  await transport.disconnect()
  expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
})

it('disconnects the Matrix client without requiring callers to remove peers first', async () => {
  const { transport, client } = await setup()
  await transport.addPeer(peer)
  await transport.disconnect()
  expect(client.stop).toHaveBeenCalledTimes(1)
  expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
  expect(await transport.getPeers()).toEqual([peer])
})
