import { BeaconMessageType } from '../beacon/BeaconMessageType'
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
  deadline?: number
  acknowledged: boolean | undefined
}
