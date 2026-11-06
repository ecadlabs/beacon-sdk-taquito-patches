import type { MockInstance } from 'vitest'
import { LocalStorage, Serializer } from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessageType,
  NetworkType,
  Origin,
  PermissionScope,
  SigningType
} from '@ecadlabs/beacon-types'
import { WalletConnectCommunicationClient } from '../../../beacon-transport-walletconnect/src/communication-client/WalletConnectCommunicationClient'
import {
  mockRemote,
  mockApprovals,
  session,
  mockRequests,
  mockHandlers,
  mockPings,
  account,
  resetWire,
  restoreSession,
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

// These tests use public DAppClient requests and disconnect, real transport routing
// and real timers under Vitest's clock. No open-request map or timeout is injected.
describe('WalletConnect public request lifetime (#102)', () => {
  installLocalChannel()
  let dapp: DAppClient
  let delivered: unknown[]
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
    delivered = []
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
    await dapp?.destroy()
    vi.restoreAllMocks()
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
    await adapter.listenForEncryptedMessage('observer', (encoded) => {
      void serializer.deserialize(encoded).then((message) => {
        delivered.push(message)
      })
    })
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
  async function acknowledge() {
    const handler = mockHandlers.get('session_event')
    if (!handler) throw new Error('Missing session event listener')
    handler({
      id: 123,
      topic: 'current',
      params: { event: { name: 'requestAcknowledged', data: {} } }
    })
    await flush()
  }

  it('legacy ACKs cannot turn a bounded public request into an indefinite wait', async () => {
    await start(1000)
    const request = await sign('aa')
    await vi.advanceTimersByTimeAsync(500)
    await acknowledge()
    await acknowledge()
    await vi.advanceTimersByTimeAsync(501)
    expect(request.settled).toHaveBeenCalledTimes(1)
    expect(await request.outcome).toEqual({
      error: expect.objectContaining({ errorType: BeaconErrorType.PEER_UNREACHABLE })
    })
  })

  it('a configured longer deadline allows an approval beyond the default minute without ACKs', async () => {
    await start(120_000)
    const request = await sign('aa')
    await vi.advanceTimersByTimeAsync(90_000)
    expect(request.settled).not.toHaveBeenCalled()
    mockRequests[0].reply.resolve({ signature: 'slow-signature' })
    await flush()
    expect(await request.outcome).toEqual({
      value: expect.objectContaining({
        id: request.id,
        signature: 'slow-signature',
        type: BeaconMessageType.SignPayloadResponse
      })
    })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(request.settled).toHaveBeenCalledTimes(1)
  })

  it.each(['response', 'error'])(
    'an expired request cannot deliver its late %s to its successor',
    async (late) => {
      await start(1000)
      const old = await sign('aa')
      await vi.advanceTimersByTimeAsync(1001)
      expect(old.settled).toHaveBeenCalledTimes(1)
      expect(await old.outcome).toEqual({
        error: expect.objectContaining({ errorType: BeaconErrorType.PEER_UNREACHABLE })
      })
      const next = await sign('bb')
      const before = delivered.length
      if (late === 'response') mockRequests[0].reply.resolve({ signature: 'old-signature' })
      else mockRequests[0].reply.reject(new Error('old rejection'))
      await flush()
      expect(next.settled).not.toHaveBeenCalled()
      mockRequests[1].reply.resolve({ signature: 'new-signature' })
      await flush()
      expect(next.settled).toHaveBeenCalledTimes(1)
      expect(await next.outcome).toEqual({
        value: expect.objectContaining({
          id: next.id,
          signature: 'new-signature',
          type: BeaconMessageType.SignPayloadResponse
        })
      })
      expect(old.settled).toHaveBeenCalledTimes(1)
      expect(delivered.slice(before)).toEqual([
        expect.objectContaining({ id: next.id, signature: 'new-signature' })
      ])
    }
  )

  it('a late legacy ACK for an expired request cannot disable the successor deadline', async () => {
    await start(1000)
    const old = await sign('aa')
    await vi.advanceTimersByTimeAsync(1001)
    expect(old.settled).toHaveBeenCalledTimes(1)
    const next = await sign('bb')
    await acknowledge()
    await vi.advanceTimersByTimeAsync(1001)
    expect(next.settled).toHaveBeenCalledTimes(1)
    expect(await next.outcome).toEqual({
      error: expect.objectContaining({ id: next.id, errorType: BeaconErrorType.PEER_UNREACHABLE })
    })
  })

  it('a successor can complete while an expired wallet request is still pending', async () => {
    await start(1000)
    const old = await sign('aa')
    await vi.advanceTimersByTimeAsync(1001)
    expect(old.settled).toHaveBeenCalledTimes(1)
    const next = await sign('bb')
    mockRequests[1].reply.resolve({ signature: 'new-signature' })
    await flush()
    expect(next.settled).toHaveBeenCalledTimes(1)
    expect(await next.outcome).toEqual({
      value: expect.objectContaining({ id: next.id, signature: 'new-signature' })
    })
    mockRequests[0].reply.reject(new Error('abandoned rejection'))
    await flush()
    expect(old.settled).toHaveBeenCalledTimes(1)
    expect(next.settled).toHaveBeenCalledTimes(1)
  })

  it('public disconnect rejects once; a pending ping and response cannot settle a reconnected request', async () => {
    await start(1000)
    const old = await sign('aa')
    expect(mockPings).toHaveLength(1)
    const closing = dapp.disconnect()
    await flush()
    await closing
    expect(old.settled).toHaveBeenCalledTimes(1)
    expect(await old.outcome).toEqual({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
    const oldRequest = mockRequests[0]
    const oldPing = mockPings[0]
    // A new transport restores the known session through the public selection API.
    restoreSession('current')
    await dapp.setActiveAccount(selected)
    holdPings()
    const next = await sign('bb')
    oldPing.resolve()
    oldRequest.reply.resolve({ signature: 'abandoned-signature' })
    await flush()
    expect(next.settled).not.toHaveBeenCalled()
    mockRequests[1].reply.resolve({ signature: 'new-signature' })
    await flush()
    expect(next.settled).toHaveBeenCalledTimes(1)
    expect(await next.outcome).toEqual({
      value: expect.objectContaining({ id: next.id, signature: 'new-signature' })
    })
    expect(old.settled).toHaveBeenCalledTimes(1)
  })
  it('permission renewal aborts an older public request even with timeout disabled', async () => {
    await start(0)
    const old = await sign('aa')
    const renewed = vi.fn()
    const renewal = dapp.requestPermissions().then(
      (value) => {
        renewed({ value })
        return value
      },
      (error: unknown) => {
        renewed({ error })
        return { error }
      }
    )
    await flush()
    expect(mockApprovals).toHaveLength(1)
    const approved = session('renewed')
    approved.sessionProperties = {
      ...approved.sessionProperties,
      pubkey: 'edpkv3Nf62TZxR1XwzKRteLTh1SmXLmr8cGEwHRSNoiUV3oiBrDbFX'
    }
    mockApprovals[0].resolve(approved)
    await flush()
    expect(old.settled).toHaveBeenCalledTimes(1)
    expect(await old.outcome).toEqual({
      error: expect.objectContaining({ id: old.id, errorType: BeaconErrorType.ABORTED_ERROR })
    })
    expect(renewed).toHaveBeenCalledTimes(1)
    expect(await renewal).toEqual(
      expect.objectContaining({ publicKey: approved.sessionProperties.pubkey })
    )
    mockRequests[0].reply.resolve({ signature: 'obsolete' })
    await flush()
    expect(old.settled).toHaveBeenCalledTimes(1)
    expect(adapter.currentSession()?.topic).toBe('renewed')
  })
  it('revocation during request decoding settles the public caller with timeout disabled', async () => {
    await start(0)
    const sendMessage = adapter.sendMessage
    let closing: Promise<void> | undefined
    vi.spyOn(adapter, 'sendMessage').mockImplementationOnce((encoded) => {
      const sending = sendMessage.call(adapter, encoded)
      closing = adapter.closeSignClient()
      return sending
    })
    const settled = vi.fn()
    const outcome = dapp.requestSignPayload({ payload: 'aa', signingType: SigningType.RAW }).then(
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
    expect(mockRequests).toHaveLength(0)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(await outcome).toEqual({
      error: expect.objectContaining({ errorType: BeaconErrorType.ABORTED_ERROR })
    })
    await closing
  })

  it('public renewal timeout discards a late approval and preserves the active session', async () => {
    await start(1000)
    const settled = vi.fn()
    const outcome = dapp.requestPermissions().then(
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
    expect(mockApprovals).toHaveLength(1)
    await acknowledge()
    await vi.advanceTimersByTimeAsync(1001)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(await outcome).toEqual({
      error: expect.objectContaining({ errorType: BeaconErrorType.PEER_UNREACHABLE })
    })
    mockApprovals[0].resolve(session('late-renewal'))
    await flush()
    expect(mockRemote.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'late-renewal' })
    )
    expect(adapter.currentSession()?.topic).toBe('current')
    expect(settled).toHaveBeenCalledTimes(1)
  })
  it.each(['session_delete', 'session_expire'])(
    'wallet %s rejects the public request even with timeout disabled',
    async (event) => {
      await start(0)
      const request = await sign('aa')
      const handler = mockHandlers.get(event)
      if (!handler) throw new Error(`Missing ${event} handler`)
      handler({ topic: 'current' })
      await flush()
      expect(request.settled).toHaveBeenCalledTimes(1)
      expect(await request.outcome).toEqual({
        error: expect.objectContaining({ id: request.id, errorType: BeaconErrorType.ABORTED_ERROR })
      })
      expect(await dapp.getActiveAccount()).toBeUndefined()
      mockRequests[0].reply.resolve({ signature: 'after-wallet-disconnect' })
      await flush()
      expect(request.settled).toHaveBeenCalledTimes(1)
    }
  )
})
