import { BeaconBaseMessage } from '../BeaconBaseMessage'
import { BeaconMessageType } from '../BeaconMessageType'
import { Network } from '../Network'
import { PermissionScope } from '../PermissionScope'
import { Threshold } from '../Threshold'
import { Notification } from '../../Notification'

export interface ChangeAccountRequest extends BeaconBaseMessage {
  type: BeaconMessageType.ChangeAccountRequest
  address?: string
  walletType: 'implicit' | 'abstracted_account'
  verificationType?: 'proof_of_event'
  publicKey?: string
  network: Network
  scopes: PermissionScope[]
  threshold?: Threshold
  notification?: Notification
}
