import {
  TezosOperationType,
  PvmKind,
  SmartRollupRefutationOptions,
  type WalletPartialTezosOperation
} from '@ecadlabs/beacon-types'

export const managerOperations = [
  {
    kind: TezosOperationType.TRANSACTION,
    amount: '1',
    destination: 'tz1destination',
    parameters: { entrypoint: 'default', value: { int: '7' } }
  },
  {
    kind: TezosOperationType.ORIGINATION,
    balance: '0',
    script: { code: [], storage: { prim: 'Unit' } }
  },
  { kind: TezosOperationType.DELEGATION, delegate: 'tz1delegate' },
  { kind: TezosOperationType.REVEAL, public_key: 'edpkpublickey', proof: 'proof' },
  { kind: TezosOperationType.SET_DEPOSITS_LIMIT, limit: '0' },
  {
    kind: TezosOperationType.REGISTER_GLOBAL_CONSTANT,
    value: { prim: 'Pair', args: [{ int: '1' }, { string: 'hello' }] }
  },
  {
    kind: TezosOperationType.TRANSFER_TICKET,
    ticket_contents: { int: '1' },
    ticket_ty: { prim: 'nat' },
    ticket_ticketer: 'KT1ticketer',
    ticket_amount: '1',
    destination: 'KT1destination',
    entrypoint: 'default'
  },
  { kind: TezosOperationType.INCREASE_PAID_STORAGE, amount: '1', destination: 'KT1destination' },
  { kind: TezosOperationType.UPDATE_COMPANION_KEY, pk: 'BLpkkey', proof: 'proof' },
  {
    kind: TezosOperationType.SMART_ROLLUP_ORIGINATE,
    pvm_kind: PvmKind.WASM2,
    kernel: '00',
    parameters_ty: { prim: 'unit' },
    whitelist: ['tz1staker']
  },
  { kind: TezosOperationType.SMART_ROLLUP_ADD_MESSAGES, message: ['00'] },
  {
    kind: TezosOperationType.SMART_ROLLUP_EXECUTE_OUTBOX_MESSAGE,
    rollup: 'sr1rollup',
    cemented_commitment: 'src1commitment',
    output_proof: '00'
  },
  {
    kind: TezosOperationType.SMART_ROLLUP_PUBLISH,
    rollup: 'sr1rollup',
    commitment: {
      compressed_state: 'srs1state',
      inbox_level: 1,
      predecessor: 'src1previous',
      number_of_ticks: '1'
    }
  },
  {
    kind: TezosOperationType.SMART_ROLLUP_CEMENT,
    rollup: 'sr1rollup',
    commitment: 'src1commitment'
  },
  { kind: TezosOperationType.SMART_ROLLUP_RECOVER_BOND, rollup: 'sr1rollup', staker: 'tz1staker' },
  {
    kind: TezosOperationType.SMART_ROLLUP_REFUTE,
    rollup: 'sr1rollup',
    opponent: 'tz1opponent',
    refutation: {
      refutation_kind: SmartRollupRefutationOptions.START,
      player_commitment_hash: 'src1player',
      opponent_commitment_hash: 'src1opponent'
    }
  },
  {
    kind: TezosOperationType.SMART_ROLLUP_TIMEOUT,
    rollup: 'sr1rollup',
    stakers: { alice: 'tz1alice', bob: 'tz1bob' }
  },
  {
    kind: TezosOperationType.DAL_PUBLISH_COMMITMENT,
    slot_header: { slot_index: 0, commitment: 'commitment', commitment_proof: 'proof' }
  }
] satisfies WalletPartialTezosOperation[]
