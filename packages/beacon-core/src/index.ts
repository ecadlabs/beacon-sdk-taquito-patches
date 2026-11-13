/**
 * General docs
 * @module public
 */
import { Client } from './clients/client/Client'
import { Transport, getPairingPeerOwnership } from './transports/Transport'
import { ChromeStorage } from './storage/ChromeStorage'
import { LocalStorage } from './storage/LocalStorage'
import { getStorage } from './storage/getStorage'
import { Serializer } from './Serializer'
// import { RequestEncryptPayloadInput } from './types/RequestEncryptPayloadInput'
import { ClientOptions } from './clients/client/ClientOptions'
import { SDK_VERSION, BEACON_VERSION } from './constants'
import { AccountManager } from './managers/AccountManager'
import { AppMetadataManager } from './managers/AppMetadataManager'
import { PermissionManager } from './managers/PermissionManager'
import { BeaconClient } from './clients/beacon-client/BeaconClient'
import { BeaconClientOptions } from './clients/beacon-client/BeaconClientOptions'
import { getAccountIdentifier } from './utils/get-account-identifier'
import { getSenderId } from './utils/get-sender-id'
import { PeerManager } from './managers/PeerManager'
import { MessageBasedClient } from './transports/clients/MessageBasedClient'
import { setDebugEnabled, getDebugEnabled } from './debug'
// import { EncryptPayloadRequest } from './types/beacon/messages/EncryptPayloadRequest'
// import { EncryptPayloadResponse } from './types/beacon/messages/EncryptPayloadResponse'
import { getLogger, Logger, setLogger, reportDiagnostic } from './utils/Logger'
import { windowRef } from './MockWindow'
import { CommunicationClient } from './transports/clients/CommunicationClient'
import { ClientEvents } from './transports/clients/ClientEvents'
import { WCStorage } from './storage/WCStorage'
import { IndexedDBStorage } from './storage/IndexedDBStorage'
import { StorageValidator } from './storage/StorageValidator'
import { MultiTabChannel, observeMultiTabChannel } from './utils/multi-tab-channel'
// import { EncryptionType } from './types/EncryptionType'
// import { EncryptionOperation } from './types/EncryptionOperation'

// Clients
export { BeaconClient, BeaconClientOptions, Client, ClientOptions, ClientEvents }

// Errors
export {
  getError,
  BeaconError,
  BeaconErrorOptions,
  AbortedBeaconError,
  BroadcastBeaconError,
  NetworkNotSupportedBeaconError,
  NoAddressBeaconError,
  NoPrivateKeyBeaconError,
  NotGrantedBeaconError,
  ParametersInvalidBeaconError,
  TooManyOperationsBeaconError,
  TransactionInvalidBeaconError,
  SignatureTypeNotSupportedBeaconError,
  PeerUnreachableBeaconError,
  // EncryptionTypeNotSupportedBeaconError,
  UnknownBeaconError,
  isBeaconError,
  isErrorOrigin,
  isErrorResponse,
  isRequestErrorResponse,
  isTezosRpcError,
  ErrorOrigin,
  RequestErrorResponse,
  TezosRpcError
} from '@ecadlabs/beacon-types'

// Transport
export { Transport, getPairingPeerOwnership, MessageBasedClient, CommunicationClient }
export type { ClientTransport } from './transports/ClientTransport'
export type {
  TransportHealth,
  TransportStatusChangeReason,
  TransportStatusChangedInfo,
  ConnectionInfo,
  WaitingForWalletAckInfo,
  PendingRequestInfo
} from '@ecadlabs/beacon-types'

// Storage
export { ChromeStorage, LocalStorage, WCStorage, IndexedDBStorage, StorageValidator, getStorage }

// Managers
export { PeerManager, AccountManager, AppMetadataManager, PermissionManager }

// Constants
export { SDK_VERSION, BEACON_VERSION }

// Utils
export { getSenderId, getAccountIdentifier, windowRef, MultiTabChannel, observeMultiTabChannel }

// Others
export { Serializer, Logger, setLogger, getLogger, reportDiagnostic }
export type { LoggerDiagnostic } from './utils/Logger'

export { PendingPairingRequests } from './transports/clients/PendingPairingRequests'

// Debug
export { setDebugEnabled, getDebugEnabled }

export { NOTIFICATION_ORACLE_URL } from './constants'
