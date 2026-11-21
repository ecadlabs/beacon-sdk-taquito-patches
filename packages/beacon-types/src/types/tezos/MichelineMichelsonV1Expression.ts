import type { MichelsonPrimitives } from './MichelsonPrimitives'
/**
 * @internalapi
 * @category Tezos
 */
export type MichelineMichelsonV1Expression<Primitive extends string = MichelsonPrimitives> =
  | { int: string }
  | { string: string } // eslint-disable-line id-blacklist
  | { bytes: string }
  | MichelineMichelsonV1Expression<Primitive>[]
  | {
      prim: Primitive
      args?: MichelineMichelsonV1Expression<Primitive>[]
      annots?: string[]
    }
