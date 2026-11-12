import type { Transport } from './Transport'

/** Public operations used after a client selects a transport at runtime. */
export type ClientTransport = Pick<
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
  | 'addPeer'
  | 'removePeer'
  | 'removeAllPeers'
  | 'listen'
> &
  Partial<Pick<Transport, 'health' | 'relayServer' | 'addStatusListener'>>
