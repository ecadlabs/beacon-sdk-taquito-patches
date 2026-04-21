import { NetworkType } from './NetworkType'

export interface Network {
  type: NetworkType
  name?: string
  rpcUrl?: string
}
