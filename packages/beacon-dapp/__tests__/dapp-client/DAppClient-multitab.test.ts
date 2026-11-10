import { DAppClient } from '../../src/dapp-client/DAppClient'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { BeaconEvent } from '../../src/events'
import { LocalStorage } from '@ecadlabs/beacon-core'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessageType,
  NetworkType,
  Origin,
  PermissionScope,
  SigningType,
  StorageKey,
  TransportStatus
} from '@ecadlabs/beacon-types'

const channel = vi.hoisted(() => ({ leader: false, postMessage: vi.fn(), close: vi.fn() }))
vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  MultiTabChannel: class {
    isLeader() {
      return channel.leader
    }
    async hasLeader() {
      return true
    }
    async getLeadership() {}
    async init() {}
    async close() {
      channel.close()
    }
    postMessage(message: unknown) {
      channel.postMessage(message)
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

const network = { type: NetworkType.MAINNET }
const account: AccountInfo = {
  accountIdentifier: 'account',
  senderId: 'wallet',
  address: 'tz1TGu6TN5GSez2ndXXeDX6LgUDvLzPLqgYV',
  network,
  scopes: [PermissionScope.OPERATION_REQUEST, PermissionScope.SIGN],
  origin: { type: Origin.WALLETCONNECT, id: 'peer' },
  connectedAt: 1,
  walletType: 'implicit'
}
const connectionInfo = { origin: Origin.WALLETCONNECT, id: 'peer' }
let client: DAppClient
let transport: DappWalletConnectTransport
let storage: LocalStorage
beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  channel.leader = false
  storage = new LocalStorage('multitab')
  client = new DAppClient({
    name: 'Multitab',
    storage,
    disableDefaultEvents: true,
    enableAppSwitching: false
  })
  await client.getActiveAccount()
  transport = new DappWalletConnectTransport(
    'Wallet',
    await getKeypairFromSeed('multitab'),
    storage,
    { network: NetworkType.MAINNET, opts: { projectId: 'offline' } },
    async () => channel.leader
  )
  transport['_isConnected'] = TransportStatus.SECONDARY_TAB_CONNECTED
  vi.spyOn(transport, 'waitForResolution').mockResolvedValue(true)
  vi.spyOn(transport, 'disconnect').mockResolvedValue(undefined)
  vi.spyOn(transport, 'removeAllPeers').mockResolvedValue(undefined)
  vi.spyOn(transport, 'getPeers').mockResolvedValue([])
  client['_transport'] = ExposedPromise.resolve<Awaited<DAppClient['transport']>>(transport)
  client['_activeAccount'] = ExposedPromise.resolve<AccountInfo | undefined>(account)
  vi.spyOn(client, 'getWalletInfo').mockResolvedValue({ name: 'Wallet' })
  vi.spyOn(client, 'init').mockResolvedValue(transport.type)
})
afterEach(async () => {
  client['abortOpenRequests']()
  await client.destroy()
  vi.restoreAllMocks()
})
async function forwardedSign() {
  const pending = client.requestSignPayload({ payload: 'aa', signingType: SigningType.RAW })
  // Attach a rejection observer immediately, including when a later assertion fails.
  void pending.catch(() => {})
  await vi.waitFor(() => expect(channel.postMessage).toHaveBeenCalled())
  const message: unknown = channel.postMessage.mock.calls[0][0]
  if (
    !message ||
    typeof message !== 'object' ||
    !('id' in message) ||
    typeof message.id !== 'string'
  )
    throw new Error('Missing broadcast request ID')
  const id = message.id
  await vi.waitFor(() => expect(client['requestTracker'].get(id) !== undefined).toBe(true))
  return { id, pending }
}
it('forwards a secondary-tab request and resolves it from the leader RESPONSE', async () => {
  const { id, pending } = await forwardedSign()
  expect(channel.postMessage).toHaveBeenCalledWith({
    id,
    type: BeaconMessageType.SignPayloadRequest,
    data: expect.objectContaining({
      type: BeaconMessageType.SignPayloadRequest,
      payload: 'aa',
      signingType: SigningType.RAW
    })
  })
  await client['onBCMessageHandler']({
    type: 'RESPONSE',
    id,
    data: {
      message: {
        id,
        type: BeaconMessageType.SignPayloadResponse,
        version: '2',
        senderId: 'wallet',
        signature: 'sig',
        signingType: SigningType.RAW
      },
      connectionInfo
    }
  })
  await expect(pending).resolves.toMatchObject({ signature: 'sig', signingType: SigningType.RAW })
  expect(client['requestTracker'].get(id) !== undefined).toBe(false)
})
it('leader prepares delegated requests and broadcasts their responses with the original ID', async () => {
  channel.leader = true
  const request = {
    id: 'delegated',
    type: BeaconMessageType.SignPayloadRequest,
    data: { type: BeaconMessageType.SignPayloadRequest, payload: 'aa' }
  }
  const makeRequest = vi
    .spyOn(client as unknown as { makeRequest: (typeof client)['makeRequest'] }, 'makeRequest')
    .mockReturnValue(new Promise(() => {}))
  await client['onBCMessageHandler'](request)
  await vi.waitFor(() => expect(makeRequest).toHaveBeenCalledWith(request.data, false, request.id))
  expect(transport.waitForResolution).toHaveBeenCalledTimes(1)
  expect(client['requestTracker'].get(request.id)?.route === 'LeaderProxy').toBe(true)
  const response = {
    id: request.id,
    type: BeaconMessageType.SignPayloadResponse,
    version: '2',
    senderId: 'wallet',
    signature: 'sig',
    signingType: SigningType.RAW
  }
  // handleResponse accepts responses at runtime despite its request-only annotation.
  await client['onBCMessageHandler']({
    type: 'RESPONSE',
    data: { message: response, connectionInfo }
  })
  expect(channel.postMessage).toHaveBeenCalledWith({
    type: 'RESPONSE',
    id: request.id,
    data: { message: response, connectionInfo }
  })
  expect(client['requestTracker'].get(request.id)?.route === 'LeaderProxy').toBe(false)
})
it.each([
  {
    type: BeaconMessageType.Error,
    errorType: BeaconErrorType.ABORTED_ERROR,
    id: 'wrong',
    senderId: 'wallet',
    version: '2'
  },
  new Error('transport unavailable')
])('broadcasts delegated failures and releases request ownership: %j', async (error) => {
  channel.leader = true
  vi.spyOn(
    client as unknown as { makeRequest: (typeof client)['makeRequest'] },
    'makeRequest'
  ).mockRejectedValue(error)
  await client['prepareRequest']({
    id: 'delegated',
    data: { type: BeaconMessageType.SignPayloadRequest, payload: 'aa' }
  })
  await vi.waitFor(() =>
    expect(channel.postMessage).toHaveBeenCalledWith({
      type: 'RESPONSE',
      id: 'delegated',
      data: {
        message: expect.objectContaining({
          id: 'delegated',
          type: BeaconMessageType.Error,
          errorType:
            error instanceof Error ? BeaconErrorType.UNKNOWN_ERROR : BeaconErrorType.ABORTED_ERROR
        }),
        connectionInfo: { origin: Origin.WALLETCONNECT, id: '' }
      }
    })
  )
  expect(client['requestTracker'].size).toBe(0)
})
it('secondary tabs ignore delegated requests instead of sending them again', async () => {
  const makeRequest = vi.spyOn(
    client as unknown as { makeRequest: (typeof client)['makeRequest'] },
    'makeRequest'
  )
  await client['prepareRequest']({ id: 'delegated', data: {} })
  expect(makeRequest).not.toHaveBeenCalled()
  expect(client['requestTracker'].size).toBe(0)
})
it('broadcasts DISCONNECT when a secondary tab clears its wallet selection', async () => {
  await client['clearWalletConnectSelection'](client['accountTransition'].signal)
  expect(channel.postMessage).toHaveBeenCalledWith({ type: 'DISCONNECT' })
  expect(transport.disconnect).not.toHaveBeenCalled()
})
it('handles a DISCONNECT broadcast through disconnect', async () => {
  const disconnect = vi.spyOn(client, 'disconnect').mockResolvedValue(undefined)
  await client['onBCMessageHandler']({ type: 'DISCONNECT' })
  expect(disconnect).toHaveBeenCalledTimes(1)
})
it('synchronizes active-account storage changes and clears selection when storage is cleared', async () => {
  const selected: AccountInfo = { ...account, origin: { type: Origin.P2P, id: 'peer' } }
  await storage.set(StorageKey.ACCOUNTS, [selected])
  await storage.set(StorageKey.ACTIVE_ACCOUNT, selected.accountIdentifier)
  const p2p = new DappP2PTransport('Dapp', await getKeypairFromSeed('sync'), storage, {})
  client['p2pTransport'] = p2p
  vi.spyOn(client, 'initInternalTransports').mockResolvedValue(undefined)
  vi.spyOn(p2p, 'connect').mockResolvedValue(undefined)
  vi.spyOn(p2p, 'disconnect').mockResolvedValue(undefined)
  vi.spyOn(p2p, 'getPeers').mockResolvedValue([])
  vi.spyOn(p2p['client'], 'unsubscribeFromEncryptedMessages').mockResolvedValue(undefined)
  const notified = vi.fn()
  await client.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, notified)
  await client['onStorageChanged']({
    eventType: 'entryModified',
    key: storage.getPrefixedKey(StorageKey.ACTIVE_ACCOUNT),
    oldValue: null,
    newValue: selected.accountIdentifier
  })
  expect(await client.getActiveAccount()).toEqual(selected)
  expect(notified).toHaveBeenCalledWith(selected, undefined)
  await client['onStorageChanged']({
    eventType: 'storageCleared',
    key: null,
    oldValue: null,
    newValue: null
  })
  expect(await client.getActiveAccount()).toBeUndefined()
})
it.each([
  [BeaconMessageType.OperationRequest, BeaconEvent.OPERATION_REQUEST_SENT],
  [BeaconMessageType.SignPayloadRequest, BeaconEvent.SIGN_REQUEST_SENT],
  [BeaconMessageType.BroadcastRequest, BeaconEvent.BROADCAST_REQUEST_SENT]
])('emits the matching sent event for %s', async (type, event) => {
  const emitted = vi.fn()
  await client.subscribeToEvent(event, emitted)
  const permissionEmitted = vi.fn()
  await client.subscribeToEvent(BeaconEvent.PERMISSION_REQUEST_SENT, permissionEmitted)
  const pending =
    type === BeaconMessageType.OperationRequest
      ? client.requestOperation({ operationDetails: [] })
      : type === BeaconMessageType.BroadcastRequest
        ? client.requestBroadcast({ signedTransaction: 'deadbeef', network })
        : client.requestSignPayload({ payload: 'aa', signingType: SigningType.RAW })
  void pending.catch(() => {})
  await vi.waitFor(() => expect(client['requestTracker'].size).toBe(1))
  expect(channel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type }))
  expect(emitted).toHaveBeenCalledTimes(1)
  expect(permissionEmitted).not.toHaveBeenCalled()
})
// Sign, operation and broadcast requests have no default deadline: the wallet keeps the
// request after a local timeout, so timing out invites a double submission. Explicit-deadline
// timeout and ownership cleanup for forwarded requests are covered in
// FollowerRouteOwnership and DelegatedRequestLifetime.
it('keeps an unanswered secondary-tab sign request open by default', async () => {
  vi.useFakeTimers()
  try {
    const { id, pending } = await forwardedSign()
    const settled = vi.fn()
    void pending.then(settled, settled)
    expect(client['requestTracker'].get(id)?.deadline === 'Armed').toBe(false)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(settled).not.toHaveBeenCalled()
    expect(client['requestTracker'].get(id) !== undefined).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

// Permission requests keep the default deadline, including when a secondary tab forwards them.
it('times out a forwarded permission request after the 60 s default', async () => {
  vi.useFakeTimers()
  try {
    const pending = client['makeRequestBC']({
      type: BeaconMessageType.PermissionRequest,
      appMetadata: { name: 'Dapp', senderId: 'dapp' },
      network,
      scopes: []
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
    // Not vi.waitFor: under fake timers it advances the clock while polling.
    await vi.advanceTimersByTimeAsync(0)
    expect(client['requestTracker'].size).toBe(1)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toEqual({
      error: expect.objectContaining({
        errorType: BeaconErrorType.PEER_UNREACHABLE,
        errorOrigin: 'local'
      })
    })
  } finally {
    vi.useRealTimers()
  }
})

it('emits PERMISSION_REQUEST_SENT for a forwarded permission request', async () => {
  const emitted = vi.fn()
  await client.subscribeToEvent(BeaconEvent.PERMISSION_REQUEST_SENT, emitted)
  const pending = client['makeRequestBC']({
    type: BeaconMessageType.PermissionRequest,
    appMetadata: { name: 'Dapp', senderId: 'dapp' },
    network,
    scopes: []
  })
  void pending.catch(() => {})
  await vi.waitFor(() => expect(client['requestTracker'].size).toBe(1))
  expect(emitted).toHaveBeenCalledTimes(1)
  expect(channel.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: BeaconMessageType.PermissionRequest })
  )
})
