import { BeaconMessageType } from '../beacon/BeaconMessageType'
import { BeaconRequestMessage } from '../beacon/BeaconRequestMessage'
import { BeaconMessageEnvelopeV3 } from '../beaconV3/PermissionRequest'
import { ConnectionContext } from '../ConnectionContext'
import { ExtendedPeerInfo } from '../PeerInfo'
import { TransportStatus } from './TransportStatus'
import { TransportType } from './TransportType'

export type TransportHealth = 'ok' | 'degraded'

export type TransportStatusChangeReason =
  | 'sync_failing'
  | 'token_renewed'
  | 'session_deleted'
  | 'session_expired'
  | 'relay_changed'

export interface TransportStatusChangedInfo {
  transport: TransportType
  status: TransportStatus
  previous: TransportStatus
  health: TransportHealth
  reason?: TransportStatusChangeReason
  relayServer?: string
}

export interface ConnectionInfo {
  transport?: TransportType
  status: TransportStatus
  health: TransportHealth
  relayServer?: string
  senderId?: string
}

export interface WaitingForWalletAckInfo {
  requestId: string
  transport: TransportType
  elapsedMs: number
}

export interface PendingRequestInfo {
  id: string
  type: BeaconMessageType
  transport: TransportType
  senderId?: string
  sentAt: number
  /**
   * Epoch millisecond timestamp when the request will time out with PEER_UNREACHABLE
   * (incorporating DAppClientOptions.requestTimeoutMs, the 60s default permission timeout,
   * and WalletConnect's 5-minute request expiry), or undefined when no deadline applies
   * (or after correlated ACK).
   */
  deadline?: number
  acknowledged: boolean | undefined
}

export type WalletPendingRequestRemovalReason = 'responded' | 'dismissed' | 'peer_disconnected'

export interface WalletPendingRequestInfo {
  id: string
  type: BeaconMessageType
  version: string
  transport: TransportType
  senderId: string
  receivedAt: number
  connectionContext: ConnectionContext
  request: BeaconRequestMessage | BeaconMessageEnvelopeV3
}

export type WalletPendingRequestEvent =
  | {
      type: 'request_received'
      request: WalletPendingRequestInfo
    }
  | {
      type: 'request_removed'
      request: WalletPendingRequestInfo
      reason: WalletPendingRequestRemovalReason
    }

export interface WalletPeerEvent {
  type: 'peer_added' | 'peer_removed'
  peer: ExtendedPeerInfo
  source: 'local' | 'storage'
}

