import {
  TransportStatus,
  StorageKey,
  Storage,
  ExtendedPostMessagePairingResponse
} from '@ecadlabs/beacon-types'
import { PendingPairingRequests, Logger } from '@ecadlabs/beacon-core'
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
  constructor(
    name: string,
    keyPair: KeyPair,
    storage: Storage,
    pendingPairings?: PendingPairingRequests
  ) {
    super(name, keyPair, storage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP, pendingPairings)
  }

  public async startOpenChannelListener(): Promise<void> {
    return this.client.listenForChannelOpening(
      async (peer: ExtendedPostMessagePairingResponse, isActive) => {
        logger.log('connect', `received PostMessagePairingResponse`, peer)

        await this.addPairingPeer(peer, isActive, async () => {
          this._isConnected = TransportStatus.CONNECTED
          const listener = this.newPeerListener
          this.newPeerListener = undefined
          if (listener) {
            return listener(peer)
          }

          return false
        })
      }
    )
  }

  public async listenForNewPeer(
    newPeerListener: (peer: ExtendedPostMessagePairingResponse) => boolean | Promise<boolean>
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
