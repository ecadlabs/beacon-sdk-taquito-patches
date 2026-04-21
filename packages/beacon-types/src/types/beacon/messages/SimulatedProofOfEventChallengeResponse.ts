import { BeaconBaseMessage } from '../BeaconBaseMessage'
import { BeaconMessageType } from '../BeaconMessageType'

export interface SimulatedProofOfEventChallengeResponse extends BeaconBaseMessage {
  type: BeaconMessageType.SimulatedProofOfEventChallengeResponse
  operationsList: string // Base64 encoded json
  errorMessage: string
}
