import { Network, NetworkType } from '@ecadlabs/beacon-types'
import { BlockExplorer } from './block-explorer'

export class TzktBlockExplorer extends BlockExplorer {
  constructor(
    public readonly rpcUrls: { [key in NetworkType]?: string } = {
      [NetworkType.MAINNET]: 'https://tzkt.io',
      [NetworkType.GHOSTNET]: 'https://ghostnet.tzkt.io',
      [NetworkType.WEEKLYNET]: 'https://weeklynet.tzkt.io',
      [NetworkType.DAILYNET]: 'https://dailynet.tzkt.io',
      [NetworkType.SEOULNET]: 'https://seoulnet.tzkt.io',
      [NetworkType.SHADOWNET]: 'https://shadownet.tzkt.io',
      [NetworkType.TALLINNNET]: 'https://tallinnnet.tzkt.io',
      [NetworkType.TEZLINK_SHADOWNET]: 'https://shadownet.tezlink.tzkt.io',
      [NetworkType.TEZOSX_PREVIEWNET]: 'https://tzkt.previewnet.tezosx.nomadic-labs.com',
      [NetworkType.USHUAIANET]: 'https://ushuaianet.tzkt.io'
    }
  ) {
    super(rpcUrls)
  }

  public async getAddressLink(address: string, network: Network): Promise<string> {
    const blockExplorer = await this.getLinkForNetwork(network)

    return `${blockExplorer}/${address}`
  }
  public async getTransactionLink(transactionId: string, network: Network): Promise<string> {
    const blockExplorer = await this.getLinkForNetwork(network)

    return `${blockExplorer}/${transactionId}`
  }
}
