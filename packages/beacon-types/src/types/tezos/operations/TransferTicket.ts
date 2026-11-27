import type { MichelsonPrimitives } from '../MichelsonPrimitives'
import { MichelineMichelsonV1Expression } from '../MichelineMichelsonV1Expression'
import { TezosOperationType } from '../OperationTypes'
import { TezosBaseOperation } from '../TezosBaseOperation'

export interface TezosTransferTicketOperation<
  Primitive extends string = MichelsonPrimitives
> extends TezosBaseOperation {
  kind: TezosOperationType.TRANSFER_TICKET
  source: string
  fee: string
  counter: string
  gas_limit: string
  storage_limit: string
  ticket_contents: MichelineMichelsonV1Expression<Primitive>
  ticket_ty: MichelineMichelsonV1Expression<Primitive>
  ticket_ticketer: string
  ticket_amount: string
  destination: string
  entrypoint: string
}
