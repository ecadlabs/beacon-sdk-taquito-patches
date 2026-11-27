import type { MichelsonPrimitives } from '../MichelsonPrimitives'
import { MichelineMichelsonV1Expression } from '../MichelineMichelsonV1Expression'
import { TezosOperationType } from '../OperationTypes'
import { TezosBaseOperation } from '../TezosBaseOperation'

export interface TezosRegisterGlobalConstantOperation<
  Primitive extends string = MichelsonPrimitives
> extends TezosBaseOperation {
  kind: TezosOperationType.REGISTER_GLOBAL_CONSTANT
  source: string
  fee: string
  counter: string
  gas_limit: string
  storage_limit: string
  value: MichelineMichelsonV1Expression<Primitive>
}
