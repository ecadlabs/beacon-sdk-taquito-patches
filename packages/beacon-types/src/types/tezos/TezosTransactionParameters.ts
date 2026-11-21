import type { MichelsonPrimitives } from './MichelsonPrimitives'
import { MichelineMichelsonV1Expression } from './MichelineMichelsonV1Expression'

/**
 * @internalapi
 * @category Tezos
 */
export interface TezosTransactionParameters<Primitive extends string = MichelsonPrimitives> {
  entrypoint:
    | 'default'
    | 'root'
    | 'do'
    | 'set_delegate'
    | 'remove_delegate'
    | 'deposit'
    | 'stake'
    | 'unstake'
    | 'finalize_unstake'
    | 'set_delegate_parameters'
    | string
  value: MichelineMichelsonV1Expression<Primitive>
}
