import {
  ExtendedWalletConnectPairingResponse,
  NetworkType,
  Storage,
  StorageKey
} from '@ecadlabs/beacon-types'
import { Logger } from '@ecadlabs/beacon-core'
import { KeyPair } from '@ecadlabs/beacon-utils'
import { SessionTypes, SignClientTypes } from '@walletconnect/types'
import { WalletConnectCommunicationClient } from '../src/communication-client/WalletConnectCommunicationClient'
import { WalletConnectTransport } from '../src/WalletConnectTransport'

vi.mock('@walletconnect/sign-client', () => ({ default: {} }))
vi.mock('@walletconnect/utils', () => ({
  getSdkError: vi.fn((code: string) => ({ code }))
}))

describe('WalletConnectTransport', () => {
  const sessionTopic = '33c6427472db52620e24076bff678831edb40f80d0676b8a27f080edd3ffbabd'
  const walletPublicKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const wcOptions = {
    network: NetworkType.MAINNET,
    opts: {} as SignClientTypes.Options
  }
  const isLeader = vi.fn().mockResolvedValue(true)
  const keyPair = {} as KeyPair
  const storage = {} as Storage

  let getInstanceSpy:
    vi.SpiedFunction<typeof WalletConnectCommunicationClient.getInstance> | undefined

  const createSession = (): SessionTypes.Struct =>
    ({
      topic: sessionTopic,
      peer: {
        publicKey: walletPublicKey,
        metadata: {
          name: 'Kukai',
          description: 'Kukai wallet',
          url: 'https://wallet.kukai.app',
          icons: ['https://wallet.kukai.app/icon.png']
        }
      }
    }) as unknown as SessionTypes.Struct

  const createTransport = (session: SessionTypes.Struct) => {
    const communicationClient = {
      currentSession: vi.fn(() => session)
    } as unknown as WalletConnectCommunicationClient

    getInstanceSpy = vi
      .spyOn(WalletConnectCommunicationClient, 'getInstance')
      .mockReturnValue(communicationClient)

    return new WalletConnectTransport<
      ExtendedWalletConnectPairingResponse,
      StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP
    >('DApp', keyPair, storage, StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP, wcOptions, isLeader)
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    getInstanceSpy?.mockRestore()
  })

  it('uses the WalletConnect session topic as the synthesized peer senderId', async () => {
    const session = createSession()
    const transport = createTransport(session)

    const [peer] = await transport.getPeers()

    expect(peer.senderId).toBe(sessionTopic)
    expect(peer.senderId).not.toBe(walletPublicKey)
    expect(peer.publicKey).toBe(walletPublicKey)
  })

  it('matches synthesized peer senderId to the stored WalletConnect account senderId', async () => {
    const session = createSession()
    const transport = createTransport(session)
    const storedAccount = {
      accountIdentifier: 'mainnet-tz1-account',
      senderId: session.topic
    }

    const peers = await transport.getPeers()
    const peerIdsToRemove = peers.map((peer) => peer.senderId)
    const accountsToRemove = [storedAccount].filter((account) =>
      peerIdsToRemove.includes(account.senderId)
    )

    expect(accountsToRemove).toEqual([storedAccount])
  })
  it('reports asynchronous message handler failures at the event boundary', async () => {
    let receive!: (message: string) => void | Promise<void>
    const communicationClient = {
      listenForEncryptedMessage: vi.fn(async (_key: string, callback: typeof receive) => {
        receive = callback
      })
    } as unknown as WalletConnectCommunicationClient
    getInstanceSpy = vi
      .spyOn(WalletConnectCommunicationClient, 'getInstance')
      .mockReturnValue(communicationClient)
    const transport = new WalletConnectTransport(
      'test',
      keyPair,
      storage,
      StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP,
      wcOptions,
      isLeader
    )
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const failure = new Error('handler failed')
    const reported = new Promise<void>((resolve) => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => resolve())
    })
    try {
      await transport.addListener(async () => {
        await pending
        throw failure
      })
      await transport.listen(walletPublicKey)
      const delivery = receive('message')
      expect(delivery).toBeInstanceOf(Promise)
      let completed = false
      Promise.resolve(delivery).then(() => {
        completed = true
      })
      await Promise.resolve()
      expect(completed).toBe(false)
      finish()
      await delivery
      await reported
      expect(Logger.prototype.error).toHaveBeenCalledWith('listen', failure)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
