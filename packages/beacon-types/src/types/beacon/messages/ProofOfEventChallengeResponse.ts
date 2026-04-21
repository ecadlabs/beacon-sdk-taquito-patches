import { BeaconBaseMessage } from '../BeaconBaseMessage'
import { BeaconMessageType } from '../BeaconMessageType'

export interface ProofOfEventChallengeResponse extends BeaconBaseMessage {
  type: BeaconMessageType.ProofOfEventChallengeResponse
  payloadHash: string
  isAccepted: boolean // Indicating whether the challenge is accepted
}
