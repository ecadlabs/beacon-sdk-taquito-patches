// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CommunicationClient,
  LocalStorage,
  PeerManager,
  Serializer,
  Transport,
  PeerUnreachableBeaconError,
  AbortedBeaconError,
  NotGrantedBeaconError
} from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  BeaconErrorType,
  BeaconMessage,
  BeaconMessageType,
  ConnectionContext,
  ExtendedP2PPairingResponse,
  ExtendedWalletConnectPairingResponse,
  NetworkType,
  Origin,
  PeerInfoType,
  PermissionScope,
  Regions,
  SigningType,
  StorageKey,
  TransportStatus,
  TransportType
} from '@ecadlabs/beacon-types'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'
import { BeaconEvent, TransportStatusChangedInfo, WaitingForWalletAckInfo } from '../../src/events'
import { MatrixClient, MatrixClientStore } from '@ecadlabs/beacon-transport-matrix'
import { WalletConnectCommunicationClient } from '@ecadlabs/beacon-transport-walletconnect'

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

class ControlledClient extends CommunicationClient {
  async sendMessage(): Promise<void> {}
  async unsubscribeFromEncryptedMessages(): Promise<void> {}
  async unsubscribeFromEncryptedMessage(): Promise<void> {}
}

class ControlledTransport extends Transport<
  PeerInfoType,
  StorageKey.TRANSPORT_P2P_PEERS_DAPP,
  ControlledClient
> {
  public readonly type: TransportType

  constructor(storage: LocalStorage, type: TransportType = TransportType.P2P) {
    super(
      'Observability test',
      new ControlledClient(),
      new PeerManager(storage, StorageKey.TRANSPORT_P2P_PEERS_DAPP)
    )
    this.type = type
  }

  async listen(): Promise<void> {}

  async doClientCleanup(): Promise<void> {}

  async receive(message: BeaconMessage, ctx: ConnectionContext = p2pContext): Promise<void> {
    await this.notifyListeners(await new Serializer().serialize(message), ctx)
  }
}

const p2pPeer: ExtendedP2PPairingResponse = {
  id: 'p2p-peer-id',
  type: 'p2p-pairing-response',
  name: 'Test Matrix Wallet',
  publicKey: '11'.repeat(32),
  relayServer: 'matrix-1.test.ecad.io',
  senderId: 'wallet-sender-p2p',
  version: '2'
}

const wcPeer: ExtendedWalletConnectPairingResponse = {
  id: 'wc-peer-id',
  type: 'walletconnect-pairing-response',
  name: 'Test WC Wallet',
  publicKey: '22'.repeat(32),
  senderId: 'wallet-sender-wc',
  version: '2'
}

const p2pContext: ConnectionContext = { origin: Origin.P2P, id: p2pPeer.publicKey }

const p2pAccount: AccountInfo = {
  accountIdentifier: 'p2p-account-id',
  senderId: p2pPeer.senderId,
  origin: { type: Origin.P2P, id: p2pPeer.publicKey },
  address: 'tz1TGu6TN5GSez2ndXXeDX6LgUDvLzPLqgYV',
  network: { type: NetworkType.MAINNET },
  scopes: [PermissionScope.OPERATION_REQUEST, PermissionScope.SIGN],
  connectedAt: 1,
  walletType: 'implicit'
}

const wcAccount: AccountInfo = {
  accountIdentifier: 'wc-account-id',
  senderId: wcPeer.senderId,
  origin: { type: Origin.WALLETCONNECT, id: wcPeer.publicKey },
  address: 'tz1TGu6TN5GSez2ndXXeDX6LgUDvLzPLqgYV',
  network: { type: NetworkType.MAINNET },
  scopes: [PermissionScope.OPERATION_REQUEST, PermissionScope.SIGN],
  connectedAt: 1,
  walletType: 'implicit'
}

describe('DAppClient connection status, health, ACK timeout, and pending requests (#150)', () => {
  let dapp: DAppClient | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    Reflect.deleteProperty(WalletConnectCommunicationClient, 'instance')
    Object.defineProperty(window, 'beaconCreatedClientInstance', {
      value: false,
      writable: true,
      configurable: true
    })
  })

  afterEach(async () => {
    await dapp?.destroy()
    dapp = undefined
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function createConfiguredClient(options: {
    transportType?: TransportType
    requestTimeoutMs?: number
    ackTimeoutMs?: number
  } = {}): Promise<{ client: DAppClient; transport: ControlledTransport }> {
    const {
      transportType = TransportType.P2P,
      requestTimeoutMs,
      ackTimeoutMs
    } = options
    const storage = new LocalStorage('dapp-observability-150')
    const transport = new ControlledTransport(storage, transportType)
    const client = new DAppClient({
      name: 'Observability test',
      storage,
      disableDefaultEvents: true,
      enableAppSwitching: false,
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
      ...(ackTimeoutMs !== undefined ? { ackTimeoutMs } : {})
    })
    dapp = client

    const activePeer = transportType === TransportType.WALLETCONNECT ? wcPeer : p2pPeer
    const activeAccount = transportType === TransportType.WALLETCONNECT ? wcAccount : p2pAccount

    await client.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    await client.getActiveAccount()
    await client.init(transport as unknown as Transport<PeerInfoType>)
    client['resolveActivePeer'](activePeer)
    client['resolveActiveAccount'](activeAccount)
    vi.spyOn(client, 'getActiveAccount').mockResolvedValue(activeAccount)
    vi.spyOn(client, 'getPeer').mockResolvedValue(activePeer)
    vi.spyOn(client, 'checkPermissions').mockResolvedValue(true)
    client['tryToAppSwitch'] = async () => {}
    vi.spyOn(transport, 'send').mockResolvedValue(undefined)

    return { client, transport }
  }

  async function getSentRequestIdAt(transport: ControlledTransport, index: number): Promise<string> {
    const calls = vi.mocked(transport.send).mock.calls
    const call = calls[index]
    const deserialized = (await new Serializer().deserialize(call[0])) as { id: string }
    return deserialized.id
  }

  async function getLastSentRequestId(transport: ControlledTransport): Promise<string> {
    const calls = vi.mocked(transport.send).mock.calls
    return getSentRequestIdAt(transport, calls.length - 1)
  }

  describe('getConnectionInfo()', () => {
    it('resolves immediately without blocking when no transport is active', async () => {
      const storage = new LocalStorage('dapp-disconnected-info')
      dapp = new DAppClient({
        name: 'Disconnected test',
        storage,
        disableDefaultEvents: true
      })

      const info = await dapp.getConnectionInfo()

      expect(info).toEqual({
        transport: undefined,
        status: TransportStatus.NOT_CONNECTED,
        health: 'ok',
        relayServer: undefined,
        senderId: undefined
      })
    })

    it('reflects transport, status, health, senderId, and resets after disconnect()', async () => {
      const { client, transport } = await createConfiguredClient({
        transportType: TransportType.P2P
      })
      await transport.connect()

      expect(await client.getConnectionInfo()).toEqual({
        transport: TransportType.P2P,
        status: TransportStatus.CONNECTED,
        health: 'ok',
        relayServer: undefined,
        senderId: p2pPeer.senderId
      })

      vi.mocked(client.getActiveAccount).mockRestore()
      await client.disconnect({ notifyPeers: false })

      expect(await client.getConnectionInfo()).toEqual({
        transport: undefined,
        status: TransportStatus.NOT_CONNECTED,
        health: 'ok',
        relayServer: undefined,
        senderId: undefined
      })
    })
  })

  describe('BeaconEvent.TRANSPORT_STATUS_CHANGED', () => {
    it('reports real WalletConnect status transitions including SECONDARY_TAB_CONNECTED, leader promotion, and disconnect', async () => {
      const storage = new LocalStorage('dapp-wc-status-transitions')
      let isLeader = false
      const wcTransport = new DappWalletConnectTransport(
        'WC transition test',
        { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64), keyType: 'ed25519' },
        storage,
        { network: NetworkType.MAINNET, opts: { projectId: 'test-project' } },
        async () => isLeader
      )
      vi.spyOn(wcTransport['client'], 'init').mockResolvedValue(undefined)
      vi.spyOn(wcTransport['client'], 'close').mockResolvedValue(undefined)
      vi.spyOn(wcTransport, 'startOpenChannelListener').mockResolvedValue(undefined)

      dapp = new DAppClient({
        name: 'WC transition test',
        storage,
        disableDefaultEvents: true
      })
      await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})

      const events: TransportStatusChangedInfo[] = []
      await dapp.subscribeToEvent(BeaconEvent.TRANSPORT_STATUS_CHANGED, (event) => {
        events.push(event)
      })

      await dapp.init(wcTransport)

      // 1. Connect as follower tab -> CONNECTING -> SECONDARY_TAB_CONNECTED
      await wcTransport.connect()
      expect(await dapp.getConnectionInfo()).toMatchObject({
        transport: TransportType.WALLETCONNECT,
        status: TransportStatus.SECONDARY_TAB_CONNECTED,
        health: 'ok'
      })

      // 2. Promote follower tab to leader -> CONNECTING -> CONNECTED
      isLeader = true
      await wcTransport.connect()
      expect(await dapp.getConnectionInfo()).toMatchObject({
        transport: TransportType.WALLETCONNECT,
        status: TransportStatus.CONNECTED,
        health: 'ok'
      })

      // 3. Disconnect -> NOT_CONNECTED
      await wcTransport.disconnect()

      expect(events).toEqual([
        {
          transport: TransportType.WALLETCONNECT,
          previous: TransportStatus.NOT_CONNECTED,
          status: TransportStatus.CONNECTING,
          health: 'ok'
        },
        {
          transport: TransportType.WALLETCONNECT,
          previous: TransportStatus.CONNECTING,
          status: TransportStatus.SECONDARY_TAB_CONNECTED,
          health: 'ok'
        },
        {
          transport: TransportType.WALLETCONNECT,
          previous: TransportStatus.SECONDARY_TAB_CONNECTED,
          status: TransportStatus.CONNECTING,
          health: 'ok'
        },
        {
          transport: TransportType.WALLETCONNECT,
          previous: TransportStatus.CONNECTING,
          status: TransportStatus.CONNECTED,
          health: 'ok'
        },
        {
          transport: TransportType.WALLETCONNECT,
          previous: TransportStatus.CONNECTED,
          status: TransportStatus.NOT_CONNECTED,
          health: 'ok'
        }
      ])
    })

    it('Matrix: resets failure count on intermediate success, moves health to degraded after 3 consecutive failures, recovers to ok, and resets health on disconnect', async () => {
      const storage = new LocalStorage('dapp-matrix-health')
      dapp = new DAppClient({
        name: 'Matrix health test',
        storage,
        disableDefaultEvents: true,
        matrixNodes: {
          [Regions.EU1]: ['matrix-1.test.ecad.io']
        }
      })
      await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
      await dapp.initInternalTransports()

      const p2pTransport = dapp['p2pTransport'] as DappP2PTransport
      const realStore = new MatrixClientStore(storage)
      const login = vi.fn().mockResolvedValue({ access_token: 'token-1' })
      const sync = vi.fn().mockResolvedValue({ next_batch: 'batch-1', rooms: {} })
      const matrixClient = new MatrixClient(
        realStore,
        { onStateChanged: vi.fn(), on: vi.fn(), removeListener: vi.fn() } as never,
        { login } as never,
        {} as never,
        { sync } as never,
        { cancelAllRequests: vi.fn().mockResolvedValue(undefined) } as never
      )

      vi.spyOn(MatrixClient, 'create').mockReturnValue(matrixClient)
      const commClient = p2pTransport['client']
      await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'matrix-1.test.ecad.io')
      vi.spyOn(commClient as unknown as { getBeaconInfo: () => Promise<{ timestamp: number }> }, 'getBeaconInfo')
        .mockResolvedValue({ timestamp: 1_700_000_000 })
      vi.spyOn(commClient, 'listenForChannelOpening').mockResolvedValue(undefined)

      const events: TransportStatusChangedInfo[] = []
      await dapp.subscribeToEvent(BeaconEvent.TRANSPORT_STATUS_CHANGED, (event) => {
        events.push(event)
      })

      let firstPoll = true
      const stepPoll = async (ms = 0): Promise<void> => {
        const delta = ms > 0 ? ms : firstPoll ? 0 : 1
        firstPoll = false
        await vi.advanceTimersByTimeAsync(delta)
      }

      await dapp.init(p2pTransport)
      await p2pTransport.connect()
      for (let i = 0; i < 8; i++) {
        await Promise.resolve()
      }
      events.length = 0

      // 2 failures followed by 1 success must reset the consecutive failure counter
      sync
        .mockRejectedValueOnce(new Error('transient failure 1'))
        .mockRejectedValueOnce(new Error('transient failure 2'))
        .mockResolvedValueOnce({ next_batch: 'batch-ok', rooms: {} })
        // Then 4 consecutive failures: 3rd triggers degraded, 4th does not re-emit
        .mockRejectedValueOnce(new Error('consecutive failure 1'))
        .mockRejectedValueOnce(new Error('consecutive failure 2'))
        .mockRejectedValueOnce(new Error('consecutive failure 3'))
        .mockRejectedValueOnce(new Error('consecutive failure 4'))
        // Recovery sync
        .mockResolvedValue({ next_batch: 'batch-recovered', rooms: {} })

      // Transient failures 1 & 2 + recovery
      await stepPoll(0)
      await stepPoll(0)
      await stepPoll(0)
      expect(events).toEqual([])

      // Consecutive failures 1 & 2 (must not degrade on failure 1 even though 2 transient failures occurred earlier)
      await stepPoll(0)
      expect(events).toEqual([])
      await stepPoll(0)
      expect(events).toEqual([])

      // Consecutive failure 3 -> degraded
      await stepPoll(0)
      expect(events).toEqual([
        {
          transport: TransportType.P2P,
          status: TransportStatus.CONNECTED,
          previous: TransportStatus.CONNECTED,
          health: 'degraded',
          reason: 'sync_failing',
          relayServer: 'matrix-1.test.ecad.io'
        }
      ])

      const degradedInfo = await dapp.getConnectionInfo()
      expect(degradedInfo.health).toBe('degraded')
      expect(degradedInfo.relayServer).toBe('matrix-1.test.ecad.io')

      // Consecutive failure 4 -> still degraded, no duplicate event
      await stepPoll(0)
      expect(events).toHaveLength(1)

      // Recovery on next sync after backoff (5000ms) -> back to ok
      await stepPoll(5_000)
      expect(events).toEqual([
        {
          transport: TransportType.P2P,
          status: TransportStatus.CONNECTED,
          previous: TransportStatus.CONNECTED,
          health: 'degraded',
          reason: 'sync_failing',
          relayServer: 'matrix-1.test.ecad.io'
        },
        {
          transport: TransportType.P2P,
          status: TransportStatus.CONNECTED,
          previous: TransportStatus.CONNECTED,
          health: 'ok',
          relayServer: 'matrix-1.test.ecad.io'
        }
      ])

      const recoveredInfo = await dapp.getConnectionInfo()
      expect(recoveredInfo.health).toBe('ok')

      // Subsequent successful sync -> no duplicate ok event
      await stepPoll(0)
      expect(events).toHaveLength(2)

      // Degrade again and verify disconnect() resets health to 'ok'
      sync
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockRejectedValueOnce(new Error('fail 3'))
      await stepPoll(0)
      await stepPoll(0)
      await stepPoll(0)
      expect((await dapp.getConnectionInfo()).health).toBe('degraded')

      await p2pTransport.disconnect()
      expect(events[events.length - 1]).toEqual({
        transport: TransportType.P2P,
        status: TransportStatus.NOT_CONNECTED,
        previous: TransportStatus.CONNECTED,
        health: 'ok',
        relayServer: 'matrix-1.test.ecad.io'
      })
      expect((await dapp.getConnectionInfo()).health).toBe('ok')
    })

    it('Matrix: M_UNKNOWN_TOKEN renewal emits reason: token_renewed', async () => {
      const storage = new LocalStorage('dapp-matrix-token-renewed')
      dapp = new DAppClient({
        name: 'Matrix token renewal test',
        storage,
        disableDefaultEvents: true,
        matrixNodes: {
          [Regions.EU1]: ['matrix-1.test.ecad.io']
        }
      })
      await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
      await dapp.initInternalTransports()

      const p2pTransport = dapp['p2pTransport'] as DappP2PTransport
      const realStore = new MatrixClientStore(storage)
      const login = vi
        .fn()
        .mockResolvedValueOnce({ access_token: 'initial-token' })
        .mockResolvedValue({ access_token: 'renewed-token' })
      const sync = vi.fn().mockResolvedValue({ next_batch: 'batch-1', rooms: {} })
      const matrixClient = new MatrixClient(
        realStore,
        { onStateChanged: vi.fn(), on: vi.fn(), removeListener: vi.fn() } as never,
        { login } as never,
        {} as never,
        { sync } as never,
        { cancelAllRequests: vi.fn().mockResolvedValue(undefined) } as never
      )

      vi.spyOn(MatrixClient, 'create').mockReturnValue(matrixClient)
      const commClient = p2pTransport['client']
      await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'matrix-1.test.ecad.io')
      vi.spyOn(commClient as unknown as { getBeaconInfo: () => Promise<{ timestamp: number }> }, 'getBeaconInfo')
        .mockResolvedValue({ timestamp: 1_700_000_000 })
      vi.spyOn(commClient, 'listenForChannelOpening').mockResolvedValue(undefined)

      const events: TransportStatusChangedInfo[] = []
      await dapp.subscribeToEvent(BeaconEvent.TRANSPORT_STATUS_CHANGED, (event) => {
        events.push(event)
      })

      await dapp.init(p2pTransport)
      await p2pTransport.connect()
      events.length = 0

      sync.mockRejectedValueOnce({ errcode: 'M_UNKNOWN_TOKEN' })
      await vi.advanceTimersByTimeAsync(0)

      expect(login).toHaveBeenCalledTimes(2)
      expect(events).toEqual([
        {
          transport: TransportType.P2P,
          status: TransportStatus.CONNECTED,
          previous: TransportStatus.CONNECTED,
          health: 'ok',
          reason: 'token_renewed',
          relayServer: 'matrix-1.test.ecad.io'
        }
      ])
    })

    it('Matrix: relay failover during startup or re-discovery emits reason: relay_changed with updated relayServer', async () => {
      const storage = new LocalStorage('dapp-matrix-relay-changed')
      dapp = new DAppClient({
        name: 'Matrix relay changed test',
        storage,
        disableDefaultEvents: true,
        matrixNodes: {
          [Regions.EU1]: ['matrix-1.test.ecad.io', 'matrix-2.test.ecad.io']
        }
      })
      await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
      await dapp.initInternalTransports()

      const p2pTransport = dapp['p2pTransport'] as DappP2PTransport
      const commClient = p2pTransport['client']
      await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'matrix-1.test.ecad.io')

      let failFirstNode = false
      vi.spyOn(
        commClient as unknown as {
          getBeaconInfo: (node: string) => Promise<{ timestamp: number }>
        },
        'getBeaconInfo'
      ).mockImplementation(async (node: string) => {
        if (node !== 'matrix-1.test.ecad.io' && node !== 'matrix-2.test.ecad.io') {
          throw new Error('unconfigured node')
        }
        if (node === 'matrix-1.test.ecad.io' && failFirstNode) {
          throw new Error('node down')
        }
        return { timestamp: 1_700_000_000 }
      })
      vi.spyOn(commClient, 'listenForChannelOpening').mockResolvedValue(undefined)

      let createdCount = 0
      vi.spyOn(MatrixClient, 'create').mockImplementation(() => {
        createdCount++
        const client = new MatrixClient(
          new MatrixClientStore(storage),
          { onStateChanged: vi.fn(), on: vi.fn(), removeListener: vi.fn() } as never,
          {
            login: vi.fn().mockImplementation(async () => {
              if (createdCount === 1) {
                failFirstNode = true
                throw new Error('matrix-1 login failed')
              }
              return { access_token: 'token-2' }
            })
          } as never,
          {} as never,
          { sync: vi.fn().mockResolvedValue({ next_batch: 'batch-1', rooms: {} }) } as never,
          { cancelAllRequests: vi.fn().mockResolvedValue(undefined) } as never
        )
        return client
      })

      const events: TransportStatusChangedInfo[] = []
      await dapp.subscribeToEvent(BeaconEvent.TRANSPORT_STATUS_CHANGED, (event) => {
        events.push(event)
      })

      await dapp.init(p2pTransport)
      await p2pTransport.connect()

      expect(events).toContainEqual({
        transport: TransportType.P2P,
        status: TransportStatus.CONNECTING,
        previous: TransportStatus.CONNECTING,
        health: 'ok',
        reason: 'relay_changed',
        relayServer: 'matrix-2.test.ecad.io'
      })

      const connectionInfo = await dapp.getConnectionInfo()
      expect(connectionInfo.relayServer).toBe('matrix-2.test.ecad.io')
    })

    it.each([
      ['session_delete', 'session_deleted'],
      ['session_expire', 'session_expired']
    ] as const)(
      'WalletConnect: %s ignores unrelated topics and emits reason %s once before the active account is cleared',
      async (wcEvent, expectedReason) => {
        const storage = new LocalStorage(`dapp-wc-${wcEvent}`)

        dapp = new DAppClient({
          name: `WC ${wcEvent} test`,
          storage,
          disableDefaultEvents: true,
          walletConnectOptions: {
            projectId: 'test-project-id'
          }
        })

        const callOrder: string[] = []
        let accountDuringStatusChange: AccountInfo | undefined
        const statusEvents: TransportStatusChangedInfo[] = []

        await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, (account) => {
          if (account === undefined) {
            callOrder.push('account_cleared')
          }
        })
        await dapp.getActiveAccount()
        await dapp.initInternalTransports()

        const wcTransport = dapp['walletConnectTransport'] as DappWalletConnectTransport
        const wcClient = wcTransport['client']
        vi.spyOn(wcClient, 'init').mockResolvedValue(undefined)
        vi.spyOn(wcTransport, 'startOpenChannelListener').mockResolvedValue(undefined)

        const signClientHandlers = new Map<string, (event: { topic: string }) => void>()
        const fakeSignClient = {
          on: (event: string, cb: (payload: { topic: string }) => void) => {
            signClientHandlers.set(event, cb)
          },
          off: vi.fn(),
          disconnect: vi.fn().mockResolvedValue(undefined),
          pairing: {
            getAll: vi.fn().mockReturnValue([])
          },
          session: {
            get: vi.fn(),
            getAll: vi.fn().mockReturnValue([]),
            keys: []
          },
          core: {
            pairing: {
              getPairings: vi.fn().mockReturnValue([]),
              disconnect: vi.fn().mockResolvedValue(undefined),
              events: {
                on: vi.fn(),
                off: vi.fn(),
                removeAllListeners: vi.fn()
              }
            },
            relayer: {
              on: vi.fn(),
              off: vi.fn()
            }
          }
        }

        const activeSession = {
          topic: wcPeer.senderId,
          pairingTopic: 'wc-pairing-topic',
          peer: {
            publicKey: wcPeer.publicKey,
            metadata: { name: wcPeer.name, description: '', url: '', icons: [] }
          },
          namespaces: {
            tezos: {
              accounts: [`tezos:mainnet:${wcAccount.address}`],
              methods: [],
              events: []
            }
          }
        }

        await storage.set(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP, [wcPeer])
        await storage.set(StorageKey.ACCOUNTS, [wcAccount])
        await storage.set(StorageKey.ACTIVE_ACCOUNT, wcAccount.accountIdentifier)

        wcClient['signClient'] = fakeSignClient as never
        wcClient['session'] = activeSession as never
        wcClient['activeAccountOrPbk'] = [wcAccount.address, wcPeer.publicKey]
        wcClient['subscribeToSessionEvents'](fakeSignClient as never)

        await dapp.init(wcTransport)
        await wcTransport.connect()
        dapp['resolveActivePeer'](wcPeer)
        dapp['resolveActiveAccount'](wcAccount)
        await wcTransport.listen(wcPeer.publicKey)

        await dapp.subscribeToEvent(BeaconEvent.TRANSPORT_STATUS_CHANGED, async (event) => {
          statusEvents.push(event)
          callOrder.push(`transport_status:${event.reason ?? event.status}`)
          accountDuringStatusChange = await dapp?.getActiveAccount()
        })

        statusEvents.length = 0
        callOrder.length = 0

        const handler = signClientHandlers.get(wcEvent)
        expect(handler).toBeDefined()

        // Unrelated topic must be ignored completely
        handler?.({ topic: 'unrelated-topic' })
        await vi.advanceTimersByTimeAsync(10)
        expect(statusEvents).toEqual([])
        expect((await dapp.getActiveAccount())?.accountIdentifier).toBe(wcAccount.accountIdentifier)

        // Matching topic emits TRANSPORT_STATUS_CHANGED with reason before clearing active account
        handler?.({ topic: wcPeer.senderId })
        await vi.advanceTimersByTimeAsync(10)

        expect(statusEvents).toEqual([
          {
            transport: TransportType.WALLETCONNECT,
            status: TransportStatus.NOT_CONNECTED,
            previous: TransportStatus.CONNECTED,
            health: 'ok',
            reason: expectedReason
          }
        ])
        expect(accountDuringStatusChange?.accountIdentifier).toBe(wcAccount.accountIdentifier)
        expect(callOrder).toEqual([`transport_status:${expectedReason}`, 'account_cleared'])
        expect(await dapp.getActiveAccount()).toBeUndefined()
      }
    )

    it('unsubscribes custom transport status listeners on destroy()', async () => {
      const storage = new LocalStorage('dapp-destroy-custom-transport')
      const customTransport = new ControlledTransport(storage, TransportType.P2P)
      dapp = new DAppClient({
        name: 'Destroy custom transport test',
        storage,
        disableDefaultEvents: true
      })
      await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})

      const events: TransportStatusChangedInfo[] = []
      await dapp.subscribeToEvent(BeaconEvent.TRANSPORT_STATUS_CHANGED, (event) => {
        events.push(event)
      })

      await dapp.init(customTransport as unknown as ClientTransport)
      await customTransport.connect()
      expect(events).toEqual([
        {
          transport: TransportType.P2P,
          previous: TransportStatus.NOT_CONNECTED,
          status: TransportStatus.CONNECTED,
          health: 'ok'
        }
      ])

      await dapp.destroy()
      events.length = 0

      await customTransport.disconnect()
      await customTransport.connect()
      expect(events).toEqual([])
    })

    it('suppresses candidate transport status noise during multi-transport pairing and emits NOT_CONNECTED -> CONNECTED only when a winner is selected', async () => {
      const storage = new LocalStorage('dapp-multi-transport-pairing')
      dapp = new DAppClient({
        name: 'Multi-transport pairing test',
        storage,
        disableDefaultEvents: true
      })
      await dapp.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
      await dapp.getActiveAccount()
      await dapp.initInternalTransports()

      const postMessageTransport = dapp['postMessageTransport']!
      const p2pTransport = dapp['p2pTransport']!
      const wcTransport = dapp['walletConnectTransport']!

      let p2pPeerCallback: ((peer: ExtendedP2PPairingResponse) => Promise<boolean> | void) | undefined
      vi.spyOn(postMessageTransport, 'connect').mockImplementation(async () => {
        postMessageTransport['updateConnectionStatus']({ status: TransportStatus.CONNECTED })
      })
      vi.spyOn(postMessageTransport, 'listenForNewPeer').mockResolvedValue(undefined)
      vi.spyOn(p2pTransport, 'connect').mockImplementation(async () => {
        p2pTransport['updateConnectionStatus']({ status: TransportStatus.CONNECTING })
        p2pTransport['updateConnectionStatus']({ status: TransportStatus.CONNECTED })
      })
      vi.spyOn(p2pTransport, 'listenForNewPeer').mockImplementation(async (cb) => {
        p2pPeerCallback = cb
      })
      vi.spyOn(wcTransport, 'listenForNewPeer').mockResolvedValue(undefined)

      const events: TransportStatusChangedInfo[] = []
      await dapp.subscribeToEvent(BeaconEvent.TRANSPORT_STATUS_CHANGED, (event) => {
        events.push(event)
      })

      const initPromise = dapp.init()
      await vi.advanceTimersByTimeAsync(0)

      // Candidate transports connecting during multi-transport pairing must not emit noise
      expect(events).toEqual([])
      expect(await dapp.getConnectionInfo()).toEqual({
        status: TransportStatus.NOT_CONNECTED,
        health: 'ok'
      })

      // Winning P2P peer pairs -> emits single NOT_CONNECTED -> CONNECTED transition for P2P
      await p2pPeerCallback?.(p2pPeer)
      await expect(initPromise).resolves.toBe(TransportType.P2P)

      expect(events).toEqual([
        {
          transport: TransportType.P2P,
          previous: TransportStatus.NOT_CONNECTED,
          status: TransportStatus.CONNECTED,
          health: 'ok'
        }
      ])
    })
  })

  describe('getPendingRequests()', () => {
    it('reflects send, correlated ACK, defensive copies, and success completion on Matrix (P2P)', async () => {
      const { client, transport } = await createConfiguredClient({
        transportType: TransportType.P2P,
        requestTimeoutMs: 30_000
      })

      expect(client.getPendingRequests()).toEqual([])

      const opPromise = client.requestOperation({
        operationDetails: [{ kind: 'transaction' as never, amount: '1', destination: p2pAccount.address }]
      })
      opPromise.catch(() => undefined)

      await vi.advanceTimersByTimeAsync(0)
      const requestId = await getLastSentRequestId(transport)

      const pendingAfterSend = client.getPendingRequests()
      expect(pendingAfterSend).toHaveLength(1)
      expect(pendingAfterSend[0]).toEqual({
        id: requestId,
        type: BeaconMessageType.OperationRequest,
        transport: TransportType.P2P,
        senderId: p2pPeer.senderId,
        sentAt: expect.any(Number),
        deadline: pendingAfterSend[0].sentAt + 30_000,
        acknowledged: false
      })

      // Returned array and entries are immutable / defensive snapshots
      expect(Object.isFrozen(pendingAfterSend)).toBe(true)
      expect(Object.isFrozen(pendingAfterSend[0])).toBe(true)

      // Deliver correlated ACK
      await transport.receive({
        id: requestId,
        version: '2',
        senderId: p2pPeer.senderId,
        type: BeaconMessageType.Acknowledge
      })

      const pendingAfterAck = client.getPendingRequests()
      expect(pendingAfterAck).toHaveLength(1)
      expect(pendingAfterAck[0]).toEqual({
        id: requestId,
        type: BeaconMessageType.OperationRequest,
        transport: TransportType.P2P,
        senderId: p2pPeer.senderId,
        sentAt: pendingAfterSend[0].sentAt,
        deadline: undefined,
        acknowledged: true
      })

      // Deliver success response
      await transport.receive({
        id: requestId,
        version: '2',
        senderId: p2pPeer.senderId,
        type: BeaconMessageType.OperationResponse,
        transactionHash: 'oo123456'
      })

      await expect(opPromise).resolves.toMatchObject({ transactionHash: 'oo123456' })
      expect(client.getPendingRequests()).toEqual([])
    })

    it('tracks permission requests (with default 60s deadline) and multiple concurrent requests independently', async () => {
      const { client, transport } = await createConfiguredClient({
        transportType: TransportType.P2P
      })

      const permPromise = client.requestPermissions()
      permPromise.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      const permReqId = await getSentRequestIdAt(transport, 0)

      const signPromise = client.requestSignPayload({
        signingType: SigningType.RAW,
        payload: '050100'
      })
      signPromise.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      const signReqId = await getSentRequestIdAt(transport, 1)

      const pending = client.getPendingRequests()
      expect(pending).toHaveLength(2)
      expect(pending[0]).toMatchObject({
        id: permReqId,
        type: BeaconMessageType.PermissionRequest,
        transport: TransportType.P2P,
        deadline: pending[0].sentAt + 60_000,
        acknowledged: false
      })
      expect(pending[1]).toMatchObject({
        id: signReqId,
        type: BeaconMessageType.SignPayloadRequest,
        transport: TransportType.P2P,
        deadline: undefined,
        acknowledged: false
      })

      // Acknowledge only the second request
      await transport.receive({
        id: signReqId,
        version: '2',
        senderId: p2pPeer.senderId,
        type: BeaconMessageType.Acknowledge
      })
      expect(client.getPendingRequests().map((r) => ({ id: r.id, acknowledged: r.acknowledged }))).toEqual([
        { id: permReqId, acknowledged: false },
        { id: signReqId, acknowledged: true }
      ])

      // Resolve the second request; first remains pending
      await transport.receive({
        id: signReqId,
        version: '2',
        senderId: p2pPeer.senderId,
        type: BeaconMessageType.SignPayloadResponse,
        signingType: SigningType.RAW,
        signature: 'edsig123'
      })
      await expect(signPromise).resolves.toMatchObject({ signature: 'edsig123' })
      expect(client.getPendingRequests().map((r) => r.id)).toEqual([permReqId])

      await client.disconnect({ notifyPeers: false })
      await expect(permPromise).rejects.toBeInstanceOf(AbortedBeaconError)
      expect(client.getPendingRequests()).toEqual([])
    })

    it('removes pending request on wallet error response, timeout, and disconnect', async () => {
      const { client, transport } = await createConfiguredClient({
        transportType: TransportType.P2P,
        requestTimeoutMs: 10_000
      })

      // 1. Wallet error response
      const errorPromise = client.requestSignPayload({
        signingType: SigningType.RAW,
        payload: '050100'
      })
      errorPromise.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      const errorReqId = await getLastSentRequestId(transport)
      expect(client.getPendingRequests().map((r) => r.id)).toEqual([errorReqId])

      await transport.receive({
        id: errorReqId,
        version: '2',
        senderId: p2pPeer.senderId,
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.NOT_GRANTED_ERROR
      })
      await expect(errorPromise).rejects.toBeInstanceOf(NotGrantedBeaconError)
      expect(client.getPendingRequests()).toEqual([])

      // 2. Timeout
      const timeoutPromise = client.requestSignPayload({
        signingType: SigningType.RAW,
        payload: '050100'
      })
      timeoutPromise.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      const timeoutReqId = await getLastSentRequestId(transport)
      expect(client.getPendingRequests().map((r) => r.id)).toEqual([timeoutReqId])

      await vi.advanceTimersByTimeAsync(10_000)
      await expect(timeoutPromise).rejects.toBeInstanceOf(PeerUnreachableBeaconError)
      expect(client.getPendingRequests()).toEqual([])

      // 3. Disconnect
      const disconnectPromise = client.requestSignPayload({
        signingType: SigningType.RAW,
        payload: '050100'
      })
      disconnectPromise.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      const disconnectReqId = await getLastSentRequestId(transport)
      expect(client.getPendingRequests().map((r) => r.id)).toEqual([disconnectReqId])

      await client.disconnect({ notifyPeers: false })
      await expect(disconnectPromise).rejects.toBeInstanceOf(AbortedBeaconError)
      expect(client.getPendingRequests()).toEqual([])
    })

    it('sets acknowledged to undefined for WalletConnect requests', async () => {
      const { client, transport } = await createConfiguredClient({
        transportType: TransportType.WALLETCONNECT
      })

      const signPromise = client.requestSignPayload({
        signingType: SigningType.RAW,
        payload: '050100'
      })
      signPromise.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      const requestId = await getLastSentRequestId(transport)

      const pending = client.getPendingRequests()
      expect(pending).toEqual([
        {
          id: requestId,
          type: BeaconMessageType.SignPayloadRequest,
          transport: TransportType.WALLETCONNECT,
          senderId: wcPeer.senderId,
          sentAt: expect.any(Number),
          deadline: undefined,
          acknowledged: undefined
        }
      ])

      await client.disconnect({ notifyPeers: false })
      await expect(signPromise).rejects.toBeInstanceOf(AbortedBeaconError)
    })
  })

  describe('BeaconEvent.WAITING_FOR_WALLET_ACK', () => {
    it('uses default ackTimeoutMs (5000ms) when omitted, fires once on Matrix when unacknowledged, and still resolves on delayed ACK + response', async () => {
      const { client, transport } = await createConfiguredClient({
        transportType: TransportType.P2P
      })
      const waitingEvents: WaitingForWalletAckInfo[] = []
      await client.subscribeToEvent(BeaconEvent.WAITING_FOR_WALLET_ACK, (info) => {
        waitingEvents.push(info)
      })

      const signPromise = client.requestSignPayload({
        signingType: SigningType.RAW,
        payload: '050100'
      })
      signPromise.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      const requestId = await getLastSentRequestId(transport)

      await vi.advanceTimersByTimeAsync(4_999)
      expect(waitingEvents).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      expect(waitingEvents).toEqual([
        {
          requestId,
          transport: TransportType.P2P,
          elapsedMs: 5_000
        }
      ])

      // Advancing further does not fire a duplicate WAITING_FOR_WALLET_ACK for the same request
      await vi.advanceTimersByTimeAsync(10_000)
      expect(waitingEvents).toHaveLength(1)

      // Delayed ACK arrives after WAITING_FOR_WALLET_ACK
      await transport.receive({
        id: requestId,
        version: '2',
        senderId: p2pPeer.senderId,
        type: BeaconMessageType.Acknowledge
      })
      expect(client.getPendingRequests()[0]?.acknowledged).toBe(true)

      await transport.receive({
        id: requestId,
        version: '2',
        senderId: p2pPeer.senderId,
        type: BeaconMessageType.SignPayloadResponse,
        signingType: SigningType.RAW,
        signature: 'edsig123'
      })

      await expect(signPromise).resolves.toMatchObject({ signature: 'edsig123' })
      expect(waitingEvents).toHaveLength(1)
    })

    it('does not fire when correlated ACK or direct terminal response arrives before ackTimeoutMs', async () => {
      const { client, transport } = await createConfiguredClient({
        transportType: TransportType.P2P,
        ackTimeoutMs: 2_000
      })
      const waitingEvents: WaitingForWalletAckInfo[] = []
      await client.subscribeToEvent(BeaconEvent.WAITING_FOR_WALLET_ACK, (info) => {
        waitingEvents.push(info)
      })

      // 1. Correlated ACK arrives at 500ms
      const ackedPromise = client.requestSignPayload({
        signingType: SigningType.RAW,
        payload: '050100'
      })
      ackedPromise.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      const ackedId = await getLastSentRequestId(transport)

      await vi.advanceTimersByTimeAsync(500)
      await transport.receive({
        id: ackedId,
        version: '2',
        senderId: p2pPeer.senderId,
        type: BeaconMessageType.Acknowledge
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(waitingEvents).toEqual([])

      await transport.receive({
        id: ackedId,
        version: '2',
        senderId: p2pPeer.senderId,
        type: BeaconMessageType.SignPayloadResponse,
        signingType: SigningType.RAW,
        signature: 'edsig123'
      })
      await expect(ackedPromise).resolves.toMatchObject({ signature: 'edsig123' })

      // 2. Direct terminal response arrives at 500ms WITHOUT an intermediate ACK
      const directPromise = client.requestSignPayload({
        signingType: SigningType.RAW,
        payload: '050100'
      })
      directPromise.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      const directId = await getLastSentRequestId(transport)

      await vi.advanceTimersByTimeAsync(500)
      await transport.receive({
        id: directId,
        version: '2',
        senderId: p2pPeer.senderId,
        type: BeaconMessageType.SignPayloadResponse,
        signingType: SigningType.RAW,
        signature: 'edsig-direct'
      })
      await expect(directPromise).resolves.toMatchObject({ signature: 'edsig-direct' })

      await vi.advanceTimersByTimeAsync(5_000)
      expect(waitingEvents).toEqual([])
    })

    it('never fires on WalletConnect', async () => {
      const { client } = await createConfiguredClient({
        transportType: TransportType.WALLETCONNECT,
        ackTimeoutMs: 1_000
      })
      const waitingEvents: WaitingForWalletAckInfo[] = []
      await client.subscribeToEvent(BeaconEvent.WAITING_FOR_WALLET_ACK, (info) => {
        waitingEvents.push(info)
      })

      const signPromise = client.requestSignPayload({
        signingType: SigningType.RAW,
        payload: '050100'
      })
      signPromise.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(waitingEvents).toEqual([])

      await client.disconnect({ notifyPeers: false })
      await expect(signPromise).rejects.toBeInstanceOf(AbortedBeaconError)
    })
  })
})
