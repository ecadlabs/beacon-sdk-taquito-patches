import { Network } from '../Network'
import { PermissionScope } from '../PermissionScope'
import { Threshold } from '../Threshold'
import { Notification } from '../../Notification'

export interface ChangeAccountInput {
  address?: string
  publicKey?: string
  walletType?: 'implicit' | 'abstracted_account'
  verificationType?: 'proof_of_event'
  network: Network
  scopes: PermissionScope[]
  threshold?: Threshold
  notification?: Notification
}
