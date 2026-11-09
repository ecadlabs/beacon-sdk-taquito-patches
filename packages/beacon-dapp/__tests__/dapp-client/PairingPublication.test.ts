import 'fake-indexeddb/auto'
import { LocalStorage } from '@ecadlabs/beacon-core'
import {
  BeaconErrorType,
  ExtendedP2PPairingResponse,
  ExtendedPostMessagePairingResponse,
  ExtendedWalletConnectPairingResponse,
  NetworkType,
  StorageKey,
  StorageKeyReturnType,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { PostMessageTransport } from '@ecadlabs/beacon-transport-postmessage'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { BeaconEvent, BeaconEventType } from '../../src/events'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { DappPostMessageTransport } from '../../src/transports/DappPostMessageTransport'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'

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
  },
  StorageValidator: class {
    async validate() {
      return true
    }
  }
}))

type Kind = 'p2p' | 'post' | 'wc'
type Pairing = BeaconEventType[BeaconEvent.PAIR_INIT]
const kinds: Kind[] = ['p2p', 'post', 'wc']
const types = {
  p2p: TransportType.P2P,
  post: TransportType.POST_MESSAGE,
  wc: TransportType.WALLETCONNECT
}
const keys = {
  p2p: StorageKey.TRANSPORT_P2P_PEERS_DAPP,
  post: StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP,
  wc: StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP
}
class Gate {
  readonly entered = new ExposedPromise<void>()
  readonly release = new ExposedPromise<void>()
  async wait(): Promise<void> {
    this.entered.resolve()
    await this.release.promise
  }
}
class PairingStorage extends LocalStorage {
  nextWrite?: { key: StorageKey; gate: Gate }
  async set<K extends StorageKey>(key: K, value: StorageKeyReturnType[K]): Promise<void> {
    if (this.nextWrite?.key === key) {
      const gate = this.nextWrite.gate
      this.nextWrite = undefined
      await gate.wait()
    }
    await super.set(key, value)
  }
}
function observe<T>(promise: PromiseLike<T>) {
  const settled = vi.fn()
  const outcome = Promise.resolve(promise).then(
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
const fields = { id: 'pairing', senderId: 'wallet-sender', name: 'Wallet', version: '3' }
const peers: {
  p2p: ExtendedP2PPairingResponse
  post: ExtendedPostMessagePairingResponse
  wc: ExtendedWalletConnectPairingResponse
} = {
  p2p: {
    ...fields,
    publicKey: '11'.repeat(32),
    type: 'p2p-pairing-response',
    relayServer: 'relay.example'
  },
  post: {
    ...fields,
    publicKey: '22'.repeat(32),
    type: 'postmessage-pairing-response',
    extensionId: 'extension'
  },
  wc: {
    ...fields,
    publicKey: '33'.repeat(32),
    type: 'walletconnect-pairing-response',
    extensionId: 'walletconnect'
  }
}
const retainedFields = {
  name: 'Retained Wallet',
  publicKey: '44'.repeat(32),
  senderId: 'retained-sender'
}

function adapters(storage: PairingStorage) {
  const keyPair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) }
  const p2p = new DappP2PTransport('Pairing publication', keyPair, storage, {})
  const post = new DappPostMessageTransport('Pairing publication', keyPair, storage)
  const wc = new DappWalletConnectTransport(
    'Pairing publication',
    keyPair,
    storage,
    { network: NetworkType.MAINNET, opts: { projectId: 'pairing-publication' } },
    async () => true
  )
  const listenGates: Partial<Record<Kind, Gate>> = {}
  async function listening(kind: Kind): Promise<void> {
    const gate = listenGates[kind]
    delete listenGates[kind]
    await gate?.wait()
  }
  vi.spyOn(p2p['client'], 'listenForEncryptedMessage').mockImplementation(() => listening('p2p'))
  vi.spyOn(post['client'], 'listenForEncryptedMessage').mockImplementation(() => listening('post'))
  vi.spyOn(wc['client'], 'listenForEncryptedMessage').mockImplementation(() => listening('wc'))
  for (const transport of [p2p, post, wc]) {
    vi.spyOn(transport['client'], 'unsubscribeFromEncryptedMessage').mockResolvedValue(undefined)
    vi.spyOn(transport['client'], 'unsubscribeFromEncryptedMessages').mockResolvedValue(undefined)
    vi.spyOn(transport, 'disconnect').mockImplementation(async () => {
      transport['_isConnected'] = TransportStatus.NOT_CONNECTED
    })
  }
  vi.spyOn(wc, 'doClientCleanup').mockResolvedValue(undefined)
  let p2pDelivery: Parameters<(typeof p2p)['client']['listenForChannelOpening']>[0] | undefined
  let postDelivery: Parameters<(typeof post)['client']['listenForChannelOpening']>[0] | undefined
  let wcDelivery: Parameters<(typeof wc)['client']['listenForChannelOpening']>[0] | undefined
  vi.spyOn(p2p['client'], 'listenForChannelOpening').mockImplementation(async (callback) => {
    p2pDelivery = callback
  })
  vi.spyOn(post['client'], 'listenForChannelOpening').mockImplementation(async (callback) => {
    postDelivery = callback
  })
  vi.spyOn(wc['client'], 'listenForChannelOpening').mockImplementation(async (callback) => {
    wcDelivery = callback
  })
  vi.spyOn(p2p, 'connect').mockImplementation(async () => {
    p2p['_isConnected'] = TransportStatus.CONNECTED
    await p2p.startOpenChannelListener()
  })
  vi.spyOn(post, 'connect').mockImplementation(async () => {
    post['_isConnected'] = TransportStatus.CONNECTED
    await post.startOpenChannelListener()
  })
  vi.spyOn(wc, 'connect').mockResolvedValue(undefined)
  const request = { id: 'pairing', publicKey: '55'.repeat(32), name: 'DApp', version: '3' }
  vi.spyOn(p2p, 'getPairingRequestInfo').mockResolvedValue({
    ...request,
    type: 'p2p-pairing-request',
    relayServer: 'relay.example'
  })
  vi.spyOn(post, 'getPairingRequestInfo').mockResolvedValue({
    ...request,
    type: 'postmessage-pairing-request'
  })
  vi.spyOn(wc, 'getPairingRequestInfo').mockResolvedValue({
    ...request,
    type: 'walletconnect-pairing-request',
    senderId: 'dapp',
    uri: 'wc:pairing'
  })
  return {
    p2p,
    post,
    wc,
    listenGates,
    transport(kind: Kind) {
      return { p2p, post, wc }[kind]
    },
    async deliver(kind: Kind) {
      switch (kind) {
        case 'p2p':
          if (!p2pDelivery) throw new Error('P2P intake is not registered')
          return p2pDelivery(peers.p2p, () => true)
        case 'post':
          if (!postDelivery) throw new Error('PostMessage intake is not registered')
          return postDelivery(peers.post, () => true)
        case 'wc':
          if (!wcDelivery) throw new Error('WalletConnect intake is not registered')
          return wcDelivery(peers.wc, () => true)
      }
    },
    async remove(kind: Kind) {
      switch (kind) {
        case 'p2p':
          return p2p.removePeer(peers.p2p)
        case 'post':
          return post.removePeer(peers.post)
        case 'wc':
          return wc.removePeer(peers.wc)
      }
    },
    async retainCandidate(kind: Kind) {
      switch (kind) {
        case 'p2p':
          return p2p.addPeer({ ...peers.p2p, name: 'Earlier Wallet' })
        case 'post':
          return post.addPeer({ ...peers.post, name: 'Earlier Wallet' })
        case 'wc':
          return wc.addPeer({ ...peers.wc, name: 'Earlier Wallet' })
      }
    },
    async addRetained(kind: Kind) {
      switch (kind) {
        case 'p2p':
          return p2p.addPeer({ ...peers.p2p, ...retainedFields })
        case 'post':
          return post.addPeer({ ...peers.post, ...retainedFields })
        case 'wc':
          return wc.addPeer({ ...peers.wc, ...retainedFields })
      }
    }
  }
}

describe('Pairing publication ownership', () => {
  let dapp: DAppClient
  let storage: PairingStorage
  let group: ReturnType<typeof adapters>
  let selectionGate: Gate | undefined
  let pairInit: ReturnType<typeof vi.fn<(value: Pairing) => void>>
  let pairSuccess: ReturnType<typeof vi.fn<(peer: unknown) => void>>
  let transportSet: ReturnType<typeof vi.fn<(transport: unknown) => void>>
  const gates: Gate[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    Reflect.set(window, 'beaconCreatedClientInstance', false)
    selectionGate = undefined
    pairInit = vi.fn((pairing: Pairing) => {
      observe(pairing.p2pPeerInfo)
      observe(pairing.postmessagePeerInfo)
    })
    pairSuccess = vi.fn()
    transportSet = vi.fn()
    vi.spyOn(PostMessageTransport, 'getAvailableExtensions').mockResolvedValue([])
  })
  afterEach(async () => {
    gates.forEach((gate) => gate.release.resolve())
    await vi.advanceTimersByTimeAsync(0)
    await dapp?.destroy()
    await group?.wc.release()
    gates.length = 0
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  function hold() {
    const gate = new Gate()
    gates.push(gate)
    return gate
  }
  async function start() {
    storage = new PairingStorage('pairing-publication')
    group = adapters(storage)
    class PairingClient extends DAppClient {
      public async initInternalTransports(): Promise<void> {
        if (this.p2pTransport) {
          const gate = selectionGate
          selectionGate = undefined
          await gate?.wait()
          return
        }
        this.p2pTransport = group.p2p
        this.postMessageTransport = group.post
        this.walletConnectTransport = group.wc
        await Promise.all([
          this.addListener(group.p2p),
          this.addListener(group.post),
          this.addListener(group.wc)
        ])
      }
    }
    dapp = new PairingClient({
      name: 'Pairing publication',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      eventHandlers: {
        [BeaconEvent.PAIR_INIT]: { handler: pairInit },
        [BeaconEvent.PAIR_SUCCESS]: { handler: pairSuccess },
        [BeaconEvent.ACTIVE_TRANSPORT_SET]: { handler: transportSet }
      }
    })
    await dapp.getActiveAccount()
    await vi.advanceTimersByTimeAsync(0)
    transportSet.mockClear()
    const init = observe(dapp.init())
    await vi.advanceTimersByTimeAsync(0)
    expect(pairInit).toHaveBeenCalledTimes(1)
    return init
  }

  it.each(kinds)(
    'waits for admitted %s peer writes before publishing a candidate',
    async (kind) => {
      const init = await start()
      const registration = hold()
      group.listenGates[kind] = registration
      const delivery = observe(group.deliver(kind))
      await registration.entered.promise
      const write = hold()
      storage.nextWrite = { key: keys[kind], gate: write }
      const retained = group.addRetained(kind)
      await write.entered.promise
      registration.release.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(transportSet.mock.calls.filter(([transport]) => transport !== undefined)).toHaveLength(
        0
      )
      expect(pairSuccess).not.toHaveBeenCalled()
      expect(init.settled).not.toHaveBeenCalled()
      write.release.resolve()
      await retained
      await delivery.outcome
      expect(await init.outcome).toEqual({ value: types[kind] })
      expect(await dapp['getPeer']()).toEqual(peers[kind])
      expect(await storage.get(keys[kind])).toEqual(
        expect.arrayContaining([peers[kind], expect.objectContaining(retainedFields)])
      )
      expect(pairSuccess).toHaveBeenCalledTimes(1)
    }
  )

  it.each(kinds)(
    'does not publish %s after removal intent behind a held peer write',
    async (kind) => {
      const init = await start()
      const registration = hold()
      group.listenGates[kind] = registration
      const delivery = observe(group.deliver(kind))
      await registration.entered.promise
      const write = hold()
      storage.nextWrite = { key: keys[kind], gate: write }
      const retained = group.addRetained(kind)
      await write.entered.promise
      const removal = group.remove(kind)
      registration.release.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(transportSet.mock.calls.filter(([transport]) => transport !== undefined)).toHaveLength(
        0
      )
      expect(pairSuccess).not.toHaveBeenCalled()
      expect(init.settled).not.toHaveBeenCalled()
      write.release.resolve()
      await Promise.all([retained, removal, delivery.outcome])
      expect(await dapp['getPeer']()).toBeUndefined()
      expect(await storage.get(keys[kind])).toEqual([expect.objectContaining(retainedFields)])
      expect(init.settled).not.toHaveBeenCalled()
      const next: Kind = kind === 'p2p' ? 'post' : 'p2p'
      await group.deliver(next)
      expect(await init.outcome).toEqual({ value: types[next] })
      expect(await dapp['getPeer']()).toEqual(peers[next])
    }
  )

  it.each(kinds)('rechecks %s ownership after asynchronous selection preparation', async (kind) => {
    const init = await start()
    const preparing = hold()
    selectionGate = preparing
    const delivery = observe(group.deliver(kind))
    await preparing.entered.promise
    await group.remove(kind)
    preparing.release.resolve()
    await delivery.outcome
    expect(transportSet.mock.calls.filter(([transport]) => transport !== undefined)).toHaveLength(0)
    expect(pairSuccess).not.toHaveBeenCalled()
    expect(await dapp['getPeer']()).toBeUndefined()
    expect(await storage.get(keys[kind])).toEqual([])
    expect(await init.outcome).toEqual({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
  })

  it.each(kinds)(
    'revokes %s publication intent after selection has begun while deletion is queued',
    async (kind) => {
      const init = await start()
      const preparing = hold()
      selectionGate = preparing
      const delivery = observe(group.deliver(kind))
      await preparing.entered.promise
      const write = hold()
      storage.nextWrite = { key: keys[kind], gate: write }
      const retained = group.addRetained(kind)
      await write.entered.promise
      const removal = group.remove(kind)
      preparing.release.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(transportSet.mock.calls.filter(([transport]) => transport !== undefined)).toHaveLength(
        0
      )
      expect(pairSuccess).not.toHaveBeenCalled()
      expect(init.settled).not.toHaveBeenCalledWith({ value: types[kind] })
      write.release.resolve()
      await Promise.all([retained, removal, delivery.outcome])
      expect(await init.outcome).toEqual({
        error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
      })
      expect(await dapp['getPeer']()).toBeUndefined()
      expect(await storage.get(keys[kind])).toEqual([expect.objectContaining(retainedFields)])
    }
  )

  const orders: [Kind, Kind][] = [
    ['p2p', 'post'],
    ['p2p', 'wc'],
    ['post', 'p2p'],
    ['post', 'wc'],
    ['wc', 'p2p'],
    ['wc', 'post']
  ]
  it.each(orders)('retains the %s winner when %s finishes later', async (winner, later) => {
    const init = await start()
    await group.retainCandidate(later)
    const preparing = hold()
    selectionGate = preparing
    const winningDelivery = observe(group.deliver(winner))
    await preparing.entered.promise
    await group.deliver(later)
    expect(pairSuccess).not.toHaveBeenCalled()
    expect(init.settled).not.toHaveBeenCalled()
    preparing.release.resolve()
    await winningDelivery.outcome
    expect(await init.outcome).toEqual({ value: types[winner] })
    expect(await dapp['getPeer']()).toEqual(peers[winner])
    expect(await dapp['transport']).toBe(group.transport(winner))
    expect(await storage.get(keys[winner])).toEqual([peers[winner]])
    expect(await storage.get(keys[later])).toEqual([{ ...peers[later], name: 'Earlier Wallet' }])
    expect(pairSuccess).toHaveBeenCalledTimes(1)
  })

  it.each(kinds)(
    'restores the retained %s peer when selection preparation rejects',
    async (kind) => {
      const init = await start()
      await group.retainCandidate(kind)
      const preparing = hold()
      selectionGate = preparing
      const delivery = observe(group.deliver(kind))
      await preparing.entered.promise
      const failure = new Error('Selection preparation failed')
      preparing.release.reject(failure)
      expect(await delivery.outcome).toEqual(kind === 'wc' ? { value: false } : { error: failure })
      expect(await init.outcome).toEqual({ error: failure })
      expect(pairSuccess).not.toHaveBeenCalled()
      expect(await dapp['getPeer']()).toBeUndefined()
      expect(await storage.get(keys[kind])).toEqual([{ ...peers[kind], name: 'Earlier Wallet' }])
    }
  )

  it.each(kinds)(
    'settles %s initialization before held selection work drains on disconnect',
    async (kind) => {
      const init = await start()
      const preparing = hold()
      selectionGate = preparing
      const delivery = observe(group.deliver(kind))
      await preparing.entered.promise
      await dapp.disconnect({ notifyPeers: false })
      expect(await init.outcome).toEqual({
        error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
      })
      expect(delivery.settled).not.toHaveBeenCalled()
      preparing.release.resolve()
      await delivery.outcome
      expect(transportSet.mock.calls.filter(([transport]) => transport !== undefined)).toHaveLength(
        0
      )
      expect(pairSuccess).not.toHaveBeenCalled()
      expect(await dapp['getPeer']()).toBeUndefined()
      expect(await storage.get(keys[kind])).toEqual([])
    }
  )

  it.each(kinds)(
    'settles %s initialization when the modal closes during selection preparation',
    async (kind) => {
      const init = await start()
      await group.addRetained(kind)
      const preparing = hold()
      selectionGate = preparing
      const delivery = observe(group.deliver(kind))
      await preparing.entered.promise
      const pairing = pairInit.mock.calls[0][0]
      const aborted = observe(Promise.resolve(pairing.abortedHandler?.()))
      await vi.advanceTimersByTimeAsync(0)
      expect(init.settled).toHaveBeenCalledExactlyOnceWith({
        error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
      })
      expect(delivery.settled).not.toHaveBeenCalled()
      preparing.release.resolve()
      await Promise.all([delivery.outcome, aborted.outcome])
      expect(pairSuccess).not.toHaveBeenCalled()
      expect(await dapp['getPeer']()).toBeUndefined()
      expect(await storage.get(keys[kind])).toEqual([expect.objectContaining(retainedFields)])
    }
  )

  it.each(kinds)(
    'rejects pending %s initialization when PAIR_SUCCESS disconnects synchronously',
    async (kind) => {
      const init = await start()
      let disconnected: Promise<void> | undefined
      pairSuccess.mockImplementation(() => {
        disconnected = dapp.disconnect({ notifyPeers: false })
      })
      await group.deliver(kind)
      await disconnected
      expect(await init.outcome).toEqual({
        error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
      })
      expect(pairSuccess).toHaveBeenCalledTimes(1)
      expect(await dapp['getPeer']()).toBeUndefined()
      expect(await storage.get(keys[kind])).toEqual([])
    }
  )

  it.each(kinds)(
    'rejects %s initialization when PAIR_SUCCESS removes its peer synchronously',
    async (kind) => {
      const init = await start()
      let removed: Promise<void> | undefined
      pairSuccess.mockImplementation(() => {
        removed = group.remove(kind)
      })
      await group.deliver(kind)
      expect(removed).toBeDefined()
      await removed
      expect(await init.outcome).toEqual({
        error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
      })
      expect(pairSuccess).toHaveBeenCalledTimes(1)
      expect(await dapp['getPeer']()).toBeUndefined()
      expect(await storage.get(keys[kind])).toEqual([])
      expect(transportSet.mock.lastCall?.[0]).toBeUndefined()
      pairSuccess.mockImplementation(() => undefined)
      transportSet.mockImplementation(() => undefined)
      const retry = observe(dapp.init())
      await vi.advanceTimersByTimeAsync(0)
      expect(pairInit).toHaveBeenCalledTimes(2)
      expect(retry.settled).not.toHaveBeenCalled()
      await group.deliver(kind)
      expect(await retry.outcome).toEqual({ value: types[kind] })
      expect(await dapp['getPeer']()).toEqual(peers[kind])
    }
  )

  it.each(kinds)(
    'stops %s publication when ACTIVE_TRANSPORT_SET removes the selected peer',
    async (kind) => {
      const init = await start()
      let removed: Promise<void> | undefined
      transportSet.mockImplementation((transport) => {
        if (transport && !removed) removed = group.remove(kind)
      })
      await group.deliver(kind)
      expect(removed).toBeDefined()
      await removed
      expect(pairSuccess).not.toHaveBeenCalled()
      expect(await dapp['getPeer']()).toBeUndefined()
      expect(await storage.get(keys[kind])).toEqual([])
      expect(await init.outcome).toEqual({
        error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
      })
      expect(transportSet.mock.lastCall?.[0]).toBeUndefined()
      pairSuccess.mockImplementation(() => undefined)
      transportSet.mockImplementation(() => undefined)
      const retry = observe(dapp.init())
      await vi.advanceTimersByTimeAsync(0)
      expect(pairInit).toHaveBeenCalledTimes(2)
      expect(retry.settled).not.toHaveBeenCalled()
      await group.deliver(kind)
      expect(await retry.outcome).toEqual({ value: types[kind] })
      expect(await dapp['getPeer']()).toEqual(peers[kind])
    }
  )
})
