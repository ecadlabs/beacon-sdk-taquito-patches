import type { ExtendedPeerInfo } from '@ecadlabs/beacon-types'
import type { Transport } from './Transport'

/** Public operations used after a client selects a transport at runtime. */
export type ClientTransport = Omit<
  Pick<
    Transport,
    | 'type'
    | 'connectionStatus'
    | 'setEventHandler'
    | 'connect'
    | 'disconnect'
    | 'send'
    | 'addListener'
    | 'removeListener'
    | 'getPeers'
    | 'removePeer'
    | 'removeAllPeers'
    | 'listen'
  >,
  'addPeer'
> & {
  addPeer(peer: ExtendedPeerInfo, sendPairingResponse?: boolean): Promise<void>
} &
  Partial<Pick<Transport, 'health' | 'relayServer' | 'addStatusListener'>>
