import { ClientEvents, Logger } from '@ecadlabs/beacon-core'
import { NetworkType } from '@ecadlabs/beacon-types'
import { SessionTypes } from '@walletconnect/types'
import { WalletConnectCommunicationClient } from '../../src/communication-client/WalletConnectCommunicationClient'

const metadata = { name: 'wallet', description: '', url: 'https://wallet.example', icons: [] }
const restoredSession: SessionTypes.Struct = {
  topic: 'restored-topic',
  pairingTopic: 'pairing-topic',
  relay: { protocol: 'irn' },
  expiry: 0,
  acknowledged: true,
  controller: 'wallet',
  namespaces: { tezos: { accounts: ['tezos:mainnet:tz1account'], methods: [], events: [] } },
  requiredNamespaces: {},
  optionalNamespaces: {},
  self: { publicKey: 'dapp-key', metadata },
  peer: { publicKey: 'wallet-key', metadata }
}
const mockRemote = {
  session: { keys: ['restored-topic'], get: vi.fn(() => restoredSession) },
  ping: vi.fn<(...args: []) => Promise<void>>(),
  extend: vi.fn<(...args: []) => Promise<void>>(),
  disconnect: vi.fn<(...args: []) => Promise<void>>(),
  connect: vi.fn(async () => ({
    uri: 'wc:new-topic@2?symKey=key',
    approval: () => new Promise<SessionTypes.Struct>(() => {})
  })),
  on: vi.fn(),
  core: {
    relayer: { on: vi.fn(), off: vi.fn() },
    pairing: { events: { on: vi.fn() }, ping: vi.fn(async () => {}) }
  }
}

// esbuild does not inline const enums from built dependencies. Load the source enum.
vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  ...(await vi.importActual<
    typeof import('../../../beacon-core/src/transports/clients/ClientEvents')
  >('../../../beacon-core/src/transports/clients/ClientEvents'))
}))

vi.mock('@walletconnect/sign-client', () => ({ default: { init: async () => mockRemote } }))
// Match the SDK's USER_DISCONNECTED reason without loading its ESM-only crypto dependencies in JSDOM.
vi.mock('@walletconnect/utils', () => ({
  getSdkError: () => ({ code: 6000, message: 'User disconnected.' })
}))

class LocalBroadcastChannel {
  onmessage: unknown
  onmessageerror: unknown
  postMessage(_message: unknown): void {}
  close(): void {}
}

describe('WalletConnect restored-session failure containment', () => {
  const originalChannel = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel')

  beforeAll(() => {
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      value: LocalBroadcastChannel
    })
  })
  afterAll(() => {
    if (originalChannel) {
      Object.defineProperty(globalThis, 'BroadcastChannel', originalChannel)
    } else {
      Reflect.deleteProperty(globalThis, 'BroadcastChannel')
    }
  })
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    localStorage.clear()
    Object.defineProperty(restoredSession, 'expiry', {
      configurable: true,
      writable: true,
      value: Math.floor(Date.now() / 1000) + 3600
    })
    mockRemote.session.keys = ['restored-topic']
    mockRemote.ping.mockResolvedValue(undefined)
    mockRemote.extend.mockResolvedValue(undefined)
    mockRemote.disconnect.mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function client(): WalletConnectCommunicationClient {
    return new WalletConnectCommunicationClient(
      { network: NetworkType.MAINNET, opts: {} },
      async () => true
    )
  }

  it.each([
    { label: 'null', failure: null, closes: true },
    { label: 'throwing message getter', failure: { get message(): string { throw new Error('getter failed') } }, closes: true },
    { label: 'plain string', failure: 'Wallet rejected pairing', closes: false }
  ])('contains a $label proposal rejection without abandoning recovery', async ({ failure, closes }) => {
    mockRemote.session.keys = []
    mockRemote.connect.mockResolvedValueOnce({
      uri: 'wc:new-topic@2?symKey=key',
      approval: () => Promise.reject(failure)
    })
    const instance = client()
    const closeAlert = vi.fn()
    const proposalError = vi.fn()
    instance.eventHandlers.set(ClientEvents.CLOSE_ALERT, closeAlert)
    instance.eventHandlers.set(ClientEvents.WC_ACK_NOTIFICATION, proposalError)
    await instance.init()
    await vi.waitFor(() => expect(closes ? closeAlert : proposalError).toHaveBeenCalledWith(
      closes ? 'walletconnect' : 'error'
    ))
    expect(instance.currentSession()).toBeUndefined()
    await expect(instance.init()).resolves.toEqual({
      uri: 'wc:new-topic@2?symKey=key',
      topic: 'new-topic'
    })
    expect(mockRemote.connect).toHaveBeenCalledTimes(2)
  })

  it.each([
    { event: ClientEvents.CLOSE_ALERT, failure: null, context: 'close alert callback' },
    {
      event: ClientEvents.WC_ACK_NOTIFICATION,
      failure: 'Wallet rejected pairing',
      context: 'pairing error callback'
    }
  ])(
    'reports rejected $event callbacks while retiring a failed proposal',
    async ({ event, failure, context }) => {
      mockRemote.session.keys = []
      mockRemote.connect.mockResolvedValueOnce({
        uri: 'wc:new-topic@2?symKey=key',
        approval: () => Promise.reject(failure)
      })
      const warn = vi.spyOn(Logger.prototype, 'warn')
      const instance = client()
      instance.eventHandlers.set(event, async () => {
        throw new Error('notification failed')
      })
      await instance.init()
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(context, 'notification failed'))
      expect(instance.currentSession()).toBeUndefined()
    }
  )

  it.each([
    { failure: null, diagnostic: null },
    { failure: new Error('relay unavailable'), diagnostic: 'relay unavailable' }
  ])(
    'continues to new pairing when validation and cleanup reject with $failure',
    async ({ failure, diagnostic }) => {
      mockRemote.ping.mockRejectedValue(failure)
      mockRemote.disconnect.mockRejectedValue(failure)
      const warn = vi.spyOn(Logger.prototype, 'warn')
      const instance = client()

      await expect(instance.init()).resolves.toEqual({
        uri: 'wc:new-topic@2?symKey=key',
        topic: 'new-topic'
      })

      expect(warn).toHaveBeenCalledWith('Session validation failed: ping failed', diagnostic)
      expect(warn).toHaveBeenCalledWith('Error cleaning up stale session', diagnostic)
      expect(mockRemote.disconnect).toHaveBeenCalledWith({
        topic: 'restored-topic',
        reason: expect.objectContaining({ code: 6000 })
      })
      expect(instance.currentSession()).toBeUndefined()
      expect(mockRemote.connect).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    { failure: null, diagnostic: null },
    { failure: 'relay unavailable', diagnostic: 'relay unavailable' },
    { failure: { message: 'relay conflict' }, diagnostic: 'relay conflict' }
  ])(
    'retains the valid session and original diagnostic when extension rejects with $failure',
    async ({ failure, diagnostic }) => {
      mockRemote.extend.mockRejectedValue(failure)
      const warn = vi.spyOn(Logger.prototype, 'warn')
      const error = vi.spyOn(Logger.prototype, 'error')
      const instance = client()

      await expect(instance.init()).resolves.toBeUndefined()

      expect(warn).toHaveBeenCalledWith('Session extension failed, continuing anyway', {
        error: diagnostic,
        remainingHours: '1.0'
      })
      expect(
        error.mock.calls.filter(
          ([message]) => message === 'Unexpected error in checkAndExtendSession'
        )
      ).toEqual([])
      expect(instance.currentSession()).toBe(restoredSession)
      await expect(instance.getAccountOrPK()).resolves.toBe('tz1account')
      expect(mockRemote.connect).not.toHaveBeenCalled()
    }
  )

  it('contains an unexpected extension preparation failure without replacing the restored session', async () => {
    let expiryReads = 0
    Object.defineProperty(restoredSession, 'expiry', {
      configurable: true,
      get: () => {
        if (++expiryReads === 1) {
          return Math.floor(Date.now() / 1000) + 3600
        }
        throw null
      }
    })
    const error = vi.spyOn(Logger.prototype, 'error')
    const instance = client()

    await expect(instance.init()).resolves.toBeUndefined()

    expect(error).toHaveBeenCalledWith('Unexpected error in checkAndExtendSession', null)
    expect(instance.currentSession()).toBe(restoredSession)
    expect(mockRemote.extend).not.toHaveBeenCalled()
    expect(mockRemote.connect).not.toHaveBeenCalled()
  })
  it.each([
    new Proxy(
      { message: 'relay unavailable' },
      {
        has() {
          throw new Error('property check failed')
        }
      }
    ),
    {
      get message(): string {
        throw new Error('message getter failed')
      }
    }
  ])('continues pairing when a rejection cannot be inspected', async (failure) => {
    mockRemote.ping.mockRejectedValue(failure)
    const warn = vi.spyOn(Logger.prototype, 'warn')

    await expect(client().init()).resolves.toEqual({
      uri: 'wc:new-topic@2?symKey=key',
      topic: 'new-topic'
    })

    const diagnostic = warn.mock.calls.find(
      ([label]) => label === 'Session validation failed: ping failed'
    )
    expect(diagnostic?.[1]).toBe(failure)
    expect(mockRemote.connect).toHaveBeenCalledTimes(1)
  })
})
