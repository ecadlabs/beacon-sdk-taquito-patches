import 'fake-indexeddb/auto'
import { LocalStorage } from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  BeaconErrorType,
  ExtendedP2PPairingResponse,
  ExtendedPostMessagePairingResponse,
  ExtendedWalletConnectPairingResponse,
  NetworkType,
  Origin,
  PermissionScope,
  Storage,
  StorageKey,
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

type StorageListener = Parameters<Storage['subscribeToStorageChanged']>[0]

class PairingStorage extends LocalStorage {
  private changed?: StorageListener
  async subscribeToStorageChanged(callback: StorageListener): Promise<void> {
    this.changed = callback
  }
  async notifyAccount(accountIdentifier: string): Promise<void> {
    if (!this.changed) throw new Error('Storage listener is not registered')
    await this.changed({
      eventType: 'entryModified',
      key: this.getPrefixedKey(StorageKey.ACTIVE_ACCOUNT),
      oldValue: null,
      newValue: accountIdentifier
    })
  }
}

class Gate {
  readonly entered = new ExposedPromise<void>()
  readonly release = new ExposedPromise<void>()
  async wait(): Promise<void> {
    this.entered.resolve()
    await this.release.promise
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

type Pairing = BeaconEventType[BeaconEvent.PAIR_INIT]
const keyPair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) }
const peerFields = {
  id: 'wallet',
  senderId: 'wallet-sender',
  publicKey: '11'.repeat(32),
  name: 'Wallet',
  version: '3'
}
const p2pPeer: ExtendedP2PPairingResponse = {
  ...peerFields,
  type: 'p2p-pairing-response',
  relayServer: 'relay.example'
}
const postPeer: ExtendedPostMessagePairingResponse = {
  ...peerFields,
  type: 'postmessage-pairing-response',
  extensionId: 'extension'
}
const wcPeer: ExtendedWalletConnectPairingResponse = {
  ...peerFields,
  type: 'walletconnect-pairing-response',
  extensionId: 'walletconnect'
}

function adapters(storage: LocalStorage) {
  const p2p = new DappP2PTransport('Initialization pairing', keyPair, storage, {})
  const post = new DappPostMessageTransport('Initialization pairing', keyPair, storage)
  const wc = new DappWalletConnectTransport(
    'Initialization pairing',
    keyPair,
    storage,
    { network: NetworkType.MAINNET, opts: { projectId: 'initialization-pairing' } },
    async () => true
  )
  for (const transport of [p2p, post, wc]) {
    vi.spyOn(transport, 'connect').mockImplementation(async () => {
      transport['_isConnected'] = TransportStatus.CONNECTED
    })
    vi.spyOn(transport, 'disconnect').mockImplementation(async () => {
      transport['_isConnected'] = TransportStatus.NOT_CONNECTED
    })
    if (transport instanceof DappWalletConnectTransport) {
      vi.spyOn(transport, 'doClientCleanup').mockResolvedValue(undefined)
    }
    vi.spyOn(transport, 'getPeers').mockResolvedValue([])
    vi.spyOn(transport, 'removeAllPeers').mockResolvedValue(undefined)
    vi.spyOn(transport, 'stopListeningForNewPeers').mockResolvedValue(undefined)
  }
  let p2pCallback: Parameters<DappP2PTransport['listenForNewPeer']>[0] | undefined
  let postCallback: Parameters<DappPostMessageTransport['listenForNewPeer']>[0] | undefined
  let wcCallback: Parameters<DappWalletConnectTransport['listenForNewPeer']>[0] | undefined
  vi.spyOn(p2p, 'listenForNewPeer').mockImplementation(async (callback) => {
    p2pCallback = callback
  })
  vi.spyOn(post, 'listenForNewPeer').mockImplementation(async (callback) => {
    postCallback = callback
  })
  vi.spyOn(wc, 'listenForNewPeer').mockImplementation(async (callback) => {
    wcCallback = callback
  })
  const request = { id: 'pairing', publicKey: '22'.repeat(32), name: 'DApp', version: '3' }
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
    async accept(kind: 'p2p' | 'post' | 'wc') {
      switch (kind) {
        case 'p2p':
          if (!p2pCallback) throw new Error('P2P callback is not registered')
          return p2pCallback(p2pPeer)
        case 'post':
          if (!postCallback) throw new Error('PostMessage callback is not registered')
          return postCallback(postPeer)
        case 'wc':
          if (!wcCallback) throw new Error('WalletConnect callback is not registered')
          wc['_isConnected'] = TransportStatus.CONNECTED
          return wcCallback(wcPeer)
      }
    }
  }
}

describe('Initialization pairing completion', () => {
  const gates: Gate[] = []
  const created: ReturnType<typeof adapters>[] = []
  let dapp: DAppClient
  let storage: PairingStorage
  let pairingEvents: Pairing[]
  let pairInit: ReturnType<typeof vi.fn<(pairing: Pairing) => void>>
  let pairSuccess: ReturnType<typeof vi.fn<() => void>>
  let transportChanged: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    Reflect.set(window, 'beaconCreatedClientInstance', false)
    pairingEvents = []
    pairInit = vi.fn((pairing: Pairing) => {
      pairingEvents.push(pairing)
      // UI consumers observe both eagerly-created completion promises.
      observe(pairing.p2pPeerInfo)
      observe(pairing.postmessagePeerInfo)
    })
    pairSuccess = vi.fn()
    transportChanged = vi.fn()
    vi.spyOn(PostMessageTransport, 'getAvailableExtensions').mockResolvedValue([])
  })

  afterEach(async () => {
    gates.forEach((gate) => gate.release.resolve())
    await vi.advanceTimersByTimeAsync(0)
    await dapp?.destroy()
    for (const group of created) await group.wc.release()
    created.length = 0
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

  async function create() {
    storage = new PairingStorage('initialization-pairing')
    let group = adapters(storage)
    created.push(group)
    let installed = false
    class PairingClient extends DAppClient {
      public async initInternalTransports(): Promise<void> {
        if (this.p2pTransport || this.postMessageTransport || this.walletConnectTransport) return
        if (installed) {
          group = adapters(storage)
          created.push(group)
        }
        installed = true
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
      name: 'Initialization pairing',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      eventHandlers: {
        [BeaconEvent.PAIR_INIT]: { handler: pairInit },
        [BeaconEvent.PAIR_SUCCESS]: { handler: pairSuccess },
        [BeaconEvent.ACTIVE_TRANSPORT_SET]: { handler: transportChanged }
      }
    })
    await dapp.getActiveAccount()
    await vi.advanceTimersByTimeAsync(0)
    transportChanged.mockClear()
    return group
  }

  async function start() {
    const first = observe(dapp.init())
    const second = observe(dapp.init())
    await vi.advanceTimersByTimeAsync(0)
    expect(pairingEvents).toHaveLength(1)
    return { first, second, pairing: pairingEvents[0] }
  }

  it.each<'p2p' | 'post' | 'wc'>(['p2p', 'post', 'wc'])(
    'shares initialization and preserves the %s candidate callback',
    async (kind) => {
      const group = await create()
      const { first, second, pairing } = await start()
      expect(pairInit).toHaveBeenCalledTimes(1)
      expect(group.wc.getPairingRequestInfo).not.toHaveBeenCalled()
      expect(first.settled).not.toHaveBeenCalled()
      const information = await pairing.p2pPeerInfo
      expect(information).not.toBe('')
      await expect(Promise.resolve(pairing.walletConnectPeerInfo)).resolves.toBe('wc:pairing')
      await expect(Promise.resolve(pairing.walletConnectPeerInfo)).resolves.toBe('wc:pairing')
      expect(group.wc.getPairingRequestInfo).toHaveBeenCalledTimes(1)
      await expect(group.accept(kind)).resolves.toBe(true)
      const type =
        kind === 'p2p'
          ? TransportType.P2P
          : kind === 'post'
            ? TransportType.POST_MESSAGE
            : TransportType.WALLETCONNECT
      expect(await first.outcome).toEqual({ value: type })
      expect(await second.outcome).toEqual({ value: type })
      expect(pairSuccess).toHaveBeenCalledTimes(1)
      expect(dapp.connectionStatus).toBe(TransportStatus.CONNECTED)
      await pairing.abortedHandler?.()
      expect(group.p2p.disconnect).not.toHaveBeenCalled()
      expect(group.post.disconnect).not.toHaveBeenCalled()
    }
  )

  it.each<{ source: 'public' | 'storage'; finish: 'ready' | 'disconnect' }>([
    { source: 'public', finish: 'ready' },
    { source: 'storage', finish: 'ready' },
    { source: 'public', finish: 'disconnect' },
    { source: 'storage', finish: 'disconnect' }
  ])(
    'joins pending $source account selection through $finish without opening pairing',
    async ({ source, finish }) => {
      const group = await create()
      const gate = hold()
      vi.mocked(group.p2p.connect).mockRestore()
      vi.mocked(group.p2p.disconnect).mockRestore()
      vi.spyOn(group.p2p['client'], 'start').mockImplementationOnce(() => gate.wait())
      vi.spyOn(group.p2p['client'], 'stop').mockResolvedValue(undefined)
      vi.spyOn(group.p2p, 'startOpenChannelListener').mockResolvedValue(undefined)
      const account: AccountInfo = {
        accountIdentifier: 'selected-account',
        senderId: p2pPeer.senderId,
        origin: { type: Origin.P2P, id: p2pPeer.id },
        address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        network: { type: NetworkType.MAINNET },
        scopes: [PermissionScope.OPERATION_REQUEST],
        connectedAt: 1,
        walletType: 'implicit'
      }
      await storage.set(StorageKey.ACCOUNTS, [account])
      if (source === 'storage')
        await storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
      const selection = observe(
        source === 'public'
          ? dapp.setActiveAccount(account)
          : storage.notifyAccount(account.accountIdentifier)
      )
      await gate.entered.promise
      const first = observe(dapp.init())
      const second = observe(dapp.init())
      await vi.advanceTimersByTimeAsync(0)
      expect.soft(pairInit).not.toHaveBeenCalled()
      expect(first.settled).not.toHaveBeenCalled()
      expect(second.settled).not.toHaveBeenCalled()
      if (finish === 'disconnect') {
        await dapp.disconnect({ notifyPeers: false })
        await expect(first.outcome).resolves.toEqual({
          error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
        })
        await expect(second.outcome).resolves.toEqual({
          error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
        })
        gate.release.resolve()
        await selection.outcome
        await expect(dapp.getActiveAccount()).resolves.toBeUndefined()
        expect(dapp.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
      } else {
        gate.release.resolve()
        await selection.outcome
        await vi.advanceTimersByTimeAsync(0)
        expect.soft(first.settled).toHaveBeenCalledExactlyOnceWith({ value: TransportType.P2P })
        expect.soft(second.settled).toHaveBeenCalledExactlyOnceWith({ value: TransportType.P2P })
        await expect(dapp.getActiveAccount()).resolves.toEqual(account)
        expect(dapp.connectionStatus).toBe(TransportStatus.CONNECTED)
      }
      expect(pairSuccess).not.toHaveBeenCalled()
    }
  )

  it('settles all init callers before modal listener cleanup completes', async () => {
    const group = await create()
    const gate = hold()
    vi.mocked(group.p2p.stopListeningForNewPeers).mockImplementationOnce(() => gate.wait())
    const { first, second, pairing } = await start()
    const abort = observe(Promise.resolve(pairing.abortedHandler?.()))
    await gate.entered.promise
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(first.settled).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
    expect.soft(second.settled).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
    expect(abort.settled).not.toHaveBeenCalled()
    gate.release.resolve()
    await abort.outcome
    await first.outcome
    await second.outcome
  })

  it('waits for modal cleanup before retrying and keeps the replacement initialization live', async () => {
    const group = await create()
    const gate = hold()
    vi.mocked(group.p2p.stopListeningForNewPeers).mockImplementationOnce(() => gate.wait())
    const { first, second, pairing } = await start()
    const abort = observe(Promise.resolve(pairing.abortedHandler?.()))
    await gate.entered.promise
    const retry = observe(dapp.init())
    await vi.advanceTimersByTimeAsync(0)
    expect(pairInit).toHaveBeenCalledTimes(1)
    expect(retry.settled).not.toHaveBeenCalled()
    gate.release.resolve()
    await abort.outcome
    await vi.advanceTimersByTimeAsync(0)
    expect(pairInit).toHaveBeenCalledTimes(2)
    expect.soft(retry.settled).not.toHaveBeenCalled()
    expect.soft(pairSuccess).not.toHaveBeenCalled()
    const replacement = created[created.length - 1]
    await expect(replacement.accept('p2p')).resolves.toBe(true)
    expect(await retry.outcome).toEqual({ value: TransportType.P2P })
    await first.outcome
    await second.outcome
  })

  it('settles issued pairing information when disconnect retires a pending connection', async () => {
    const group = await create()
    const gate = hold()
    vi.mocked(group.p2p.connect).mockRestore()
    vi.mocked(group.p2p.disconnect).mockRestore()
    vi.spyOn(group.p2p['client'], 'start').mockImplementationOnce(() => gate.wait())
    vi.spyOn(group.p2p['client'], 'stop').mockResolvedValue(undefined)
    const { first, second, pairing } = await start()
    await gate.entered.promise
    const information = observe(pairing.p2pPeerInfo)
    await dapp.disconnect({ notifyPeers: false })
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(information.settled).toHaveBeenCalledExactlyOnceWith({ value: '' })
    expect(await first.outcome).toEqual({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
    expect(await second.outcome).toEqual({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
    transportChanged.mockClear()
    gate.release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(await information.outcome).toEqual({ value: '' })
    expect(group.p2p.getPairingRequestInfo).not.toHaveBeenCalled()
    expect(pairSuccess).not.toHaveBeenCalled()
    expect(transportChanged).not.toHaveBeenCalled()
    expect(dapp.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
  })

  it('does not start a lazy WalletConnect request after the pairing is retired', async () => {
    const group = await create()
    const { pairing } = await start()
    await dapp.disconnect({ notifyPeers: false })
    await expect(Promise.resolve(pairing.walletConnectPeerInfo)).resolves.toBe('')
    expect(group.wc.getPairingRequestInfo).not.toHaveBeenCalled()
  })

  it.each<{ kind: 'p2p' | 'post' | 'wc'; finish: 'resolve' | 'reject' }>([
    { kind: 'p2p', finish: 'resolve' },
    { kind: 'p2p', finish: 'reject' },
    { kind: 'post', finish: 'resolve' },
    { kind: 'post', finish: 'reject' },
    { kind: 'wc', finish: 'resolve' },
    { kind: 'wc', finish: 'reject' }
  ])('settles held $kind pairing information before its late $finish', async ({ kind, finish }) => {
    const group = await create()
    const gate = hold()
    const wait = async () => {
      await gate.wait()
      if (finish === 'reject') throw new Error('Pairing information did not complete')
    }
    if (kind === 'p2p') {
      const info = await group.p2p.getPairingRequestInfo()
      vi.mocked(group.p2p.getPairingRequestInfo).mockImplementationOnce(async () => {
        await wait()
        return info
      })
    } else if (kind === 'post') {
      const info = await group.post.getPairingRequestInfo()
      vi.mocked(group.post.getPairingRequestInfo).mockImplementationOnce(async () => {
        await wait()
        return info
      })
    } else {
      const info = await group.wc.getPairingRequestInfo()
      vi.mocked(group.wc.getPairingRequestInfo).mockImplementationOnce(async () => {
        await wait()
        return info
      })
    }
    const { pairing } = await start()
    const information = observe(
      kind === 'p2p'
        ? pairing.p2pPeerInfo
        : kind === 'post'
          ? pairing.postmessagePeerInfo
          : pairing.walletConnectPeerInfo
    )
    await gate.entered.promise
    await dapp.disconnect({ notifyPeers: false })
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(information.settled).toHaveBeenCalledExactlyOnceWith({ value: '' })
    gate.release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(await information.outcome).toEqual({ value: '' })
    expect(information.settled).toHaveBeenCalledTimes(1)
    expect(pairSuccess).not.toHaveBeenCalled()
  })

  it('preserves Matrix startup failure cleanup and delayed error notification', async () => {
    const group = await create()
    const failure = new Error('Relay connection did not complete')
    vi.mocked(group.p2p.connect).mockRejectedValueOnce(failure)
    const genericError = vi.fn()
    await dapp.subscribeToEvent(BeaconEvent.GENERIC_ERROR, genericError)
    const { first, second, pairing } = await start()
    await expect(pairing.p2pPeerInfo).resolves.toBe('')
    expect(await first.outcome).toEqual({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
    expect(await second.outcome).toEqual({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
    expect(group.p2p.disconnect).toHaveBeenCalledTimes(1)
    expect(group.post.disconnect).toHaveBeenCalledTimes(1)
    expect(group.wc.disconnect).toHaveBeenCalledTimes(1)
    expect(pairSuccess).not.toHaveBeenCalled()
    expect(genericError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(999)
    expect(genericError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(genericError).toHaveBeenCalledExactlyOnceWith(failure.message, undefined)
  })
})
