import { closeAlert, closeToast, openAlert, openToast } from '@ecadlabs/beacon-ui'
import { getError } from '@ecadlabs/beacon-core'
import {
  BeaconEvent,
  BeaconEventHandler,
  BeaconEventType,
  defaultEventCallbacks
} from '../src/events'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessageType,
  ErrorResponse,
  NetworkType,
  OperationResponse,
  Origin,
  SignPayloadResponse,
  SigningType
} from '@ecadlabs/beacon-types'
import { RequestErrorResponse } from '../src/dapp-client/request-error'
import { TzktBlockExplorer } from '../src/utils/tzkt-blockexplorer'
import { shortenString } from '../src/utils/shorten-string'

vi.mock('@ecadlabs/beacon-ui', () => ({
  closeAlert: vi.fn(),
  closeToast: vi.fn(),
  isMobile: vi.fn().mockReturnValue(false),
  isMobileOS: vi.fn().mockReturnValue(false),
  openAlert: vi.fn(),
  openToast: vi.fn()
}))

describe('default event callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows a usable generic error without a retired reporting action', async () => {
    await defaultEventCallbacks[BeaconEvent.GENERIC_ERROR]('Connection failed')

    expect(openAlert).toHaveBeenCalledWith({
      title: 'Connection failed',
      body: 'Please try again.'
    })
  })

  it('repairs a missing active account silently', async () => {
    await defaultEventCallbacks[BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]({
      reason: 'missing_active_account'
    })

    expect(openAlert).not.toHaveBeenCalled()
  })

  it('shows the expired-session modal for invalid account storage', async () => {
    await defaultEventCallbacks[BeaconEvent.INVALID_ACCOUNT_DEACTIVATED]({
      reason: 'invalid_active_account_storage'
    })

    expect(openAlert).toHaveBeenCalledWith({
      title: 'Error',
      body: 'Your session has expired. Please pair with your wallet again.'
    })
  })
})

const walletInfo = { name: 'Wallet' }
const network = { type: NetworkType.MAINNET }
const account: AccountInfo = {
  accountIdentifier: 'one',
  senderId: 'wallet',
  address: 'tz1TGu6TN5GSez2ndXXeDX6LgUDvLzPLqgYV',
  network,
  scopes: [],
  origin: { type: Origin.P2P, id: 'peer' },
  connectedAt: 1,
  walletType: 'implicit'
}
const envelope = { id: 'one', senderId: 'wallet', version: '2' }

describe('Phase 2A event wiring', () => {
  beforeEach(() => vi.clearAllMocks())
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  afterEach(() => {
    vi.restoreAllMocks()
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })
  it.each([
    BeaconEvent.PERMISSION_REQUEST_SENT,
    BeaconEvent.OPERATION_REQUEST_SENT,
    BeaconEvent.SIGN_REQUEST_SENT,
    BeaconEvent.BROADCAST_REQUEST_SENT
  ] as const)('%s shows loading state and wires reset', async (event) => {
    const resetCallback = vi.fn()
    await defaultEventCallbacks[event]({ walletInfo, extraInfo: { resetCallback } })
    expect(openToast).toHaveBeenCalledWith(
      expect.objectContaining({ walletInfo, state: 'loading' })
    )
    const action = vi
      .mocked(openToast)
      .mock.calls[0][0].actions?.find((item) => item.actionText === 'Reset Connection')
    expect(action?.actionCallback).toBeTypeOf('function')
    await action?.actionCallback?.()
    expect(resetCallback).toHaveBeenCalledTimes(1)
    expect(closeToast).toHaveBeenCalledTimes(1)
  })
  it.each([
    BeaconEvent.PERMISSION_REQUEST_ERROR,
    BeaconEvent.OPERATION_REQUEST_ERROR,
    BeaconEvent.SIGN_REQUEST_ERROR,
    BeaconEvent.BROADCAST_REQUEST_ERROR
  ] as const)('%s presents the wallet rejection', async (event) => {
    await defaultEventCallbacks[event]({
      walletInfo,
      errorMessages: {},
      errorResponse: {
        ...envelope,
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.ABORTED_ERROR
      }
    })
    expect(openToast).toHaveBeenCalledWith(
      expect.objectContaining({
        walletInfo,
        state: 'finished',
        timer: expect.any(Number),
        actions: expect.arrayContaining([expect.objectContaining({ isBold: true })])
      })
    )
  })
  it('PAIR_INIT preserves pairing payload and abort callback, PAIR_SUCCESS closes the alert', async () => {
    const data = {
      p2pPeerInfo: Promise.resolve('p2p'),
      postmessagePeerInfo: Promise.resolve('extension'),
      walletConnectPeerInfo: Promise.resolve('wc'),
      networkType: NetworkType.MAINNET,
      analytics: { track: vi.fn() },
      abortedHandler: vi.fn(),
      disclaimerText: 'Disclaimer',
      featuredWallets: ['wallet']
    }
    await defaultEventCallbacks[BeaconEvent.PAIR_INIT](data)
    expect(openAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        pairingPayload: {
          p2pSyncCode: data.p2pPeerInfo,
          postmessageSyncCode: data.postmessagePeerInfo,
          walletConnectSyncCode: data.walletConnectPeerInfo,
          networkType: data.networkType
        },
        closeButtonCallback: data.abortedHandler,
        disclaimerText: 'Disclaimer',
        featuredWallets: ['wallet']
      })
    )
    await defaultEventCallbacks[BeaconEvent.PAIR_SUCCESS]({
      id: 'peer',
      name: 'Wallet',
      publicKey: 'key',
      version: '2',
      type: 'p2p-pairing-response',
      senderId: 'wallet',
      relayServer: 'relay'
    })
    expect(closeAlert).toHaveBeenCalledTimes(1)
  })
  it('permission success includes address, network and scopes', async () => {
    await defaultEventCallbacks[BeaconEvent.PERMISSION_REQUEST_SUCCESS]({
      account,
      walletInfo,
      connectionContext: { origin: Origin.P2P, id: 'peer' },
      output: {
        ...envelope,
        type: BeaconMessageType.PermissionResponse,
        address: account.address,
        accountInfo: account,
        network,
        scopes: [],
        walletType: 'implicit',
        appMetadata: { name: 'Wallet', senderId: 'wallet' }
      },
      blockExplorer: new TzktBlockExplorer()
    })
    expect(openToast).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'finished',
        actions: expect.arrayContaining([
          expect.objectContaining({ text: 'Network', actionText: 'mainnet' }),
          expect.objectContaining({ text: 'Permissions' }),
          expect.objectContaining({ text: 'Address' })
        ])
      })
    )
  })
  it.each([BeaconEvent.OPERATION_REQUEST_SUCCESS, BeaconEvent.BROADCAST_REQUEST_SUCCESS] as const)(
    '%s links to the transaction explorer',
    async (event) => {
      const blockExplorer = new TzktBlockExplorer()
      const link = vi
        .spyOn(blockExplorer, 'getTransactionLink')
        .mockResolvedValue('https://explorer.example/op')
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      const transactionHash = 'operation-hash'
      if (event === BeaconEvent.OPERATION_REQUEST_SUCCESS) {
        await defaultEventCallbacks[event]({
          account,
          walletInfo,
          blockExplorer,
          connectionContext: { origin: Origin.P2P, id: 'peer' },
          output: { ...envelope, type: BeaconMessageType.OperationResponse, transactionHash }
        })
      } else {
        await defaultEventCallbacks[event]({
          network,
          walletInfo,
          blockExplorer,
          connectionContext: { origin: Origin.P2P, id: 'peer' },
          output: { ...envelope, type: BeaconMessageType.BroadcastResponse, transactionHash }
        })
      }
      expect(openToast).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'finished', walletInfo })
      )
      await vi.mocked(openToast).mock.calls[0][0].actions?.[0].actionCallback?.()
      expect(link).toHaveBeenCalledWith(transactionHash, network)
      expect(open).toHaveBeenCalledWith('https://explorer.example/op', '_blank', 'noopener')
    }
  )
  it('sign success copies the signature', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await defaultEventCallbacks[BeaconEvent.SIGN_REQUEST_SUCCESS]({
      walletInfo,
      connectionContext: { origin: Origin.P2P, id: 'peer' },
      output: {
        ...envelope,
        type: BeaconMessageType.SignPayloadResponse,
        signature: 'signature',
        signingType: SigningType.RAW
      }
    })
    await vi.mocked(openToast).mock.calls[0][0].actions?.[0].actionCallback?.()
    expect(writeText).toHaveBeenCalledWith('signature')
  })
  it('acknowledge updates toast state, internal errors and rate limits display alerts', async () => {
    await defaultEventCallbacks[BeaconEvent.ACKNOWLEDGE_RECEIVED]({
      walletInfo,
      extraInfo: {},
      message: { ...envelope, type: BeaconMessageType.Acknowledge }
    })
    expect(openToast).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'acknowledge', walletInfo })
    )
    const buttons = [{ text: 'Retry', actionCallback: vi.fn() }]
    await defaultEventCallbacks[BeaconEvent.INTERNAL_ERROR]({ text: 'Failed', buttons })
    expect(openAlert).toHaveBeenCalledWith({
      title: 'Internal Error',
      body: 'Failed',
      buttons: [...buttons, { text: 'Done', style: 'outline' }]
    })
    expect(buttons).toHaveLength(1)
    await defaultEventCallbacks[BeaconEvent.LOCAL_RATE_LIMIT_REACHED](undefined)
    expect(openAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: 'Rate limit reached. Please slow down', timer: 3000 })
    )
  })
  it('supports default overrides, additional subscribers and disabling all defaults', async () => {
    const override = vi.fn()
    const subscriber = vi.fn()
    const handler = new BeaconEventHandler({ [BeaconEvent.INTERNAL_ERROR]: { handler: override } })
    await handler.on(BeaconEvent.INTERNAL_ERROR, subscriber)
    const data = { text: 'failure' }
    await handler.emit(BeaconEvent.INTERNAL_ERROR, data)
    expect(override).toHaveBeenCalledWith(data, undefined)
    expect(subscriber).toHaveBeenCalledWith(data, undefined)
    expect(openAlert).not.toHaveBeenCalled()
    const disabled = new BeaconEventHandler({}, true)
    await disabled.emit(BeaconEvent.LOCAL_RATE_LIMIT_REACHED)
    expect(openAlert).not.toHaveBeenCalled()
    const defaults = new BeaconEventHandler()
    await defaults.emit(BeaconEvent.LOCAL_RATE_LIMIT_REACHED)
    expect(openAlert).toHaveBeenCalledTimes(1)
  })
  it('maps contract errors and opens the full RPC details', async () => {
    const errorData = [
      { kind: 'temporary', id: 'contract.runtime_error', contract_handle: 'KT1contract' },
      { kind: 'temporary', id: 'contract.reject', with: { int: '42' } }
    ]
    await defaultEventCallbacks[BeaconEvent.OPERATION_REQUEST_ERROR]({
      walletInfo,
      errorResponse: {
        ...envelope,
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.TRANSACTION_INVALID_ERROR,
        errorData
      },
      errorMessages: { KT1contract: { 42: 'Insufficient balance' } }
    })
    const actions = vi.mocked(openToast).mock.calls[0][0].actions
    expect(actions).toContainEqual({ text: 'Insufficient balance', isBold: true })
    const details = actions?.find((action) => action.actionText === 'Show Details')
    expect(details?.actionCallback).toBeTypeOf('function')
    await details?.actionCallback?.()
    expect(closeToast).toHaveBeenCalledTimes(1)
    expect(openAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Transaction Invalid',
        data: JSON.stringify(errorData, undefined, 2)
      })
    )
  })
})

describe('request timeout toast', () => {
  beforeEach(() => vi.clearAllMocks())

  // The dApp raises PEER_UNREACHABLE itself when its request deadline fires. The wallet
  // returned nothing and still holds the request, so the toast must not claim the wallet
  // answered, and must show the description that warns the request can still complete.
  // The toast keys on `errorOrigin`, not on the error type: a wallet can send PEER_UNREACHABLE too.
  function errorResponse(
    errorType: BeaconErrorType,
    errorOrigin: 'wallet' | 'local'
  ): ErrorResponse & { errorOrigin: 'wallet' | 'local' } {
    return { ...envelope, type: BeaconMessageType.Error, errorType, errorOrigin }
  }
  type ErrorToast = {
    request: string
    show: (errorResponse: ErrorResponse) => void | Promise<void>
  }
  const errorToasts: ErrorToast[] = [
    {
      request: 'permission',
      show: (errorResponse) =>
        defaultEventCallbacks[BeaconEvent.PERMISSION_REQUEST_ERROR]({ walletInfo, errorResponse })
    },
    {
      request: 'operation',
      show: (errorResponse) =>
        defaultEventCallbacks[BeaconEvent.OPERATION_REQUEST_ERROR]({
          walletInfo,
          errorResponse,
          errorMessages: {}
        })
    },
    {
      request: 'sign payload',
      show: (errorResponse) =>
        defaultEventCallbacks[BeaconEvent.SIGN_REQUEST_ERROR]({ walletInfo, errorResponse })
    },
    {
      request: 'broadcast',
      show: (errorResponse) =>
        defaultEventCallbacks[BeaconEvent.BROADCAST_REQUEST_ERROR]({ walletInfo, errorResponse })
    },
    {
      request: 'proof of event',
      show: (errorResponse) =>
        defaultEventCallbacks[BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR]({
          walletInfo,
          errorResponse
        })
    },
    {
      request: 'simulated proof of event',
      show: (errorResponse) =>
        defaultEventCallbacks[BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR]({
          walletInfo,
          errorResponse
        })
    }
  ]
  const timedOut = errorResponse(BeaconErrorType.PEER_UNREACHABLE, 'local')

  it.each(errorToasts)(
    'says the wallet did not respond for a timed-out $request request',
    async ({ show }) => {
      await show(timedOut)

      expect(openToast).toHaveBeenCalledTimes(1)
      const toast = vi.mocked(openToast).mock.calls[0][0]
      expect(toast.body).toBe('{{wallet}}  did not respond')
      expect(toast.state).toBe('finished')
      expect(toast.walletInfo).toEqual(walletInfo)
      // Stays open: the user has to read it before deciding whether to retry.
      expect(toast.timer).toBeUndefined()
    }
  )

  it.each(errorToasts)(
    'shows the timeout title and description for a timed-out $request request',
    async ({ show }) => {
      await show(timedOut)

      const error = getError(BeaconErrorType.PEER_UNREACHABLE, undefined)
      expect(vi.mocked(openToast).mock.calls[0][0].actions).toEqual([
        { text: error.title, isBold: true },
        { text: error.description }
      ])
    }
  )

  it.each([
    [BeaconErrorType.ABORTED_ERROR, '{{wallet}}  request was cancelled'],
    [BeaconErrorType.UNKNOWN_ERROR, '{{wallet}}  request failed'],
    [BeaconErrorType.NOT_GRANTED_ERROR, '{{wallet}}  request failed']
  ])('describes a local %s without blaming the wallet', async (errorType, body) => {
    await defaultEventCallbacks[BeaconEvent.OPERATION_REQUEST_ERROR]({
      walletInfo,
      errorResponse: errorResponse(errorType, 'local'),
      errorMessages: {}
    })

    expect(vi.mocked(openToast).mock.calls[0][0].body).toBe(body)
  })

  // Guards against widening the local copy to errors the wallet actually sent.
  it.each([
    BeaconErrorType.NOT_GRANTED_ERROR,
    BeaconErrorType.ABORTED_ERROR,
    BeaconErrorType.UNKNOWN_ERROR,
    BeaconErrorType.PEER_UNREACHABLE
  ])('keeps "has returned an error" for a wallet-sent %s', async (errorType) => {
    await defaultEventCallbacks[BeaconEvent.OPERATION_REQUEST_ERROR]({
      walletInfo,
      errorResponse: errorResponse(errorType, 'wallet'),
      errorMessages: {}
    })

    expect(vi.mocked(openToast).mock.calls[0][0].body).toBe('{{wallet}}  has returned an error')
  })
})

describe('late response toast', () => {
  beforeEach(() => vi.clearAllMocks())

  const connectionInfo = { origin: Origin.P2P, id: 'peer' }
  const hash = 'ooLateOperationHashThatIsLongEnoughToShorten'
  type LateResponse = BeaconEventType[BeaconEvent.LATE_RESPONSE_RECEIVED]
  const base = { requestId: 'one', connectionInfo, walletInfo }
  const operation: OperationResponse = {
    ...envelope,
    type: BeaconMessageType.OperationResponse,
    transactionHash: hash
  }
  const v3Operation = {
    ...envelope,
    version: '3',
    message: {
      type: BeaconMessageType.BlockchainResponse,
      blockchainIdentifier: 'tezos',
      blockchainData: { transactionHash: hash }
    }
  }
  const signature: SignPayloadResponse = {
    ...envelope,
    type: BeaconMessageType.SignPayloadResponse,
    signingType: SigningType.RAW,
    signature: 'late-signature'
  }
  const walletError: RequestErrorResponse = {
    ...envelope,
    type: BeaconMessageType.Error,
    errorType: BeaconErrorType.ABORTED_ERROR,
    errorOrigin: 'wallet'
  }

  // A user who saw the timeout toast may be about to retry. If the operation went through
  // after all, the default UI has to say so, with the hash, before they pay twice.
  it.each<{ response: string; data: LateResponse; body: string }>([
    {
      response: 'V2 operation',
      data: {
        ...base,
        kind: 'success',
        requestType: BeaconMessageType.OperationRequest,
        message: operation,
        output: operation,
        transactionHash: hash
      },
      body: '{{wallet}}\u00A0 submitted the operation after the request timed out'
    },
    {
      response: 'V3 operation',
      data: {
        ...base,
        kind: 'success',
        requestType: BeaconMessageType.BlockchainRequest,
        message: v3Operation,
        output: v3Operation.message,
        transactionHash: hash
      },
      body: '{{wallet}}\u00A0 submitted the operation after the request timed out'
    },
    {
      response: 'V2 broadcast',
      data: {
        ...base,
        kind: 'success',
        requestType: BeaconMessageType.BroadcastRequest,
        message: { ...operation, type: BeaconMessageType.BroadcastResponse },
        output: { ...operation, type: BeaconMessageType.BroadcastResponse },
        transactionHash: hash
      },
      body: '{{wallet}}\u00A0 broadcast the transaction after the request timed out'
    }
  ])('shows the hash for a late $response response', async ({ data, body }) => {
    // Through the handler, so the default callback is also registered for the event.
    await new BeaconEventHandler().emit(BeaconEvent.LATE_RESPONSE_RECEIVED, data)

    expect(openToast).toHaveBeenCalledTimes(1)
    const toast = vi.mocked(openToast).mock.calls[0][0]
    expect(toast.body).toBe(body)
    expect(toast.state).toBe('finished')
    expect(toast.walletInfo).toEqual(walletInfo)
    expect(toast.timer).toBeUndefined()
    expect(toast.actions).toContainEqual(
      expect.objectContaining({ text: shortenString(hash), isBold: true })
    )
  })

  // The toast follows the normalised payload; extracting the hash is tested with the helper
  // that builds it (request-error.test.ts).
  it.each<{ response: string; data: LateResponse }>([
    {
      response: 'wallet error for an operation',
      data: {
        ...base,
        kind: 'error',
        requestType: BeaconMessageType.OperationRequest,
        message: walletError,
        error: walletError
      }
    },
    {
      response: 'signature',
      data: {
        ...base,
        kind: 'success',
        requestType: BeaconMessageType.SignPayloadRequest,
        message: signature,
        output: signature
      }
    },
    {
      response: 'success without a transaction hash',
      data: {
        ...base,
        kind: 'success',
        requestType: BeaconMessageType.OperationRequest,
        message: { ...operation, transactionHash: '' },
        output: { ...operation, transactionHash: '' }
      }
    }
  ])('stays quiet for a late $response', async ({ data }) => {
    // The handler swallows callback errors, so call the default callback directly as well.
    await expect(
      Promise.resolve(defaultEventCallbacks[BeaconEvent.LATE_RESPONSE_RECEIVED](data))
    ).resolves.toBeUndefined()
    await new BeaconEventHandler().emit(BeaconEvent.LATE_RESPONSE_RECEIVED, data)

    expect(openToast).not.toHaveBeenCalled()
    expect(openAlert).not.toHaveBeenCalled()
  })
})
