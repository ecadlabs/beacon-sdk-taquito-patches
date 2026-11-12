import {
  CommunicationClient,
  LocalStorage,
  PeerManager,
  Serializer,
  Transport
} from '@ecadlabs/beacon-core'
import {
  AccountInfo,
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
  PermissionRequestV3,
  StorageKey,
  StorageKeyReturnType,
  TransportType
} from '@ecadlabs/beacon-types'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { BeaconEvent } from '../../src/events'
import { DappPostMessageTransport } from '../../src/transports/DappPostMessageTransport'

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
      'Permission lifetime',
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
const accountIdentifier = 'response-account'
const partialAccounts = [
  { accountId: accountIdentifier, address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', publicKey }
]
const previous: AccountInfo = {
  accountIdentifier,
  senderId: peer.senderId,
  origin: { type: connectionInfo.origin, id: connectionInfo.id },
  address: partialAccounts[0].address,
  publicKey,
  network: { type: NetworkType.MAINNET },
  scopes: [PermissionScope.OPERATION_REQUEST],
  connectedAt: 1,
  walletType: 'implicit'
}

type Boundary =
  | 'account info'
  | 'account write'
  | 'active selection'
  | 'callback wallet info'
  | 'response callback'
  | 'success wallet info'

class PausedStorage extends LocalStorage {
  beforeWrite: (key: StorageKey) => Promise<void> = async () => {}

  override async set<K extends StorageKey>(key: K, value: StorageKeyReturnType[K]): Promise<void> {
    await this.beforeWrite(key)
    await super.set(key, value)
  }
}

describe('V3 permission response lifetime', () => {
  let dapp: DAppClient
  let transport: ControlledTransport
  let storage: PausedStorage
  let release: ExposedPromise<void>
  let reached: boolean
  let resumeFailure: boolean
  let responseStarted: boolean
  let walletReads: number
  const failed = vi.fn()
  const succeeded = vi.fn()
  const changed = vi.fn()
  const callback = vi.fn<Blockchain['handleResponse']>()
  let blockchain: Blockchain

  beforeEach(async () => {
    vi.useFakeTimers()
    localStorage.clear()
    Object.defineProperty(window, 'beaconCreatedClientInstance', {
      value: false,
      writable: true,
      configurable: true
    })
    release = new ExposedPromise<void>()
    reached = false
    resumeFailure = false
    responseStarted = false
    walletReads = 0
    storage = new PausedStorage('permission-response-v3')
    transport = new ControlledTransport(storage)
    dapp = new DAppClient({
      name: 'Permission lifetime',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      requestTimeoutMs: 0
    })
    await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, changed)
    await dapp.subscribeToEvent(BeaconEvent.PERMISSION_REQUEST_ERROR, failed)
    await dapp.subscribeToEvent(BeaconEvent.PERMISSION_REQUEST_SUCCESS, succeeded)
    await dapp.getActiveAccount()
    await transport.addPeer(peer)
    await transport.connect()
    await dapp.init(transport)
    dapp['resolveActivePeer'](peer)
    // A supplied transport handles the wire; account selection needs no additional adapters.
    vi.spyOn(dapp, 'initInternalTransports').mockResolvedValue(undefined)
    callback.mockResolvedValue(undefined)
    blockchain = {
      identifier: 'tezos',
      async validateRequest() {},
      handleResponse: callback,
      async getWalletLists() {
        return { extensionList: [], desktopList: [], webList: [], iOSList: [] }
      },
      async getAccountInfosFromPermissionResponse() {
        responseStarted = true
        return partialAccounts
      }
    }
    dapp.addBlockchain(blockchain)
    vi.clearAllMocks()
  })

  afterEach(async () => {
    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await dapp.destroy()
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function hold() {
    reached = true
    await release.promise
    if (resumeFailure) {
      throw new Error('Deferred response work failed')
    }
  }

  function pauseAt(boundary: Boundary) {
    let paused = false
    if (boundary === 'account info') {
      blockchain.getAccountInfosFromPermissionResponse = async () => {
        responseStarted = true
        await hold()
        return partialAccounts
      }
    } else if (boundary === 'account write' || boundary === 'active selection') {
      const target = boundary === 'account write' ? StorageKey.ACCOUNTS : StorageKey.ACTIVE_ACCOUNT
      storage.beforeWrite = async (key) => {
        if (key === target && !paused) {
          paused = true
          await hold()
        }
      }
    } else if (boundary === 'response callback') {
      callback.mockImplementationOnce(hold)
    } else {
      const getWalletInfo = dapp['getWalletInfo'].bind(dapp)
      dapp['getWalletInfo'] = async (...args) => {
        if (responseStarted) {
          walletReads++
          const target = boundary === 'callback wallet info' ? 1 : 2
          if (walletReads === target) {
            await hold()
          }
        }
        return getWalletInfo(...args)
      }
    }
  }

  async function begin(responseChain = 'tezos', responseScopes: unknown = [PermissionScope.SIGN]) {
    const settled = vi.fn()
    const outcome = dapp
      .permissionRequest({
        type: BeaconMessageType.PermissionRequest,
        blockchainIdentifier: 'tezos',
        blockchainData: {
          appMetadata: { senderId: 'dapp', name: 'Permission lifetime' },
          scopes: [PermissionScope.SIGN]
        }
      })
      .then(
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
    const sent: unknown = await new Serializer().deserialize(await transport.sent)
    if (!sent || typeof sent !== 'object' || !('id' in sent) || typeof sent.id !== 'string') {
      throw new Error('Missing request ID')
    }
    const message = {
      type: BeaconMessageType.PermissionResponse,
      blockchainIdentifier: responseChain,
      blockchainData: { appMetadata: metadata, scopes: responseScopes }
    }
    await transport.receive({ id: sent.id, senderId: peer.senderId, version: '3', message })
    await vi.advanceTimersByTimeAsync(0)
    return { id: sent.id, message, settled, outcome }
  }

  function aborted(id: string) {
    return {
      id,
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.ABORTED_ERROR,
      senderId: '',
      version: '2',
      errorOrigin: 'local'
    }
  }

  it.each<Boundary>([
    'account info',
    'account write',
    'active selection',
    'callback wallet info',
    'response callback',
    'success wallet info'
  ])(
    'settles on disconnect while %s remains pending and ignores its later completion',
    async (boundary) => {
      pauseAt(boundary)
      const pending = await begin()
      expect(reached).toBe(true)
      expect(pending.settled).not.toHaveBeenCalled()
      const callbacksBeforeDisconnect = callback.mock.calls.length
      const disconnect = dapp.disconnect({ notifyPeers: false })
      await vi.advanceTimersByTimeAsync(0)
      expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining(aborted(pending.id)) })
      expect
        .soft(failed)
        .toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ errorResponse: aborted(pending.id) }),
          expect.any(Array)
        )
      changed.mockClear()

      release.resolve()
      await disconnect
      await vi.advanceTimersByTimeAsync(0)
      expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining(aborted(pending.id)) })
      expect.soft(succeeded).not.toHaveBeenCalled()
      expect
        .soft(failed)
        .toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ errorResponse: aborted(pending.id) }),
          expect.any(Array)
        )
      expect.soft(callback).toHaveBeenCalledTimes(callbacksBeforeDisconnect)
      expect.soft(changed.mock.calls.filter(([account]) => account !== undefined)).toEqual([])
      expect.soft(await dapp.getActiveAccount()).toBeUndefined()
    }
  )

  it.each<Boundary>(['account info', 'account write', 'response callback'])(
    'keeps the abort outcome when deferred %s later rejects',
    async (boundary) => {
      pauseAt(boundary)
      const pending = await begin()
      expect(reached).toBe(true)
      const disconnect = dapp.disconnect({ notifyPeers: false })
      await vi.advanceTimersByTimeAsync(0)
      expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining(aborted(pending.id)) })
      resumeFailure = true
      release.resolve()
      await disconnect
      await vi.advanceTimersByTimeAsync(0)
      expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining(aborted(pending.id)) })
      expect
        .soft(failed)
        .toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ errorResponse: aborted(pending.id) }),
          expect.any(Array)
        )
      expect(succeeded).not.toHaveBeenCalled()
    }
  )

  it('preserves the prior account snapshot when selection changes during its replacement write', async () => {
    await storage.set(StorageKey.ACCOUNTS, [previous])
    pauseAt('account write')
    const pending = await begin()
    expect(reached).toBe(true)
    const selection = dapp.setActiveAccount(undefined)
    await vi.advanceTimersByTimeAsync(0)
    release.resolve()
    await selection
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(await dapp.getAccounts()).toEqual([previous])
    expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining(aborted(pending.id)) })
    expect(succeeded).not.toHaveBeenCalled()
  })

  it('orders account rollback before a queued removal', async () => {
    await storage.set(StorageKey.ACCOUNTS, [previous])
    pauseAt('account write')
    const pending = await begin()
    expect(reached).toBe(true)
    const disconnect = dapp.disconnect({ notifyPeers: false })
    const removal = dapp.removeAccount(previous.accountIdentifier)
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining(aborted(pending.id)) })
    release.resolve()
    await Promise.all([disconnect, removal])
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(await dapp.getAccounts()).toEqual([])
    expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining(aborted(pending.id)) })
    expect(succeeded).not.toHaveBeenCalled()
  })

  it('removes a new account when disconnect interrupts its first write', async () => {
    pauseAt('account write')
    const pending = await begin()
    expect(reached).toBe(true)
    const disconnect = dapp.disconnect({ notifyPeers: false })
    await vi.advanceTimersByTimeAsync(0)
    release.resolve()
    await disconnect
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(await dapp.getAccounts()).toEqual([])
    expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining(aborted(pending.id)) })
    expect(succeeded).not.toHaveBeenCalled()
  })

  it('keeps an unrelated account selection when account information arrives later', async () => {
    await storage.set(StorageKey.ACCOUNTS, [previous])
    pauseAt('account info')
    const pending = await begin()
    expect(reached).toBe(true)
    await dapp.setActiveAccount(previous)
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining(aborted(pending.id)) })
    changed.mockClear()
    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(await dapp.getAccounts()).toEqual([previous])
    expect.soft(await dapp.getActiveAccount()).toEqual(previous)
    expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining(aborted(pending.id)) })
    expect.soft(changed).not.toHaveBeenCalled()
    expect.soft(callback).not.toHaveBeenCalled()
    expect(succeeded).not.toHaveBeenCalled()
  })

  it('persists and selects its account without aborting its own request', async () => {
    const pending = await begin()
    await expect(pending.outcome).resolves.toEqual({ value: pending.message })
    expect(pending.settled).toHaveBeenCalledExactlyOnceWith({ value: pending.message })
    expect(await dapp.getAccounts()).toEqual([
      expect.objectContaining({ accountIdentifier, scopes: [PermissionScope.SIGN] })
    ])
    expect(await dapp.getActiveAccount()).toEqual(expect.objectContaining({ accountIdentifier }))
    expect(callback).toHaveBeenCalledTimes(1)
    expect(succeeded).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
  })

  it('keeps a completed permission result when disconnect follows success', async () => {
    const pending = await begin()
    await expect(pending.outcome).resolves.toEqual({ value: pending.message })
    await dapp.disconnect({ notifyPeers: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(pending.settled).toHaveBeenCalledExactlyOnceWith({ value: pending.message })
    expect(succeeded).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
    expect(await dapp.getActiveAccount()).toBeUndefined()
  })

  it('persists a chain-owned account and emits the original wrapped permission response', async () => {
    const pending = await begin()
    await expect(pending.outcome).resolves.toEqual({ value: pending.message })
    const account = await dapp.getActiveAccount()
    expect(account).toEqual({
      accountIdentifier,
      senderId: peer.senderId,
      origin: { type: connectionInfo.origin, id: connectionInfo.id },
      address: partialAccounts[0].address,
      publicKey,
      scopes: [PermissionScope.SIGN],
      connectedAt: expect.any(Number),
      chainData: pending.message.blockchainData,
      blockchainIdentifier: 'tezos'
    })
    expect(await dapp.getAccounts()).toEqual([account])
    expect(callback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ account }))
    expect(succeeded).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        protocolVersion: '3',
        account,
        output: { id: pending.id, senderId: peer.senderId, version: '3', message: pending.message }
      }),
      undefined
    )
  })

  it.each([
    ['wrong blockchain', 'another-chain', [PermissionScope.SIGN]],
    ['non-string scopes', 'tezos', [PermissionScope.SIGN, 7]]
  ])('rejects %s before adapter dispatch or account persistence', async (_label, chain, scopes) => {
    const accounts = vi.spyOn(blockchain, 'getAccountInfosFromPermissionResponse')
    const pending = await begin(chain, scopes)
    await expect(pending.outcome).resolves.toEqual({ error: expect.any(Error) })
    expect(accounts).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
    expect(succeeded).not.toHaveBeenCalled()
    expect(await dapp.getAccounts()).toEqual([])
    expect(await dapp.getActiveAccount()).toBeUndefined()
  })

  it('snapshots wallet grants before adapter awaits and isolates the returned response', async () => {
    blockchain.getAccountInfosFromPermissionResponse = async (response) => {
      await Promise.resolve()
      response.blockchainIdentifier = 'mutated-chain'
      response.blockchainData.scopes.push('injected-scope')
      return partialAccounts
    }
    callback.mockImplementationOnce(async (input) => {
      input.request.type = BeaconMessageType.OperationRequest
      input.request.blockchainIdentifier = 'mutated-callback-chain'
      if ('chainData' in input.account) {
        input.account.scopes.push('injected-account-scope')
        const chainData = input.account.chainData
        if (
          chainData !== null &&
          typeof chainData === 'object' &&
          'scopes' in chainData &&
          Array.isArray(chainData.scopes)
        ) {
          chainData.scopes.push('injected-chain-scope')
        }
      }
      if ('blockchainData' in input.output.message) {
        input.output.message.blockchainData = { scopes: ['second-injection'] }
      }
    })
    const pending = await begin()
    await expect.soft(pending.outcome).resolves.toEqual({ value: pending.message })
    expect(succeeded).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        protocolVersion: '3',
        output: { id: pending.id, senderId: peer.senderId, version: '3', message: pending.message }
      }),
      undefined
    )
    expect(await dapp.getActiveAccount()).toEqual(
      expect.objectContaining({
        scopes: [PermissionScope.SIGN],
        blockchainIdentifier: 'tezos',
        chainData: pending.message.blockchainData
      })
    )
  })

  it('rejects an empty blockchain account list before persisting or selecting an account', async () => {
    blockchain.getAccountInfosFromPermissionResponse = async () => []
    const pending = await begin()
    await expect(pending.outcome).resolves.toEqual({
      error: new Error('No accounts returned by blockchain "tezos"')
    })
    expect(await dapp.getAccounts()).toEqual([])
    expect(await dapp.getActiveAccount()).toBeUndefined()
    expect(callback).not.toHaveBeenCalled()
    expect(succeeded).not.toHaveBeenCalled()
  })

  it('keeps the V3 result when a success observer clears the account', async () => {
    let clear: Promise<void> | undefined
    await dapp.subscribeToEvent(BeaconEvent.PERMISSION_REQUEST_SUCCESS, () => {
      clear = dapp.clearActiveAccount()
    })
    const pending = await begin()
    expect(clear).toBeDefined()
    await clear
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ value: pending.message })
    await expect.soft(pending.outcome).resolves.toEqual({ value: pending.message })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(succeeded).toHaveBeenCalledTimes(1)
    expect.soft(failed).not.toHaveBeenCalled()
    expect(await dapp.getActiveAccount()).toBeUndefined()
  })

  it('aborts before account storage drains when all accounts are removed', async () => {
    pauseAt('account write')
    const pending = await begin()
    expect(reached).toBe(true)
    const removal = dapp.removeAllAccounts()
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining(aborted(pending.id)) })
    expect
      .soft(failed)
      .toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ errorResponse: aborted(pending.id) }),
        expect.any(Array)
      )
    release.resolve()
    await removal
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining(aborted(pending.id)) })
    expect
      .soft(failed)
      .toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ errorResponse: aborted(pending.id) }),
        expect.any(Array)
      )
    expect(await dapp.getAccounts()).toEqual([])
    expect(await dapp.getActiveAccount()).toBeUndefined()
    expect(succeeded).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
  })

  it('keeps the selecting transport when an overlapping permission request is revoked', async () => {
    const adapter = new DappPostMessageTransport(
      'Permission lifetime',
      await getKeypairFromSeed('permission-lifetime-v3'),
      storage
    )
    vi.spyOn(adapter, 'connect').mockResolvedValue(undefined)
    vi.spyOn(adapter, 'disconnect').mockResolvedValue(undefined)
    dapp['postMessageTransport'] = adapter
    const sends = vi.spyOn(transport, 'send')
    const input: PermissionRequestV3 = {
      type: BeaconMessageType.PermissionRequest,
      blockchainIdentifier: 'tezos',
      blockchainData: {
        appMetadata: { senderId: 'dapp', name: 'Permission lifetime' },
        scopes: [PermissionScope.SIGN]
      }
    }
    const first = dapp.permissionRequest(input).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(sends).toHaveBeenCalledTimes(1)
    const second = dapp.permissionRequest(input).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(sends).toHaveBeenCalledTimes(2)
    const sent: unknown = await new Serializer().deserialize(sends.mock.calls[0][0])
    const other: unknown = await new Serializer().deserialize(sends.mock.calls[1][0])
    if (
      !sent ||
      typeof sent !== 'object' ||
      !('id' in sent) ||
      typeof sent.id !== 'string' ||
      !other ||
      typeof other !== 'object' ||
      !('id' in other) ||
      typeof other.id !== 'string'
    ) {
      throw new Error('Missing request IDs')
    }
    const message: PermissionResponseV3 = {
      type: BeaconMessageType.PermissionResponse,
      blockchainIdentifier: 'tezos',
      blockchainData: { appMetadata: metadata, scopes: [PermissionScope.SIGN] }
    }
    await transport.receive({
      id: sent.id,
      senderId: peer.senderId,
      version: '3',
      message
    })
    await vi.advanceTimersByTimeAsync(0)
    await expect(first).resolves.toEqual({ value: message })
    await expect(second).resolves.toEqual({ error: expect.objectContaining(aborted(other.id)) })
    expect(await dapp.getActiveAccount()).toEqual(expect.objectContaining({ accountIdentifier }))
    expect(succeeded).toHaveBeenCalledTimes(1)
    expect(failed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ errorResponse: aborted(other.id) }),
      expect.any(Array)
    )
    expect.soft(dapp['postMessageTransport']).toBe(adapter)
    expect.soft(await dapp['transport']).toBe(adapter)
  })
})
