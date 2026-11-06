import {
  StorageKey,
  Storage,
  ExtendedWalletConnectPairingResponse,
  TransportStatus,
  NetworkType
} from '@ecadlabs/beacon-types'
import { Logger } from '@ecadlabs/beacon-core'
import { WalletConnectTransport } from '@ecadlabs/beacon-transport-walletconnect'
import { KeyPair } from '@ecadlabs/beacon-utils'
import { SignClientTypes } from '@walletconnect/types'
import { isMobileOS } from '@ecadlabs/beacon-ui'

const logger = new Logger('DappWalletConnectTransport')

/**
 * @internalapi
 *
 *
 */
export class DappWalletConnectTransport extends WalletConnectTransport<
  ExtendedWalletConnectPairingResponse,
  StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP
> {
  constructor(
    name: string,
    keyPair: KeyPair,
    storage: Storage,
    wcOptions: { network: NetworkType; opts: SignClientTypes.Options },
    private readonly getIsLeader: () => Promise<boolean>
  ) {
    super(
      name,
      keyPair,
      storage,
      StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP,
      wcOptions,
      getIsLeader
    )
  }

  public async listenForNewPeer(
    newPeerListener: (peer: ExtendedWalletConnectPairingResponse) => void
  ): Promise<void> {
    this.client.cancelPendingPairing()
    this.newPeerListener = newPeerListener
    await this.client.listenForChannelOpening(async (peer, isCurrent) => {
      const listener = this.newPeerListener
      const ownsPairing = () => isCurrent() && this.newPeerListener === listener
      if (!listener || !ownsPairing()) {
        return false
      }

      const status =
        isMobileOS(window) || (await this.getIsLeader())
          ? TransportStatus.CONNECTED
          : TransportStatus.SECONDARY_TAB_CONNECTED
      if (!ownsPairing()) {
        return false
      }

      // Peer storage is asynchronous. Cancellation must roll it back before the next approval.
      await this.peerManager.addPeer(peer)
      if (!ownsPairing()) {
        await this.peerManager.removePeer(peer.publicKey)

        return false
      }
      await this.listen(peer.publicKey)
      if (!ownsPairing()) {
        await this.removePeer(peer)

        return false
      }

      this._isConnected = status
      if (this.isReady.isPending()) {
        this.isReady.resolve(true)
      }
      this.newPeerListener = undefined
      listener(peer)

      return true
    })
  }

  public async stopListeningForNewPeers(): Promise<void> {
    logger.log('stopListeningForNewPeers')
    // Successful delivery has already consumed the listener; it still owns session cleanup.
    if (this.newPeerListener) {
      this.client.cancelPendingPairing()
    }
    this.newPeerListener = undefined
  }
}
