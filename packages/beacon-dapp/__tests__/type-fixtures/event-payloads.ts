import {
  AccountInfo,
  AcknowledgeResponse,
  BeaconMessageType,
  TransportType
} from '@ecadlabs/beacon-types'
import { DAppClient } from '../../src/dapp-client/DAppClient'
import { BeaconEvent, BeaconEventType } from '../../src/events'

// This fixture is checked by TypeScript, not just transpiled by Vitest.
export const cleared: BeaconEventType[BeaconEvent.ACTIVE_ACCOUNT_SET] = undefined

export function subscribe(client: DAppClient): void {
  void client.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, (account) => {
    // @ts-expect-error Clearing the active account emits undefined.
    const unsafe: AccountInfo = account
    void unsafe
    if (account) {
      const selected: AccountInfo = account
      void selected
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
