import { resolve } from 'node:path'
import ts from 'typescript'
import { Client, LocalStorage, PeerManager, windowRef, getSenderId } from '@ecadlabs/beacon-core'
import {
  ExtendedP2PPairingRequest,
  ExtendedPostMessagePairingRequest,
  NetworkType,
  P2PPairingRequest,
  PeerInfo,
  PermissionInfo,
  PermissionScope,
  StorageKey,
  TransportType
} from '@ecadlabs/beacon-types'
import { WalletClient } from '../../src/client/WalletClient'
import {
  PeerTestTransport,
  RecordingPeerClient
} from '../../../beacon-core/__tests__/helpers/transport-peers'

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

const known = new ExtendedP2PPairingRequest(
  'known',
  'DApp',
  'known-key',
  '3',
  'relay.example',
  'known-sender'
)
const postKnown = new ExtendedPostMessagePairingRequest(
  'post-known',
  'Post DApp',
  'post-key',
  '3',
  'post-sender'
)
const missing = new P2PPairingRequest('missing', 'Legacy DApp', 'missing-key', '3', 'relay.example')
const permission = (senderId: string): PermissionInfo => ({
  accountIdentifier: senderId,
  senderId,
  appMetadata: { senderId, name: 'DApp' },
  website: '',
  address: 'tz1address',
  network: { type: NetworkType.MAINNET },
  scopes: [PermissionScope.OPERATION_REQUEST],
  connectedAt: 1
})

async function setup() {
  const storage = new LocalStorage('wallet-peer-models')
  const manager = new PeerManager(storage, StorageKey.TRANSPORT_P2P_PEERS_WALLET)
  localStorage.setItem(
    storage.getPrefixedKey(StorageKey.TRANSPORT_P2P_PEERS_WALLET),
    JSON.stringify([known, missing])
  )
  await storage.set(StorageKey.PERMISSION_LIST, [
    permission('known-sender'),
    permission('other-sender')
  ])
  const transport = new PeerTestTransport<PeerInfo, StorageKey.TRANSPORT_P2P_PEERS_WALLET>(
    new RecordingPeerClient(),
    manager,
    TransportType.P2P
  )
  const wallet = new WalletClient({ name: 'Peer model wallet', storage })
  await Client.prototype.init.call(wallet, transport)
  return { wallet, storage, transport }
}

describe('Wallet peer sender IDs', () => {
  beforeEach(() => {
    localStorage.clear()
    windowRef.beaconCreatedClientInstance = false
  })
  afterEach(() => {
    localStorage.clear()
    windowRef.beaconCreatedClientInstance = false
  })

  it('removes permissions only for existing stored sender IDs when clearing peers', async () => {
    const { wallet, storage, transport } = await setup()
    try {
      await wallet.removeAllPeers()
      await expect(transport.getPeers()).resolves.toEqual([])
      await expect(storage.get(StorageKey.PERMISSION_LIST)).resolves.toEqual([
        permission('other-sender')
      ])
    } finally {
      await wallet.destroy()
    }
  })

  it('aligns wallet peer storage keys and getPeers() return types with ExtendedPeerInfo', () => {
    const diagnostics = typeCheckInline(`
      import {
        WalletClient,
        StorageKey,
        type StorageKeyReturnType,
        type ExtendedPeerInfo,
        type ExtendedP2PPairingRequest,
        type ExtendedPostMessagePairingRequest
      } from './index'
      import { WalletP2PTransport } from './transports/WalletP2PTransport'
      import { WalletPostMessageTransport } from './transports/WalletPostMessageTransport'

      export async function checkWalletPeerTypes(
        wallet: WalletClient,
        p2pTransport: WalletP2PTransport,
        postTransport: WalletPostMessageTransport,
        p2pStored: StorageKeyReturnType[StorageKey.TRANSPORT_P2P_PEERS_WALLET],
        postStored: StorageKeyReturnType[StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET]
      ): Promise<string | undefined> {
        const peers: ExtendedPeerInfo[] = await wallet.getPeers()
        const p2pPeers: ExtendedP2PPairingRequest[] = await p2pTransport.getPeers()
        const postPeers: ExtendedPostMessagePairingRequest[] = await postTransport.getPeers()
        const p2pChecked: ExtendedP2PPairingRequest[] = p2pStored
        const postChecked: ExtendedPostMessagePairingRequest[] = postStored
        const first = peers[0] ?? p2pPeers[0] ?? postPeers[0] ?? p2pChecked[0] ?? postChecked[0]
        if (!first) {
          return undefined
        }
        await wallet.removePeer(first)
        await wallet.removeAppMetadata(first.senderId)
        return first.senderId
      }
    `)
    expect(diagnostics).toBe('')
  }, 30_000)

  it('returns [] without blocking before init() when no peers are stored', async () => {
    const storage = new LocalStorage('wallet-peers-empty')
    const wallet = new WalletClient({ name: 'Empty peers wallet', storage })
    try {
      expect(wallet['_transport'].isResolved()).toBe(false)
      await expect(wallet.getPeers()).resolves.toEqual([])
      expect(wallet['_transport'].isResolved()).toBe(false)
    } finally {
      await wallet.destroy()
    }
  }, 1000)

  it('returns persisted P2P and PostMessage wallet peers from storage before init() completes', async () => {
    const storage = new LocalStorage('wallet-peers-persisted')
    await storage.set(StorageKey.TRANSPORT_P2P_PEERS_WALLET, [known])
    await storage.set(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET, [postKnown])
    const wallet = new WalletClient({ name: 'Persisted peers wallet', storage })
    try {
      expect(wallet['_transport'].isResolved()).toBe(false)
      const peers = await wallet.getPeers()
      expect(peers).toEqual([known, postKnown])
      expect(peers.map((peer) => peer.senderId)).toEqual(['known-sender', 'post-sender'])
      expect(wallet['_transport'].isResolved()).toBe(false)
    } finally {
      await wallet.destroy()
    }
  }, 1000)

  it('exposes senderId on peers returned by getPeers() for removePeer() and removeAppMetadata()', async () => {
    const storage = new LocalStorage('wallet-peer-lifecycle')
    const manager = new PeerManager(storage, StorageKey.TRANSPORT_P2P_PEERS_WALLET)
    const transport = new PeerTestTransport<
      ExtendedP2PPairingRequest,
      StorageKey.TRANSPORT_P2P_PEERS_WALLET
    >(new RecordingPeerClient(), manager, TransportType.P2P)
    const wallet = new WalletClient({ name: 'Lifecycle wallet', storage })
    const publicKey = '66'.repeat(32)
    const senderId = await getSenderId(publicKey)
    const pairingRequest = new P2PPairingRequest(
      'req-id',
      'Example DApp',
      publicKey,
      '3',
      'relay.example'
    )
    await storage.set(StorageKey.APP_METADATA_LIST, [{ senderId, name: 'Example DApp' }])
    try {
      await Client.prototype.init.call(wallet, transport)
      await wallet.addPeer(pairingRequest, false)
      const peers = await wallet.getPeers()
      expect(peers).toHaveLength(1)
      expect(peers[0].senderId).toBe(senderId)
      await wallet.removePeer(peers[0])
      await wallet.removeAppMetadata(peers[0].senderId)
      await expect(wallet.getPeers()).resolves.toEqual([])
      await expect(wallet.getAppMetadataList()).resolves.toEqual([])
    } finally {
      await wallet.destroy()
    }
  })
})
