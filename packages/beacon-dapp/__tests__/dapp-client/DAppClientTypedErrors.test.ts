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
  UnknownBeaconError,
  isBeaconError,
  getAccountIdentifier
} from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessageType,
  BlockchainRequestV3,
  ConnectionContext,
  ExtendedPostMessagePairingResponse,
  NetworkType,
  Origin,
  PeerInfoType,
  PermissionRequestV3,
  PermissionScope,
  RequestPermissionInput,
  isRequestErrorResponse,
  SigningType,
  StorageKey,
  TransportType
} from '@ecadlabs/beacon-types'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { BeaconEvent } from '../../src/events'
import { toBeaconError } from '../../src/dapp-client/request-error'

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
  async receive(message: unknown): Promise<void> {
    await this.notifyListeners(await new Serializer().serialize(message), context)
  }
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
  let storage: LocalStorage

  async function createClient(requestTimeoutMs: number = 0): Promise<DAppClient> {
    storage = new LocalStorage('dapp-client-typed-errors')
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

  describe('complete public request error normalization', () => {
    const permissionInput: PermissionRequestV3 = {
      type: BeaconMessageType.PermissionRequest,
      blockchainIdentifier: 'typed-errors-chain',
      blockchainData: { appMetadata: { senderId: 'dapp', name: 'Test' }, scopes: [] }
    }
    const requestInput: BlockchainRequestV3 = {
      type: BeaconMessageType.BlockchainRequest,
      blockchainIdentifier: 'typed-errors-chain',
      accountId: account.accountIdentifier,
      blockchainData: { type: 'test', scope: 'test' }
    }

    function addBlockchain(validateRequest: () => Promise<void> = async () => {}) {
      dapp.addBlockchain({
        identifier: 'typed-errors-chain',
        validateRequest,
        async handleResponse() {},
        async getAccountInfosFromPermissionResponse() {
          return []
        },
        async getWalletLists() {
          return { extensionList: [], desktopList: [], webList: [], iOSList: [] }
        }
      })
    }

    it.each([
      'permission V2',
      'permission V3',
      'request V3',
      'operation',
      'sign',
      'broadcast',
      'proof',
      'simulated proof'
    ])(
      'normalizes unexpected pre-dispatch failures from %s while retaining diagnostic identity',
      async (method) => {
        const failure = new Error('pre-dispatch dependency failed')
        const operationErrors = vi.fn()
        await dapp.subscribeToEvent(BeaconEvent.OPERATION_REQUEST_ERROR, operationErrors)
        let pending: Promise<unknown>
        switch (method) {
          case 'permission V2':
            vi.spyOn(dapp, 'getOwnAppMetadata').mockRejectedValueOnce(failure)
            pending = dapp.requestPermissions()
            break
          case 'permission V3':
            addBlockchain()
            vi.spyOn(dapp, 'getOwnAppMetadata').mockRejectedValueOnce(failure)
            pending = dapp.permissionRequest(permissionInput)
            break
          case 'request V3':
            addBlockchain(async () => {
              throw failure
            })
            pending = dapp.request(requestInput)
            break
          case 'broadcast':
            pending = dapp.requestBroadcast({
              get signedTransaction(): string {
                throw failure
              }
            })
            break
          default:
            vi.spyOn(dapp, 'getActiveAccount').mockRejectedValueOnce(failure)
            pending =
              method === 'operation'
                ? dapp.requestOperation({ operationDetails: [] })
                : method === 'sign'
                  ? dapp.requestSignPayload({ payload: 'aa', signingType: SigningType.RAW })
                  : method === 'proof'
                    ? dapp.requestProofOfEventChallenge({ payload: 'challenge' })
                    : dapp.requestSimulatedProofOfEventChallenge({ payload: 'challenge' })
        }
        const error: unknown = await pending.catch((error: unknown) => error)
        expect(error).toBeInstanceOf(UnknownBeaconError)
        if (!isBeaconError(error)) throw new Error('Expected typed request rejection')
        expect(error.errorData).toBe(failure)
        expect(error.description).toBe(failure.message)
        expect(error.errorOrigin).toBe('local')
        expect(operationErrors).not.toHaveBeenCalled()
        expect(transport.send).not.toHaveBeenCalled()
      }
    )

    it.each([
      { label: 'missing' },
      { label: 'empty', code: '' },
      { label: 'numeric', code: 42 },
      { label: 'null', code: null }
    ])('retains a validator rejection with a $label error code', async (entry) => {
      const failure = {
        id: 'plugin-failure',
        senderId: '',
        version: '2',
        type: BeaconMessageType.Error,
        ...('code' in entry ? { errorType: entry.code } : {}),
        message: 'driver unavailable',
        detail: { component: 'plugin' }
      }
      addBlockchain(async () => {
        throw failure
      })
      const error: unknown = await dapp.request(requestInput).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(UnknownBeaconError)
      if (!isBeaconError(error)) throw new Error('Expected typed plugin rejection')
      expect(error.errorData).toBe(failure)
      expect(transport.send).not.toHaveBeenCalled()
    })

    it('retains a validator error whose message getter throws', async () => {
      const failure = new Error()
      Object.defineProperty(failure, 'message', {
        get() {
          throw new RangeError('unreadable message')
        }
      })
      addBlockchain(async () => {
        throw failure
      })
      const error: unknown = await dapp.request(requestInput).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(UnknownBeaconError)
      if (!isBeaconError(error)) throw new Error('Expected typed validator rejection')
      expect(error.errorData).toBe(failure)
      expect(error.errorOrigin).toBe('local')
      expect(transport.send).not.toHaveBeenCalled()
    })

    it('retains a revoked proxy rejection without inspecting its properties', async () => {
      const failure = Proxy.revocable({}, {})
      failure.revoke()
      addBlockchain(async () => {
        throw failure.proxy
      })
      const error: unknown = await dapp.request(requestInput).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(UnknownBeaconError)
      if (!isBeaconError(error)) throw new Error('Expected typed validator rejection')
      expect(error.errorData).toBe(failure.proxy)
      expect(error.errorOrigin).toBe('local')
      expect(transport.send).not.toHaveBeenCalled()
    })

    it('retains an uncloneable diagnostic by identity for a direct request', async () => {
      const failure = { message: 'storage read failed', retry() {} }
      vi.spyOn(dapp, 'getActiveAccount').mockRejectedValueOnce(failure)
      const error: unknown = await dapp
        .requestOperation({ operationDetails: [] })
        .catch((error: unknown) => error)
      if (!isBeaconError(error)) throw new Error('Expected direct request error')
      expect(error).toBeInstanceOf(UnknownBeaconError)
      expect(error.description).toBe(new UnknownBeaconError().description)
      expect(error.errorData).toBe(failure)
      expect(transport.send).not.toHaveBeenCalled()
    })

    it.each(['rate limit reached', 'No permissions to send this request to wallet!'])(
      'preserves unrelated V3 validator errors matching admission text: %s',
      async (message) => {
        const failure = new Error(message)
        const rateLimited = vi.fn()
        const denied = vi.fn()
        await dapp.subscribeToEvent(BeaconEvent.LOCAL_RATE_LIMIT_REACHED, rateLimited)
        await dapp.subscribeToEvent(BeaconEvent.NO_PERMISSIONS, denied)
        addBlockchain(async () => {
          throw failure
        })
        const error: unknown = await dapp.request(requestInput).catch((error: unknown) => error)
        expect(error).toBeInstanceOf(UnknownBeaconError)
        if (!isBeaconError(error)) throw new Error('Expected typed validator rejection')
        expect(error.errorData).toBe(failure)
        expect(error.errorOrigin).toBe('local')
        expect(denied).not.toHaveBeenCalled()
        expect(rateLimited).not.toHaveBeenCalled()
      }
    )

    it.each([undefined, null, 'raw rejection', { diagnostic: 'original object' }])(
      'retains non-Error rejection %j in errorData',
      async (failure) => {
        vi.spyOn(dapp, 'getActiveAccount').mockRejectedValueOnce(failure)
        const error: unknown = await dapp
          .requestOperation({ operationDetails: [] })
          .catch((error: unknown) => error)
        expect(error).toBeInstanceOf(UnknownBeaconError)
        if (!isBeaconError(error)) throw new Error('Expected typed request rejection')
        expect(error.errorData).toBe(failure)
      }
    )

    it('preserves an existing typed error instance from pre-dispatch code', async () => {
      const failure = new AbortedBeaconError({ id: 'original-id', errorOrigin: 'local' })
      vi.spyOn(dapp, 'getActiveAccount').mockRejectedValueOnce(failure)
      await expect(dapp.requestOperation({ operationDetails: [] })).rejects.toBe(failure)
    })

    it.each([{ scopes: undefined }, { scopes: ['valid', 42] }])(
      'types malformed V3 permission scopes $scopes through the public request',
      async ({ scopes }) => {
        addBlockchain()
        const pending = dapp.permissionRequest(permissionInput).catch((error: unknown) => error)
        await vi.advanceTimersByTimeAsync(0)
        const requestId = await getLastSentRequestId()
        await dapp['handleResponse'](
          {
            id: requestId,
            senderId: peer.senderId,
            version: '3',
            message: {
              type: BeaconMessageType.PermissionResponse,
              blockchainIdentifier: 'typed-errors-chain',
              blockchainData: { scopes }
            }
          },
          context
        )
        const error: unknown = await pending
        expect(error).toBeInstanceOf(ParametersInvalidBeaconError)
        if (!isBeaconError(error)) throw new Error('Expected typed malformed response rejection')
        expect(error.description).toBe('Invalid scopes in V3 permission response')
        expect(error.errorData).toEqual(scopes)
      }
    )

    it('types a mismatched V3 blockchain at the response boundary', async () => {
      addBlockchain()
      const pending = dapp.permissionRequest(permissionInput).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      const requestId = await getLastSentRequestId()
      await dapp['handleResponse'](
        {
          id: requestId,
          senderId: peer.senderId,
          version: '3',
          message: {
            type: BeaconMessageType.PermissionResponse,
            blockchainIdentifier: 'unexpected-chain',
            blockchainData: { scopes: [] }
          }
        },
        context
      )
      const error: unknown = await pending
      expect(error).toBeInstanceOf(ParametersInvalidBeaconError)
      if (!isBeaconError(error)) throw new Error('Expected typed malformed response rejection')
      expect(error.description).toBe('Unexpected blockchain in V3 permission response')
      expect(error.errorData).toBe('unexpected-chain')
      expect(error.errorOrigin).toBe('local')
    })

    it.each([
      'Invalid scopes in V3 permission response',
      'Unexpected blockchain in V3 permission response'
    ])('does not classify an unrelated failure by its message: %s', async (message) => {
      const failure = new Error(message)
      vi.spyOn(dapp, 'getActiveAccount').mockRejectedValueOnce(failure)
      const error: unknown = await dapp
        .requestOperation({ operationDetails: [] })
        .catch((error: unknown) => error)
      expect(error).toBeInstanceOf(UnknownBeaconError)
      if (!isBeaconError(error)) throw new Error('Expected typed dependency rejection')
      expect(error.errorData).toBe(failure)
    })

    it('normalizes a post-response dependency failure without replaying request-error side effects', async () => {
      const failure = new Error('wallet info failed after response')
      const operationErrors = vi.fn()
      await dapp.subscribeToEvent(BeaconEvent.OPERATION_REQUEST_ERROR, operationErrors)
      const pending = dapp
        .requestOperation({ operationDetails: [] })
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      const requestId = await getLastSentRequestId()
      vi.spyOn(dapp, 'getWalletInfo').mockRejectedValue(failure)
      await dapp['handleResponse'](
        {
          id: requestId,
          version: '2',
          senderId: peer.senderId,
          type: BeaconMessageType.OperationResponse,
          transactionHash: 'operation-hash'
        },
        context
      )
      const error: unknown = await pending
      expect(error).toBeInstanceOf(UnknownBeaconError)
      if (!isBeaconError(error)) throw new Error('Expected typed post-response rejection')
      expect(error.errorData).toBe(failure)
      expect(operationErrors).not.toHaveBeenCalled()
    })
  })

  describe('wallet error response rejections', () => {
    it.each(['2', '3'] as const)(
      'rejects a public V%s request when the wallet error omits senderId',
      async (version) => {
        const succeeded = vi.fn()
        const failed = vi.fn()
        const handleResponse = vi.fn()
        await dapp.subscribeToEvent(BeaconEvent.OPERATION_REQUEST_SUCCESS, succeeded)
        await dapp.subscribeToEvent(BeaconEvent.OPERATION_REQUEST_ERROR, failed)
        dapp.addBlockchain({
          identifier: 'senderless-chain',
          async validateRequest() {},
          handleResponse,
          async getAccountInfosFromPermissionResponse() {
            return []
          },
          async getWalletLists() {
            return { extensionList: [], desktopList: [], webList: [], iOSList: [] }
          }
        })
        const pending = (
          version === '2'
            ? dapp.requestOperation({ operationDetails: [] })
            : dapp.request({
                type: BeaconMessageType.BlockchainRequest,
                blockchainIdentifier: 'senderless-chain',
                accountId: account.accountIdentifier,
                blockchainData: { type: 'operation', scope: 'operation_request' }
              })
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        )
        await vi.advanceTimersByTimeAsync(0)
        const id = await getLastSentRequestId()
        const payload = {
          type: BeaconMessageType.Error,
          errorType: BeaconErrorType.NOT_GRANTED_ERROR,
          errorData: { detail: 'wallet declined' }
        }
        await transport.receive(
          version === '2' ? { id, version, ...payload } : { id, version, message: payload }
        )
        const outcome = await pending
        expect(outcome).toHaveProperty('error')
        if (!('error' in outcome) || !isBeaconError(outcome.error))
          throw new Error('Expected senderless wallet rejection')
        expect(outcome.error).toBeInstanceOf(NotGrantedBeaconError)
        expect(outcome.error).toMatchObject({
          id,
          version,
          senderId: '',
          errorOrigin: 'wallet',
          errorData: payload.errorData
        })
        expect(isRequestErrorResponse(outcome.error)).toBe(true)
        expect(succeeded).not.toHaveBeenCalled()
        expect(handleResponse).not.toHaveBeenCalled()
        if (version === '2') expect(failed).toHaveBeenCalledTimes(1)
        expect(dapp['requestTracker'].size).toBe(0)
      }
    )

    it('rejects with NotGrantedBeaconError when wallet replies with NOT_GRANTED_ERROR and keeps event errorResponse plain', async () => {
      const onOperationError = vi.fn()
      await dapp.subscribeToEvent(BeaconEvent.OPERATION_REQUEST_ERROR, onOperationError)

      const errorPromise = dapp
        .requestOperation({
          operationDetails: []
        })
        .then(
          () => {
            throw new Error('Expected requestOperation to reject')
          },
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

    it.each(['2', '3'] as const)(
      'keeps unfamiliar V%s wallet codes and diagnostics in plain events',
      async (version) => {
        const failed = vi.fn()
        const handleResponse = vi.fn(async () => {})
        await dapp.subscribeToEvent(BeaconEvent.OPERATION_REQUEST_ERROR, failed)
        dapp.addBlockchain({
          identifier: 'future-error-chain',
          async validateRequest() {},
          handleResponse,
          async getAccountInfosFromPermissionResponse() {
            return []
          },
          async getWalletLists() {
            return { extensionList: [], desktopList: [], webList: [], iOSList: [] }
          }
        })
        const pending = (
          version === '2'
            ? dapp.requestOperation({ operationDetails: [] })
            : dapp.request({
                type: BeaconMessageType.BlockchainRequest,
                blockchainIdentifier: 'future-error-chain',
                accountId: account.accountIdentifier,
                blockchainData: { type: 'operation', scope: 'operation_request' }
              })
        ).catch((error: unknown) => error)
        await vi.advanceTimersByTimeAsync(0)
        const id = await getLastSentRequestId()
        const payload = {
          type: BeaconMessageType.Error,
          errorType: 'FUTURE_WALLET_ERROR',
          errorData: { detail: 'wallet diagnostic' }
        }
        const header = { id, version, senderId: peer.senderId }
        const response =
          version === '2' ? { ...header, ...payload } : { ...header, message: payload }
        await dapp['handleResponse'](response, context)
        const error: unknown = await pending
        expect(error).toBeInstanceOf(UnknownBeaconError)
        if (!isBeaconError(error)) throw new Error('Expected typed unknown wallet rejection')
        expect(error).toMatchObject({
          ...header,
          errorOrigin: 'wallet',
          errorType: BeaconErrorType.UNKNOWN_ERROR
        })
        expect(error.errorData).toBe(payload.errorData)
        expect(handleResponse).not.toHaveBeenCalled()
        expect(failed).toHaveBeenCalledTimes(1)
        const event = failed.mock.calls[0][0].errorResponse
        expect(event).not.toBeInstanceOf(Error)
        expect(isRequestErrorResponse(event)).toBe(false)
        expect(event).toEqual({ ...header, ...payload, errorOrigin: 'wallet' })
        expect(event.errorData).toBe(payload.errorData)
        const normalized = toBeaconError(event)
        expect(normalized).toBeInstanceOf(UnknownBeaconError)
        expect(normalized).toMatchObject({ ...header, errorOrigin: 'wallet' })
        expect(normalized.errorData).toBe(payload.errorData)
      }
    )

    it('offers removal of only the requested account when the wallet cannot find its private key', async () => {
      const requested = {
        ...account,
        accountIdentifier: await getAccountIdentifier(account.address, account.network)
      }
      const otherNetwork = { type: NetworkType.SHADOWNET }
      const unrelated = {
        ...account,
        accountIdentifier: await getAccountIdentifier(account.address, otherNetwork),
        network: otherNetwork
      }
      await storage.set(StorageKey.ACCOUNTS, [requested, unrelated])
      vi.mocked(dapp.getActiveAccount).mockResolvedValue(requested)
      const failed = vi.fn()
      await dapp.subscribeToEvent(BeaconEvent.OPERATION_REQUEST_ERROR, failed)
      const outcome = dapp.requestOperation({ operationDetails: [] }).then(
        () => {
          throw new Error('Expected requestOperation to reject')
        },
        (error: unknown) => error
      )
      await vi.advanceTimersByTimeAsync(0)
      const id = await getLastSentRequestId()
      await transport.receive({
        id,
        version: '2',
        senderId: peer.senderId,
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR
      })

      const error = await outcome
      expect(isBeaconError(error)).toBe(true)
      expect(error).toMatchObject({ id, errorType: BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR })
      expect(failed).toHaveBeenCalledTimes(1)
      const [info, buttons] = failed.mock.calls[0]
      expect(info.errorResponse).not.toBeInstanceOf(Error)
      expect(info.errorResponse).toEqual({
        id,
        version: '2',
        senderId: peer.senderId,
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR,
        errorOrigin: 'wallet'
      })
      expect(buttons).toEqual([{ text: 'Remove account', actionCallback: expect.any(Function) }])
      expect(await dapp.getAccounts()).toEqual([requested, unrelated])
      await buttons[0].actionCallback()
      expect(await dapp.getAccounts()).toEqual([unrelated])
      expect(failed).toHaveBeenCalledTimes(1)
    })

    it('rejects with TransactionInvalidBeaconError carrying errorData when wallet replies with TRANSACTION_INVALID_ERROR', async () => {
      const rpcErrorData = [{ kind: 'temporary', id: 'proto.michelson_v1.runtime_exhausted' }]
      const errorPromise = dapp
        .requestOperation({
          operationDetails: []
        })
        .then(
          () => {
            throw new Error('Expected requestOperation to reject')
          },
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

      const errorPromise = dapp
        .requestOperation({
          operationDetails: []
        })
        .then(
          () => {
            throw new Error('Expected requestOperation to reject')
          },
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
      const errorPromise = dapp
        .requestOperation({
          operationDetails: []
        })
        .then(
          () => {
            throw new Error('Expected requestOperation to reject')
          },
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

      const error: any = await dapp
        .requestOperation({
          operationDetails: []
        })
        .then(
          () => {
            throw new Error('Expected requestOperation to reject')
          },
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

      const error: any = await dapp
        .requestOperation({
          operationDetails: []
        })
        .then(
          () => {
            throw new Error('Expected requestOperation to reject')
          },
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

      const error: any = await dapp
        .requestOperation({
          operationDetails: []
        })
        .then(
          () => {
            throw new Error('Expected requestOperation to reject')
          },
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

    it('rejects a rate-limited permission request before pairing starts', async () => {
      const init = vi.spyOn(dapp, 'init')
      await dapp.addRequestAndCheckIfRateLimited()
      await dapp.addRequestAndCheckIfRateLimited()

      const error: unknown = await dapp.requestPermissions().then(
        () => {
          throw new Error('Expected requestPermissions to reject')
        },
        (err: unknown) => err
      )

      expect(error).toBeInstanceOf(UnknownBeaconError)
      expect(init).not.toHaveBeenCalled()
    })

    it('rejects with ParametersInvalidBeaconError when sign payload does not start with 03 prefix for OPERATION', async () => {
      const error: any = await dapp
        .requestSignPayload({
          signingType: SigningType.OPERATION,
          payload: 'deadbeef'
        })
        .then(
          () => {
            throw new Error('Expected requestSignPayload to reject')
          },
          (err: unknown) => err
        )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(ParametersInvalidBeaconError)
      expect(error.errorType).toBe(BeaconErrorType.PARAMETERS_INVALID_ERROR)
      expect(error.errorOrigin).toBe('local')
    })

    it('rejects with ParametersInvalidBeaconError when sign payload is not a string', async () => {
      const error: any = await dapp
        .requestSignPayload({
          signingType: SigningType.RAW,
          payload: 123 as unknown as string
        })
        .then(
          () => {
            throw new Error('Expected requestSignPayload to reject')
          },
          (err: unknown) => err
        )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(ParametersInvalidBeaconError)
      expect(isBeaconError(error)).toBe(true)
      expect(error.id).toBe('')
      expect(error.senderId).toBe('')
      expect(error.version).toBe('2')
      expect(error.errorType).toBe(BeaconErrorType.PARAMETERS_INVALID_ERROR)
      expect(error.errorOrigin).toBe('local')
      expect(error.description).toBe('Payload must be a string')
    })

    it('rejects with ParametersInvalidBeaconError when deprecated network property is passed to requestPermissions', async () => {
      const error: any = await dapp
        .requestPermissions({
          network: { type: NetworkType.MAINNET }
        } as unknown as RequestPermissionInput)
        .then(
          () => {
            throw new Error('Expected requestPermissions to reject')
          },
          (err: unknown) => err
        )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(ParametersInvalidBeaconError)
      expect(isBeaconError(error)).toBe(true)
      expect(error.id).toBe('')
      expect(error.senderId).toBe('')
      expect(error.version).toBe('2')
      expect(error.errorType).toBe(BeaconErrorType.PARAMETERS_INVALID_ERROR)
      expect(error.errorOrigin).toBe('local')
      expect(error.description).toBe(
        '[BEACON] the "network" property is no longer accepted in input. Please provide it when instantiating DAppClient.'
      )
    })

    it('rejects with ParametersInvalidBeaconError when concurrent requestPermissions with different scopes is called', async () => {
      const firstPromise = dapp
        .requestPermissions({ scopes: [PermissionScope.SIGN] })
        .catch(() => {})

      const error: any = await dapp
        .requestPermissions({
          scopes: [PermissionScope.OPERATION_REQUEST]
        })
        .then(
          () => {
            throw new Error('Expected requestPermissions to reject')
          },
          (err: unknown) => err
        )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(ParametersInvalidBeaconError)
      expect(isBeaconError(error)).toBe(true)
      expect(error.id).toBe('')
      expect(error.senderId).toBe('')
      expect(error.version).toBe('2')
      expect(error.errorType).toBe(BeaconErrorType.PARAMETERS_INVALID_ERROR)
      expect(error.errorOrigin).toBe('local')
      expect(error.description).toBe(
        'Cannot start a permission request with different scopes while another permission request is pending'
      )

      await vi.advanceTimersByTimeAsync(0)
      await dapp.disconnect()
      await firstPromise
    })

    it('rejects with NoAddressBeaconError when requesting proof of event challenge without active account', async () => {
      vi.spyOn(dapp, 'getActiveAccount').mockResolvedValue(undefined)

      const error: any = await dapp.requestProofOfEventChallenge({ payload: 'test' }).then(
        () => {
          throw new Error('Expected requestProofOfEventChallenge to reject')
        },
        (err: unknown) => err
      )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(NoAddressBeaconError)
      expect(isBeaconError(error)).toBe(true)
      expect(error.id).toBe('')
      expect(error.senderId).toBe('')
      expect(error.version).toBe('2')
      expect(error.errorType).toBe(BeaconErrorType.NO_ADDRESS_ERROR)
      expect(error.errorOrigin).toBe('local')
      expect(error.description).toBe(
        'Please request permissions before doing a proof of event challenge'
      )
    })

    it('rejects with NoAddressBeaconError when requesting simulated proof of event challenge without active account', async () => {
      vi.spyOn(dapp, 'getActiveAccount').mockResolvedValue(undefined)

      const error: any = await dapp.requestSimulatedProofOfEventChallenge({ payload: 'test' }).then(
        () => {
          throw new Error('Expected requestSimulatedProofOfEventChallenge to reject')
        },
        (err: unknown) => err
      )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(NoAddressBeaconError)
      expect(isBeaconError(error)).toBe(true)
      expect(error.id).toBe('')
      expect(error.senderId).toBe('')
      expect(error.version).toBe('2')
      expect(error.errorType).toBe(BeaconErrorType.NO_ADDRESS_ERROR)
      expect(error.errorOrigin).toBe('local')
      expect(error.description).toBe(
        'Please request permissions before doing a proof of event challenge'
      )
    })

    it('rejects with NoAddressBeaconError when requesting proof of event challenge with active account missing network', async () => {
      vi.spyOn(dapp, 'getActiveAccount').mockResolvedValue({
        ...account,
        network: undefined
      } as unknown as AccountInfo)

      const error: any = await dapp.requestProofOfEventChallenge({ payload: 'test' }).then(
        () => {
          throw new Error('Expected requestProofOfEventChallenge to reject')
        },
        (err: unknown) => err
      )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(NoAddressBeaconError)
      expect(isBeaconError(error)).toBe(true)
      expect(error.id).toBe('')
      expect(error.senderId).toBe('')
      expect(error.version).toBe('2')
      expect(error.errorType).toBe(BeaconErrorType.NO_ADDRESS_ERROR)
      expect(error.errorOrigin).toBe('local')
      expect(error.description).toBe(
        'Please request permissions before doing a proof of event challenge'
      )
    })

    it('rejects with NoAddressBeaconError when requesting simulated proof of event challenge with active account missing network', async () => {
      vi.spyOn(dapp, 'getActiveAccount').mockResolvedValue({
        ...account,
        network: undefined
      } as unknown as AccountInfo)

      const error: any = await dapp.requestSimulatedProofOfEventChallenge({ payload: 'test' }).then(
        () => {
          throw new Error('Expected requestSimulatedProofOfEventChallenge to reject')
        },
        (err: unknown) => err
      )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(NoAddressBeaconError)
      expect(isBeaconError(error)).toBe(true)
      expect(error.id).toBe('')
      expect(error.senderId).toBe('')
      expect(error.version).toBe('2')
      expect(error.errorType).toBe(BeaconErrorType.NO_ADDRESS_ERROR)
      expect(error.errorOrigin).toBe('local')
      expect(error.description).toBe(
        'Please request permissions before doing a proof of event challenge'
      )
    })

    it('rejects with ParametersInvalidBeaconError when requesting proof of event challenge with non-abstracted account', async () => {
      const error: any = await dapp.requestProofOfEventChallenge({ payload: 'test' }).then(
        () => {
          throw new Error('Expected requestProofOfEventChallenge to reject')
        },
        (err: unknown) => err
      )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(ParametersInvalidBeaconError)
      expect(isBeaconError(error)).toBe(true)
      expect(error.id).toBe('')
      expect(error.senderId).toBe('')
      expect(error.version).toBe('2')
      expect(error.errorType).toBe(BeaconErrorType.PARAMETERS_INVALID_ERROR)
      expect(error.errorOrigin).toBe('local')
      expect(error.description).toBe(
        'This wallet is not an abstracted account and thus cannot perform proof of event'
      )
    })

    it('rejects with ParametersInvalidBeaconError when requesting simulated proof of event challenge with non-abstracted account', async () => {
      const error: any = await dapp.requestSimulatedProofOfEventChallenge({ payload: 'test' }).then(
        () => {
          throw new Error('Expected requestSimulatedProofOfEventChallenge to reject')
        },
        (err: unknown) => err
      )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(ParametersInvalidBeaconError)
      expect(isBeaconError(error)).toBe(true)
      expect(error.id).toBe('')
      expect(error.senderId).toBe('')
      expect(error.version).toBe('2')
      expect(error.errorType).toBe(BeaconErrorType.PARAMETERS_INVALID_ERROR)
      expect(error.errorOrigin).toBe('local')
      expect(error.description).toBe(
        'This wallet is not an abstracted account and thus cannot perform a simulated proof of event'
      )
    })

    it('rejects with ParametersInvalidBeaconError when permissionRequest V3 uses unregistered blockchainIdentifier', async () => {
      const input: PermissionRequestV3 = {
        type: BeaconMessageType.PermissionRequest,
        blockchainIdentifier: 'tezos-v3-unknown',
        blockchainData: {
          appMetadata: { senderId: 'dapp', name: 'Test' },
          scopes: []
        }
      }

      const error: any = await dapp.permissionRequest(input).then(
        () => {
          throw new Error('Expected permissionRequest to reject')
        },
        (err: unknown) => err
      )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(ParametersInvalidBeaconError)
      expect(isBeaconError(error)).toBe(true)
      expect(error.id).toBe('')
      expect(error.senderId).toBe('')
      expect(error.version).toBe('2')
      expect(error.errorType).toBe(BeaconErrorType.PARAMETERS_INVALID_ERROR)
      expect(error.errorOrigin).toBe('local')
      expect(error.description).toBe('Blockchain "tezos-v3-unknown" not supported by dAppClient')
    })

    it('rejects with ParametersInvalidBeaconError when request V3 uses unregistered blockchainIdentifier', async () => {
      const input: BlockchainRequestV3 = {
        type: BeaconMessageType.BlockchainRequest,
        blockchainIdentifier: 'tezos-v3-unknown',
        accountId: 'test-account-id',
        blockchainData: {
          type: 'test',
          scope: 'test'
        }
      }

      const error: any = await dapp.request(input).then(
        () => {
          throw new Error('Expected request to reject')
        },
        (err: unknown) => err
      )

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(ParametersInvalidBeaconError)
      expect(isBeaconError(error)).toBe(true)
      expect(error.id).toBe('')
      expect(error.senderId).toBe('')
      expect(error.version).toBe('2')
      expect(error.errorType).toBe(BeaconErrorType.PARAMETERS_INVALID_ERROR)
      expect(error.errorOrigin).toBe('local')
      expect(error.description).toBe('Blockchain "tezos-v3-unknown" not supported by dAppClient')
    })
  })
})
