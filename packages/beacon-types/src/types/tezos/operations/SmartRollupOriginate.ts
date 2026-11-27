import type { MichelsonPrimitives } from '../MichelsonPrimitives'
import { MichelineMichelsonV1Expression } from '../MichelineMichelsonV1Expression'
import { TezosOperationType } from '../OperationTypes'
import { TezosBaseOperation } from '../TezosBaseOperation'
import { PvmKind } from '../common'

export interface TezosSmartRollupOriginateOperation<
  Primitive extends string = MichelsonPrimitives
> extends TezosBaseOperation {
  kind: TezosOperationType.SMART_ROLLUP_ORIGINATE
  source: string
  fee: string
  counter: string
  gas_limit: string
  storage_limit: string
  pvm_kind: PvmKind
  kernel: string
  parameters_ty: MichelineMichelsonV1Expression<Primitive>
  whitelist?: string[]
}
