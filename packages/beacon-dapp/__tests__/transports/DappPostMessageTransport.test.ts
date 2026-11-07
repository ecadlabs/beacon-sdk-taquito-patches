import { DappPostMessageTransport } from '../../src/transports/DappPostMessageTransport'
import { LocalStorage, windowRef } from '@ecadlabs/beacon-core'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import {
  ExtendedPostMessagePairingResponse,
  ExtensionMessageTarget,
  Origin,
  StorageKey,
  TransportStatus
} from '@ecadlabs/beacon-types'

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
const peer: ExtendedPostMessagePairingResponse = {
  id: 'peer',
  name: 'Wallet',
  publicKey: 'public-key',
  version: '2',
  type: 'postmessage-pairing-response',
  senderId: 'sender',
  extensionId: 'extension'
}
async function setup() {
  const transport = new DappPostMessageTransport(
    'Dapp',
    await getKeypairFromSeed('phase2a'),
    new LocalStorage()
  )
  const client = transport['client']
  vi.spyOn(client, 'listenForEncryptedMessage').mockResolvedValue(undefined)
  vi.spyOn(client, 'unsubscribeFromEncryptedMessage').mockResolvedValue(undefined)
  vi.spyOn(client, 'unsubscribeFromEncryptedMessages').mockResolvedValue(undefined)

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
  expect(await new LocalStorage().get(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)).toEqual([peer])
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

it('removes window listeners when disconnecting an extension transport', async () => {
  const transport = new DappPostMessageTransport(
    'Dapp',
    await getKeypairFromSeed('cleanup'),
    new LocalStorage()
  )
  const add = windowListeners
  const remove = vi.spyOn(windowRef, 'removeEventListener')
  try {
    await transport.listen(peer.publicKey)
    await transport.startOpenChannelListener()
    const registrations = add.mock.calls.filter(([type]) => type === 'message')
    expect(registrations).toHaveLength(2)
    await transport.disconnect()
    for (const [, listener] of registrations)
      expect(remove).toHaveBeenCalledWith('message', listener)
  } finally {
    await transport['client'].unsubscribeFromEncryptedMessages()
    for (const [type, listener] of add.mock.calls) windowRef.removeEventListener(type, listener)
  }
})

it('delivers encrypted extension messages after disconnecting and reconnecting', async () => {
  const dappKeys = await getKeypairFromSeed('reconnect-dapp')
  const walletKeys = await getKeypairFromSeed('reconnect-wallet')
  const transport = new DappPostMessageTransport('Dapp', dappKeys, new LocalStorage())
  const wallet = new DappPostMessageTransport('Wallet', walletKeys, new LocalStorage())['client']
  const connectedPeer = { ...peer, publicKey: Buffer.from(walletKeys.publicKey).toString('hex') }
  const received = vi.fn()
  await transport.addPeer(connectedPeer)
  await transport.addListener(received)
  try {
    await transport.connect()
    await transport.disconnect()
    await transport.connect()
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    const encryptedPayload = await wallet['encryptMessage'](
      Buffer.from(dappKeys.publicKey).toString('hex'),
      'response after reconnect'
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
          sender: { id: connectedPeer.extensionId },
          message: { target: ExtensionMessageTarget.PAGE, encryptedPayload }
        }
      })
    )
    await vi.waitFor(() =>
      expect(received).toHaveBeenCalledExactlyOnceWith('response after reconnect', {
        origin: Origin.EXTENSION,
        id: connectedPeer.extensionId
      })
    )
  } finally {
    await transport.disconnect()
    await transport['client'].unsubscribeFromEncryptedMessages()
    await wallet.unsubscribeFromEncryptedMessages()
  }
})

it('keeps a disconnected transport stopped when an earlier connect resumes', async () => {
  const transport = new DappPostMessageTransport(
    'Dapp',
    await getKeypairFromSeed('late-connect'),
    new LocalStorage()
  )
  const gate = new ExposedPromise<ExtendedPostMessagePairingResponse[]>()
  const peers = vi.spyOn(transport, 'getPeers').mockReturnValue(gate.promise)
  const connecting = transport.connect()
  await vi.waitFor(() => expect(peers).toHaveBeenCalledTimes(1))
  await transport.disconnect()
  const registrations = windowListeners.mock.calls.length
  gate.resolve([peer])
  await connecting
  expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
  expect(windowListeners).toHaveBeenCalledTimes(registrations)
})

it('does not reconnect when pairing persistence finishes after disconnect', async () => {
  const storage = new LocalStorage()
  const transport = new DappPostMessageTransport(
    'Dapp',
    await getKeypairFromSeed('late-pairing'),
    storage
  )
  const opening = vi
    .spyOn(transport['client'], 'listenForChannelOpening')
    .mockResolvedValue(undefined)
  await transport.startOpenChannelListener()
  const gate = new ExposedPromise<void>()
  const write = vi.spyOn(storage, 'set').mockReturnValue(gate.promise)
  const pairing = opening.mock.calls[0][0](peer)
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
  await transport.disconnect()
  const registrations = windowListeners.mock.calls.length
  gate.resolve()
  await pairing
  expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
  expect(windowListeners).toHaveBeenCalledTimes(registrations)
})
