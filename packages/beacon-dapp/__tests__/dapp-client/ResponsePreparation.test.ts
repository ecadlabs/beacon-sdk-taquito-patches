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

describe('Response metadata preparation', () => {
  let dapp: DAppClient
  let transport: ControlledTransport
  let storage: LocalStorage
  let release: ExposedPromise<void>
  const failed = vi.fn()
  const succeeded = vi.fn()
  const changed = vi.fn()
  const closed = vi.fn()

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
    storage = new LocalStorage('response-preparation')
    transport = new ControlledTransport(storage)
    dapp = new DAppClient({
      name: 'Response preparation',
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
              appMetadata: { senderId: 'dapp', name: 'Response preparation' },
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
    return { id, type: BeaconMessageType.Error, errorType, senderId: '', version: '2' }
  }

  it.each(['2', '3'] as const)(
    'rejects a V%s permission request when its response metadata cannot be stored',
    async (version) => {
      await start(0)
      const pending = await request(version)
      const storageError = new Error('Metadata write failed')
      const write = vi
        .spyOn(dapp['appMetadataManager'], 'addAppMetadata')
        .mockRejectedValueOnce(storageError)
      const deliveryErrors: unknown[] = []

      await transport.receive(response(version, pending.id)).catch((error) => {
        deliveryErrors.push(error)
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(write).toHaveBeenCalledExactlyOnceWith(metadata)
      const expected = expectedError(pending.id, BeaconErrorType.UNKNOWN_ERROR)
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expected })
      await expect(pending.outcome).resolves.toEqual({ error: expected })
      expect(deliveryErrors).toEqual([])
      expect(failed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ errorResponse: expected }),
        expect.any(Array)
      )
      expect(succeeded).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
      expect(await dapp.getAccounts()).toEqual([])
      expect(dapp['requestTracker'].size).toBe(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(closed).not.toHaveBeenCalled()
    }
  )

  it.each(['2', '3'] as const)(
    'keeps the V%s request timeout when response metadata later fails',
    async (version) => {
      await start(25)
      const pending = await request(version)
      const write = vi
        .spyOn(dapp['appMetadataManager'], 'addAppMetadata')
        .mockImplementationOnce(async () => {
          await release.promise
          throw new Error('Metadata write failed')
        })
      const delivery = transport.receive(response(version, pending.id)).catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(write).toHaveBeenCalledExactlyOnceWith(metadata)
      expect(pending.settled).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(25)
      const expected = expectedError(pending.id, BeaconErrorType.PEER_UNREACHABLE)
      await expect(pending.outcome).resolves.toEqual({ error: expected })
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expected })
      expect(closed).toHaveBeenCalledTimes(1)

      release.resolve()
      await delivery
      await vi.advanceTimersByTimeAsync(1000)
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expected })
      expect(failed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ errorResponse: expected }),
        expect.any(Array)
      )
      expect(succeeded).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
      expect(await dapp.getAccounts()).toEqual([])
      expect(dapp['requestTracker'].size).toBe(0)
      expect(closed).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['2', '3'] as const)(
    'keeps the V%s request abort when response metadata later fails',
    async (version) => {
      await start(25)
      const pending = await request(version)
      const write = vi
        .spyOn(dapp['appMetadataManager'], 'addAppMetadata')
        .mockImplementationOnce(async () => {
          await release.promise
          throw new Error('Metadata write failed')
        })
      const delivery = transport.receive(response(version, pending.id)).catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(write).toHaveBeenCalledExactlyOnceWith(metadata)
      expect(pending.settled).not.toHaveBeenCalled()

      await dapp.disconnect({ notifyPeers: false })
      const expected = expectedError(pending.id, BeaconErrorType.ABORTED_ERROR)
      await expect(pending.outcome).resolves.toEqual({ error: expected })
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expected })
      changed.mockClear()

      release.resolve()
      await delivery
      await vi.advanceTimersByTimeAsync(1000)
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expected })
      expect(failed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ errorResponse: expected }),
        expect.any(Array)
      )
      expect(succeeded).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
      expect(await dapp.getAccounts()).toEqual([])
      expect(dapp['requestTracker'].size).toBe(0)
      expect(closed).not.toHaveBeenCalled()
    }
  )
})
