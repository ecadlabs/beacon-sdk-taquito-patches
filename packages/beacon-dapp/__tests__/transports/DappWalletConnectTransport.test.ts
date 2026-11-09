import { LocalStorage } from '@ecadlabs/beacon-core'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import {
  BeaconErrorType,
  NetworkType,
  StorageKey,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { SessionTypes } from '@walletconnect/types'
import { WalletConnectCommunicationClient } from '../../../beacon-transport-walletconnect/src/communication-client/WalletConnectCommunicationClient'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { DappPostMessageTransport } from '../../src/transports/DappPostMessageTransport'
import { PostMessageTransport } from '@ecadlabs/beacon-transport-postmessage'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'

jest.mock('@ecadlabs/beacon-transport-walletconnect', () =>
  jest.requireActual('../../../beacon-transport-walletconnect/src')
)
jest.mock('broadcast-channel', () => ({
  BroadcastChannel: class {
    postMessage() {}
    close() {}
  },
  createLeaderElection: () => ({
    awaitLeadership: async () => {},
    hasLeader: async () => true,
    die: async () => {}
  })
}))
jest.mock('@walletconnect/sign-client', () => ({}))
jest.mock('@walletconnect/utils', () => ({
  getSdkError: () => ({ code: 6000, message: 'Disconnected' })
}))
jest.mock('@ecadlabs/beacon-core', () => ({
  ...jest.requireActual('@ecadlabs/beacon-core'),
  WCStorage: jest.fn().mockImplementation(() => ({ backup: jest.fn() }))
}))

class InspectableClient extends WalletConnectCommunicationClient {
  public listenerKeys() {
    return [...this.activeListeners.keys()]
  }
}

function session(topic: string): SessionTypes.Struct {
  return {
    topic,
    pairingTopic: `pairing-${topic}`,
    relay: { protocol: 'irn' },
    expiry: 2000000000,
    acknowledged: true,
    controller: topic,
    self: { publicKey: 'dapp', metadata: { name: 'dapp', description: '', url: '', icons: [] } },
    peer: {
      publicKey: 'wallet-key',
      metadata: { name: topic, description: '', url: '', icons: [] }
    },
    namespaces: {
      tezos: {
        accounts: ['tezos:mainnet:tz1wallet'],
        methods: ['tezos_getAccounts', 'tezos_send', 'tezos_sign'],
        events: []
      }
    },
    requiredNamespaces: {}
  }
}

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

describe('WalletConnect pairing approval ownership', () => {
  const options = { network: NetworkType.MAINNET, opts: { projectId: 'test' } }
  let client: InspectableClient
  let transport: DappWalletConnectTransport
  let storage: LocalStorage
  let approval: ExposedPromise<SessionTypes.Struct>
  let paired: jest.Mock
  let disconnect: jest.Mock
  let connect: jest.Mock<Promise<{ uri: string; approval: () => Promise<SessionTypes.Struct> }>, []>
  let leader: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    localStorage.clear()
    leader = jest.fn().mockResolvedValue(true)
    client = new InspectableClient(options, leader)
    approval = new ExposedPromise()
    disconnect = jest.fn().mockResolvedValue(undefined)
    // Mock the network boundary; peer persistence and both SDK layers remain real.
    connect = jest.fn(async () => ({
      uri: 'wc:pairing@2?symKey=test',
      approval: () => approval.promise
    }))
    const signClient = {
      session: { keys: [], getAll: () => [] },
      pairing: { getAll: () => [] },
      core: { pairing: { ping: () => Promise.resolve(), getPairings: () => [] } },
      connect,
      disconnect
    }
    Reflect.set(client, 'signClient', signClient)
    jest.spyOn(WalletConnectCommunicationClient, 'getInstance').mockReturnValue(client)
    storage = new LocalStorage('approval-test')
    transport = new DappWalletConnectTransport(
      'Test',
      { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
      storage,
      options,
      leader
    )
    paired = jest.fn().mockResolvedValue(true)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  async function start() {
    await transport.listenForNewPeer(paired)
    await client.init()
  }

  async function expectRejected() {
    await flush()
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([])
    expect(client.listenerKeys()).toEqual([])
    expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
    expect(paired).not.toHaveBeenCalled()
    const ready = jest.fn()
    void transport.waitForResolution().then(ready)
    await flush()
    expect(ready).not.toHaveBeenCalled()
    expect(client.currentSession()).toBeUndefined()
    expect(disconnect).toHaveBeenCalledWith(expect.objectContaining({ topic: 'stale' }))
  }

  it.each([false, true])('awaits a declined callback and preserves previous peer=%s', async (existing) => {
    const previous = {
      id: 'wallet-key', publicKey: 'wallet-key', senderId: 'previous',
      type: 'walletconnect-pairing-response' as const, name: 'previous', version: 'first',
      extensionId: 'previous'
    }
    if (existing) await transport.addPeer(previous)
    const decision = new ExposedPromise<boolean>()
    const entered = new ExposedPromise<void>()
    paired.mockImplementation(() => { entered.resolve(); return decision.promise })
    await start()
    approval.resolve(session('stale'))
    await entered.promise
    decision.resolve(false)
    await flush()
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual(existing ? [previous] : [])
    expect(client.listenerKeys()).toEqual(existing ? ['wallet-key'] : [])
    expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
    expect(client.currentSession()).toBeUndefined()
    expect(disconnect).toHaveBeenCalledWith(expect.objectContaining({ topic: 'stale' }))
  })

  it('rejects delayed approval after pairing cancellation', async () => {
    await start()
    await transport.stopListeningForNewPeers()
    approval.resolve(session('stale'))
    await expectRejected()
  })

  it('rejects delayed approval after transport disconnect', async () => {
    await start()
    await transport.disconnect()
    approval.resolve(session('stale'))
    await expectRejected()
  })

  it.each(['Matrix selection', 'account cancellation', 'WalletConnect success then disconnect'])(
    'rejects delayed approval after DAppClient %s',
    async (outcome) => {
      const keys = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) }
      const post = new DappPostMessageTransport('Test', keys, storage)
      const matrix = new DappP2PTransport('Test', keys, storage, {})
      jest.spyOn(post, 'connect').mockResolvedValue(undefined)
      jest.spyOn(matrix, 'connect').mockResolvedValue(undefined)
      // Matrix networking is not started in this WalletConnect fixture.
      jest.spyOn(matrix, 'removeAllPeers').mockResolvedValue(undefined)
      jest.spyOn(matrix, 'disconnect').mockResolvedValue(undefined)
      jest.spyOn(matrix, 'getPairingRequestInfo').mockResolvedValue({
        id: 'matrix',
        type: 'p2p-pairing-request',
        name: 'Test',
        publicKey: 'matrix-key',
        version: '3',
        relayServer: 'matrix.example.com'
      })
      jest.spyOn(post, 'getPairingRequestInfo').mockResolvedValue({
        id: 'post',
        type: 'postmessage-pairing-request',
        name: 'Test',
        publicKey: 'post-key',
        version: '3'
      })
      jest.spyOn(PostMessageTransport, 'getAvailableExtensions').mockResolvedValue([])
      const matrixListener = new ExposedPromise<
        Parameters<DappP2PTransport['listenForNewPeer']>[0]
      >()
      jest.spyOn(matrix, 'listenForNewPeer').mockImplementation(async (listener) => {
        matrixListener.resolve(listener)
      })
      const wc = transport
      class PairingClient extends DAppClient {
        public async initInternalTransports(): Promise<void> {
          this.postMessageTransport = post
          this.p2pTransport = matrix
          this.walletConnectTransport = wc
        }
        public selectedTransport() {
          return this.transport
        }
      }
      Reflect.set(window, 'beaconCreatedClientInstance', false)
      const dapp = new PairingClient({ name: 'Pairing test', storage, disableDefaultEvents: true })
      await dapp.getActiveAccount()
      const selection = dapp.init()
      const selectMatrix = await matrixListener.promise
      await client.init()
      if (outcome === 'WalletConnect success then disconnect') {
        approval.resolve(session('valid'))
        await expect(selection).resolves.toBe(TransportType.WALLETCONNECT)
        await dapp.disconnect({ notifyPeers: false })
        await flush()
        expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([])
        expect(client.listenerKeys()).toEqual([])
        expect(client.currentSession()).toBeUndefined()
        expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
        return
      }
      if (outcome === 'Matrix selection') {
        selectMatrix({
          id: 'matrix',
          type: 'p2p-pairing-response',
          name: 'Matrix wallet',
          publicKey: 'matrix-key',
          version: '3',
          relayServer: 'matrix.example.com'
        })
        await expect(selection).resolves.toBe(TransportType.P2P)
      } else {
        const rejected = expect(selection).rejects.toMatchObject({
          errorType: BeaconErrorType.ABORTED_ERROR
        })
        await dapp.clearActiveAccount()
        await rejected
      }
      approval.resolve(session('stale'))
      await expectRejected()
      if (outcome === 'Matrix selection') {
        await expect(dapp.selectedTransport()).resolves.toBe(matrix)
      }
    }
  )

  it('accepts a new pairing on a transport reused after peer cleanup', async () => {
    await start()
    await transport.removeAllPeers()
    approval = new ExposedPromise()
    await start()
    approval.resolve(session('valid'))
    await flush()
    expect(paired).toHaveBeenCalledTimes(1)
    expect(client.currentSession()?.topic).toBe('valid')
    expect(client.listenerKeys()).toEqual(['wallet-key'])
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([
      expect.objectContaining({ senderId: 'valid' })
    ])
  })

  it('starts fresh setup instead of sharing the cancelled pairing request', async () => {
    const pending = new ExposedPromise<{
      uri: string
      approval: () => Promise<SessionTypes.Struct>
    }>()
    const pendingReplacement = new ExposedPromise<{
      uri: string
      approval: () => Promise<SessionTypes.Struct>
    }>()
    const oldApproval = approval
    connect
      .mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(() => pendingReplacement.promise)
    await transport.listenForNewPeer(paired)
    const oldRequest = client.getPairingRequestInfo()
    await flush()
    await transport.stopListeningForNewPeers()
    approval = new ExposedPromise()
    await transport.listenForNewPeer(paired)
    const replacementRequest = client.getPairingRequestInfo()
    await flush()
    pending.resolve({ uri: 'wc:old@2?symKey=test', approval: () => oldApproval.promise })
    await oldRequest
    const sharedReplacement = client.getPairingRequestInfo()
    await flush()
    expect(connect).toHaveBeenCalledTimes(2)
    pendingReplacement.resolve({
      uri: 'wc:pairing@2?symKey=test',
      approval: () => approval.promise
    })
    await sharedReplacement
    expect((await replacementRequest).uri).toBe('wc:pairing@2?symKey=test')
    approval.resolve(session('replacement'))
    oldApproval.resolve(session('stale'))
    await flush()
    expect(paired).toHaveBeenCalledTimes(1)
    expect(client.currentSession()?.topic).toBe('replacement')
    expect(client.listenerKeys()).toEqual(['wallet-key'])
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([
      expect.objectContaining({ senderId: 'replacement' })
    ])
  })

  it('does not restore an old session after cancellation during validation', async () => {
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    Reflect.set(client, 'signClient', {
      session: { keys: ['stale'], get: () => session('stale') },
      ping: () => {
        entered.resolve()
        return release.promise
      }
    })
    await transport.listenForNewPeer(paired)
    const restoring = client.init()
    await entered.promise
    await transport.stopListeningForNewPeers()
    const replacement = session('replacement')
    Reflect.set(client, 'session', replacement)
    release.resolve()
    await restoring
    expect(client.currentSession()).toBe(replacement)
  })

  it('rolls back a peer when cancellation occurs during persistence', async () => {
    await start()
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    const set = storage.set.bind(storage)
    jest.spyOn(storage, 'set').mockImplementationOnce(async (key, value) => {
      entered.resolve()
      await release.promise
      return set(key, value)
    })
    approval.resolve(session('stale'))
    await entered.promise
    await transport.stopListeningForNewPeers()
    release.resolve()
    await expectRejected()
  })

  it('rejects approval cancelled during the leadership check', async () => {
    await start()
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<boolean>()
    leader.mockImplementationOnce(() => {
      entered.resolve()
      return release.promise
    })
    approval.resolve(session('stale'))
    await entered.promise
    await transport.stopListeningForNewPeers()
    release.resolve(true)
    await expectRejected()
  })

  it('does not deliver an old approval to a replacement pairing listener', async () => {
    await start()
    await transport.stopListeningForNewPeers()
    const replacement = jest.fn()
    await transport.listenForNewPeer(replacement)
    approval.resolve(session('stale'))
    await expectRejected()
    expect(replacement).not.toHaveBeenCalled()
  })

  it('preserves a legitimate replacement session when an older approval arrives', async () => {
    await start()
    const oldApproval = approval
    await transport.stopListeningForNewPeers()
    approval = new ExposedPromise()
    await transport.listenForNewPeer(paired)
    await client.init()
    approval.resolve(session('replacement'))
    await flush()
    oldApproval.resolve(session('stale'))
    await flush()
    expect(client.currentSession()?.topic).toBe('replacement')
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([
      expect.objectContaining({ senderId: 'replacement' })
    ])
    expect(client.listenerKeys()).toEqual(['wallet-key'])
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    expect(paired).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledWith(expect.objectContaining({ topic: 'stale' }))
    expect(disconnect).not.toHaveBeenCalledWith(expect.objectContaining({ topic: 'replacement' }))
  })

  it('finishes stale persistence cleanup before accepting a replacement with the same key', async () => {
    await start()
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    const set = storage.set.bind(storage)
    jest.spyOn(storage, 'set').mockImplementationOnce(async (key, value) => {
      entered.resolve()
      await release.promise
      return set(key, value)
    })
    approval.resolve(session('stale'))
    await entered.promise
    await transport.stopListeningForNewPeers()
    approval = new ExposedPromise()
    await transport.listenForNewPeer(paired)
    await client.init()
    approval.resolve(session('replacement'))
    await flush()
    release.resolve()
    await flush()
    expect(client.currentSession()?.topic).toBe('replacement')
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([
      expect.objectContaining({ senderId: 'replacement' })
    ])
    expect(client.listenerKeys()).toEqual(['wallet-key'])
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    expect(paired).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledWith(expect.objectContaining({ topic: 'stale' }))
    expect(disconnect).not.toHaveBeenCalledWith(expect.objectContaining({ topic: 'replacement' }))
  })

  it('accepts a same-topic session refresh during peer persistence', async () => {
    await start()
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    const set = storage.set.bind(storage)
    jest.spyOn(storage, 'set').mockImplementationOnce(async (key, value) => {
      entered.resolve()
      await release.promise
      return set(key, value)
    })
    approval.resolve(session('valid'))
    await entered.promise
    // Session update/extend handlers replace the snapshot without changing its ownership.
    const refreshed = { ...session('valid'), expiry: 2100000000 }
    Reflect.set(client, 'session', refreshed)
    release.resolve()
    await flush()
    expect(client.currentSession()).toBe(refreshed)
    expect(paired).toHaveBeenCalledTimes(1)
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    expect(client.listenerKeys()).toEqual(['wallet-key'])
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([
      expect.objectContaining({ senderId: 'valid' })
    ])
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('preserves the existing session when a secondary tab declines an approval', async () => {
    leader.mockResolvedValue(false)
    const close = jest.spyOn(client, 'closeSignClient').mockResolvedValue(undefined)
    const previous = session('previous')
    const peer = {
      id: 'wallet-key', publicKey: 'wallet-key', senderId: 'previous',
      type: 'walletconnect-pairing-response' as const, name: 'Previous wallet',
      version: '3', extensionId: 'Previous wallet'
    }
    await transport.addPeer(peer)
    Reflect.set(client, 'session', previous)
    paired.mockResolvedValue(false)
    await start()
    approval.resolve(session('declined'))
    await flush()
    expect(client.currentSession()).toBe(previous)
    expect(close).not.toHaveBeenCalled()
    expect(client.listenerKeys()).toEqual(['wallet-key'])
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([peer])
    expect(disconnect).toHaveBeenCalledWith(expect.objectContaining({ topic: 'declined' }))
    expect(disconnect).not.toHaveBeenCalledWith(expect.objectContaining({ topic: 'previous' }))
  })

  it('preserves a replacement approved while secondary-tab cleanup is awaiting close', async () => {
    leader.mockResolvedValue(false)
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    jest.spyOn(client, 'closeSignClient').mockImplementationOnce(() => {
      entered.resolve()
      return release.promise
    })
    paired.mockImplementation(() => {
      void transport.stopListeningForNewPeers()
      return true
    })
    await start()
    approval.resolve(session('first'))
    await entered.promise
    leader.mockResolvedValue(true)
    approval = new ExposedPromise()
    await start()
    approval.resolve(session('replacement'))
    await flush()
    release.resolve()
    await flush()
    expect(client.currentSession()?.topic).toBe('replacement')
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    expect(client.listenerKeys()).toEqual(['wallet-key'])
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([
      expect.objectContaining({ senderId: 'replacement' })
    ])
    expect(paired).toHaveBeenCalledTimes(2)
  })

  it('retains secondary-tab cleanup after valid selection stops pairing listeners', async () => {
    leader.mockResolvedValue(false)
    const close = jest.spyOn(client, 'closeSignClient').mockResolvedValue(undefined)
    paired.mockImplementation(() => {
      void transport.stopListeningForNewPeers()
      return true
    })
    await start()
    approval.resolve(session('valid'))
    await flush()
    expect(paired).toHaveBeenCalledTimes(1)
    expect(transport.connectionStatus).toBe(TransportStatus.SECONDARY_TAB_CONNECTED)
    await expect(transport.waitForResolution()).resolves.toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    expect(client.currentSession()).toBeUndefined()
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([
      expect.objectContaining({ senderId: 'valid' })
    ])
    expect(client.listenerKeys()).toEqual(['wallet-key'])
  })

  it('accepts valid approval and keeps the session when selection stops pairing listeners', async () => {
    paired.mockImplementation(() => {
      void transport.stopListeningForNewPeers()
      return true
    })
    await start()
    approval.resolve(session('valid'))
    await flush()
    expect(await storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP)).toEqual([
      expect.objectContaining({ senderId: 'valid' })
    ])
    expect(client.listenerKeys()).toEqual(['wallet-key'])
    expect(client.currentSession()?.topic).toBe('valid')
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    await expect(transport.waitForResolution()).resolves.toBe(true)
    expect(paired).toHaveBeenCalledTimes(1)
    expect(disconnect).not.toHaveBeenCalled()
  })
})
