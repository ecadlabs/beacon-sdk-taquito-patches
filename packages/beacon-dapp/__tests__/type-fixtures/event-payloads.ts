import {
  AccountInfo,
  StoredAccountInfo,
  AcknowledgeResponse,
  BeaconMessageType,
  ConnectionInfo,
  PendingRequestInfo,
  TransportHealth,
  TransportStatus,
  TransportStatusChangeReason,
  TransportType
} from '@ecadlabs/beacon-types'
import { ClientEvents, CommunicationClient } from '@ecadlabs/beacon-core'
import { DappWalletConnectTransport } from '../../src/transports/DappWalletConnectTransport'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import {
  BeaconEvent,
  BeaconEventHandler,
  BeaconEventType,
  TransportStatusChangedInfo,
  WaitingForWalletAckInfo
} from '../../src/events'

export function configureToasts(): void {
  new DAppClient({ name: 'Custom notifications', uiOptions: { enableToasts: false } })
  new BeaconEventHandler({}, false, { enableToasts: true })
  // @ts-expect-error Toast configuration accepts a boolean, not a string.
  new DAppClient({ name: 'Invalid option', uiOptions: { enableToasts: 'false' } })
}

// This fixture is checked by TypeScript, not just transpiled by Vitest.
export const cleared: BeaconEventType[BeaconEvent.ACTIVE_ACCOUNT_SET] = undefined

export function subscribe(client: DAppClient): void {
  void client.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, (account) => {
    // @ts-expect-error Clearing the active account emits undefined.
    const unsafe: AccountInfo = account
    void unsafe
    if (account) {
      const selected: StoredAccountInfo = account
      void selected
      // @ts-expect-error A selected account can belong to a non-Tezos blockchain.
      const networkType: string = account.network.type
      void networkType
      if (account.network) {
        const tezos: AccountInfo = account
        void tezos
      }
    }
  })
  void client.subscribeToEvent(BeaconEvent.ACKNOWLEDGE_RECEIVED, (ack) => {
    const receivedAt: number = ack.receivedAt
    void receivedAt
    // @ts-expect-error WalletConnect pending has no protocol acknowledge message.
    void ack.message.id
    if (ack.correlated) {
      const id: string = ack.requestId
      const message: AcknowledgeResponse = ack.message
      void id
      void message
    } else {
      // @ts-expect-error An uncorrelated status must not claim a request ID.
      void ack.requestId
      // @ts-expect-error An uncorrelated status must not contain a placeholder message.
      void ack.message
    }
  })
}

export function sent(info: BeaconEventType[BeaconEvent.SIGN_REQUEST_SENT]): void {
  const id: string = info.requestId
  const requestType: BeaconMessageType = info.requestType
  const transport: TransportType = info.transport
  const sender: string | undefined = info.senderId
  void id
  void requestType
  void transport
  void sender
  if (info.dispatchStage === 'transport') {
    const sentAt: number = info.sentAt
    void sentAt
    // @ts-expect-error Transport dispatch is not a forwarding notification.
    void info.forwardedAt
  } else {
    const forwardedAt: number = info.forwardedAt
    void forwardedAt
    // @ts-expect-error A follower cannot claim an actual transport send time.
    void info.sentAt
  }
}

type TerminalEvent =
  | BeaconEvent.PERMISSION_REQUEST_SUCCESS
  | BeaconEvent.PERMISSION_REQUEST_ERROR
  | BeaconEvent.OPERATION_REQUEST_SUCCESS
  | BeaconEvent.OPERATION_REQUEST_ERROR
  | BeaconEvent.SIGN_REQUEST_SUCCESS
  | BeaconEvent.SIGN_REQUEST_ERROR
  | BeaconEvent.BROADCAST_REQUEST_SUCCESS
  | BeaconEvent.BROADCAST_REQUEST_ERROR
  | BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS
  | BeaconEvent.PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR
  | BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_SUCCESS
  | BeaconEvent.SIMULATED_PROOF_OF_EVENT_CHALLENGE_REQUEST_ERROR
  | BeaconEvent.BLOCKCHAIN_REQUEST_SUCCESS

export function terminal(info: BeaconEventType[TerminalEvent]): void {
  const id: string = info.requestId
  const receivedAt: number = info.receivedAt
  void id
  void receivedAt
}
export function permission(info: BeaconEventType[BeaconEvent.PERMISSION_REQUEST_SUCCESS]): void {
  if (info.protocolVersion === '3') {
    const chain: string = info.output.message.blockchainIdentifier
    const scopes: string[] = info.account.scopes
    void chain
    void scopes
    // @ts-expect-error V3 output is the real envelope, not a fabricated V2 response.
    void info.output.network.type
  } else {
    const networkType: string = info.output.network.type
    const tezos: AccountInfo = info.account
    void networkType
    void tezos
    // @ts-expect-error V2 output has its existing flat shape.
    void info.output.message
  }
}

export async function observability(client: DAppClient): Promise<void> {
  void client.subscribeToEvent(BeaconEvent.TRANSPORT_STATUS_CHANGED, (info) => {
    const typed: TransportStatusChangedInfo = info
    const transport: TransportType = typed.transport
    const status: TransportStatus = typed.status
    const previous: TransportStatus = typed.previous
    const health: TransportHealth = typed.health
    const reason: TransportStatusChangeReason | undefined = typed.reason
    const relayServer: string | undefined = typed.relayServer
    void transport
    void status
    void previous
    void health
    void reason
    void relayServer
  })

  void client.subscribeToEvent(BeaconEvent.WAITING_FOR_WALLET_ACK, (info) => {
    const typed: WaitingForWalletAckInfo = info
    const requestId: string = typed.requestId
    const transport: TransportType = typed.transport
    const elapsedMs: number = typed.elapsedMs
    void requestId
    void transport
    void elapsedMs
  })

  const connectionInfo: ConnectionInfo = await client.getConnectionInfo()
  const pending: ReadonlyArray<PendingRequestInfo> = client.getPendingRequests()
  // @ts-expect-error Pending requests array is readonly
  pending.push
  void connectionInfo
  void pending
}


export function clientCallbacks(
  transport: DappWalletConnectTransport,
  communication: CommunicationClient
): void {
  transport.setEventHandler(ClientEvents.WC_ACK_NOTIFICATION, async (status) => {
    const acknowledged: 'pending' | 'error' = status
    void acknowledged
  })
  transport.setEventHandler(ClientEvents.TRANSPORT_STATUS, async (update) => {
    const status: TransportStatus | undefined = update.status
    void status
  })
  communication.eventHandlers.set(ClientEvents.RESET_STATE, async (_type: TransportType) => {})
  // @ts-expect-error ACK notifications carry a status, not a transport type.
  transport.setEventHandler(ClientEvents.WC_ACK_NOTIFICATION, (_type: TransportType) => {})
  // @ts-expect-error Transport status callbacks receive an update object.
  communication.eventHandlers.set(ClientEvents.TRANSPORT_STATUS, (_status: string) => {})
  // @ts-expect-error Retrieved ACK callbacks retain their status payload.
  communication.eventHandlers.get(ClientEvents.WC_ACK_NOTIFICATION)?.(TransportType.WALLETCONNECT)
  communication.eventHandlers.get(ClientEvents.TRANSPORT_STATUS)?.({ reason: 'relay_changed' })
}
