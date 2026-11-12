/**
 * Shape of an individual RPC error returned from a Tezos node.
 *
 * @category Error
 */
export interface TezosRpcError {
  kind: string
  id: string
  [key: string]: unknown
}
