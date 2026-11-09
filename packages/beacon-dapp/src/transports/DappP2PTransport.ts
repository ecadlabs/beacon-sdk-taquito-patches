import {
  Storage,
  StorageKey,
  TransportStatus,
  ExtendedP2PPairingResponse,
  NodeDistributions
} from '@ecadlabs/beacon-types'
import { PendingPairingRequests, Logger } from '@ecadlabs/beacon-core'
import { P2PTransport } from '@ecadlabs/beacon-transport-matrix'
import { KeyPair } from '@ecadlabs/beacon-utils'

const logger = new Logger('DappP2PTransport')

/**
 * @internalapi
 *
 *
 */
export class DappP2PTransport extends P2PTransport<
  ExtendedP2PPairingResponse,
  StorageKey.TRANSPORT_P2P_PEERS_DAPP
> {
  constructor(
    name: string,
    keyPair: KeyPair,
    storage: Storage,
    matrixNodes: NodeDistributions,
    iconUrl?: string,
    appUrl?: string,
    pendingPairings?: PendingPairingRequests
  ) {
    super(
      name,
      keyPair,
      storage,
      matrixNodes,
      StorageKey.TRANSPORT_P2P_PEERS_DAPP,
      iconUrl,
      appUrl,
      pendingPairings
    )
  }

  public async startOpenChannelListener(): Promise<void> {
    return this.client.listenForChannelOpening(async (peer, isActive) => {
      logger.log('listenForNewPeer', `new publicKey`, peer.publicKey)

      await this.addPairingPeer(peer, isActive, async () => {
        this._isConnected = TransportStatus.CONNECTED
        const listener = this.newPeerListener
        this.newPeerListener = undefined
        if (listener) {
          return listener(peer)
        }

        return false
      })
    })
  }

  public async listenForNewPeer(
    newPeerListener: (peer: ExtendedP2PPairingResponse) => boolean | Promise<boolean>
  ): Promise<void> {
    logger.log('listenForNewPeer')
    this.newPeerListener = newPeerListener
  }

  public async stopListeningForNewPeers(): Promise<void> {
    logger.log('stopListeningForNewPeers')
    const cancelled = this.client.cancelPairingRequests()
    this.newPeerListener = undefined
    await cancelled
  }
}
