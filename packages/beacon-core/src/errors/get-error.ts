import {
  getError,
  BeaconError,
  AbortedBeaconError,
  BroadcastBeaconError,
  NetworkNotSupportedBeaconError,
  NoAddressBeaconError,
  NoPrivateKeyBeaconError,
  NotGrantedBeaconError,
  ParametersInvalidBeaconError,
  PeerUnreachableBeaconError,
  SignatureTypeNotSupportedBeaconError,
  TooManyOperationsBeaconError,
  TransactionInvalidBeaconError,
  UnknownBeaconError
} from '@ecadlabs/beacon-types'

export {
  getError,
  BeaconError,
  AbortedBeaconError,
  BroadcastBeaconError,
  NetworkNotSupportedBeaconError,
  NoAddressBeaconError,
  NoPrivateKeyBeaconError,
  NotGrantedBeaconError,
  ParametersInvalidBeaconError,
  PeerUnreachableBeaconError,
  SignatureTypeNotSupportedBeaconError,
  TooManyOperationsBeaconError,
  TransactionInvalidBeaconError,
  UnknownBeaconError
}

export default getError
