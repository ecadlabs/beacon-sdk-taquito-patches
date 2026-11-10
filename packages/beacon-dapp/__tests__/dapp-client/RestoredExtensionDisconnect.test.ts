import { LocalStorage, getAccountIdentifier } from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  ExtendedP2PPairingResponse,
  ExtendedPostMessagePairingResponse,
  NetworkType,
  Origin,
  PermissionScope,
  StorageKey
} from '@ecadlabs/beacon-types'
import { getKeypairFromSeed, toHex } from '@ecadlabs/beacon-utils'
import { P2PCommunicationClient } from '@ecadlabs/beacon-transport-matrix'
import { DAppClient } from '../../src/dapp-client/DAppClient'

// Vitest transpiles the DApp source without inlining const enums from compiled packages.
// Supply the real source enum; preserve every runtime core implementation.
vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  ...(await vi.importActual<
    typeof import('../../../beacon-core/src/transports/clients/ClientEvents')
  >('../../../beacon-core/src/transports/clients/ClientEvents'))
}))

// Keep real transports, storage and promises: mocking cleanup conceals this deadlock.
it('disconnects a restored extension account without starting unused Matrix', async () => {
  localStorage.clear()
  const storage = new LocalStorage('restored-extension-disconnect')
  const network = { type: NetworkType.MAINNET }
  const walletKeys = await getKeypairFromSeed('restored-extension-wallet')
  const peer = new ExtendedPostMessagePairingResponse(
    'wallet-peer',
    'Test extension',
    toHex(walletKeys.publicKey),
    '2',
    'wallet-sender',
    'a'.repeat(32)
  )
  const address = 'tz1VQA4RP4fLjEEMW2FR4pE9kAg5abb5h5GL'
  const account: AccountInfo = {
    accountIdentifier: await getAccountIdentifier(address, network),
    senderId: peer.senderId,
    origin: { type: Origin.EXTENSION, id: peer.extensionId },
    address,
    publicKey: 'edpku4US3ZykcZifjzSGFCmFr3zRgCKndE82estE4irj4d5oqDNDvf',
    network,
    scopes: [PermissionScope.SIGN],
    connectedAt: 1,
    walletType: 'implicit'
  }
  await storage.set(StorageKey.ACCOUNTS, [account])
  await storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)
  const matrixPeer: ExtendedP2PPairingResponse = {
    id: 'old-matrix-peer',
    name: 'Old Matrix wallet',
    version: '2',
    type: 'p2p-pairing-response',
    publicKey: toHex((await getKeypairFromSeed('restored-extension-matrix-peer')).publicKey),
    senderId: 'old-matrix-wallet',
    relayServer: 'relay.example'
  }
  await storage.set(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP, [peer])
  await storage.set(StorageKey.TRANSPORT_P2P_PEERS_DAPP, [matrixPeer])
  const start = vi.spyOn(P2PCommunicationClient.prototype, 'start')
  const send = vi.spyOn(P2PCommunicationClient.prototype, 'sendMessage')
  const options = {
    name: 'Restored extension regression',
    storage,
    disableDefaultEvents: true,
    enableMetrics: false
  }
  const clients: DAppClient[] = []
  try {
    const client = new DAppClient(options)
    clients.push(client)
    expect(await client.getActiveAccount()).toEqual(account)
    await client.disconnect()
    expect(await client.getActiveAccount()).toBeUndefined()
    expect(await storage.get(StorageKey.ACCOUNTS)).toEqual([])
    expect(await storage.get(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)).toEqual([])
    expect(await storage.get(StorageKey.TRANSPORT_P2P_PEERS_DAPP)).toEqual([])
    expect(await storage.get(StorageKey.ACTIVE_ACCOUNT)).toBeUndefined()
    expect(start).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    const restored = new DAppClient(options)
    clients.push(restored)
    expect(await restored.getActiveAccount()).toBeUndefined()
    expect(start).not.toHaveBeenCalled()
  } finally {
    await Promise.all(clients.map((client) => client.destroy()))
    vi.restoreAllMocks()
    localStorage.clear()
  }
})
