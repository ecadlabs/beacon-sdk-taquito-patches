import { closeAlert, closeToast, openAlert, openToast } from '@ecadlabs/beacon-ui'
import { BeaconEvent, BeaconEventHandler, defaultEventCallbacks } from '../src/events'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessageType,
  NetworkType,
  Origin,
  SigningType
} from '@ecadlabs/beacon-types'
import { TzktBlockExplorer } from '../src/utils/tzkt-blockexplorer'

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
