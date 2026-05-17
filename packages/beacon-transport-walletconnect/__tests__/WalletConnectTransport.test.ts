import {
  ExtendedWalletConnectPairingResponse,
  NetworkType,
  Storage,
  StorageKey
} from '@ecadlabs/beacon-types'
import { KeyPair } from '@ecadlabs/beacon-utils'
import { SessionTypes, SignClientTypes } from '@walletconnect/types'
import { WalletConnectCommunicationClient } from '../src/communication-client/WalletConnectCommunicationClient'
import { WalletConnectTransport } from '../src/WalletConnectTransport'

jest.mock('@walletconnect/sign-client', () => ({}))
jest.mock('@walletconnect/utils', () => ({
  getSdkError: jest.fn((code: string) => ({ code }))
}))

describe('WalletConnectTransport', () => {
  const sessionTopic =
    '33c6427472db52620e24076bff678831edb40f80d0676b8a27f080edd3ffbabd'
  const walletPublicKey =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const wcOptions = {
    network: NetworkType.MAINNET,
    opts: {} as SignClientTypes.Options
  }
  const isLeader = jest.fn().mockResolvedValue(true)
  const keyPair = {} as KeyPair
  const storage = {} as Storage

  let getInstanceSpy:
    | jest.SpiedFunction<typeof WalletConnectCommunicationClient.getInstance>
    | undefined

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
      currentSession: jest.fn(() => session)
    } as unknown as WalletConnectCommunicationClient

    getInstanceSpy = jest
      .spyOn(WalletConnectCommunicationClient, 'getInstance')
      .mockReturnValue(communicationClient)

    return new WalletConnectTransport<
      ExtendedWalletConnectPairingResponse,
      StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP
    >(
      'DApp',
      keyPair,
      storage,
      StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP,
      wcOptions,
      isLeader
    )
  }

  beforeEach(() => {
    jest.clearAllMocks()
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
})
