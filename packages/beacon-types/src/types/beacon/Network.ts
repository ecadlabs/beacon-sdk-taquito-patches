import { NetworkType } from '@ecadlabs/beacon-types'

export interface Network {
  type: NetworkType
  name?: string
  rpcUrl?: string
}
