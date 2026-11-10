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
  BlockchainResponseV3,
  ConnectionContext,
  ExtendedPostMessagePairingResponse,
  ExtendedWalletConnectPairingResponse,
  NetworkType,
  Origin,
  PeerInfoType,
  SigningType,
  StorageKey,
  TransportType
} from '@ecadlabs/beacon-types'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { WalletConnectTransport } from '@ecadlabs/beacon-transport-walletconnect'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { BeaconEvent } from '../../src/events'

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

class ControlledClient extends CommunicationClient {
  async sendMessage(): Promise<void> {}
  async unsubscribeFromEncryptedMessages(): Promise<void> {}
  async unsubscribeFromEncryptedMessage(): Promise<void> {}
}
class ControlledTransport extends Transport<
  PeerInfoType,
  StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP,
  ControlledClient
> {
  constructor(
    storage: LocalStorage,
    public readonly type: TransportType
  ) {
    super(
      'Dispatch test',
      new ControlledClient(),
      new PeerManager(storage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
    )
  }
  async listen(): Promise<void> {}
  async receive(
    message: BeaconMessage | BeaconMessageWrapper<BlockchainResponseV3>,
    context: ConnectionContext
  ) {
    await this.notifyListeners(await new Serializer().serialize(message), context)
  }
}
class ControlledWalletConnectTransport extends WalletConnectTransport<
  ExtendedWalletConnectPairingResponse,
  StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP
> {
  async receive(
    message: BeaconMessage | BeaconMessageWrapper<BlockchainResponseV3>,
    context: ConnectionContext
  ) {
    await this.notifyListeners(await new Serializer().serialize(message), context)
  }
}
const peer: ExtendedPostMessagePairingResponse = {
  id: 'dispatch-peer',
  type: 'postmessage-pairing-response',
  name: 'Dispatch wallet',
  publicKey: '11'.repeat(32),
  senderId: 'wallet-sender',
  extensionId: 'dispatch-extension',
  version: '3'
}
const versions = ['2', '3'] as const
const transports = [
  TransportType.POST_MESSAGE,
  TransportType.P2P,
  TransportType.WALLETCONNECT
] as const
const cases = transports.flatMap((transport) => versions.map((version) => ({ transport, version })))

// The dispatch boundary separates transport completion from caller completion.
// Permission and account wrappers are covered by their own public API suites.
describe('Request dispatch lifetime', () => {
  let dapp: DAppClient
  let transport: ControlledTransport | ControlledWalletConnectTransport
  let release: ExposedPromise<void>
  let context: ConnectionContext
  const sent = vi.fn()
  const internalError = vi.fn()
  const closed = vi.fn()
  const switchApp = vi.fn(async () => {})

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    Object.defineProperty(window, 'beaconCreatedClientInstance', {
      value: false,
      writable: true,
      configurable: true
    })
    release = new ExposedPromise<void>()
  })
  afterEach(async () => {
    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await dapp?.destroy()
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  async function start(type: TransportType, requestTimeoutMs: number) {
    const storage = new LocalStorage('dispatch-lifetime')
    context = {
      origin:
        type === TransportType.WALLETCONNECT
          ? Origin.WALLETCONNECT
          : type === TransportType.P2P
            ? Origin.P2P
            : Origin.EXTENSION,
      id: 'dispatch-peer'
    }
    transport =
      type === TransportType.WALLETCONNECT
        ? new ControlledWalletConnectTransport(
            'Dispatch test',
            await getKeypairFromSeed('dispatch-test'),
            storage,
            StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP,
            { network: NetworkType.MAINNET, opts: { projectId: 'offline' } },
            async () => true
          )
        : new ControlledTransport(storage, type)
    if (transport instanceof ControlledWalletConnectTransport) {
      vi.spyOn(transport, 'disconnect').mockResolvedValue(undefined)
      vi.spyOn(transport, 'cancelRequest').mockImplementation(() => {})
    }
    dapp = new DAppClient({
      name: 'Dispatch test',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      requestTimeoutMs
    })
    await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    await dapp.subscribeToEvent(BeaconEvent.SIGN_REQUEST_SENT, sent)
    await dapp.subscribeToEvent(BeaconEvent.OPERATION_REQUEST_SENT, sent)
    await dapp.subscribeToEvent(BeaconEvent.INTERNAL_ERROR, internalError)
    await dapp.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, closed)
    await dapp.getActiveAccount()
    // The public init signature uses the full peer union; this fixture has no pairing callback.
    await dapp.init(transport as unknown as Transport<PeerInfoType>)
    dapp['resolveActivePeer'](peer)
    vi.spyOn(dapp, 'checkPermissions').mockResolvedValue(true)
    dapp['tryToAppSwitch'] = switchApp
    vi.clearAllMocks()
  }
  function response(
    version: '2' | '3',
    id: string
  ): BeaconMessage | BeaconMessageWrapper<BlockchainResponseV3> {
    return version === '2'
      ? {
          id,
          version,
          senderId: peer.senderId,
          type: BeaconMessageType.SignPayloadResponse,
          signingType: SigningType.RAW,
          signature: 'request-signature'
        }
      : {
          id,
          version,
          senderId: peer.senderId,
          message: {
            type: BeaconMessageType.BlockchainResponse,
            blockchainIdentifier: 'tezos',
            blockchainData: { signature: 'request-signature' }
          }
        }
  }
  function dispatch(version: '2' | '3', duringSend?: (id: string) => Promise<void>) {
    let id = ''
    const send = vi.spyOn(transport, 'send').mockImplementation(async (encoded) => {
      const decoded: unknown = await new Serializer().deserialize(encoded)
      if (
        !decoded ||
        typeof decoded !== 'object' ||
        !('id' in decoded) ||
        typeof decoded.id !== 'string'
      )
        throw new Error('Missing dispatch ID')
      id = decoded.id
      // The baseline does not observe this rejection until send returns.
      // Observe it here so RED measures caller settlement, not unhandled rejection.
      const baselineRequests: unknown = Reflect.get(dapp, 'openRequests')
      if (baselineRequests instanceof Map) {
        const baselineRequest: unknown = baselineRequests.get(id)
        if (baselineRequest instanceof ExposedPromise) {
          void baselineRequest.promise.catch(() => undefined)
        }
      }
      await duringSend?.(id)
      await release.promise
    })
    const pending =
      version === '2'
        ? dapp['makeRequest']({
            type: BeaconMessageType.SignPayloadRequest,
            signingType: SigningType.RAW,
            payload: 'aa'
          })
        : dapp['makeRequestV3']({
            type: BeaconMessageType.BlockchainRequest,
            blockchainIdentifier: 'tezos',
            accountId: 'dispatch-account',
            blockchainData: { type: 'sign', scope: 'sign' }
          })
    const settled = vi.fn()
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
    return { send, settled, outcome, id: () => id }
  }
  function expectedError(id: string, errorType: BeaconErrorType) {
    return {
      error: {
        id,
        type: BeaconMessageType.Error,
        errorType,
        senderId: '',
        version: '2',
        errorOrigin: 'local'
      }
    }
  }

  it.each(cases)(
    'settles V$version $transport timeout before send completes and ignores its later completion',
    async ({ version, transport: type }) => {
      await start(type, 25)
      const pending = dispatch(version)
      await vi.advanceTimersByTimeAsync(0)
      expect(pending.send).toHaveBeenCalledTimes(1)
      expect(pending.id()).not.toBe('')
      await vi.advanceTimersByTimeAsync(25)
      const expected = expectedError(pending.id(), BeaconErrorType.PEER_UNREACHABLE)
      expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith(expected)
      expect(closed).toHaveBeenCalledTimes(1)
      release.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(await pending.outcome).toEqual(expected)
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith(expected)
      expect.soft(sent).not.toHaveBeenCalled()
      expect.soft(switchApp).not.toHaveBeenCalled()
      expect(internalError).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1000)
      expect(closed).toHaveBeenCalledTimes(1)
    }
  )

  it.each(cases)(
    'settles V$version $transport abort while send is pending and ignores its late failure',
    async ({ version, transport: type }) => {
      await start(type, 0)
      const pending = dispatch(version)
      await vi.advanceTimersByTimeAsync(0)
      expect(pending.send).toHaveBeenCalledTimes(1)
      await dapp.disconnect({ notifyPeers: false })
      await vi.advanceTimersByTimeAsync(0)
      const expected = expectedError(pending.id(), BeaconErrorType.ABORTED_ERROR)
      expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith(expected)
      release.reject(new Error('Send completed after disconnect'))
      await vi.advanceTimersByTimeAsync(0)
      expect.soft(await pending.outcome).toEqual(expected)
      expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith(expected)
      expect(sent).not.toHaveBeenCalled()
      expect(switchApp).not.toHaveBeenCalled()
      expect.soft(internalError).not.toHaveBeenCalled()
      expect(closed).not.toHaveBeenCalled()
    }
  )

  it.each(cases)(
    'settles V$version $transport response delivered during send and ignores its late failure',
    async ({ version, transport: type }) => {
      await start(type, 25)
      const pending = dispatch(version, async (id) =>
        transport.receive(response(version, id), context)
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(pending.send).toHaveBeenCalledTimes(1)
      const expected = {
        value: { message: response(version, pending.id()), connectionInfo: context }
      }
      expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith(expected)
      release.reject(new Error('Send completed after response'))
      await vi.advanceTimersByTimeAsync(0)
      expect.soft(await pending.outcome).toEqual(expected)
      expect.soft(pending.settled).toHaveBeenCalledExactlyOnceWith(expected)
      expect(sent).not.toHaveBeenCalled()
      expect(switchApp).not.toHaveBeenCalled()
      expect.soft(internalError).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1000)
      expect(closed).not.toHaveBeenCalled()
    }
  )

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'keeps a request pending without a finite positive deadline (%s)',
    async (timeout) => {
      await start(TransportType.POST_MESSAGE, timeout)
      const pending = dispatch('2')
      await vi.advanceTimersByTimeAsync(0)
      expect(pending.send).toHaveBeenCalledTimes(1)
      release.resolve()
      await vi.advanceTimersByTimeAsync(100_000)
      expect(pending.settled).not.toHaveBeenCalled()
      expect(closed).not.toHaveBeenCalled()
      await transport.receive(response('2', pending.id()), context)
      await vi.advanceTimersByTimeAsync(0)
      expect(pending.settled).toHaveBeenCalledExactlyOnceWith({
        value: { message: response('2', pending.id()), connectionInfo: context }
      })
      expect(internalError).not.toHaveBeenCalled()
    }
  )

  it.each(transports)('keeps %s skipResponse completion tied to send', async (type) => {
    await start(type, 25)
    const send = vi.spyOn(transport, 'send').mockImplementation(async () => release.promise)
    const settled = vi.fn()
    const pending = dapp['makeRequest'](
      { type: BeaconMessageType.SignPayloadRequest, signingType: SigningType.RAW, payload: 'aa' },
      true
    ).then(settled)
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).toHaveBeenCalledTimes(1)
    expect(settled).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
    release.resolve()
    await pending
    expect(settled).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(switchApp).toHaveBeenCalledTimes(1)
    expect(internalError).not.toHaveBeenCalled()
  })
})
