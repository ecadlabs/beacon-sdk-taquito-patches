import {
  CommunicationClient,
  LocalStorage,
  PeerManager,
  Serializer,
  Transport
} from '@ecadlabs/beacon-core'
import {
  BeaconErrorType,
  BeaconMessage,
  BeaconMessageType,
  BeaconMessageWrapper,
  Blockchain,
  ConnectionContext,
  ExtendedPostMessagePairingResponse,
  NetworkType,
  Origin,
  PeerInfoType,
  PermissionScope,
  PermissionResponseV3,
  StorageKey,
  TransportType
} from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { BeaconEvent } from '../../src/events'

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  ...(await vi.importActual<
    typeof import('../../../beacon-core/src/transports/clients/ClientEvents')
  >('../../../beacon-core/src/transports/clients/ClientEvents')),
  MultiTabChannel: class {
    async init() {}
    isLeader() {
      return true
    }
    hasLeader() {
      return Promise.resolve(true)
    }
    getLeadership() {
      return Promise.resolve()
    }
    postMessage() {}
    close() {
      return Promise.resolve()
    }
  }
}))

vi.mock('@ecadlabs/beacon-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-ui')>()),
  isMobileOS: () => false,
  isDesktop: () => true
}))

class ControlledClient extends CommunicationClient {
  readonly sent = new ExposedPromise<string>()
  async sendMessage(message: string): Promise<void> {
    this.sent.resolve(message)
  }
  async unsubscribeFromEncryptedMessages(): Promise<void> {}
  async unsubscribeFromEncryptedMessage(): Promise<void> {}
}

class ControlledTransport extends Transport<
  PeerInfoType,
  StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP,
  ControlledClient
> {
  readonly type = TransportType.POST_MESSAGE
  readonly sent: Promise<string>

  constructor(storage: LocalStorage) {
    const client = new ControlledClient()
    super(
      'Response test',
      client,
      new PeerManager(storage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
    )
    this.sent = client.sent.promise
  }

  async listen(): Promise<void> {}

  async receive(message: BeaconMessage | BeaconMessageWrapper<{ type: unknown }>): Promise<void> {
    await this.notifyListeners(await new Serializer().serialize(message), connectionInfo)
  }
}

const connectionInfo: ConnectionContext = { origin: Origin.EXTENSION, id: 'extension-id' }
const peer: ExtendedPostMessagePairingResponse = {
  type: 'postmessage-pairing-response',
  id: 'wallet-peer',
  senderId: 'wallet-sender',
  publicKey: '11'.repeat(32),
  name: 'Response wallet',
  extensionId: connectionInfo.id,
  version: '3'
}
const publicKey = 'edpkv3Nf62TZxR1XwzKRteLTh1SmXLmr8cGEwHRSNoiUV3oiBrDbFX'
const metadata = { senderId: peer.senderId, name: peer.name }
const blockchain: Blockchain = {
  identifier: 'tezos',
  async validateRequest() {},
  async handleResponse() {},
  async getWalletLists() {
    return { extensionList: [], desktopList: [], webList: [], iOSList: [] }
  },
  async getAccountInfosFromPermissionResponse() {
    return [
      { accountId: 'response-account', address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', publicKey }
    ]
  }
}

describe('Request response ownership', () => {
  let dapp: DAppClient
  let transport: ControlledTransport
  let storage: LocalStorage
  let release: ExposedPromise<void>
  const failed = vi.fn()
  const succeeded = vi.fn()
  const changed = vi.fn()
  const closed = vi.fn()
  const acknowledged = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    release = new ExposedPromise<void>()
    localStorage.clear()
    Object.defineProperty(window, 'beaconCreatedClientInstance', {
      value: false,
      writable: true,
      configurable: true
    })
  })

  async function start(requestTimeoutMs: number) {
    storage = new LocalStorage('request-response-ownership')
    transport = new ControlledTransport(storage)
    dapp = new DAppClient({
      name: 'Request response ownership',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      requestTimeoutMs,
      network: { type: NetworkType.MAINNET }
    })
    await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, changed)
    await dapp.subscribeToEvent(BeaconEvent.PERMISSION_REQUEST_ERROR, failed)
    await dapp.subscribeToEvent(BeaconEvent.PERMISSION_REQUEST_SUCCESS, succeeded)
    await dapp.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, closed)
    await dapp.subscribeToEvent(BeaconEvent.ACKNOWLEDGE_RECEIVED, acknowledged)
    await dapp.getActiveAccount()
    await transport.addPeer(peer)
    await transport.connect()
    await dapp.init(transport)
    dapp['resolveActivePeer'](peer)
    dapp.addBlockchain(blockchain)
    vi.clearAllMocks()
  }

  afterEach(async () => {
    release.resolve()
    await dapp.destroy()
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function request(version: '2' | '3') {
    const settled = vi.fn()
    const pending =
      version === '2'
        ? dapp.requestPermissions()
        : dapp.permissionRequest({
            type: BeaconMessageType.PermissionRequest,
            blockchainIdentifier: 'tezos',
            blockchainData: {
              appMetadata: { senderId: 'dapp', name: 'Request response ownership' },
              scopes: [PermissionScope.SIGN]
            }
          })
    const outcome = pending.then(
      (value) => {
        settled({ value })
        return { value }
      },
      (error: unknown) => {
        settled({ error })
        return { error }
      }
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()
    const encoded = await transport.sent
    const sent: unknown = await new Serializer().deserialize(encoded)
    if (!sent || typeof sent !== 'object' || !('id' in sent) || typeof sent.id !== 'string') {
      throw new Error('Missing request ID')
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()
    return { id: sent.id, outcome, settled }
  }

  function response(
    version: '2' | '3',
    id: string
  ): BeaconMessage | BeaconMessageWrapper<PermissionResponseV3> {
    return version === '2'
      ? {
          id,
          version,
          senderId: peer.senderId,
          type: BeaconMessageType.PermissionResponse,
          walletType: 'implicit',
          publicKey,
          appMetadata: metadata,
          network: { type: NetworkType.MAINNET },
          scopes: [PermissionScope.SIGN]
        }
      : {
          id,
          version,
          senderId: peer.senderId,
          message: {
            type: BeaconMessageType.PermissionResponse,
            blockchainIdentifier: 'tezos',
            blockchainData: { appMetadata: metadata, scopes: [PermissionScope.SIGN] }
          }
        }
  }

  function expectedError(id: string, errorType: BeaconErrorType) {
    return expect.objectContaining({
      id,
      type: BeaconMessageType.Error,
      errorType,
      senderId: '',
      version: '2',
      errorOrigin: 'local'
    })
  }

  function control(version: '2' | '3', id: string, type: BeaconMessageType.Acknowledge) {
    return version === '2'
      ? { id, version, senderId: peer.senderId, type }
      : { id, version, senderId: peer.senderId, message: { type } }
  }

  function holdMetadata() {
    const manager = dapp['appMetadataManager']
    const original = manager.addAppMetadata.bind(manager)
    return vi.spyOn(manager, 'addAppMetadata').mockImplementation(async (value) => {
      await release.promise
      await original(value)
    })
  }

  it.each(['2', '3'] as const)(
    'prepares a V%s response once when the same response arrives twice',
    async (version) => {
      await start(25)
      const pending = await request(version)
      const write = holdMetadata()
      const first = transport.receive(response(version, pending.id))
      await vi.advanceTimersByTimeAsync(0)
      expect(write).toHaveBeenCalledExactlyOnceWith(metadata)
      const second = transport.receive(response(version, pending.id))
      await vi.advanceTimersByTimeAsync(0)
      expect(pending.settled).not.toHaveBeenCalled()
      const writeCount = write.mock.calls.length

      release.resolve()
      await Promise.all([first, second])
      await vi.advanceTimersByTimeAsync(100)
      expect(writeCount).toBe(1)
      expect(pending.settled).toHaveBeenCalledTimes(1)
      expect(await pending.outcome).toEqual({ value: expect.any(Object) })
      expect(succeeded).toHaveBeenCalledTimes(1)
      expect(failed).not.toHaveBeenCalled()
      expect(closed).not.toHaveBeenCalled()
    }
  )

  it.each(['2', '3'] as const)(
    'keeps a V%s response in preparation when a later wallet error arrives',
    async (version) => {
      await start(25)
      const pending = await request(version)
      const write = holdMetadata()
      const preparing = transport.receive(response(version, pending.id))
      await vi.advanceTimersByTimeAsync(0)
      expect(write).toHaveBeenCalledExactlyOnceWith(metadata)
      await transport.receive({
        id: pending.id,
        version: '2',
        senderId: peer.senderId,
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.NOT_GRANTED_ERROR
      })
      await vi.advanceTimersByTimeAsync(0)
      const prematureSettlements = pending.settled.mock.calls.length

      release.resolve()
      await preparing
      await vi.advanceTimersByTimeAsync(100)
      expect(prematureSettlements).toBe(0)
      expect(pending.settled).toHaveBeenCalledTimes(1)
      expect(await pending.outcome).toEqual({ value: expect.any(Object) })
      expect(succeeded).toHaveBeenCalledTimes(1)
      expect(failed).not.toHaveBeenCalled()
      expect(closed).not.toHaveBeenCalled()
    }
  )

  it.each(['2', '3'] as const)(
    'keeps V%s metadata preparation after its send reports a late failure',
    async (version) => {
      await start(0)
      const sendFinished = new ExposedPromise<void>()
      const send = transport.send.bind(transport)
      vi.spyOn(transport, 'send').mockImplementation(async (...args) => {
        await send(...args)
        await sendFinished.promise
      })
      const pending = await request(version)
      const write = holdMetadata()
      const preparing = transport.receive(response(version, pending.id))
      await vi.advanceTimersByTimeAsync(0)
      expect(write).toHaveBeenCalledExactlyOnceWith(metadata)
      const internalError = vi.fn()
      await dapp.subscribeToEvent(BeaconEvent.INTERNAL_ERROR, internalError)
      sendFinished.reject(new Error('Send finished after response arrival'))
      await vi.advanceTimersByTimeAsync(0)
      const prematureSettlements = pending.settled.mock.calls.length

      release.resolve()
      await preparing
      await vi.advanceTimersByTimeAsync(0)
      expect(prematureSettlements).toBe(0)
      expect(pending.settled).toHaveBeenCalledTimes(1)
      expect(await pending.outcome).toEqual({ value: expect.any(Object) })
      expect(succeeded).toHaveBeenCalledTimes(1)
      expect(failed).not.toHaveBeenCalled()
      expect(internalError).not.toHaveBeenCalled()
      expect(closed).not.toHaveBeenCalled()
    }
  )

  it.each(['2', '3'] as const)(
    'accepts a V%s ACK once during preparation and keeps waiting past the deadline',
    async (version) => {
      await start(25)
      const pending = await request(version)
      const write = holdMetadata()
      const preparing = transport.receive(response(version, pending.id))
      await vi.advanceTimersByTimeAsync(0)
      expect(write).toHaveBeenCalledExactlyOnceWith(metadata)
      await transport.receive(control(version, pending.id, BeaconMessageType.Acknowledge))
      await transport.receive(control(version, pending.id, BeaconMessageType.Acknowledge))
      await vi.advanceTimersByTimeAsync(100)
      expect(acknowledged).toHaveBeenCalledTimes(1)
      expect(pending.settled).not.toHaveBeenCalled()
      expect(closed).not.toHaveBeenCalled()

      release.resolve()
      await preparing
      await vi.advanceTimersByTimeAsync(0)
      expect(pending.settled).toHaveBeenCalledTimes(1)
      expect(await pending.outcome).toEqual({ value: expect.any(Object) })
      expect(succeeded).toHaveBeenCalledTimes(1)
      expect(failed).not.toHaveBeenCalled()
      await transport.receive(control(version, pending.id, BeaconMessageType.Acknowledge))
      expect(acknowledged).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['2', '3'] as const)(
    'keeps the V%s timeout outcome when held preparation succeeds later',
    async (version) => {
      await start(25)
      const pending = await request(version)
      const write = holdMetadata()
      const preparing = transport.receive(response(version, pending.id))
      await vi.advanceTimersByTimeAsync(0)
      expect(write).toHaveBeenCalledExactlyOnceWith(metadata)
      await vi.advanceTimersByTimeAsync(25)
      const expected = expectedError(pending.id, BeaconErrorType.PEER_UNREACHABLE)
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expected })
      expect(closed).toHaveBeenCalledTimes(1)

      release.resolve()
      await preparing
      await vi.advanceTimersByTimeAsync(100)
      expect(await pending.outcome).toEqual({ error: expected })
      expect(pending.settled).toHaveBeenCalledTimes(1)
      expect(failed).toHaveBeenCalledTimes(1)
      expect(succeeded).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
      expect(await dapp.getAccounts()).toEqual([])
      expect(closed).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['2', '3'] as const)(
    'settles a V%s abort while preparation remains pending',
    async (version) => {
      await start(0)
      const pending = await request(version)
      const write = holdMetadata()
      const preparing = transport.receive(response(version, pending.id))
      await vi.advanceTimersByTimeAsync(0)
      expect(write).toHaveBeenCalledExactlyOnceWith(metadata)
      await dapp.disconnect({ notifyPeers: false })
      const expected = expectedError(pending.id, BeaconErrorType.ABORTED_ERROR)
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expected })
      expect(await pending.outcome).toEqual({ error: expected })
      changed.mockClear()

      release.resolve()
      await preparing
      await vi.advanceTimersByTimeAsync(100)
      expect(pending.settled).toHaveBeenCalledTimes(1)
      expect(failed).toHaveBeenCalledTimes(1)
      expect(succeeded).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
      expect(await dapp.getAccounts()).toEqual([])
      expect(closed).not.toHaveBeenCalled()
    }
  )

  it.each(['2', '3'] as const)(
    'discards a V%s ACK notification when its wallet details finish after disconnect',
    async (version) => {
      await start(25)
      const pending = await request(version)
      const details = dapp['getWalletInfo'].bind(dapp)
      // Bracket access preserves the private method signature for this controlled wait.
      const boundary = { getWalletInfo: dapp['getWalletInfo'] }
      const lookup = vi.spyOn(boundary, 'getWalletInfo').mockImplementation(async (...args) => {
        await release.promise
        return details(...args)
      })
      if (version === '3') lookup.mockImplementationOnce((...args) => details(...args))
      dapp['getWalletInfo'] = boundary.getWalletInfo
      const delivering = transport.receive(
        control(version, pending.id, BeaconMessageType.Acknowledge)
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(lookup).toHaveBeenCalledTimes(version === '3' ? 2 : 1)
      await vi.advanceTimersByTimeAsync(100)
      expect(pending.settled).not.toHaveBeenCalled()
      expect(closed).not.toHaveBeenCalled()

      // Disconnect's account notification needs wallet details independently of this ACK.
      dapp['getWalletInfo'] = details
      await dapp.disconnect({ notifyPeers: false })
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({
        error: expectedError(pending.id, BeaconErrorType.ABORTED_ERROR)
      })
      release.resolve()
      await delivering
      await vi.advanceTimersByTimeAsync(0)
      expect(acknowledged).not.toHaveBeenCalled()
      expect(pending.settled).toHaveBeenCalledTimes(1)
      expect(succeeded).not.toHaveBeenCalled()
    }
  )
})
