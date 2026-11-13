import { InternalLogger, Logger, Serializer, setLogger } from '@ecadlabs/beacon-core'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import {
  BeaconErrorType,
  BeaconMessageType,
  NetworkType,
  SigningType
} from '@ecadlabs/beacon-types'
import { WalletConnectCommunicationClient } from '../../src/communication-client/WalletConnectCommunicationClient'
import {
  mockRemote,
  account,
  mockApprovals,
  mockRequests,
  mockHandlers,
  resetWire,
  session,
  flush,
  installLocalChannel
} from '../helpers/controlled-sign-client'

const pairingHandlers = new Map<string, (event: { topic: string }) => void>()
let listSession = true
const remote = {
  ...mockRemote,
  session: {
    get: mockRemote.session.get,
    getAll: mockRemote.session.getAll,
    get keys() {
      return listSession ? mockRemote.session.keys : []
    }
  },
  off(name: string, callback: (event: unknown) => void) {
    if (mockHandlers.get(name) === callback) {
      mockHandlers.delete(name)
    }
  },
  core: {
    ...mockRemote.core,
    pairing: {
      ...mockRemote.core.pairing,
      events: {
        on(name: string, callback: (event: { topic: string }) => void) {
          pairingHandlers.set(name, callback)
        },
        off(name: string, callback: (event: { topic: string }) => void) {
          if (pairingHandlers.get(name) === callback) {
            pairingHandlers.delete(name)
          }
        },
        removeAllListeners(name?: string) {
          if (name) {
            pairingHandlers.delete(name)
          } else {
            pairingHandlers.clear()
          }
        }
      }
    }
  }
}

vi.mock('@walletconnect/sign-client', () => ({ default: { init: async () => remote } }))
vi.mock('@walletconnect/utils', () => ({
  getSdkError: () => ({ code: 6000, message: 'User disconnected.' })
}))
vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  ...(await vi.importActual<
    typeof import('../../../beacon-core/src/transports/clients/ClientEvents')
  >('../../../beacon-core/src/transports/clients/ClientEvents'))
}))

describe('WalletConnect session ownership', () => {
  installLocalChannel()
  const serializer = new Serializer()
  let client: WalletConnectCommunicationClient
  let responses: unknown[]

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resetWire()
    listSession = true
    pairingHandlers.clear()
    responses = []
    client = new WalletConnectCommunicationClient(
      { network: NetworkType.MAINNET, opts: { projectId: 'offline' } },
      async () => true
    )
    await client.init()
    await client.listenForEncryptedMessage('wallet-key', async (encoded) => {
      responses.push(await serializer.deserialize(encoded))
    })
  })

  afterEach(async () => {
    await client.close()
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function sign(id: string) {
    await client.sendMessage(
      await serializer.serialize({
        id,
        version: '2',
        senderId: 'dapp',
        type: BeaconMessageType.SignPayloadRequest,
        signingType: SigningType.RAW,
        payload: id
      })
    )
    await flush()
  }

  function aborted(id: string) {
    return {
      id,
      version: '2',
      senderId: 'current',
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.ABORTED_ERROR
    }
  }

  it.each(['pairing_delete', 'pairing_expire'])(
    'keeps the active session and request after %s',
    async (event) => {
      await sign('pending')
      const handler = pairingHandlers.get(event)
      expect(handler).toBeDefined()
      handler?.({ topic: 'pairing' })
      await flush()
      expect(client.currentSession()?.topic).toBe('current')
      expect(responses).toEqual([])
      expect(mockRemote.disconnect).not.toHaveBeenCalled()
      mockRequests[0].reply.resolve({ signature: 'signed' })
      await flush()
      expect(responses).toEqual([
        {
          id: 'pending',
          version: '2',
          senderId: 'current',
          type: BeaconMessageType.SignPayloadResponse,
          signingType: SigningType.RAW,
          signature: 'signed'
        }
      ])
    }
  )

  it('disposes a topic once when delete and expiry arrive together', async () => {
    await sign('pending')
    const deleted = mockHandlers.get('session_delete')
    const expired = mockHandlers.get('session_expire')
    expect(deleted).toBeDefined()
    expect(expired).toBeDefined()
    deleted?.({ topic: 'current' })
    expired?.({ topic: 'current' })
    await flush()
    expect(client.currentSession()).toBeUndefined()
    expect(responses).toEqual([
      aborted('pending'),
      expect.objectContaining({ type: BeaconMessageType.Disconnect, senderId: 'current' })
    ])
    expect
      .soft(mockRemote.core.pairing.disconnect)
      .toHaveBeenCalledExactlyOnceWith({ topic: 'pairing' })
    mockRequests[0].reply.resolve({ signature: 'late' })
    await flush()
    expect(responses).toHaveLength(2)
  })

  it('closes the established session and aborts its request before returning a forced URI', async () => {
    await sign('pending')
    const pairing = await client.getPairingRequestInfo()
    await flush()
    expect(pairing.uri).toBe('wc:pairing@2?symKey=test')
    expect(mockRemote.disconnect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ topic: 'current' })
    )
    expect(mockRemote.core.relayer.transportClose).toHaveBeenCalledTimes(1)
    expect(client.currentSession()).toBeUndefined()
    expect(responses).toEqual([aborted('pending')])
    mockRequests[0].reply.resolve({ signature: 'late' })
    await flush()
    expect(responses).toEqual([aborted('pending')])
  })

  it.each([false, true])(
    'disconnects despite a rejecting public listener, preserving both failures: cleanupRejects=%s',
    async (cleanupRejects) => {
      const failure = new Error('Application notification failed')
      const cleanupFailure = new Error('SDK disconnect failed')
      const warn = vi.spyOn(Logger.prototype, 'warn')
      await client.getAccountOrPK()
      await client.listenForEncryptedMessage('failing-notification', async () => {
        throw failure
      })
      if (cleanupRejects) remote.disconnect.mockRejectedValueOnce(cleanupFailure)
      await expect(client.closeActiveSession(account)).rejects.toBe(failure)
      expect(remote.disconnect).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ topic: 'current' })
      )
      expect(client.currentSession()).toBeUndefined()
      if (cleanupRejects) {
        expect(warn).toHaveBeenCalledWith('closeActiveSession cleanup', 'SDK disconnect failed')
      }
    }
  )

  it.each(['lookup', 'listener'] as const)(
    'reports a failed session-update %s once and delivers the next account update',
    async (source) => {
      const failure = new Error(`${source} failed`)
      const diagnostic = vi.fn()
      setLogger({
        diagnostic,
        debug: vi.fn(),
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        time: vi.fn(),
        timeLog: vi.fn()
      })
      try {
        if (source === 'listener') {
          await client.listenForEncryptedMessage(
            'failing-update-listener',
            vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined)
          )
        }
        const current = client.currentSession()
        const update = mockHandlers.get('session_update')
        if (!current || !update) throw new Error('Missing active session or update registration')
        const event = { topic: current.topic, params: { namespaces: current.namespaces } }
        update(event)
        await flush()
        expect(mockRequests[0].input.request.method).toBe('tezos_getAccounts')
        if (source === 'lookup') {
          mockRequests[0].reply.reject(failure)
        } else {
          mockRequests[0].reply.resolve([
            { algo: 'ed25519', address: account, pubkey: 'edpk-first-public-key' }
          ])
        }
        await flush()

        expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
          level: 'warn',
          service: 'WalletConnectCommunicationClient',
          method: 'session_update active account',
          args: [`${source} failed`]
        })
        expect(client.currentSession()).toBe(current)
        expect(mockRemote.disconnect).not.toHaveBeenCalled()
        expect(responses).toEqual(
          source === 'lookup'
            ? []
            : [
                expect.objectContaining({
                  type: BeaconMessageType.ChangeAccountRequest,
                  senderId: 'current',
                  publicKey: 'edpk-first-public-key'
                })
              ]
        )

        responses.length = 0
        update(event)
        await flush()
        mockRequests[1].reply.resolve([
          { algo: 'ed25519', address: account, pubkey: 'edpk-recovered-public-key' }
        ])
        await flush()
        expect(responses).toEqual([
          expect.objectContaining({
            type: BeaconMessageType.ChangeAccountRequest,
            senderId: 'current',
            publicKey: 'edpk-recovered-public-key',
            network: { type: NetworkType.MAINNET }
          })
        ])
        expect(diagnostic).toHaveBeenCalledTimes(1)
      } finally {
        setLogger(new InternalLogger())
      }
    }
  )

  it('keeps prior requests aborted when a declined approval restores the previous session', async () => {
    await sign('prior')
    const retained = client.currentSession()
    const decline = new ExposedPromise<boolean>()
    const listener = vi.fn(() => decline.promise)
    await client.listenForChannelOpening(listener)
    // The relay no longer lists the retained session, so init requests a proposal.
    listSession = false
    await client.init()
    mockApprovals[0].resolve(session('replacement'))
    try {
      await flush()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(client.currentSession()?.topic).toBe('replacement')
      expect(responses).toEqual([aborted('prior')])
    } finally {
      decline.resolve(false)
    }
    await flush()
    expect(client.currentSession()).toBe(retained)
    expect(mockRemote.disconnect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ topic: 'replacement' })
    )
    mockRequests[0].reply.resolve({ signature: 'late' })
    await flush()
    expect(responses).toEqual([aborted('prior')])
  })

  it('keeps the initiating permission request when its approval replaces another pending request', async () => {
    await sign('prior')
    await client.sendMessage(
      await serializer.serialize({
        id: 'permission',
        version: '2',
        senderId: 'dapp',
        type: BeaconMessageType.PermissionRequest,
        network: { type: NetworkType.MAINNET },
        appMetadata: { senderId: 'dapp', name: 'Permission owner' }
      })
    )
    await flush()
    mockApprovals[0].resolve(session('replacement'))
    await flush()
    expect(client.currentSession()?.topic).toBe('replacement')
    expect(responses).toEqual([
      aborted('prior'),
      expect.objectContaining({
        id: 'permission',
        type: BeaconMessageType.PermissionResponse,
        senderId: 'replacement'
      })
    ])
    mockRequests[0].reply.resolve({ signature: 'late' })
    await flush()
    expect(responses).toHaveLength(2)
  })
})
