import type { Mock } from 'vitest'
import { TransportType as PairingTransportType } from '@ecadlabs/beacon-types'
// __tests__/DAppClient.test.ts
import { DAppClient } from '../../src/dapp-client/DAppClient'
import {
  BeaconMessageType,
  BeaconErrorType,
  NetworkType,
  Origin,
  PermissionScope,
  StorageKey,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { LocalStorage } from '@ecadlabs/beacon-core'
import { WalletConnectTransport } from '@ecadlabs/beacon-transport-walletconnect'
import { BeaconEvent } from '../../src/events'
import { getDAppClientInstance } from '../../src/utils/get-instance'

const mockLoggerWarn = vi.fn()
let storageChangedCallback:
  | ((event: {
      eventType: 'storageCleared' | 'entryModified'
      key: string | null
      oldValue: string | null
      newValue: string | null
    }) => Promise<void>)
  | undefined

//
// 1) Mock out all the heavy @ecadlabs/beacon-core and @ecadlabs/beacon-ui dependencies,
//    so we can instantiate DAppClient without spinning up real transports, storage, etc.
//

vi.mock('@ecadlabs/beacon-ui', () => ({
  setColorMode: vi.fn(),
  getColorMode: vi.fn().mockReturnValue('light'),
  setDesktopList: vi.fn(),
  setExtensionList: vi.fn(),
  setWebList: vi.fn(),
  setiOSList: vi.fn(),
  getiOSList: vi.fn().mockReturnValue([]),
  getDesktopList: vi.fn().mockReturnValue([]),
  getExtensionList: vi.fn().mockReturnValue([]),
  getWebList: vi.fn().mockReturnValue([]),
  isBrowser: vi.fn().mockReturnValue(true),
  isDesktop: vi.fn().mockReturnValue(false),
  isMobileOS: vi.fn().mockReturnValue(false),
  isIOS: vi.fn().mockReturnValue(false),
  currentOS: vi.fn().mockReturnValue('test'),
  closeToast: vi.fn()
}))

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecadlabs/beacon-core')>()
  return {
    ...actual,
    // A minimal in-memory LocalStorage stub. The constructor is fixture-only;
    // the real LocalStorage constructor takes an optional key prefix.
    LocalStorage: class {
      private store = new Map<string, any>()
      constructor(initialValues?: Record<string, any>) {
        Object.entries(initialValues ?? {}).forEach(([key, value]) => this.store.set(key, value))
      }
      async get(key: string) {
        return this.store.get(key)
      }
      async set(key: string, value: any) {
        this.store.set(key, value)
      }
      async delete(key: string) {
        this.store.delete(key)
      }
      subscribeToStorageChanged(cb: typeof storageChangedCallback) {
        storageChangedCallback = cb
      }
      getPrefixedKey(key: string) {
        return key
      }
    },
    // StorageValidator always “valid”
    StorageValidator: class {
      private mockStorage: any
      constructor(mockStorage: any) {
        this.mockStorage = mockStorage
      }
      validate() {
        return Promise.resolve(this.mockStorage.validateResults?.shift() ?? true)
      }
    },
    // Serializer just serializes to an empty string
    Serializer: class {
      serialize(_r: any) {
        return Promise.resolve('')
      }
    },
    // ExposedPromise with resolve/reject hooks
    ExposedPromise: class<T, E> {
      public promise: Promise<T>
      private _resolve!: (v: T) => void
      private _reject!: (e: E) => void
      constructor() {
        this.promise = new Promise<T>((res, rej) => {
          this._resolve = res
          this._reject = rej
        })
      }
      static resolve<U>(val: U) {
        const ex = new (this as any)()
        ex._resolve(val)
        return ex
      }
      resolve(v: T) {
        this._resolve(v)
      }
      reject(e: E) {
        this._reject(e)
      }
      isSettled() {
        return true
      }
    },
    generateGUID: vi.fn().mockResolvedValue('guid'),
    getSenderId: vi.fn().mockResolvedValue('senderId'),
    Logger: class {
      constructor(_name: string) {}
      error() {}
      log() {}
      warn(...args: unknown[]) {
        mockLoggerWarn(...args)
      }
      time() {}
    },
    ClientEvents: {
      CLOSE_ALERT: 'CLOSE_ALERT',
      RESET_STATE: 'RESET_STATE',
      WC_ACK_NOTIFICATION: 'WC_ACK_NOTIFICATION',
      ON_RELAYER_ERROR: 'ON_RELAYER_ERROR'
    },
    IndexedDBStorage: class {
      constructor() {}
      set() {}
      getAllKeys() {
        return Promise.resolve([])
      }
      delete() {}
    },
    MultiTabChannel: class {
      constructor(_a: any, _b: any, _c: any) {}
      isLeader() {
        return true
      }
      hasLeader() {
        return Promise.resolve(true)
      }
      getLeadership() {
        return Promise.resolve()
      }
      close() {
        return Promise.resolve()
      }
      postMessage(_msg: any) {}
    },
    BACKEND_URL: '',
    getError: (_t: any, _d: any) => new Error('beacon error')
  }
})

vi.mock('@walletconnect/sign-client', () => ({}))
vi.mock('@walletconnect/types', () => ({}))
vi.mock('@walletconnect/utils', () => ({ getSdkError: vi.fn() }))

import { PostMessageTransport } from '@ecadlabs/beacon-transport-postmessage'

describe('DApp pairing lifecycle through init', () => {
  const setup = async (extensionPending = false) => {
    const client = Object.create(DAppClient.prototype) as any
    client.accountTransition = new AbortController()
    client.startupTransition = client.accountTransition.signal
    client._transport = new ExposedPromise()
    client._activeAccount = new ExposedPromise()
    client.activeAccountLoaded = Promise.resolve()
    client.getActiveAccount = vi.fn().mockResolvedValue(undefined)
    client.initInternalTransports = vi.fn().mockResolvedValue(undefined)
    client.analytics = { track: vi.fn() }
    client.buildPayload = vi.fn().mockResolvedValue({})
    client.sendMetrics = vi.fn()
    client.setActivePeer = vi.fn().mockResolvedValue(undefined)
    client.setTransport = vi.fn().mockResolvedValue(undefined)
    client.applyActiveAccount = vi.fn().mockResolvedValue(true)
    client.dropTransports = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(client, 'network', { value: { type: 'mainnet' } })
    let connectDone!: () => void
    const connecting = new Promise<void>((resolve) => {
      connectDone = resolve
    })
    const listeners: Record<string, (peer: any) => Promise<void>> = {}
    const transport = (name: string) => ({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      stopListeningForNewPeers: vi.fn().mockResolvedValue(undefined),
      listenForNewPeer: vi.fn(async (callback: (peer: any) => Promise<void>) => {
        listeners[name] = callback
      }),
      getPairingRequestInfo: vi
        .fn()
        .mockResolvedValue({ id: name, type: 'pairing-request', uri: 'wc:test' })
    })
    const p2p = transport('p2p')
    p2p.connect.mockImplementation(() => connecting)
    const post = transport('post')
    let rejectExtension!: (error: unknown) => void
    if (extensionPending)
      post.getPairingRequestInfo.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectExtension = reject
          })
      )
    const wc = transport('wc')
    client.p2pTransport = p2p
    client.postMessageTransport = post
    client.walletConnectTransport = wc
    let initialized!: (value: any) => void
    const pairInit = new Promise<any>((resolve) => {
      initialized = resolve
    })
    const emit = vi.fn(async (event: BeaconEvent, payload: any) => {
      if (event === BeaconEvent.PAIR_INIT) initialized(payload)
    })
    client.events = { emit }
    const started = client.init()
    const outcome = started.then(
      (value: any) => ({ value }),
      (error: any) => ({ error })
    )
    const pairing = await pairInit
    return {
      client,
      p2p,
      post,
      wc,
      listeners,
      pairing,
      connectDone,
      outcome,
      emit,
      rejectExtension
    }
  }

  beforeEach(() => vi.spyOn(PostMessageTransport, 'getAvailableExtensions').mockResolvedValue([]))
  afterEach(() => vi.restoreAllMocks())

  it('does not issue pairing information after abort while connect is pending', async () => {
    const { p2p, pairing, connectDone, outcome, emit } = await setup()
    await pairing.abortedHandler()
    const result = await outcome
    expect(result.error).toBeDefined()
    connectDone()
    await expect(pairing.p2pPeerInfo).resolves.toBe('')
    expect(p2p.getPairingRequestInfo).not.toHaveBeenCalled()
    expect(emit.mock.calls.some(([event]) => event === BeaconEvent.PAIR_SUCCESS)).toBe(false)
  })

  it('finishes peer selection without deadlock and ignores a stale abort callback', async () => {
    const { client, p2p, post, listeners, pairing, connectDone, outcome, emit } = await setup()
    const peer = { name: 'Wallet', publicKey: '11'.repeat(32) }
    await listeners.p2p(peer)
    expect(await outcome).toEqual({ value: PairingTransportType.P2P })
    expect(client.setActivePeer).toHaveBeenCalledWith(peer, expect.anything())
    expect(client.setTransport).toHaveBeenCalledWith(p2p)
    await pairing.abortedHandler()
    expect(p2p.disconnect).not.toHaveBeenCalled()
    expect(post.disconnect).not.toHaveBeenCalled()
    expect(emit.mock.calls.filter(([event]) => event === BeaconEvent.PAIR_SUCCESS)).toHaveLength(1)
    connectDone()
    await expect(pairing.p2pPeerInfo).resolves.toBe('')
  })

  it.each(['post', 'p2p', 'wc'])('explicitly rejects superseded %s selection', async (kind) => {
    const { client, listeners, pairing, connectDone, emit } = await setup()
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    client.setActivePeer.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
    })
    const selection = listeners[kind]({ name: 'Stale wallet' })
    await entered.promise
    client.accountTransition.abort()
    client.accountTransition = new AbortController()
    release.resolve()
    await expect(selection).resolves.toBe(false)
    expect(client.setTransport).not.toHaveBeenCalled()
    expect(emit.mock.calls.some(([event]) => event === BeaconEvent.PAIR_SUCCESS)).toBe(false)
    connectDone()
    await pairing.p2pPeerInfo
  })

  it.each(['p2p', 'wc'])(
    'rejects initialization and emits no success when %s selection fails',
    async (winningTransport) => {
      const { client, listeners, pairing, connectDone, outcome, emit } = await setup()
      const error = new Error('selection failed')
      client.setActivePeer.mockImplementation(async (peer: any) => {
        if (peer) throw error
      })
      const selection = listeners[winningTransport]({ name: 'Wallet' })
      if (winningTransport === 'wc') await expect(selection).resolves.toBe(false)
      else await expect(selection).rejects.toBe(error)
      expect((await outcome).error).toBe(error)
      const retry = client.init().catch((retryError: any) => retryError)
      for (let i = 0; i < 30; i++) await Promise.resolve()
      const initializations = emit.mock.calls.filter(([event]) => event === BeaconEvent.PAIR_INIT)
      expect(initializations).toHaveLength(2)
      await (initializations[1][1] as any).abortedHandler()
      await retry
      expect(emit.mock.calls.some(([event]) => event === BeaconEvent.PAIR_SUCCESS)).toBe(false)
      connectDone()
      await expect(pairing.p2pPeerInfo).resolves.toBe('')
    }
  )
  it.each(['p2p', 'wc'])(
    'revokes sibling listeners before delayed %s selection finishes',
    async (winningTransport) => {
      const { client, p2p, post, listeners, pairing, connectDone, outcome } = await setup()
      let selectionDone!: () => void
      const selecting = new Promise<void>((resolve) => {
        selectionDone = resolve
      })
      client.setActivePeer.mockImplementation(async (peer: any) => {
        if (peer) await selecting
      })
      const winner = { name: 'Winner' }
      const contender = { name: 'Contender' }
      const selectingWinner = listeners[winningTransport](winner)
      await expect(listeners.post(contender)).resolves.toBe(false)
      await expect(listeners[winningTransport === 'p2p' ? 'wc' : 'p2p'](contender)).resolves.toBe(false)
      expect(client.setActivePeer).toHaveBeenCalledWith(winner, expect.anything())
      expect(client.setActivePeer).not.toHaveBeenCalledWith(contender, expect.anything())
      expect(p2p.stopListeningForNewPeers).toHaveBeenCalled()
      expect(post.stopListeningForNewPeers).toHaveBeenCalled()
      selectionDone()
      await expect(selectingWinner).resolves.toBe(true)
      expect(await outcome).toEqual({
        value:
          winningTransport === 'p2p' ? PairingTransportType.P2P : PairingTransportType.WALLETCONNECT
      })
      connectDone()
      await pairing.p2pPeerInfo
    }
  )
  it('settles extension pairing information when its generation rejects after abort', async () => {
    const { pairing, connectDone, outcome, rejectExtension } = await setup(true)
    await pairing.abortedHandler()
    expect((await outcome).error).toBeDefined()
    rejectExtension(new Error('Pairing request cancelled'))
    await expect(pairing.postmessagePeerInfo).resolves.toBe('')
    connectDone()
    await pairing.p2pPeerInfo
  })
})
