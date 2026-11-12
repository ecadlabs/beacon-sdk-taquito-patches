// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  BeaconError,
  CommunicationClient,
  LocalStorage,
  PeerManager,
  Serializer,
  Transport,
  AbortedBeaconError,
  NoAddressBeaconError,
  NotGrantedBeaconError,
  ParametersInvalidBeaconError,
  PeerUnreachableBeaconError,
  TransactionInvalidBeaconError,
  UnknownBeaconError
} from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessageType,
  ConnectionContext,
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
  public readonly type = TransportType.P2P
  constructor(storage: LocalStorage) {
    super(
      'Typed errors test',
      new ControlledClient(),
      new PeerManager(storage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
    )
  }
  async listen(): Promise<void> {}
}

const peer: ExtendedPostMessagePairingResponse = {
  id: 'test-peer-id',
  type: 'postmessage-pairing-response',
  name: 'Test Wallet',
  publicKey: '11'.repeat(32),
  senderId: 'wallet-sender',
  extensionId: 'test-extension',
  version: '2'
}

const context: ConnectionContext = { origin: Origin.P2P, id: peer.publicKey }

const account: AccountInfo = {
  accountIdentifier: 'test-account-id',
  senderId: peer.senderId,
  origin: { type: Origin.P2P, id: peer.publicKey },
  address: 'tz1testaddress123456789',
  network: { type: NetworkType.MAINNET },
  scopes: [PermissionScope.OPERATION_REQUEST, PermissionScope.SIGN],
  connectedAt: 1,
  walletType: 'implicit'
}

describe('DAppClient typed error rejections', () => {
  let dapp: DAppClient
  let transport: ControlledTransport

  async function createClient(requestTimeoutMs: number = 0): Promise<DAppClient> {
    const storage = new LocalStorage('dapp-client-typed-errors')
    transport = new ControlledTransport(storage)
    const client = new DAppClient({
      name: 'Typed errors test',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      requestTimeoutMs
    })

    await client.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    await client.getActiveAccount()
    await client.init(transport as unknown as Transport<PeerInfoType>)
    client['resolveActivePeer'](peer)
    vi.spyOn(client, 'getActiveAccount').mockResolvedValue(account)
    vi.spyOn(client, 'getPeer').mockResolvedValue(peer)
    vi.spyOn(client, 'checkPermissions').mockResolvedValue(true)
    client['tryToAppSwitch'] = async () => {}
    vi.spyOn(transport, 'send').mockResolvedValue(undefined)

    return client
  }

  async function getLastSentRequestId(): Promise<string> {
    const calls = vi.mocked(transport.send).mock.calls
    const lastCall = calls[calls.length - 1]
    const deserialized = (await new Serializer().deserialize(lastCall[0])) as { id: string }
    return deserialized.id
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    localStorage.clear()
    Object.defineProperty(window, 'beaconCreatedClientInstance', {
      value: false,
      writable: true,
      configurable: true
    })
    dapp = await createClient(0)
  })

  afterEach(async () => {
    await dapp?.destroy()
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  describe('wallet error response rejections', () => {
    it('rejects with NotGrantedBeaconError when wallet replies with NOT_GRANTED_ERROR and keeps event errorResponse plain', async () => {
      const onOperationError = vi.fn()
      await dapp.subscribeToEvent(BeaconEvent.OPERATION_REQUEST_ERROR, onOperationError)

      const errorPromise = dapp.requestOperation({
        operationDetails: []
      }).then(
        () => { throw new Error('Expected requestOperation to reject') },
        (err: unknown) => err
      )
      await vi.advanceTimersByTimeAsync(0)
      const requestId = await getLastSentRequestId()

      await (dapp as any).handleResponse(
        {
          type: BeaconMessageType.Error,
          id: requestId,
          senderId: 'wallet-sender',
          version: '2',
          errorType: BeaconErrorType.NOT_GRANTED_ERROR
        },
        context
      )

      const error: any = await errorPromise

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(NotGrantedBeaconError)
      expect(error.id).toBe(requestId)
      expect(error.senderId).toBe('wallet-sender')
      expect(error.errorType).toBe(BeaconErrorType.NOT_GRANTED_ERROR)
      expect(error.errorOrigin).toBe('wallet')

      expect(onOperationError).toHaveBeenCalledTimes(1)
      const emittedErrorResponse = onOperationError.mock.calls[0][0].errorResponse
      expect(emittedErrorResponse).not.toBeInstanceOf(Error)
      expect(emittedErrorResponse).toEqual({
        type: BeaconMessageType.Error,
        id: requestId,
        senderId: 'wallet-sender',
        version: '2',
        errorType: BeaconErrorType.NOT_GRANTED_ERROR,
        errorOrigin: 'wallet'
      })
    })

    it('rejects with TransactionInvalidBeaconError carrying errorData when wallet replies with TRANSACTION_INVALID_ERROR', async () => {
      const rpcErrorData = [{ kind: 'temporary', id: 'proto.michelson_v1.runtime_exhausted' }]
      const errorPromise = dapp.requestOperation({
        operationDetails: []
      }).then(
        () => { throw new Error('Expected requestOperation to reject') },
        (err: unknown) => err
      )
      await vi.advanceTimersByTimeAsync(0)
      const requestId = await getLastSentRequestId()

      await (dapp as any).handleResponse(
        {
          type: BeaconMessageType.Error,
          id: requestId,
          senderId: 'wallet-sender',
          version: '2',
          errorType: BeaconErrorType.TRANSACTION_INVALID_ERROR,
          errorData: rpcErrorData
        },
        context
      )

      const error: any = await errorPromise

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(TransactionInvalidBeaconError)
      expect(error.id).toBe(requestId)
      expect(error.senderId).toBe('wallet-sender')
      expect(error.errorType).toBe(BeaconErrorType.TRANSACTION_INVALID_ERROR)
      expect(error.errorOrigin).toBe('wallet')
      expect(error.errorData).toEqual(rpcErrorData)
    })
  })

  describe('timeout rejection', () => {
    it('rejects with PeerUnreachableBeaconError on request timeout', async () => {
      await dapp.destroy()
      dapp = await createClient(100)

      const errorPromise = dapp.requestOperation({
        operationDetails: []
      }).then(
        () => { throw new Error('Expected requestOperation to reject') },
        (err: unknown) => err
      )
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(100)

      const error: any = await errorPromise

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(PeerUnreachableBeaconError)
      expect(error.errorType).toBe(BeaconErrorType.PEER_UNREACHABLE)
      expect(error.errorOrigin).toBe('local')
    })
  })

  describe('aborted request via disconnect()', () => {
    it('rejects with AbortedBeaconError when pending request is aborted via disconnect()', async () => {
      const errorPromise = dapp.requestOperation({
        operationDetails: []
      }).then(
        () => { throw new Error('Expected requestOperation to reject') },
        (err: unknown) => err
      )
      await vi.advanceTimersByTimeAsync(0)

      await dapp.disconnect()

      const error: any = await errorPromise

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(AbortedBeaconError)
      expect(error.errorType).toBe(BeaconErrorType.ABORTED_ERROR)
      expect(error.errorOrigin).toBe('local')
    })
  })

  describe('local precondition failures', () => {
    it('rejects with NoAddressBeaconError when requesting operation without active account', async () => {
      vi.spyOn(dapp, 'getActiveAccount').mockResolvedValueOnce(undefined)

      const error: any = await dapp.requestOperation({
        operationDetails: []
      }).then(
        () => { throw new Error('Expected requestOperation to reject') },
        (err: unknown) => err
      )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(NoAddressBeaconError)
      expect(error.errorType).toBe(BeaconErrorType.NO_ADDRESS_ERROR)
      expect(error.errorOrigin).toBe('local')
    })

    it('rejects with NotGrantedBeaconError when checkPermissions returns false without emitting OPERATION_REQUEST_ERROR', async () => {
      const onOperationError = vi.fn()
      const onNoPermissions = vi.fn()
      await dapp.subscribeToEvent(BeaconEvent.OPERATION_REQUEST_ERROR, onOperationError)
      await dapp.subscribeToEvent(BeaconEvent.NO_PERMISSIONS, onNoPermissions)
      vi.spyOn(dapp, 'checkPermissions').mockResolvedValue(false)

      const error: any = await dapp.requestOperation({
        operationDetails: []
      }).then(
        () => { throw new Error('Expected requestOperation to reject') },
        (err: unknown) => err
      )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(NotGrantedBeaconError)
      expect(error.errorType).toBe(BeaconErrorType.NOT_GRANTED_ERROR)
      expect(error.errorOrigin).toBe('local')
      expect(onNoPermissions).toHaveBeenCalledTimes(1)
      expect(onOperationError).not.toHaveBeenCalled()
    })

    it('rejects with UnknownBeaconError when local rate limit is reached without emitting OPERATION_REQUEST_ERROR', async () => {
      const onOperationError = vi.fn()
      const onRateLimit = vi.fn()
      await dapp.subscribeToEvent(BeaconEvent.OPERATION_REQUEST_ERROR, onOperationError)
      await dapp.subscribeToEvent(BeaconEvent.LOCAL_RATE_LIMIT_REACHED, onRateLimit)
      vi.spyOn(dapp as any, 'addRequestAndCheckIfRateLimited').mockResolvedValue(true)

      const error: any = await dapp.requestOperation({
        operationDetails: []
      }).then(
        () => { throw new Error('Expected requestOperation to reject') },
        (err: unknown) => err
      )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(UnknownBeaconError)
      expect(error.errorType).toBe(BeaconErrorType.UNKNOWN_ERROR)
      expect(error.errorOrigin).toBe('local')
      expect(onRateLimit).toHaveBeenCalledTimes(1)
      expect(onOperationError).not.toHaveBeenCalled()
    })

    it('rejects with ParametersInvalidBeaconError when sign payload does not start with 03 prefix for OPERATION', async () => {
      const error: any = await dapp.requestSignPayload({
        signingType: SigningType.OPERATION,
        payload: 'deadbeef'
      }).then(
        () => { throw new Error('Expected requestSignPayload to reject') },
        (err: unknown) => err
      )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(ParametersInvalidBeaconError)
      expect(error.errorType).toBe(BeaconErrorType.PARAMETERS_INVALID_ERROR)
      expect(error.errorOrigin).toBe('local')
    })
  })
})
