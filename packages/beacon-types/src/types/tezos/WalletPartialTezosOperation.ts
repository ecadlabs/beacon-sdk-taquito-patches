import type { TezosTransactionOperation } from './operations/Transaction'
import type { TezosOriginationOperation } from './operations/Origination'
import type { TezosDelegationOperation } from './operations/Delegation'
import type { TezosRevealOperation } from './operations/Reveal'
import type { TezosSetDepositsLimitOperation } from './operations/SetDepositsLimit'
import type { TezosRegisterGlobalConstantOperation } from './operations/RegisterGlobalConstant'
import type { TezosTransferTicketOperation } from './operations/TransferTicket'
import type { TezosIncreasePaidStorageOperation } from './operations/IncreasePaidStorage'
import type { TezosUpdateConsensusKeyOperation } from './operations/UpdateCompanionKey'
import type { TezosSmartRollupOriginateOperation } from './operations/SmartRollupOriginate'
import type { TezosSmartRollupAddMessagesOperation } from './operations/SmartRollupAddMessages'
import type { TezosSmartRollupExecuteOutboxMessageOperation } from './operations/SmartRollupExecuteOutboxMessage'
import type { TezosSmartRollupPublishOperation } from './operations/SmartRollupPublish'
import type { TezosSmartRollupCementOperation } from './operations/SmartRollupCement'
import type { TezosSmartRollupRecoverBondOperation } from './operations/SmartRollupRecoverBond'
import type { TezosSmartRollupRefuteOperation } from './operations/SmartRollupRefute'
import type { TezosSmartRollupTimeoutOperation } from './operations/SmartRollupTimeout'
import type { TezosDalPublishCommitmentOperation } from './operations/DalPublishCommitment'

/** Wallet-supplied source, fee and counter never belong to a dApp operation. */
type WalletManager<T extends { gas_limit: string; storage_limit: string }> = Omit<
  T,
  'source' | 'fee' | 'counter' | 'gas_limit' | 'storage_limit'
> &
  Partial<Pick<T, 'gas_limit' | 'storage_limit'>> & {
    source?: never
    fee?: never
    counter?: never
  }

/**
 * The 18 manager-operation shapes supported by the opt-in wallet validators.
 * This is a shape contract, not proof of address validity or protocol acceptance.
 * The broad legacy PartialTezosOperation union remains available.
 * @category Tezos
 */
export type WalletPartialTezosOperation =
  | WalletManager<TezosTransactionOperation<string>>
  | (WalletManager<TezosOriginationOperation<string>> &
      Required<Pick<TezosOriginationOperation<string>, 'script'>>)
  | WalletManager<TezosDelegationOperation>
  | WalletManager<TezosRevealOperation>
  | WalletManager<TezosSetDepositsLimitOperation>
  | WalletManager<TezosRegisterGlobalConstantOperation<string>>
  | WalletManager<TezosTransferTicketOperation<string>>
  | WalletManager<TezosIncreasePaidStorageOperation>
  | WalletManager<TezosUpdateConsensusKeyOperation>
  | WalletManager<TezosSmartRollupOriginateOperation<string>>
  | WalletManager<TezosSmartRollupAddMessagesOperation>
  | WalletManager<TezosSmartRollupExecuteOutboxMessageOperation>
  | WalletManager<TezosSmartRollupPublishOperation>
  | WalletManager<TezosSmartRollupCementOperation>
  | WalletManager<TezosSmartRollupRecoverBondOperation>
  | WalletManager<TezosSmartRollupRefuteOperation>
  | WalletManager<TezosSmartRollupTimeoutOperation>
  | WalletManager<TezosDalPublishCommitmentOperation>
