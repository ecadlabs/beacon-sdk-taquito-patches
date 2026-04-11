import { Storage, StorageKey, P2PPairingRequest, NodeDistributions } from '@ecadlabs/beacon-types'
import { P2PTransport } from '@ecadlabs/beacon-transport-matrix'
import { KeyPair } from '@ecadlabs/beacon-utils'

// const logger = new Logger('DappP2PTransport')

/**
 * @internalapi
 *
 *
 */
export class WalletP2PTransport extends P2PTransport<
  P2PPairingRequest,
  StorageKey.TRANSPORT_P2P_PEERS_WALLET
> {
  constructor(
    name: string,
    keyPair: KeyPair,
    storage: Storage,
    matrixNodes: NodeDistributions,
    iconUrl?: string,
    appUrl?: string
  ) {
    super(
      name,
      keyPair,
      storage,
      matrixNodes,
      StorageKey.TRANSPORT_P2P_PEERS_WALLET,
      iconUrl,
      appUrl
    )
  }

  public async addPeer(
    newPeer: P2PPairingRequest,
    sendPairingResponse: boolean = true
  ): Promise<void> {
    await super.addPeer(newPeer)
    if (sendPairingResponse) {
      await this.client.sendPairingResponse(newPeer) // TODO: Should we have a confirmation here?
    }
  }
}
