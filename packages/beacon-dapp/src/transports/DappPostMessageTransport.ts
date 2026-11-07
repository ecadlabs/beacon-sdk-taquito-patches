import {
  TransportStatus,
  StorageKey,
  Storage,
  ExtendedPostMessagePairingResponse
} from '@ecadlabs/beacon-types'
import { Logger } from '@ecadlabs/beacon-core'
import { PostMessageTransport } from '@ecadlabs/beacon-transport-postmessage'
import { KeyPair } from '@ecadlabs/beacon-utils'

const logger = new Logger('DappPostMessageTransport')

/**
 * @internalapi
 *
 *
 */
export class DappPostMessageTransport extends PostMessageTransport<
  ExtendedPostMessagePairingResponse,
  StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP
> {
  constructor(name: string, keyPair: KeyPair, storage: Storage) {
    super(name, keyPair, storage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
  }

  public async startOpenChannelListener(): Promise<void> {
    const generation = this.connectionGeneration
    return this.client.listenForChannelOpening(async (peer: ExtendedPostMessagePairingResponse) => {
      logger.log('connect', `received PostMessagePairingResponse`, peer)

      if (generation !== this.connectionGeneration) {
        return
      }
      // A disconnected pairing may finish its write, but cannot reinstall listeners.
      await this.peerManager.addPeer(peer)
      if (generation !== this.connectionGeneration) {
        return
      }
      await this.listen(peer.publicKey)
      if (generation !== this.connectionGeneration) {
        return
      }

      this._isConnected = TransportStatus.CONNECTED

      if (this.newPeerListener) {
        this.newPeerListener(peer)
        this.newPeerListener = undefined // TODO: Remove this once we use the id
      }
    })
  }

  public async listenForNewPeer(
    newPeerListener: (peer: ExtendedPostMessagePairingResponse) => void
  ): Promise<void> {
    logger.log('listenForNewPeer')
    this.newPeerListener = newPeerListener
  }

  public async stopListeningForNewPeers(): Promise<void> {
    logger.log('stopListeningForNewPeers')
    this.newPeerListener = undefined
  }
}
