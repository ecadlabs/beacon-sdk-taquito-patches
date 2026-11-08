import type { MockInstance } from 'vitest'
import { LocalStorage, Serializer } from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessage,
  BeaconMessageType,
  ConnectionContext,
  NetworkType,
  Origin,
  PermissionScope,
  SigningType
} from '@ecadlabs/beacon-types'
import { WalletConnectCommunicationClient } from '../../../beacon-transport-walletconnect/src/communication-client/WalletConnectCommunicationClient'
import {
  mockRemote,
  mockRequests,
  account,
  resetWire,
  holdPings,
  flush,
  installLocalChannel
} from '../../../beacon-transport-walletconnect/__tests__/helpers/controlled-sign-client'
import { P2PCommunicationClient } from '@ecadlabs/beacon-transport-matrix'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { BeaconEvent } from '../../src/events'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'

vi.mock(
  '@ecadlabs/beacon-transport-walletconnect',
  async () =>
    await vi.importActual<typeof import('../../../beacon-transport-walletconnect/src')>(
      '../../../beacon-transport-walletconnect/src'
    )
)
vi.mock('@walletconnect/sign-client', () => ({ default: { init: async () => mockRemote } }))
vi.mock('@walletconnect/utils', () => ({
  getSdkError: () => ({ code: 6000, message: 'Disconnected' })
}))
// Load source modules so Vitest can intercept their imports.
vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  ...(await vi.importActual<
    typeof import('../../../beacon-core/src/transports/clients/ClientEvents')
  >('../../../beacon-core/src/transports/clients/ClientEvents')),
  ...(await vi.importActual<typeof import('../../../beacon-core/src/utils/multi-tab-channel')>(
    '../../../beacon-core/src/utils/multi-tab-channel'
  ))
}))
vi.mock('@ecadlabs/beacon-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-ui')>()),
  isMobileOS: () => false,
  isDesktop: () => true
}))
vi.mock('broadcast-channel', () => ({
  BroadcastChannel: class {
    postMessage() {}
    close() {}
    removeEventListener() {}
  },
  createLeaderElection: () => ({
    isLeader: true,
    awaitLeadership: async () => {},
    hasLeader: async () => true,
    die: async () => {}
  })
}))

describe('Request cleanup ownership', () => {
  installLocalChannel()
  let dapp: DAppClient
  let adapter: WalletConnectCommunicationClient
  const serializer = new Serializer()
  let sent: MockInstance<
    (
      ...args: Parameters<DappWalletConnectTransport['send']>
    ) => ReturnType<DappWalletConnectTransport['send']>
  >
  const selected: AccountInfo = {
    accountIdentifier: 'test-account',
    senderId: 'current',
    origin: { type: Origin.WALLETCONNECT, id: 'wallet-key' },
    address: account,
    network: { type: NetworkType.MAINNET },
    scopes: [PermissionScope.SIGN, PermissionScope.OPERATION_REQUEST],
    connectedAt: 1,
    walletType: 'implicit'
  }
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    resetWire()
    sent = vi.spyOn(DappWalletConnectTransport.prototype, 'send')
    // Matrix is never connected in this fixture; its legacy unsubscribe waits
    // for an unstarted network client. WalletConnect teardown remains real.
    vi.spyOn(
      P2PCommunicationClient.prototype,
      'unsubscribeFromEncryptedMessages'
    ).mockResolvedValue(undefined)
    adapter = new WalletConnectCommunicationClient(
      { network: NetworkType.MAINNET, opts: { projectId: 'offline' } },
      async () => true
    )
    vi.spyOn(WalletConnectCommunicationClient, 'getInstance').mockReturnValue(adapter)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await dapp?.destroy()
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  async function start(requestTimeoutMs: number) {
    dapp = new DAppClient({
      name: 'Lifetime test',
      network: { type: NetworkType.MAINNET },
      storage: new LocalStorage('lifetime'),
      disableDefaultEvents: true,
      enableAppSwitching: false,
      requestTimeoutMs
    })
    await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    await dapp.getActiveAccount()
    await dapp.setActiveAccount(selected)
    expect((await dapp.getActiveAccount())?.accountIdentifier).toBe(selected.accountIdentifier)
    expect(adapter.currentSession()?.topic).toBe('current')
    holdPings()
  }
  async function sign(payload: string) {
    const previousRequests = mockRequests.length
    const settled = vi.fn()
    const outcome = dapp.requestSignPayload({ payload, signingType: SigningType.RAW }).then(
      (value) => {
        settled({ value })
        return { value }
      },
      (error: unknown) => {
        settled({ error })
        return { error }
      }
    )
    await flush()
    expect(settled.mock.calls).toEqual([])
    expect(mockRequests).toHaveLength(previousRequests + 1)
    const message = await serializer.deserialize(sent.mock.calls[sent.mock.calls.length - 1][0])
    if (
      !message ||
      typeof message !== 'object' ||
      !('id' in message) ||
      typeof message.id !== 'string'
    ) {
      throw new Error('Public request did not send a Beacon request ID')
    }
    return { outcome, settled, id: message.id }
  }
  async function receive(message: BeaconMessage, connectionInfo: ConnectionContext) {
    // DAppClient accepts responses; its inherited declaration lists requests.
    const handleResponse = dapp['handleResponse'].bind(dapp) as (
      message: BeaconMessage,
      connectionInfo: ConnectionContext
    ) => Promise<void>
    await handleResponse(message, connectionInfo)
  }

  it.each(['response', 'disconnect'] as const)(
    'retires a request before its %s cleanup can deliver again',
    async (terminal) => {
      await start(1000)
      const request = await sign('aa')
      const transport = await dapp['transport']
      if (!(transport instanceof DappWalletConnectTransport)) {
        throw new Error('Expected WalletConnect transport')
      }
      const response: BeaconMessage = {
        id: request.id,
        type: BeaconMessageType.SignPayloadResponse,
        senderId: 'current',
        version: '2',
        signingType: SigningType.RAW,
        signature: 'completed-signature'
      }
      const connectionInfo = { origin: Origin.WALLETCONNECT, id: 'wallet-key' }
      const cancelRequest = transport.cancelRequest.bind(transport)
      let reentered = false
      let delivery: Promise<void> | undefined
      const cleanup = vi.spyOn(transport, 'cancelRequest').mockImplementation((id) => {
        cancelRequest(id)
        if (!reentered) {
          reentered = true
          delivery = receive(response, connectionInfo)
        }
      })

      if (terminal === 'response') await receive(response, connectionInfo)
      else await dapp.disconnect({ notifyPeers: false })
      await delivery
      await flush()

      expect(request.settled).toHaveBeenCalledTimes(1)
      if (terminal === 'response') {
        await expect(request.outcome).resolves.toEqual({
          value: expect.objectContaining({ signature: 'completed-signature' })
        })
      } else {
        await expect(request.outcome).resolves.toEqual({
          error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
        })
      }
      expect(cleanup).toHaveBeenCalledExactlyOnceWith(request.id)
    }
  )

  it('aborts every request when one transport cleanup throws', async () => {
    await start(1000)
    const first = await sign('aa')
    const second = await sign('bb')
    const transport = await dapp['transport']
    if (!(transport instanceof DappWalletConnectTransport)) {
      throw new Error('Expected WalletConnect transport')
    }
    const cancelRequest = transport.cancelRequest.bind(transport)
    const cleanup = vi.spyOn(transport, 'cancelRequest').mockImplementation((id) => {
      cancelRequest(id)
      if (id === first.id) throw new Error('Cancellation failed')
    })
    const closingErrors: unknown[] = []
    await dapp.disconnect({ notifyPeers: false }).catch((error: unknown) => {
      closingErrors.push(error)
    })
    await flush()

    expect(first.settled).toHaveBeenCalledTimes(1)
    expect(second.settled).toHaveBeenCalledTimes(1)
    await expect(first.outcome).resolves.toEqual({
      error: expect.objectContaining({ id: first.id, errorType: BeaconErrorType.ABORTED_ERROR })
    })
    await expect(second.outcome).resolves.toEqual({
      error: expect.objectContaining({ id: second.id, errorType: BeaconErrorType.ABORTED_ERROR })
    })
    expect(closingErrors).toEqual([])
    expect(cleanup.mock.calls).toEqual([[first.id], [second.id]])
    const closed = vi.fn()
    await dapp.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, closed)
    await vi.advanceTimersByTimeAsync(1001)
    expect(closed).not.toHaveBeenCalled()
    expect(cleanup.mock.calls).toEqual([[first.id], [second.id]])
  })
})
