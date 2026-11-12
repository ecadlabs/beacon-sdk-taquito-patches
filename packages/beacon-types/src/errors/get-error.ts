import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'
import { AbortedBeaconError } from './AbortedBeaconError'
import { BroadcastBeaconError } from './BroadcastBeaconError'
import { NetworkNotSupportedBeaconError } from './NetworkNotSupportedBeaconError'
import { NoAddressBeaconError } from './NoAddressBeaconError'
import { NoPrivateKeyBeaconError } from './NoPrivateKeyBeaconError'
import { NotGrantedBeaconError } from './NotGrantedBeaconError'
import { ParametersInvalidBeaconError } from './ParametersInvalidBeaconError'
import { PeerUnreachableBeaconError } from './PeerUnreachableBeaconError'
import { SignatureTypeNotSupportedBeaconError } from './SignatureTypeNotSupportedBeaconError'
import { TooManyOperationsBeaconError } from './TooManyOperationsBeaconError'
import { TransactionInvalidBeaconError } from './TransactionInvalidBeaconError'
import { UnknownBeaconError } from './UnknownBeaconError'

export const getError = (
  errorType: BeaconErrorType,
  errorData?: unknown,
  options?: BeaconErrorOptions
): BeaconError => {
  const mergedOptions: BeaconErrorOptions = {
    ...options,
    ...(errorData !== undefined ? { errorData } : {})
  }

  switch (errorType) {
    case BeaconErrorType.BROADCAST_ERROR:
      return new BroadcastBeaconError(mergedOptions)
    case BeaconErrorType.NETWORK_NOT_SUPPORTED:
      return new NetworkNotSupportedBeaconError(mergedOptions)
    case BeaconErrorType.NO_ADDRESS_ERROR:
      return new NoAddressBeaconError(mergedOptions)
    case BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR:
      return new NoPrivateKeyBeaconError(mergedOptions)
    case BeaconErrorType.NOT_GRANTED_ERROR:
      return new NotGrantedBeaconError(mergedOptions)
    case BeaconErrorType.PARAMETERS_INVALID_ERROR:
      return new ParametersInvalidBeaconError(mergedOptions)
    case BeaconErrorType.TOO_MANY_OPERATIONS:
      return new TooManyOperationsBeaconError(mergedOptions)
    case BeaconErrorType.TRANSACTION_INVALID_ERROR:
      return new TransactionInvalidBeaconError(mergedOptions)
    case BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED:
      return new SignatureTypeNotSupportedBeaconError(mergedOptions)
    case BeaconErrorType.ABORTED_ERROR:
      return new AbortedBeaconError(mergedOptions)
    case BeaconErrorType.PEER_UNREACHABLE:
      return new PeerUnreachableBeaconError(mergedOptions)
    case BeaconErrorType.UNKNOWN_ERROR:
      return new UnknownBeaconError(mergedOptions)
    default:
      return new UnknownBeaconError(mergedOptions)
  }
}
