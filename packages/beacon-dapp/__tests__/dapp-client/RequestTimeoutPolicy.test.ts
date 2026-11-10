import {
  CommunicationClient,
  getSenderId,
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
  BlockchainMessage,
  ConnectionContext,
  ExtendedP2PPairingResponse,
  ExtendedPostMessagePairingResponse,
  NetworkType,
  Origin,
  PeerInfoType,
  PermissionScope,
  SigningType,
  StorageKey,
  TransportType
} from '@ecadlabs/beacon-types'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { BeaconEvent } from '../../src/events'

// Request deadline policy, local error attribution and late-response reporting over a
// message transport (P2P). WalletConnect delivers responses through its own request
// bookkeeping and is covered in WalletConnectRequestLifetime.test.ts. Multi-tab routing is
// covered in DelegatedRequestLifetime.test.ts and FollowerRouteOwnership.test.ts.
//
// Background: the dApp's request deadline is local. Beacon has no cancel message, so when
// the deadline fires the wallet still holds the request and can sign or inject it later.
// Mobile wallets behind P2P only see a request once the app is foregrounded, so a 60 s
// default deadline fires while users are still approving. A retry after that can pay twice.
//
// Policy under test:
// - With no requestTimeoutMs configured, only permission requests get the 60 s deadline.
//   Operation, sign, broadcast and proof-of-event requests wait for the wallet.
// - An explicitly configured requestTimeoutMs applies to every request type. Zero or a
//   negative value disables the deadline for every request type.
// - Every rejection says whether the wallet sent it (`origin: 'wallet'`) or the dApp
//   produced it (`origin: 'local'`). A wallet cannot mark its own error as local.
// - A wallet response to a timed-out non-permission request is reported once through
//   LATE_RESPONSE_RECEIVED instead of being dropped. Late permission responses are not
//   reported: they carry no funds, and a timed-out first pairing resets the transport and
//   active peer, so there is nothing reliable to attach them to. The dApp keeps at most
//   LATE_RESPONSE_RETENTION timed-out request IDs and forgets them on disconnect, peer
//   removal and destroy.

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

const DEFAULT_PERMISSION_DEADLINE_MS = 60_000
// Long enough that any surviving 60 s default would have fired several times over.
const TEN_MINUTES_MS = 600_000
const LATE_RESPONSE_RETENTION = 100

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
  public readonly type = TransportType.P2P
  constructor(storage: LocalStorage) {
    super(
      'Timeout policy test',
      new ControlledClient(),
      new PeerManager(storage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
    )
  }
  async listen(): Promise<void> {}
  async receive(message: WalletMessage) {
    await this.notifyListeners(await new Serializer().serialize(message), context)
  }
}

type WalletMessage = BeaconMessage | BeaconMessageWrapper<BlockchainMessage>
type Outcome = { value: unknown } | { error: unknown }

const peer: ExtendedPostMessagePairingResponse = {
  id: 'timeout-peer',
  type: 'postmessage-pairing-response',
  name: 'Timeout wallet',
  publicKey: '22'.repeat(32),
  senderId: 'wallet-sender',
  extensionId: 'timeout-extension',
  version: '3'
}
const context: ConnectionContext = { origin: Origin.P2P, id: peer.publicKey }
const network = { type: NetworkType.MAINNET }
const appMetadata = { senderId: 'dapp-sender', name: 'Timeout policy test' }
const contractAddress = 'KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton'
const account: AccountInfo = {
  accountIdentifier: 'timeout-account',
  senderId: peer.senderId,
  origin: { type: Origin.P2P, id: peer.publicKey },
  address: 'tz1TGu6TN5GSez2ndXXeDX6LgUDvLzPLqgYV',
  network,
  scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST],
  connectedAt: 1,
  walletType: 'implicit'
}

type RequestKind =
  'permission' | 'sign' | 'operation' | 'broadcast' | 'proof of event' | 'simulated proof of event'
type RequestCase = { kind: RequestKind; version: '2' | '3' }
const permissionCases: RequestCase[] = [
  { kind: 'permission', version: '2' },
  { kind: 'permission', version: '3' }
]
const nonPermissionCases: RequestCase[] = [
  { kind: 'sign', version: '2' },
  { kind: 'operation', version: '2' },
  { kind: 'broadcast', version: '2' },
  { kind: 'proof of event', version: '2' },
  { kind: 'simulated proof of event', version: '2' },
  { kind: 'sign', version: '3' },
  { kind: 'operation', version: '3' }
]
const allCases = [...permissionCases, ...nonPermissionCases]
const operation: RequestCase = { kind: 'operation', version: '2' }

function requestType({ kind, version }: RequestCase): BeaconMessageType {
  if (version === '3' && kind !== 'permission') {
    return BeaconMessageType.BlockchainRequest
  }
  switch (kind) {
    case 'permission':
      return BeaconMessageType.PermissionRequest
    case 'sign':
      return BeaconMessageType.SignPayloadRequest
    case 'operation':
      return BeaconMessageType.OperationRequest
    case 'broadcast':
      return BeaconMessageType.BroadcastRequest
    case 'proof of event':
      return BeaconMessageType.ProofOfEventChallengeRequest
    case 'simulated proof of event':
      return BeaconMessageType.SimulatedProofOfEventChallengeRequest
  }
}

describe('Request timeout policy', () => {
  let dapp: DAppClient
  let transport: ControlledTransport
  const closed = vi.fn()
  const late = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    Object.defineProperty(window, 'beaconCreatedClientInstance', {
      value: false,
      writable: true,
      configurable: true
    })
  })
  afterEach(async () => {
    await dapp?.destroy()
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function start(requestTimeoutMs?: number, activePeer: PeerInfoType = peer) {
    const storage = new LocalStorage('timeout-policy')
    transport = new ControlledTransport(storage)
    dapp = new DAppClient({
      name: 'Timeout policy test',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      // Omitted in the default-policy tests: the default is what is under test.
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs })
    })
    await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    await dapp.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, closed)
    // Handlers get (payload, buttons); record the payload only.
    await dapp.subscribeToEvent(BeaconEvent.LATE_RESPONSE_RECEIVED, (info) => late(info))
    await dapp.getActiveAccount()
    // The public init signature uses the full peer union; this fixture has no pairing callback.
    await dapp.init(transport as unknown as Transport<PeerInfoType>)
    dapp['resolveActivePeer'](activePeer)
    vi.spyOn(dapp, 'checkPermissions').mockResolvedValue(true)
    dapp['tryToAppSwitch'] = async () => {}
    vi.spyOn(transport, 'send').mockResolvedValue(undefined)
    vi.clearAllMocks()
  }

  async function sentId(): Promise<string> {
    const calls = vi.mocked(transport.send).mock.calls
    const decoded: unknown = await new Serializer().deserialize(calls[calls.length - 1][0])
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      !('id' in decoded) ||
      typeof decoded.id !== 'string'
    ) {
      throw new Error('Missing dispatch ID')
    }
    return decoded.id
  }

  async function dispatch(request: RequestCase) {
    const sends = vi.mocked(transport.send).mock.calls.length
    const pending = request.version === '2' ? dispatchV2(request.kind) : dispatchV3(request.kind)
    const settled = vi.fn()
    const outcome: Promise<Outcome> = pending.then(
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
    expect(vi.mocked(transport.send).mock.calls).toHaveLength(sends + 1)
    return { settled, outcome, id: await sentId() }
  }

  function dispatchV2(kind: RequestKind) {
    switch (kind) {
      case 'permission':
        return dapp['makeRequest']({
          type: BeaconMessageType.PermissionRequest,
          appMetadata,
          network,
          scopes: [PermissionScope.OPERATION_REQUEST]
        })
      case 'sign':
        return dapp['makeRequest']({
          type: BeaconMessageType.SignPayloadRequest,
          signingType: SigningType.RAW,
          payload: 'aa',
          sourceAddress: account.address
        })
      case 'operation':
        return dapp['makeRequest']({
          type: BeaconMessageType.OperationRequest,
          network,
          operationDetails: [],
          sourceAddress: account.address
        })
      case 'broadcast':
        return dapp['makeRequest']({
          type: BeaconMessageType.BroadcastRequest,
          network,
          signedTransaction: 'aa'
        })
      case 'proof of event':
        return dapp['makeRequest']({
          type: BeaconMessageType.ProofOfEventChallengeRequest,
          payload: 'challenge',
          contractAddress
        })
      case 'simulated proof of event':
        return dapp['makeRequest']({
          type: BeaconMessageType.SimulatedProofOfEventChallengeRequest,
          payload: 'challenge',
          contractAddress
        })
    }
  }

  function dispatchV3(kind: RequestKind) {
    switch (kind) {
      case 'permission':
        return dapp['makeRequestV3']({
          type: BeaconMessageType.PermissionRequest,
          blockchainIdentifier: 'tezos',
          blockchainData: { appMetadata, scopes: ['sign'] }
        })
      case 'sign':
      case 'operation':
        return dapp['makeRequestV3']({
          type: BeaconMessageType.BlockchainRequest,
          blockchainIdentifier: 'tezos',
          accountId: account.accountIdentifier,
          blockchainData: { type: kind === 'sign' ? 'sign' : 'operation', scope: kind }
        })
      default:
        throw new Error(`No V3 ${kind} request`)
    }
  }

  function successResponse({ kind, version }: RequestCase, id: string): WalletMessage {
    if (version === '3') {
      return {
        id,
        version,
        senderId: peer.senderId,
        message: {
          type:
            kind === 'permission'
              ? BeaconMessageType.PermissionResponse
              : BeaconMessageType.BlockchainResponse,
          blockchainIdentifier: 'tezos',
          blockchainData:
            kind === 'permission'
              ? { appMetadata, scopes: ['sign'], accounts: [] }
              : kind === 'sign'
                ? { signature: 'late-signature' }
                : { transactionHash: 'ooLateHash' }
        }
      }
    }
    const envelope = { id, version, senderId: peer.senderId }
    switch (kind) {
      case 'permission':
        return {
          ...envelope,
          type: BeaconMessageType.PermissionResponse,
          walletType: 'implicit',
          appMetadata,
          publicKey: 'edpk-late',
          network,
          scopes: [PermissionScope.OPERATION_REQUEST]
        }
      case 'sign':
        return {
          ...envelope,
          type: BeaconMessageType.SignPayloadResponse,
          signingType: SigningType.RAW,
          signature: 'late-signature'
        }
      case 'operation':
        return { ...envelope, type: BeaconMessageType.OperationResponse, transactionHash: 'ooLate' }
      case 'broadcast':
        return { ...envelope, type: BeaconMessageType.BroadcastResponse, transactionHash: 'ooLate' }
      case 'proof of event':
        return {
          ...envelope,
          type: BeaconMessageType.ProofOfEventChallengeResponse,
          payloadHash: 'late-payload-hash',
          isAccepted: true
        }
      case 'simulated proof of event':
        return {
          ...envelope,
          type: BeaconMessageType.SimulatedProofOfEventChallengeResponse,
          operationsList: 'W10=',
          errorMessage: ''
        }
    }
  }

  function walletError(id: string, extra: Record<string, unknown> = {}): WalletMessage {
    return {
      id,
      version: '2',
      senderId: peer.senderId,
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.ABORTED_ERROR,
      ...extra
    }
  }

  function acknowledge(id: string): WalletMessage {
    return { id, version: '2', senderId: peer.senderId, type: BeaconMessageType.Acknowledge }
  }

  async function timeOut(request: RequestCase, timeoutMs: number) {
    const pending = await dispatch(request)
    await vi.advanceTimersByTimeAsync(timeoutMs)
    expect(await pending.outcome).toEqual({
      error: expect.objectContaining({ errorType: BeaconErrorType.PEER_UNREACHABLE })
    })
    return pending
  }

  describe('deadline', () => {
    it.each(permissionCases)(
      'times out a V$version $kind request after 60 s by default',
      async (request) => {
        await start()
        const pending = await dispatch(request)

        await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_DEADLINE_MS - 1)
        expect(pending.settled).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(1)
        expect(await pending.outcome).toEqual({
          error: expect.objectContaining({
            id: pending.id,
            type: BeaconMessageType.Error,
            errorType: BeaconErrorType.PEER_UNREACHABLE,
            origin: 'local'
          })
        })
        expect(closed).toHaveBeenCalledTimes(1)
      }
    )

    it.each(nonPermissionCases)(
      'keeps a V$version $kind request open past 60 s by default',
      async (request) => {
        await start()
        const pending = await dispatch(request)

        await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS)
        expect(pending.settled).not.toHaveBeenCalled()
        expect(closed).not.toHaveBeenCalled()

        // The slow wallet's answer still reaches the caller.
        await transport.receive(successResponse(request, pending.id))
        await vi.advanceTimersByTimeAsync(0)
        expect(await pending.outcome).toEqual({ value: expect.anything() })
        expect(pending.settled).toHaveBeenCalledTimes(1)
        expect(late).not.toHaveBeenCalled()
      }
    )

    it.each(allCases.flatMap((request) => [0, -1].map((timeoutMs) => ({ ...request, timeoutMs }))))(
      'never times out a V$version $kind request when requestTimeoutMs is $timeoutMs',
      async ({ timeoutMs, ...request }) => {
        await start(timeoutMs)
        const pending = await dispatch(request)

        await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS)
        expect(pending.settled).not.toHaveBeenCalled()
      }
    )

    it.each(allCases)(
      'applies an explicit requestTimeoutMs to a V$version $kind request',
      async (request) => {
        await start(25)
        const pending = await dispatch(request)

        await vi.advanceTimersByTimeAsync(24)
        expect(pending.settled).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(await pending.outcome).toEqual({
          error: expect.objectContaining({
            errorType: BeaconErrorType.PEER_UNREACHABLE,
            origin: 'local'
          })
        })
      }
    )

    it.each(permissionCases)(
      'uses an explicit requestTimeoutMs longer than 60 s for a V$version $kind request',
      async (request) => {
        await start(120_000)
        const pending = await dispatch(request)

        await vi.advanceTimersByTimeAsync(119_999)
        expect(pending.settled).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(pending.settled).toHaveBeenCalledTimes(1)
      }
    )
  })

  describe('error origin', () => {
    it('marks an error the wallet sent as origin wallet', async () => {
      await start(25)
      const pending = await dispatch(operation)

      await transport.receive(walletError(pending.id))
      await vi.advanceTimersByTimeAsync(0)

      expect(await pending.outcome).toEqual({
        error: expect.objectContaining({
          errorType: BeaconErrorType.ABORTED_ERROR,
          senderId: peer.senderId,
          origin: 'wallet'
        })
      })
    })

    it('does not let a wallet error mark itself as local', async () => {
      await start(25)
      const pending = await dispatch(operation)

      await transport.receive(
        walletError(pending.id, { errorType: BeaconErrorType.PEER_UNREACHABLE, origin: 'local' })
      )
      await vi.advanceTimersByTimeAsync(0)

      expect(await pending.outcome).toEqual({
        error: expect.objectContaining({
          errorType: BeaconErrorType.PEER_UNREACHABLE,
          origin: 'wallet'
        })
      })
    })

    it('marks a dApp-side abort as origin local', async () => {
      await start()
      const pending = await dispatch(operation)

      await dapp.disconnect({ notifyPeers: false })
      await vi.advanceTimersByTimeAsync(0)

      expect(await pending.outcome).toEqual({
        error: expect.objectContaining({
          errorType: BeaconErrorType.ABORTED_ERROR,
          origin: 'local'
        })
      })
    })

    it.each([
      ['a timeout', 'local'],
      ['a wallet error', 'wallet']
    ] as const)(
      'passes the origin of %s through the public API and its error event',
      async (ending, origin) => {
        await start(25)
        vi.spyOn(dapp, 'getActiveAccount').mockResolvedValue(account)
        const errorEvent = vi.fn()
        await dapp.subscribeToEvent(BeaconEvent.SIGN_REQUEST_ERROR, (data) => errorEvent(data))

        const outcome = dapp
          .requestSignPayload({ payload: 'aa', signingType: SigningType.RAW })
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error })
          )
        await vi.advanceTimersByTimeAsync(0)
        if (ending === 'a timeout') await vi.advanceTimersByTimeAsync(25)
        else await transport.receive(walletError(await sentId()))
        await vi.advanceTimersByTimeAsync(0)

        expect(await outcome).toEqual({ error: expect.objectContaining({ origin }) })
        expect(errorEvent).toHaveBeenCalledWith(
          expect.objectContaining({ errorResponse: expect.objectContaining({ origin }) })
        )
      }
    )
  })

  describe('late responses', () => {
    it.each(nonPermissionCases)(
      'reports a V$version $kind response that arrives after the deadline',
      async (request) => {
        await start(25)
        const pending = await timeOut(request, 25)
        const timedOut = await pending.outcome

        const message = successResponse(request, pending.id)
        await transport.receive(message)
        await vi.advanceTimersByTimeAsync(0)

        expect(late).toHaveBeenCalledExactlyOnceWith({
          requestId: pending.id,
          requestType: requestType(request),
          message,
          connectionInfo: context,
          walletInfo: expect.objectContaining({ name: peer.name })
        })
        // The caller already got its answer; the late response does not settle it again.
        expect(pending.settled).toHaveBeenCalledTimes(1)
        expect(await pending.outcome).toEqual(timedOut)
      }
    )

    it.each(permissionCases)(
      'does not report a V$version $kind response that arrives after the deadline',
      async (request) => {
        await start(25)
        const pending = await timeOut(request, 25)

        await transport.receive(successResponse(request, pending.id))
        await vi.advanceTimersByTimeAsync(0)

        expect(late).not.toHaveBeenCalled()
        expect(pending.settled).toHaveBeenCalledTimes(1)
      }
    )

    it('reports a late wallet error, so the dApp learns the request is dead', async () => {
      await start(25)
      const pending = await timeOut(operation, 25)

      const message = walletError(pending.id)
      await transport.receive(message)
      await vi.advanceTimersByTimeAsync(0)

      expect(late).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ requestId: pending.id, message })
      )
    })

    it('does not report a late acknowledge', async () => {
      await start(25)
      const pending = await timeOut(operation, 25)

      await transport.receive(acknowledge(pending.id))
      await vi.advanceTimersByTimeAsync(0)

      expect(late).not.toHaveBeenCalled()
    })

    it('reports an acknowledge followed by a response once, for the response', async () => {
      await start(25)
      const pending = await timeOut(operation, 25)

      await transport.receive(acknowledge(pending.id))
      const message = successResponse(operation, pending.id)
      await transport.receive(message)
      await vi.advanceTimersByTimeAsync(0)

      expect(late).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message }))
    })

    // Concurrent delivery: the timed-out entry must be consumed before any await, or both
    // copies pass the lookup while wallet details are still loading.
    it('reports concurrently duplicated late responses once', async () => {
      await start(25)
      const pending = await timeOut(operation, 25)

      await Promise.all([
        transport.receive(successResponse(operation, pending.id)),
        transport.receive(successResponse(operation, pending.id))
      ])
      await vi.advanceTimersByTimeAsync(0)

      expect(late).toHaveBeenCalledTimes(1)
    })

    it('does not report a response for a request it never sent', async () => {
      await start(25)
      await transport.receive(successResponse(operation, 'never-sent'))
      await vi.advanceTimersByTimeAsync(0)

      expect(late).not.toHaveBeenCalled()
    })

    it('does not report a response for a request the dApp aborted', async () => {
      await start(25)
      const pending = await dispatch(operation)
      await dapp.disconnect({ notifyPeers: false })
      await vi.advanceTimersByTimeAsync(0)
      expect(await pending.outcome).toEqual({
        error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
      })

      await transport.receive(successResponse(operation, pending.id))
      await vi.advanceTimersByTimeAsync(0)

      expect(late).not.toHaveBeenCalled()
    })

    it.each([
      ['disconnect', () => dapp.disconnect({ notifyPeers: false })],
      ['removeAllPeers', () => dapp.removeAllPeers()],
      ['removePeer', () => dapp.removePeer(peer)],
      ['destroy', () => dapp.destroy()]
    ] as const)('forgets timed-out requests on %s', async (_lifecycle, forget) => {
      await start(25)
      const pending = await timeOut(operation, 25)

      await forget()
      await transport.receive(successResponse(operation, pending.id))
      await vi.advanceTimersByTimeAsync(0)

      expect(late).not.toHaveBeenCalled()
    })

    // Timed-out requests belong to the wallet they were sent to. Removing some other stored
    // peer must not discard them.
    it('keeps timed-out requests when an unrelated peer is removed', async () => {
      await start(25)
      const pending = await timeOut(operation, 25)

      const otherPeer: ExtendedPostMessagePairingResponse = {
        ...peer,
        id: 'other-peer',
        publicKey: '33'.repeat(32),
        senderId: 'other-sender',
        extensionId: 'other-extension'
      }
      await dapp.removePeer(otherPeer)
      await transport.receive(successResponse(operation, pending.id))
      await vi.advanceTimersByTimeAsync(0)

      expect(late).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ requestId: pending.id })
      )
    })

    // The wallet's Disconnect clears the active account and peer before cleanup finishes, so the
    // timed-out requests must be matched to the wallet they were sent to, not the current peer.
    it('forgets timed-out requests when that wallet disconnects', async () => {
      const p2pPeer: ExtendedP2PPairingResponse = {
        id: 'p2p-peer',
        type: 'p2p-pairing-response',
        name: 'P2P wallet',
        publicKey: peer.publicKey,
        senderId: await getSenderId(peer.publicKey),
        version: '3',
        relayServer: 'relay.example'
      }
      await start(25, p2pPeer)
      const pending = await timeOut(operation, 25)

      await transport.receive({
        id: 'wallet-disconnect',
        version: '2',
        senderId: p2pPeer.senderId,
        type: BeaconMessageType.Disconnect
      })
      await vi.advanceTimersByTimeAsync(0)
      await transport.receive(successResponse(operation, pending.id))
      await vi.advanceTimersByTimeAsync(0)

      expect(late).not.toHaveBeenCalled()
    })

    it(`keeps only the ${LATE_RESPONSE_RETENTION} most recent timed-out requests`, async () => {
      await start(25)
      // The client allows two requests per 5 s; lift it so 101 requests can time out together.
      vi.spyOn(dapp, 'addRequestAndCheckIfRateLimited').mockResolvedValue(false)
      const ids: string[] = []
      for (let index = 0; index <= LATE_RESPONSE_RETENTION; index++) {
        ids.push((await dispatch(operation)).id)
      }
      await vi.advanceTimersByTimeAsync(25)

      await transport.receive(successResponse(operation, ids[0]))
      await vi.advanceTimersByTimeAsync(0)
      expect(late).not.toHaveBeenCalled()

      await transport.receive(successResponse(operation, ids[1]))
      await vi.advanceTimersByTimeAsync(0)
      expect(late).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: ids[1] }))
    })
  })
})
