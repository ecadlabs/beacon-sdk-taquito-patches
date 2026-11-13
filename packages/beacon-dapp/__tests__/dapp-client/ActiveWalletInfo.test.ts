import { LocalStorage, PeerManager } from '@ecadlabs/beacon-core'
import {
  AccountInfo,
  ExtendedPostMessagePairingResponse,
  NetworkType,
  Origin,
  StorageKey,
  TransportStatus,
  WalletInfo
} from '@ecadlabs/beacon-types'
import type { WalletInfo as PublicWalletInfo } from '../../src'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { BeaconEvent } from '../../src/events'
import { getWebList } from '@ecadlabs/beacon-ui'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { DappPostMessageTransport } from '../../src/transports/DappPostMessageTransport'
import { DappP2PTransport } from '../../src/transports/DappP2PTransport'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'
import {
  PeerTestTransport,
  RecordingPeerClient
} from '../../../beacon-core/__tests__/helpers/transport-peers'
import { expectTypeOf } from 'vitest'

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  MultiTabChannel: class {
    isLeader() {
      return true
    }
    hasLeader() {
      return Promise.resolve(true)
    }
    getLeadership() {
      return Promise.resolve()
    }
    postMessage() {}
    close() {
      return Promise.resolve()
    }
  }
}))

vi.mock('@ecadlabs/beacon-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-ui')>()),
  getWebList: vi.fn(() => []),
  getiOSList: () => [],
  getDesktopList: () => [],
  getExtensionList: () => [],
  isBrowser: () => true,
  isDesktop: () => false
}))

const account: AccountInfo = {
  accountIdentifier: 'active-account',
  senderId: 'active-sender',
  origin: { type: Origin.P2P, id: 'active-public-key' },
  address: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
  network: { type: NetworkType.MAINNET },
  scopes: [],
  connectedAt: 1,
  walletType: 'implicit'
}
const peer = {
  type: 'p2p-pairing-request',
  id: 'pairing-id',
  senderId: account.senderId,
  publicKey: account.origin.id,
  name: 'Example Wallet',
  icon: 'https://peer.test/icon',
  version: '3',
  relayServer: 'relay.test',
  extensionId: 'extension-id'
}
const storedWallet = {
  key: 'stored',
  name: 'Stored Wallet',
  icon: 'https://stored.test/icon',
  type: 'web'
} satisfies NonNullable<Awaited<ReturnType<DAppClient['getWalletInfoFromStorage']>>>

describe('DAppClient.getActiveWalletInfo', () => {
  let client: DAppClient
  let storage: LocalStorage

  beforeEach(async () => {
    localStorage.clear()
    Object.defineProperty(window, 'beaconCreatedClientInstance', {
      value: false,
      writable: true,
      configurable: true
    })
    vi.mocked(getWebList).mockReturnValue([])
    storage = new LocalStorage('active-wallet-info')
    client = new DAppClient({ name: 'Wallet info tests', storage, disableDefaultEvents: true })
    await client.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, () => {})
    await client.getActiveAccount()
  })

  afterEach(async () => {
    await client.destroy()
    vi.restoreAllMocks()
  })

  function selectAccount(selected: AccountInfo = account) {
    vi.spyOn(client, 'getActiveAccount').mockResolvedValue(selected)
  }

  async function installPeers() {
    const keys = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) }
    const post = new DappPostMessageTransport('Wallet info', keys, storage)
    const p2p = new DappP2PTransport('Wallet info', keys, storage, {})
    const wc = new DappWalletConnectTransport(
      'Wallet info',
      keys,
      storage,
      { network: NetworkType.MAINNET, opts: { projectId: 'test' } },
      async () => true
    )
    client['postMessageTransport'] = post
    client['p2pTransport'] = p2p
    client['walletConnectTransport'] = wc
    // Peer storage is real; adding a peer here must not start network subscriptions.
    vi.spyOn(post, 'addPeer').mockImplementation((value) => post['peerManager'].addPeer(value))
    vi.spyOn(p2p, 'addPeer').mockImplementation((value) => p2p['peerManager'].addPeer(value))
    vi.spyOn(wc, 'addPeer').mockImplementation(async (value) => {
      const metadata = {
        name: value.name,
        description: '',
        url: 'https://wallet.test',
        icons: value.icon ? [value.icon] : []
      }
      vi.spyOn(wc['client'], 'currentSession').mockReturnValue({
        topic: value.senderId,
        pairingTopic: 'pairing-topic',
        relay: { protocol: 'irn' },
        expiry: 9999999999,
        acknowledged: true,
        controller: value.publicKey,
        namespaces: {},
        requiredNamespaces: {},
        optionalNamespaces: {},
        self: { publicKey: 'dapp-key', metadata },
        peer: { publicKey: value.publicKey, metadata }
      })
    })
    return { post, p2p, wc }
  }

  it('returns undefined when disconnected without waiting for an active peer or initializing', async () => {
    await storage.set(StorageKey.LAST_SELECTED_WALLET, storedWallet)
    client['_activePeer'] = new ExposedPromise()
    const init = vi.spyOn(client, 'init')
    expect(client['_activePeer'].isSettled()).toBe(false)
    await expect(client.getActiveWalletInfo()).resolves.toBeUndefined()
    expect(init).not.toHaveBeenCalled()
    expect(client['_activePeer'].isSettled()).toBe(false)
  }, 1000)

  it('exposes the shared WalletInfo return type', () => {
    expectTypeOf<PublicWalletInfo>().toEqualTypeOf<WalletInfo>()
    expectTypeOf(client.getActiveWalletInfo).returns.toEqualTypeOf<
      Promise<WalletInfo | undefined>
    >()
    expect(client.getActiveWalletInfo).toBeTypeOf('function')
  })

  it('prefers active sender metadata over peers and storage', async () => {
    selectAccount()
    const { p2p } = await installPeers()
    await p2p.addPeer(peer)
    await storage.set(StorageKey.LAST_SELECTED_WALLET, storedWallet)
    await storage.set(StorageKey.APP_METADATA_LIST, [
      { senderId: 'other', name: 'Unrelated wallet' },
      { senderId: account.senderId, name: 'Metadata Wallet', icon: 'https://metadata.test/icon' }
    ])
    await expect(client.getActiveWalletInfo()).resolves.toMatchObject({
      name: 'Metadata Wallet',
      icon: 'https://metadata.test/icon'
    })
  })

  it.each([
    { kind: 'post', origin: Origin.EXTENSION, type: 'postmessage-pairing-response' },
    { kind: 'p2p', origin: Origin.P2P, type: 'p2p-pairing-request' },
    { kind: 'wc', origin: Origin.WALLETCONNECT, type: 'walletconnect-pairing-response' }
  ] as const)('matches the active sender in $kind peers', async ({ kind, origin, type }) => {
    selectAccount({ ...account, origin: { ...account.origin, type: origin } })
    const transports = await installPeers()
    await transports[kind].addPeer({
      ...peer,
      id: 'other-id',
      publicKey: 'other-key',
      senderId: 'other-sender',
      name: 'Wrong Wallet'
    })
    await transports[kind].addPeer({ ...peer, type })
    await storage.set(StorageKey.LAST_SELECTED_WALLET, storedWallet)
    await expect(client.getActiveWalletInfo()).resolves.toMatchObject({
      name: peer.name,
      icon: peer.icon
    })
  })

  it.each([
    {
      kind: 'postmessage',
      storageKey: StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP,
      origin: Origin.EXTENSION,
      type: 'postmessage-pairing-response'
    },
    {
      kind: 'p2p',
      storageKey: StorageKey.TRANSPORT_P2P_PEERS_DAPP,
      origin: Origin.P2P,
      type: 'p2p-pairing-request'
    },
    {
      kind: 'walletconnect',
      storageKey: StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP,
      origin: Origin.WALLETCONNECT,
      type: 'walletconnect-pairing-response'
    }
  ] as const)(
    'falls back to $storageKey when transports are uninitialized',
    async ({ storageKey, origin, type }) => {
      expect(client['postMessageTransport']).toBeUndefined()
      expect(client['p2pTransport']).toBeUndefined()
      expect(client['walletConnectTransport']).toBeUndefined()

      selectAccount({ ...account, origin: { ...account.origin, type: origin } })
      await storage.set(storageKey, [
        {
          ...peer,
          type,
          id: 'other-id',
          publicKey: 'other-key',
          senderId: 'other-sender',
          name: 'Wrong Wallet'
        },
        { ...peer, type }
      ])
      await storage.set(StorageKey.LAST_SELECTED_WALLET, storedWallet)

      await expect(client.getActiveWalletInfo()).resolves.toMatchObject({
        name: peer.name,
        icon: peer.icon
      })
    }
  )

  it('falls back to WalletConnect peer storage when walletConnectTransport.getPeers() is empty', async () => {
    selectAccount({ ...account, origin: { ...account.origin, type: Origin.WALLETCONNECT } })
    const { wc } = await installPeers()
    vi.spyOn(wc, 'getPeers').mockResolvedValue([])
    await storage.set(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP, [
      { ...peer, type: 'walletconnect-pairing-response' }
    ])
    await storage.set(StorageKey.LAST_SELECTED_WALLET, storedWallet)

    await expect(client.getActiveWalletInfo()).resolves.toMatchObject({
      name: peer.name,
      icon: peer.icon
    })
  })

  it('prefers live walletConnectTransport.getPeers() over stale WalletConnect peer storage', async () => {
    selectAccount({ ...account, origin: { ...account.origin, type: Origin.WALLETCONNECT } })
    const { wc } = await installPeers()
    await wc.addPeer({
      ...peer,
      type: 'walletconnect-pairing-response',
      name: 'Live WC Wallet',
      icon: 'https://live-wc.test/icon'
    })
    await storage.set(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP, [
      {
        ...peer,
        type: 'walletconnect-pairing-response',
        name: 'Stale Stored WC Wallet',
        icon: 'https://stale-wc.test/icon'
      }
    ])

    await expect(client.getActiveWalletInfo()).resolves.toMatchObject({
      name: 'Live WC Wallet',
      icon: 'https://live-wc.test/icon'
    })
  })

  it('resolves peer from a custom active transport when internal transports and default storage are empty', async () => {
    selectAccount({ ...account, origin: { ...account.origin, type: Origin.EXTENSION } })
    const customStorage = new LocalStorage('custom-transport-peers')
    const manager = new PeerManager(customStorage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
    const customPeer = new ExtendedPostMessagePairingResponse(
      peer.id,
      'Custom Transport Wallet',
      peer.publicKey,
      peer.version,
      peer.senderId,
      peer.extensionId,
      'https://custom.test/icon'
    )
    await manager.addPeer(customPeer)
    const customTransport = new PeerTestTransport<
      ExtendedPostMessagePairingResponse,
      StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP
    >(new RecordingPeerClient(), manager)
    await client.init(customTransport)

    await expect(client.getActiveWalletInfo()).resolves.toMatchObject({
      name: 'Custom Transport Wallet',
      icon: 'https://custom.test/icon'
    })
  })

  it('refreshes the selected WalletConnect peer after transport.connect() when storage held a pre-connect peer', async () => {
    const wcAccount: AccountInfo = {
      ...account,
      origin: { ...account.origin, type: Origin.WALLETCONNECT }
    }
    const { wc } = await installPeers()
    client['initInternalTransports'] = async () => {}
    await storage.set(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP, [
      {
        ...peer,
        type: 'walletconnect-pairing-response',
        name: 'Pre-connect Stored Wallet',
        icon: 'https://preconnect.test/icon'
      }
    ])
    let connected = false
    vi.spyOn(wc, 'getPeers').mockImplementation(async () =>
      connected
        ? [
            {
              ...peer,
              type: 'walletconnect-pairing-response',
              name: 'Connected Session Wallet',
              icon: 'https://connected.test/icon'
            }
          ]
        : []
    )
    vi.spyOn(wc, 'connect').mockImplementation(async () => {
      connected = true
      wc['_isConnected'] = TransportStatus.CONNECTED
    })

    const prepared = await client['prepareAccountSelection'](
      wcAccount,
      client['accountTransition'].signal,
      'local'
    )
    expect(prepared).toMatchObject({
      kind: 'ready',
      peer: expect.objectContaining({
        name: 'Connected Session Wallet',
        icon: 'https://connected.test/icon'
      })
    })
  })

  it.each(['publicKey', 'id'] as const)('falls back to the account origin %s', async (field) => {
    selectAccount()
    const { p2p } = await installPeers()
    await p2p.addPeer({
      ...peer,
      senderId: 'relay-sender',
      publicKey: 'relay-key',
      id: 'relay-id',
      [field]: account.origin.id
    })
    await expect(client.getActiveWalletInfo()).resolves.toMatchObject({ name: peer.name })
  })

  it('prefers an exact sender match over an earlier origin match', async () => {
    selectAccount()
    const { p2p } = await installPeers()
    await p2p.addPeer({
      ...peer,
      senderId: 'relay',
      id: account.origin.id,
      publicKey: 'relay-key',
      name: 'Wrong Wallet'
    })
    await p2p.addPeer(peer)
    await expect(client.getActiveWalletInfo()).resolves.toMatchObject({ name: peer.name })
  })

  it('does not return an unrelated first peer', async () => {
    selectAccount()
    const { p2p } = await installPeers()
    await p2p.addPeer({ ...peer, senderId: 'other', publicKey: 'other', id: 'other' })
    await expect(client.getActiveWalletInfo()).resolves.toBeUndefined()
  })

  it('falls back to the last selected wallet with an active account', async () => {
    selectAccount()
    await storage.set(StorageKey.LAST_SELECTED_WALLET, storedWallet)
    await expect(client.getActiveWalletInfo()).resolves.toMatchObject({
      name: storedWallet.name,
      icon: storedWallet.icon,
      type: storedWallet.type
    })
  })

  it.each([undefined, '', '   '])(
    'uses the stored key when a legacy wallet selection has name %j',
    async (name) => {
      selectAccount()
      const raw = JSON.stringify({
        key: 'legacy_wallet',
        name,
        type: 'mobile',
        icon: 'legacy-icon'
      })
      // Reproduce persisted UI output without coercing it into the current storage type.
      localStorage.setItem(storage.getPrefixedKey(StorageKey.LAST_SELECTED_WALLET), raw)

      await expect(client.getActiveWalletInfo()).resolves.toEqual({
        name: 'legacy_wallet',
        type: 'mobile',
        icon: 'legacy-icon'
      })
      expect(localStorage.getItem(storage.getPrefixedKey(StorageKey.LAST_SELECTED_WALLET))).toBe(
        raw
      )
    }
  )

  it.each([undefined, '', '   '])(
    'returns undefined when stored name %j and key are both unusable',
    async (name) => {
      selectAccount()
      localStorage.setItem(
        storage.getPrefixedKey(StorageKey.LAST_SELECTED_WALLET),
        JSON.stringify({ key: '   ', name, type: 'mobile', icon: 'legacy-icon' })
      )

      await expect(client.getActiveWalletInfo()).resolves.toBeUndefined()
    }
  )

  it('does not rewrite the last selected wallet when resolving a different peer', async () => {
    selectAccount()
    const { p2p } = await installPeers()
    await p2p.addPeer(peer)
    await storage.set(StorageKey.LAST_SELECTED_WALLET, storedWallet)
    const write = vi.spyOn(storage, 'set')

    await expect(client.getActiveWalletInfo()).resolves.toMatchObject({
      name: peer.name,
      icon: peer.icon
    })
    await expect(storage.get(StorageKey.LAST_SELECTED_WALLET)).resolves.toEqual(storedWallet)
    expect(write).not.toHaveBeenCalled()
  })

  it.each(['', '   '])(
    'ignores a blank metadata name (%j) and uses the matching peer',
    async (name) => {
      selectAccount()
      const { p2p } = await installPeers()
      await p2p.addPeer(peer)
      await storage.set(StorageKey.APP_METADATA_LIST, [{ senderId: account.senderId, name }])
      await expect(client.getActiveWalletInfo()).resolves.toMatchObject({ name: peer.name })
    }
  )

  it('enriches a known wallet with its registry icon, deeplink and type', async () => {
    selectAccount()
    vi.mocked(getWebList).mockReturnValue([
      {
        key: 'example_web',
        name: 'Example Wallet',
        shortName: 'Example',
        color: '#000',
        logo: 'https://example.test/logo',
        links: { [NetworkType.MAINNET]: 'https://example.test/mainnet' }
      }
    ])
    await storage.set(StorageKey.APP_METADATA_LIST, [
      { senderId: account.senderId, name: 'Example' }
    ])
    await expect(client.getActiveWalletInfo()).resolves.toEqual({
      name: 'Example Wallet',
      icon: 'https://example.test/logo',
      deeplink: 'https://example.test/mainnet',
      type: 'web'
    })
  })

  it('returns undefined without a name even when the registry contains a wallet-prefixed key', async () => {
    selectAccount()
    vi.mocked(getWebList).mockReturnValue([
      {
        key: 'wallet_web',
        name: 'Wrong Wallet',
        shortName: 'Wallet',
        color: '#000',
        logo: 'logo',
        links: { [NetworkType.MAINNET]: 'https://wrong.test' }
      }
    ])
    await expect(client.getActiveWalletInfo()).resolves.toBeUndefined()
  })
})
