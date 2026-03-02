export * from '@ecadlabs/beacon-core'
export * from '@ecadlabs/beacon-transport-matrix'
export * from '@ecadlabs/beacon-transport-postmessage'
export * from '@ecadlabs/beacon-types'
export * from '@ecadlabs/beacon-utils'
export * from '@ecadlabs/beacon-ui'

import { DAppClient } from './dapp-client/DAppClient'
import { DAppClientOptions } from './dapp-client/DAppClientOptions'
import { BeaconEvent, BeaconEventHandler, defaultEventCallbacks } from './events'
import { BlockExplorer } from './utils/block-explorer'
import { TzktBlockExplorer } from './utils/tzkt-blockexplorer'
import { getDAppClientInstance } from './utils/get-instance'

export { DAppClient, DAppClientOptions, getDAppClientInstance }

// Events
export { BeaconEvent, BeaconEventHandler, defaultEventCallbacks }

// BlockExplorer
export { BlockExplorer, TzktBlockExplorer, TzktBlockExplorer as TezblockBlockExplorer }
