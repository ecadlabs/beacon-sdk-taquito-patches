import 'fake-indexeddb/auto'
import { getSenderId, LocalStorage, Serializer } from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessage,
  BeaconMessageType,
  ConnectionContext,
  ExtendedP2PPairingResponse,
  ExtendedPostMessagePairingResponse,
  NetworkType,
  Origin,
  PermissionScope,
  StorageKey,
  TransportStatus
} from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { BeaconEvent } from '../../src/events'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { DappPostMessageTransport } from '../../src/transports/DappPostMessageTransport'

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
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

vi.mock('@ecadlabs/beacon-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-ui')>()),
  isMobileOS: () => false,
  isDesktop: () => true
}))

const keyPair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) }
const accountPublicKey = 'edpkv3Nf62TZxR1XwzKRteLTh1SmXLmr8cGEwHRSNoiUV3oiBrDbFX'
type PairingPeer = ExtendedP2PPairingResponse | ExtendedPostMessagePairingResponse

class RemovalP2PTransport extends DappP2PTransport {
  readonly sent = new ExposedPromise<string>()
  async connect(): Promise<void> {
    this._isConnected = TransportStatus.CONNECTED
  }
  async disconnect(): Promise<void> {
    this._isConnected = TransportStatus.NOT_CONNECTED
  }
  async listen(): Promise<void> {}
  async stopListeningForNewPeers(): Promise<void> {}
  async send(message: string): Promise<void> {
    this.sent.resolve(message)
  }
  async receive(message: BeaconMessage, context: ConnectionContext): Promise<void> {
    await this.notifyListeners(await new Serializer().serialize(message), context)
  }
}

class RemovalPostMessageTransport extends DappPostMessageTransport {
  readonly sent = new ExposedPromise<string>()
  async connect(): Promise<void> {
    this._isConnected = TransportStatus.CONNECTED
  }
  async disconnect(): Promise<void> {
    this._isConnected = TransportStatus.NOT_CONNECTED
  }
  async listen(): Promise<void> {}
  async stopListeningForNewPeers(): Promise<void> {}
  async send(message: string): Promise<void> {
    this.sent.resolve(message)
  }
  async receive(message: BeaconMessage, context: ConnectionContext): Promise<void> {
    await this.notifyListeners(await new Serializer().serialize(message), context)
  }
}

function context(peer: PairingPeer): ConnectionContext {
  return 'extensionId' in peer
    ? { origin: Origin.EXTENSION, id: peer.extensionId }
    : { origin: Origin.P2P, id: peer.publicKey }
}

function observe<T>(promise: Promise<T>) {
  const settled = vi.fn()
  const outcome = promise.then(
    (value) => {
      settled({ value })
      return { value }
    },
    (error: unknown) => {
      settled({ error })
      return { error }
    }
  )
  return { settled, outcome }
}

describe('DApp pairing peer removal', () => {
  let dapp: DAppClient
  let storage: LocalStorage
  const closed = vi.fn()
  const changed = vi.fn()
  const succeeded = vi.fn()

  beforeEach(async () => {
    vi.useFakeTimers()
    localStorage.clear()
    Object.defineProperty(window, 'beaconCreatedClientInstance', {
      value: false,
      writable: true,
      configurable: true
    })
    storage = new LocalStorage('pairing-peer-removal')
    await createClient(0)
  })

  async function createClient(requestTimeoutMs: number): Promise<void> {
    dapp = new DAppClient({
      name: 'Pairing peer removal',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      requestTimeoutMs,
      network: { type: NetworkType.MAINNET }
    })
    await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    await dapp.subscribeToEvent(BeaconEvent.ACTIVE_TRANSPORT_SET, changed)
    await dapp.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, closed)
    await dapp.subscribeToEvent(BeaconEvent.PERMISSION_REQUEST_SUCCESS, succeeded)
    await dapp.getActiveAccount()
    vi.spyOn(dapp, 'initInternalTransports').mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(0)
    vi.clearAllMocks()
  }

  afterEach(async () => {
    await dapp.destroy()
    await vi.advanceTimersByTimeAsync(0)
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function setup(kind: 'p2p' | 'postmessage') {
    const first = {
      id: 'selected-wallet',
      publicKey: '11'.repeat(32),
      senderId: await getSenderId('11'.repeat(32)),
      name: 'Selected wallet',
      version: '3'
    }
    const second = {
      id: 'retained-wallet',
      publicKey: '22'.repeat(32),
      senderId: await getSenderId('22'.repeat(32)),
      name: 'Retained wallet',
      version: '3'
    }
    let transport: RemovalP2PTransport | RemovalPostMessageTransport
    let selected: PairingPeer
    let retained: PairingPeer
    if (kind === 'p2p') {
      transport = new RemovalP2PTransport('Pairing peer removal', keyPair, storage, {})
      selected = { ...first, type: 'p2p-pairing-response', relayServer: 'relay.example' }
      retained = { ...second, type: 'p2p-pairing-response', relayServer: 'relay.example' }
      await transport.addPeer(selected)
      await transport.addPeer(retained)
      dapp['p2pTransport'] = transport
    } else {
      transport = new RemovalPostMessageTransport('Pairing peer removal', keyPair, storage)
      selected = {
        ...first,
        type: 'postmessage-pairing-response',
        extensionId: 'selected-extension'
      }
      retained = {
        ...second,
        type: 'postmessage-pairing-response',
        extensionId: 'retained-extension'
      }
      await transport.addPeer(selected)
      await transport.addPeer(retained)
      dapp['postMessageTransport'] = transport
    }
    await transport.connect()
    await dapp['addListener'](transport)
    await dapp['setActivePeer'](selected)
    await dapp.init()
    const removeAll = vi.spyOn(transport, 'removeAllPeers')
    const pending = observe(dapp.requestPermissions())
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.sent.isResolved()).toBe(true)
    const sent: unknown = await new Serializer().deserialize(await transport.sent.promise)
    if (!sent || typeof sent !== 'object' || !('id' in sent) || typeof sent.id !== 'string') {
      throw new Error('Permission request ID is missing')
    }
    const id = sent.id
    expect(pending.settled).not.toHaveBeenCalled()
    expect(await dapp.getActiveAccount()).toBeUndefined()
    changed.mockClear()
    const disconnect = (peer: PairingPeer) =>
      transport.receive(
        {
          id: 'peer-disconnect',
          version: '3',
          senderId: peer.senderId,
          type: BeaconMessageType.Disconnect
        },
        context(peer)
      )
    const respond = () =>
      transport.receive(
        {
          id,
          version: '2',
          senderId: selected.senderId,
          type: BeaconMessageType.PermissionResponse,
          walletType: 'implicit',
          publicKey: accountPublicKey,
          appMetadata: { senderId: selected.senderId, name: selected.name },
          network: { type: NetworkType.MAINNET },
          scopes: [PermissionScope.SIGN]
        },
        context(selected)
      )
    return { transport, selected, retained, pending, disconnect, respond, removeAll, id }
  }

  it.each(['p2p', 'postmessage'] satisfies ('p2p' | 'postmessage')[])(
    'retires a selected %s peer and its permission caller before account creation',
    async (kind) => {
      const fixture = await setup(kind)
      await fixture.disconnect(fixture.selected)
      await fixture.disconnect(fixture.selected)
      await vi.advanceTimersByTimeAsync(0)
      expect.soft(fixture.pending.settled).toHaveBeenCalledExactlyOnceWith({
        error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
      })
      expect.soft(await dapp['getPeer']()).toBeUndefined()
      expect.soft(changed).toHaveBeenCalledExactlyOnceWith(undefined, undefined)
      expect.soft(closed).toHaveBeenCalledTimes(1)
      expect(await fixture.transport.getPeers()).toEqual([fixture.retained])
      expect(fixture.removeAll).not.toHaveBeenCalled()

      await fixture.respond()
      await vi.advanceTimersByTimeAsync(0)
      expect.soft(fixture.pending.settled).toHaveBeenCalledTimes(1)
      expect.soft(succeeded).not.toHaveBeenCalled()
      expect.soft(await dapp.getActiveAccount()).toBeUndefined()
      expect.soft(await dapp.getAccounts()).toEqual([])
      expect(fixture.removeAll).not.toHaveBeenCalled()
    }
  )

  it.each(['p2p', 'postmessage'] satisfies ('p2p' | 'postmessage')[])(
    'removes an inactive %s peer while the selected permission route remains usable',
    async (kind) => {
      const fixture = await setup(kind)
      const retainedAccount: AccountInfo = {
        accountIdentifier: 'retained-account',
        senderId: fixture.retained.senderId,
        origin: { type: context(fixture.retained).origin, id: context(fixture.retained).id },
        address: 'tz1RetainedAccount',
        publicKey: accountPublicKey,
        network: { type: NetworkType.MAINNET },
        scopes: [PermissionScope.SIGN],
        connectedAt: 1,
        walletType: 'implicit'
      }
      await storage.set(StorageKey.ACCOUNTS, [retainedAccount])
      await fixture.disconnect(fixture.retained)
      await fixture.disconnect(fixture.retained)
      await vi.advanceTimersByTimeAsync(0)
      expect(fixture.pending.settled).not.toHaveBeenCalled()
      expect(await dapp['getPeer']()).toEqual(fixture.selected)
      expect(await dapp['transport']).toBe(fixture.transport)
      expect(await fixture.transport.getPeers()).toEqual([fixture.selected])
      expect(await dapp.getAccounts()).toEqual([])
      expect(changed).not.toHaveBeenCalled()
      expect(closed).toHaveBeenCalledTimes(1)
      expect(fixture.removeAll).not.toHaveBeenCalled()

      await fixture.respond()
      await vi.advanceTimersByTimeAsync(0)
      expect(fixture.pending.settled).toHaveBeenCalledExactlyOnceWith({
        value: expect.objectContaining({ senderId: fixture.selected.senderId })
      })
      expect(succeeded).toHaveBeenCalledTimes(1)
      expect(await dapp.getActiveAccount()).toEqual(
        expect.objectContaining({ senderId: fixture.selected.senderId })
      )
      expect(fixture.removeAll).not.toHaveBeenCalled()
    }
  )
  it('retires timeout tracking before CHANNEL_CLOSED synchronously disconnects', async () => {
    await dapp.destroy()
    await createClient(100)
    const fixture = await setup('postmessage')
    const tracker = dapp['requestTracker']
    const request = tracker.get(fixture.id)
    if (!request) throw new Error('Permission request is not tracked')
    expect(request.deadline).toBe('Armed')
    const released = vi.fn()
    tracker.attachCleanup(request.key, released)
    const atClosure = vi.fn()
    let disconnecting: Promise<void> | undefined
    await dapp.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, () => {
      atClosure({
        tracked: tracker.get(fixture.id) !== undefined,
        cleanupCount: released.mock.calls.length
      })
      disconnecting = dapp.disconnect({ notifyPeers: false })
      return disconnecting
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(atClosure).toHaveBeenCalledExactlyOnceWith({ tracked: false, cleanupCount: 1 })
    expect(disconnecting).toBeDefined()
    await disconnecting
    await expect(request.completion).resolves.toMatchObject({
      tag: 'TimedOut',
      error: { errorType: BeaconErrorType.PEER_UNREACHABLE }
    })
    // The permission wrapper still observes the synchronous callback's disconnect.
    expect(fixture.pending.settled).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
    expect(closed).toHaveBeenCalledTimes(1)
    expect(tracker.get(fixture.id)).toBeUndefined()
    expect(released).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixture.pending.settled).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(succeeded).not.toHaveBeenCalled()
  })
})
