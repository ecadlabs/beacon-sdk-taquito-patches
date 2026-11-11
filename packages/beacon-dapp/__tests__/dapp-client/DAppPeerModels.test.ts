import { resolve } from 'node:path'
import ts from 'typescript'
import { LocalStorage, PeerManager, windowRef, getSenderId } from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  BeaconMessageType,
  ExtendedP2PPairingResponse,
  ExtendedPeerInfo,
  ExtendedPostMessagePairingResponse,
  ExtendedWalletConnectPairingResponse,
  NetworkType,
  Origin,
  PeerInfo,
  PermissionScope,
  PostMessagePairingRequest,
  StorageKey
} from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { BeaconEvent } from '../../src/events'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { DappPostMessageTransport } from '../../src/transports/DappPostMessageTransport'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'
import {
  PeerTestTransport,
  RecordingPeerClient
} from '../../../beacon-core/__tests__/helpers/transport-peers'

// This injected transport does not use the remote WalletConnect SDK.
vi.mock('@walletconnect/sign-client', () => ({ init: vi.fn() }))
// Keep the SDK's reason constant without loading its ESM-only crypto modules in JSDOM.
vi.mock('@walletconnect/utils', () => ({
  getSdkError: () => ({ code: 6000, message: 'User disconnected.' })
}))

const postPeer = new ExtendedPostMessagePairingResponse(
  'post-id',
  'Extension Wallet',
  '22'.repeat(32),
  '3',
  'post-sender',
  'extension-id'
)

const p2pPeer = new ExtendedP2PPairingResponse(
  'p2p-id',
  'Matrix Wallet',
  '33'.repeat(32),
  '3',
  'relay.example',
  'p2p-sender'
)

const wcPeer = new ExtendedWalletConnectPairingResponse(
  'wc-id',
  'WC Wallet',
  '44'.repeat(32),
  'first',
  'wc-sender',
  'WC Wallet'
)

function typeCheckInline(code: string): string {
  const configPath = resolve('tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd())
  const virtualFile = resolve('src/__peer_typecheck_fixture__.ts')
  const host = ts.createCompilerHost(parsed.options)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  const originalFileExists = host.fileExists.bind(host)
  const originalReadFile = host.readFile.bind(host)
  host.fileExists = (fileName) =>
    resolve(fileName) === virtualFile || originalFileExists(fileName)
  host.readFile = (fileName) =>
    resolve(fileName) === virtualFile ? code : originalReadFile(fileName)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (resolve(fileName) === virtualFile) {
      return ts.createSourceFile(fileName, code, languageVersion)
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  }
  const program = ts.createProgram({
    rootNames: [virtualFile],
    options: { ...parsed.options, noEmit: true },
    host
  })
  const sourceFile = program.getSourceFile(virtualFile)
  const diagnostics = [
    ...parsed.errors,
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile)
  ]
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getCanonicalFileName: (file) => file,
    getNewLine: () => '\n'
  })
}

describe('DApp custom transport peers', () => {
  beforeEach(() => {
    localStorage.clear()
    windowRef.beaconCreatedClientInstance = false
  })
  afterEach(() => {
    localStorage.clear()
    windowRef.beaconCreatedClientInstance = false
  })

  it('matches stored string sender IDs and ignores peers without one', async () => {
    const storage = new LocalStorage('dapp-peer-models')
    const manager = new PeerManager(storage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
    const publicKey = '11'.repeat(32)
    const senderId = await getSenderId(publicKey)
    const known = new ExtendedPostMessagePairingResponse(
      'known',
      'Wallet',
      publicKey,
      '3',
      senderId,
      'extension'
    )
    const missing = new PostMessagePairingRequest('missing', 'Legacy', 'missing-key', '3')
    localStorage.setItem(
      storage.getPrefixedKey(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP),
      JSON.stringify([known, missing])
    )
    const transport = new PeerTestTransport<
      PeerInfo,
      StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP
    >(new RecordingPeerClient(), manager)
    const client = new DAppClient({ name: 'Peer model DApp', storage, disableDefaultEvents: true })
    const closed = vi.fn()
    await client.subscribeToEvent(BeaconEvent.CHANNEL_CLOSED, closed)
    try {
      await client.init(transport)
      await transport.receive(
        {
          id: 'known-disconnect',
          version: '2',
          senderId: senderId,
          type: BeaconMessageType.Disconnect
        },
        { origin: Origin.EXTENSION, id: 'extension' }
      )
      await expect(transport.getPeers()).resolves.toEqual([missing])
      await transport.receive(
        {
          id: 'missing-disconnect',
          version: '2',
          senderId: 'unmatched-sender',
          type: BeaconMessageType.Disconnect
        },
        { origin: Origin.EXTENSION, id: 'missing-key' }
      )
      await expect(transport.getPeers()).resolves.toEqual([missing])
      expect(closed).toHaveBeenCalledTimes(1)
    } finally {
      await client.destroy()
    }
  })

  it('type-checks ExtendedPeerInfo[] return type from DAppClient.getPeers() for removePeer()', () => {
    const diagnostics = typeCheckInline(`
      import { DAppClient, type ExtendedPeerInfo } from './index'

      export async function removeFirstPeer(client: DAppClient): Promise<string | undefined> {
        const peers: ExtendedPeerInfo[] = await client.getPeers()
        const first = peers[0]
        if (!first) {
          return undefined
        }
        const senderId: string = first.senderId
        await client.removePeer(first)
        return senderId
      }
    `)
    expect(diagnostics).toBe('')
  }, 30_000)

  it('returns [] without blocking when no transport is active and no peers are stored', async () => {
    const storage = new LocalStorage('dapp-peers-empty')
    const client = new DAppClient({ name: 'Empty peers DApp', storage, disableDefaultEvents: true })
    const init = vi.spyOn(client, 'init')
    try {
      expect(client['_transport'].isResolved()).toBe(false)
      await expect(client.getPeers()).resolves.toEqual([])
      expect(init).not.toHaveBeenCalled()
      expect(client['_transport'].isResolved()).toBe(false)
    } finally {
      await client.destroy()
    }
  }, 1000)

  it('returns persisted peers across all dApp storage keys when no transport is active', async () => {
    const storage = new LocalStorage('dapp-peers-persisted')
    await storage.set(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP, [postPeer])
    await storage.set(StorageKey.TRANSPORT_P2P_PEERS_DAPP, [p2pPeer])
    await storage.set(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP, [wcPeer])
    const client = new DAppClient({
      name: 'Persisted peers DApp',
      storage,
      disableDefaultEvents: true
    })
    try {
      expect(client['_transport'].isResolved()).toBe(false)
      const peers = await client.getPeers()
      expect(peers).toEqual([postPeer, p2pPeer, wcPeer])
      expect(peers.map((peer: ExtendedPeerInfo) => peer.senderId)).toEqual([
        'post-sender',
        'p2p-sender',
        'wc-sender'
      ])
      expect(client['_transport'].isResolved()).toBe(false)
    } finally {
      await client.destroy()
    }
  }, 1000)

  it('returns peers from initialized internal transports while _transport is unresolved', async () => {
    const storage = new LocalStorage('dapp-peers-internal-transports')
    const client = new DAppClient({
      name: 'Internal transport peers DApp',
      storage,
      disableDefaultEvents: true
    })
    const keys = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) }
    const post = new DappPostMessageTransport('DApp', keys, storage)
    const p2p = new DappP2PTransport('DApp', keys, storage, {})
    const wc = new DappWalletConnectTransport(
      'DApp',
      keys,
      storage,
      { network: NetworkType.MAINNET, opts: { projectId: 'test' } },
      async () => true
    )
    await post['peerManager'].addPeer(postPeer)
    await p2p['peerManager'].addPeer(p2pPeer)
    vi.spyOn(wc, 'getPeers').mockResolvedValue([wcPeer])
    client['postMessageTransport'] = post
    client['p2pTransport'] = p2p
    client['walletConnectTransport'] = wc
    try {
      expect(client['_transport'].isResolved()).toBe(false)
      await expect(client.getPeers()).resolves.toEqual([postPeer, p2pPeer, wcPeer])
    } finally {
      await client.destroy()
    }
  }, 1000)

  it('falls back to stored WalletConnect peers when an active WalletConnect transport has no live session yet', async () => {
    const storage = new LocalStorage('dapp-peers-wc-fallback')
    await storage.set(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP, [wcPeer])
    const client = new DAppClient({
      name: 'WC fallback peers DApp',
      storage,
      disableDefaultEvents: true
    })
    const keys = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) }
    const wc = new DappWalletConnectTransport(
      'DApp',
      keys,
      storage,
      { network: NetworkType.MAINNET, opts: { projectId: 'test' } },
      async () => false
    )
    vi.spyOn(wc, 'getPeers').mockResolvedValue([])
    client['walletConnectTransport'] = wc
    client['_transport'] = ExposedPromise.resolve<Awaited<DAppClient['transport']>>(wc)
    try {
      await expect(client.getPeers()).resolves.toEqual([wcPeer])
    } finally {
      await client.destroy()
    }
  }, 1000)

  it('allows passing a peer from getPeers() directly to removePeer()', async () => {
    const storage = new LocalStorage('dapp-remove-peer-from-get-peers')
    const manager = new PeerManager(storage, StorageKey.TRANSPORT_P2P_PEERS_DAPP)
    const retainedPeer = new ExtendedP2PPairingResponse(
      'retained-id',
      'Retained Wallet',
      '55'.repeat(32),
      '3',
      'relay.example',
      'retained-sender'
    )
    await manager.addPeer(p2pPeer)
    await manager.addPeer(retainedPeer)
    const account: AccountInfo = {
      accountIdentifier: 'p2p-account',
      senderId: p2pPeer.senderId,
      origin: { type: Origin.P2P, id: p2pPeer.publicKey },
      address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
      network: { type: NetworkType.MAINNET },
      scopes: [PermissionScope.OPERATION_REQUEST],
      connectedAt: 1,
      walletType: 'implicit'
    }
    await storage.set(StorageKey.ACCOUNTS, [account])
    const transport = new PeerTestTransport<
      ExtendedP2PPairingResponse,
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    >(new RecordingPeerClient(), manager)
    const client = new DAppClient({ name: 'Remove peer DApp', storage, disableDefaultEvents: true })
    try {
      await client.init(transport)
      const peers = await client.getPeers()
      expect(peers).toEqual([p2pPeer, retainedPeer])
      await client.removePeer(peers[0])
      await expect(client.getPeers()).resolves.toEqual([retainedPeer])
      await expect(client.getAccounts()).resolves.toEqual([])
    } finally {
      await client.destroy()
    }
  })
})
