import { Network, NetworkType } from '@ecadlabs/beacon-types'

export abstract class BlockExplorer {
  constructor(public readonly rpcUrls: { [key in NetworkType]?: string }) {}

  protected async getLinkForNetwork(network: Network): Promise<string> {
    const link = this.rpcUrls[network.type]

    if (!link) {
      throw new Error(`Block explorer not configured for network "${network.type}"`)
    }

    return link
  }

  /**
   * Return a blockexplorer link for an address
   *
   * @param address The address to be opened
   * @param network The network that was used
   */
  public abstract getAddressLink(address: string, network: Network): Promise<string>

  /**
   * Return a blockexplorer link for a transaction hash
   *
   * @param transactionId The hash of the transaction
   * @param network The network that was used
   */
  public abstract getTransactionLink(transactionId: string, network: Network): Promise<string>
}
