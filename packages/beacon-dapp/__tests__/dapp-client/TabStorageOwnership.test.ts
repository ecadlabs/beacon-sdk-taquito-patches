import { LocalStorage, Serializer } from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessageType,
  ExtendedWalletConnectPairingResponse,
  ExtendedP2PPairingResponse,
  NetworkType,
  Origin,
  PermissionScope,
  SigningType,
  Storage,
  StorageKey,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { DappPostMessageTransport } from '../../src/transports/DappPostMessageTransport'
import { PostMessageTransport } from '@ecadlabs/beacon-transport-postmessage'
import { BeaconEvent } from '../../src/events'

const channel = vi.hoisted(() => ({
  postMessage: vi.fn<(message: unknown) => void>(),
  receive: undefined as undefined | ((message: unknown) => Promise<void>)
}))
vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  MultiTabChannel: class {
    constructor(_name: string, receive: (message: unknown) => Promise<void>) {
      channel.receive = receive
    }
    isLeader() {
      return false
    }
    async hasLeader() {
      return true
    }
    async getLeadership() {}
    async init() {}
    async close() {}
    postMessage(message: unknown) {
      channel.postMessage(message)
    }
  },
  StorageValidator: class {
    async validate() {
      return true
    }
  },
  IndexedDBStorage: class {
    async get() {
      return undefined
    }
  }
}))
vi.mock('@ecadlabs/beacon-ui', () => ({
  setColorMode: vi.fn(),
  setDesktopList: vi.fn(),
  setExtensionList: vi.fn(),
  setWebList: vi.fn(),
  setiOSList: vi.fn(),
  getDesktopList: () => [],
  getExtensionList: () => [],
  getWebList: () => [],
  getiOSList: () => [],
  isMobileOS: () => false,
  isDesktop: () => true,
  isIOS: () => false,
  closeToast: vi.fn()
}))

type StorageListener = Parameters<Storage['subscribeToStorageChanged']>[0]
class TabStorage extends LocalStorage {
  private changed?: StorageListener
  async subscribeToStorageChanged(callback: StorageListener): Promise<void> {
    this.changed = callback
  }
  async notify(event: Parameters<StorageListener>[0]): Promise<void> {
    if (!this.changed) throw new Error('Storage listener is not registered')
    await this.changed(event)
  }
}
const peer: ExtendedWalletConnectPairingResponse = {
  id: 'tab-peer',
  name: 'Tab wallet',
  publicKey: 'tab-topic',
  senderId: 'tab-wallet',
  type: 'walletconnect-pairing-response',
  version: '3',
  extensionId: 'walletconnect'
}
const account: AccountInfo = {
  accountIdentifier: 'tab-account',
  senderId: peer.senderId,
  address: 'tz1TGu6TN5GSez2ndXXeDX6LgUDvLzPLqgYV',
  network: { type: NetworkType.MAINNET },
  scopes: [PermissionScope.SIGN],
  origin: { type: Origin.WALLETCONNECT, id: peer.publicKey },
  connectedAt: 1,
  walletType: 'implicit'
}
const ownedTransports: DappWalletConnectTransport[] = []
let client: DAppClient
let storage: TabStorage
let transport: DappWalletConnectTransport
beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  storage = new TabStorage('tab-storage')
  await storage.set(StorageKey.BEACON_SDK_SECRET_SEED, 'tab-storage-seed')
  client = new DAppClient({
    name: 'Tab storage',
    storage,
    disableDefaultEvents: true,
    enableAppSwitching: false
  })
  await client.getActiveAccount()
  await client.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
  transport = new DappWalletConnectTransport(
    'Tab wallet',
    await getKeypairFromSeed('tab-storage-seed'),
    storage,
    { network: NetworkType.MAINNET, opts: { projectId: 'offline' } },
    async () => false
  )
  ownedTransports.push(transport)
  transport['_isConnected'] = TransportStatus.SECONDARY_TAB_CONNECTED
  vi.spyOn(transport, 'waitForResolution').mockResolvedValue(true)
  vi.spyOn(transport, 'disconnect').mockResolvedValue(undefined)
  vi.spyOn(transport, 'release').mockResolvedValue(undefined)
  vi.spyOn(transport, 'removeAllPeers').mockResolvedValue(undefined)
  vi.spyOn(transport, 'getPeers').mockResolvedValue([peer])
  vi.spyOn(transport, 'send').mockResolvedValue(undefined)
  client['walletConnectTransport'] = transport
  client['_transport'] = ExposedPromise.resolve<Awaited<DAppClient['transport']>>(transport)
  client['_activeAccount'] = ExposedPromise.resolve<AccountInfo | undefined>(account)
  await storage.set(StorageKey.ACCOUNTS, [account])
  await storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
  vi.spyOn(client, 'getWalletInfo').mockResolvedValue({ name: 'Tab wallet' })
  vi.spyOn(client, 'init').mockResolvedValue(transport.type)
})
afterEach(async () => {
  client['abortOpenRequests']()
  await client.destroy()
  vi.restoreAllMocks()
  await Promise.all(ownedTransports.splice(0).map((owned) => owned.release()))
})
async function pendingSign() {
  const settled = vi.fn()
  const outcome = client.requestSignPayload({ payload: 'aa', signingType: SigningType.RAW }).then(
    (value) => {
      settled({ value })
      return { value }
    },
    (error: unknown) => {
      settled({ error })
      return { error }
    }
  )
  await vi.waitFor(() => expect(channel.postMessage).toHaveBeenCalled())
  const sent = channel.postMessage.mock.calls[0][0]
  if (!sent || typeof sent !== 'object' || !('id' in sent) || typeof sent.id !== 'string')
    throw new Error('Missing forwarded request ID')
  return { id: sent.id, outcome, settled }
}
async function respond(id: string) {
  if (!channel.receive) throw new Error('Broadcast listener is not registered')
  await channel.receive({
    type: 'RESPONSE',
    id,
    data: {
      message: {
        id,
        type: BeaconMessageType.SignPayloadResponse,
        version: '2',
        senderId: peer.senderId,
        signature: 'sig',
        signingType: SigningType.RAW
      },
      connectionInfo: account.origin
    }
  })
}

it.each(['active pointer', 'account membership', 'storage clear'] as const)(
  'settles a forwarded request when %s removes its selection',
  async (boundary) => {
    const request = await pendingSign()
    if (boundary === 'storage clear') {
      localStorage.clear()
      await storage.notify({
        eventType: 'storageCleared',
        key: null,
        oldValue: null,
        newValue: null
      })
    } else {
      const key = boundary === 'active pointer' ? StorageKey.ACTIVE_ACCOUNT : StorageKey.ACCOUNTS
      if (key === StorageKey.ACTIVE_ACCOUNT) await storage.delete(key)
      else await storage.set(key, [])
      await storage.notify({
        eventType: 'entryModified',
        key: storage.getPrefixedKey(key),
        oldValue:
          boundary === 'active pointer' ? account.accountIdentifier : JSON.stringify([account]),
        newValue: boundary === 'active pointer' ? null : '[]'
      })
    }
    await expect(request.outcome).resolves.toMatchObject({
      error: { errorType: BeaconErrorType.ABORTED_ERROR }
    })
    await expect(client.getActiveAccount()).resolves.toBeUndefined()
    expect(channel.postMessage).toHaveBeenCalledWith({ type: 'DISCONNECT' })
    expect(transport.disconnect).not.toHaveBeenCalled()
    await respond(request.id)
    expect(request.settled).toHaveBeenCalledTimes(1)
    expect(
      channel.postMessage.mock.calls.filter(
        ([message]) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === BeaconMessageType.SignPayloadRequest
      )
    ).toHaveLength(1)
  }
)

it('refreshes SDK identity while retaining an in-flight forwarded request on seed change', async () => {
  const before = await client.getOwnAppMetadata()
  const request = await pendingSign()
  await storage.set(StorageKey.BEACON_SDK_SECRET_SEED, 'next-tab-storage-seed')
  await storage.notify({
    eventType: 'entryModified',
    key: storage.getPrefixedKey(StorageKey.BEACON_SDK_SECRET_SEED),
    oldValue: 'tab-storage-seed',
    newValue: 'next-tab-storage-seed'
  })
  const after = await client.getOwnAppMetadata()
  expect(after.senderId).not.toBe(before.senderId)
  expect(request.settled).not.toHaveBeenCalled()
  expect(transport.disconnect).not.toHaveBeenCalled()
  expect(channel.postMessage).not.toHaveBeenCalledWith({ type: 'DISCONNECT' })
  await expect(client.getActiveAccount()).resolves.toEqual(account)
  await respond(request.id)
  await expect(request.outcome).resolves.toMatchObject({ value: { signature: 'sig' } })
})

it('performs full peer cleanup and default notification for an inbound DISCONNECT', async () => {
  const request = await pendingSign()
  if (!channel.receive) throw new Error('Broadcast listener is not registered')
  await channel.receive({ type: 'DISCONNECT' })
  await expect(request.outcome).resolves.toMatchObject({
    error: { errorType: BeaconErrorType.ABORTED_ERROR }
  })
  expect(transport.removeAllPeers).toHaveBeenCalledTimes(1)
  expect(transport.disconnect).toHaveBeenCalledTimes(1)
  expect(transport.send).toHaveBeenCalledTimes(1)
  const [payload, recipient] = vi.mocked(transport.send).mock.calls[0]
  expect(recipient).toEqual(peer)
  await expect(new Serializer().deserialize(payload)).resolves.toMatchObject({
    type: BeaconMessageType.Disconnect
  })
  await expect(client.getActiveAccount()).resolves.toBeUndefined()
  await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toEqual([])
  await respond(request.id)
  expect(request.settled).toHaveBeenCalledTimes(1)
})

it('refreshes SDK identity without retiring a pending pairing on seed change', async () => {
  await client.destroy()
  await storage.set(StorageKey.ACCOUNTS, [])
  await storage.delete(StorageKey.ACTIVE_ACCOUNT)
  const keys = await getKeypairFromSeed('tab-pairing-seed')
  const p2p = new DappP2PTransport('Tab pairing', keys, storage, {})
  const post = new DappPostMessageTransport('Tab pairing', keys, storage)
  transport = new DappWalletConnectTransport(
    'Tab pairing',
    keys,
    storage,
    { network: NetworkType.MAINNET, opts: { projectId: 'offline' } },
    async () => false
  )
  ownedTransports.push(transport)
  for (const adapter of [p2p, post, transport]) {
    vi.spyOn(adapter, 'connect').mockImplementation(async () => {
      adapter['_isConnected'] = TransportStatus.CONNECTED
    })
    vi.spyOn(adapter, 'disconnect').mockResolvedValue(undefined)
    vi.spyOn(adapter, 'getPeers').mockResolvedValue([])
    vi.spyOn(adapter, 'removeAllPeers').mockResolvedValue(undefined)
    vi.spyOn(adapter, 'stopListeningForNewPeers').mockResolvedValue(undefined)
  }
  vi.spyOn(transport, 'release').mockResolvedValue(undefined)
  vi.spyOn(transport, 'doClientCleanup').mockResolvedValue(undefined)
  let accepted: Parameters<DappP2PTransport['listenForNewPeer']>[0] | undefined
  vi.spyOn(p2p, 'listenForNewPeer').mockImplementation(async (callback) => {
    accepted = callback
  })
  vi.spyOn(post, 'listenForNewPeer').mockResolvedValue(undefined)
  vi.spyOn(transport, 'listenForNewPeer').mockResolvedValue(undefined)
  const peerFields = {
    id: 'tab-pairing',
    publicKey: '22'.repeat(32),
    name: 'Tab wallet',
    version: '3'
  }
  vi.spyOn(p2p, 'getPairingRequestInfo').mockResolvedValue({
    ...peerFields,
    type: 'p2p-pairing-request',
    relayServer: 'relay.example'
  })
  vi.spyOn(post, 'getPairingRequestInfo').mockResolvedValue({
    ...peerFields,
    type: 'postmessage-pairing-request'
  })
  vi.spyOn(PostMessageTransport, 'getAvailableExtensions').mockResolvedValue([])
  const pairingStarted = vi.fn()
  const paired = vi.fn()
  class PairingClient extends DAppClient {
    public async initInternalTransports(): Promise<void> {
      this.p2pTransport = p2p
      this.postMessageTransport = post
      this.walletConnectTransport = transport
      await Promise.all([
        this.addListener(p2p),
        this.addListener(post),
        this.addListener(transport)
      ])
    }
  }
  client = new PairingClient({
    name: 'Tab pairing',
    storage,
    disableDefaultEvents: true,
    enableAppSwitching: false,
    eventHandlers: {
      [BeaconEvent.PAIR_INIT]: {
        handler: (event) => {
          pairingStarted()
          void event.p2pPeerInfo.catch(() => {})
          void event.postmessagePeerInfo.catch(() => {})
        }
      },
      [BeaconEvent.PAIR_SUCCESS]: { handler: paired }
    }
  })
  await client.getActiveAccount()
  const before = await client.getOwnAppMetadata()
  const settled = vi.fn()
  const initialization = client.init().then(
    (value) => {
      settled({ value })
      return { value }
    },
    (error: unknown) => {
      settled({ error })
      return { error }
    }
  )
  await vi.waitFor(() => expect(pairingStarted).toHaveBeenCalledTimes(1))
  await storage.set(StorageKey.BEACON_SDK_SECRET_SEED, 'next-tab-pairing-seed')
  await storage.notify({
    eventType: 'entryModified',
    key: storage.getPrefixedKey(StorageKey.BEACON_SDK_SECRET_SEED),
    oldValue: 'tab-storage-seed',
    newValue: 'next-tab-pairing-seed'
  })
  const after = await client.getOwnAppMetadata()
  expect(after.senderId).not.toBe(before.senderId)
  expect(settled).not.toHaveBeenCalled()
  expect(paired).not.toHaveBeenCalled()
  expect(p2p.disconnect).not.toHaveBeenCalled()
  if (!accepted) throw new Error('Pairing listener is not registered')
  const candidate: ExtendedP2PPairingResponse = {
    ...peerFields,
    type: 'p2p-pairing-response',
    relayServer: 'relay.example',
    senderId: 'tab-pairing-wallet'
  }
  await expect(accepted(candidate)).resolves.toBe(true)
  await expect(initialization).resolves.toEqual({ value: TransportType.P2P })
  expect(settled).toHaveBeenCalledTimes(1)
  expect(paired).toHaveBeenCalledTimes(1)
  expect(pairingStarted).toHaveBeenCalledTimes(1)
})
