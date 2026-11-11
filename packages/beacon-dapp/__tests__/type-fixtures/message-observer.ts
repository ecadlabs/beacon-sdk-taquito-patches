import { DAppClient, type BeaconMessageRecord, TransportType } from '../../src'

export function inspect(record: BeaconMessageRecord): void {
  const direction: 'incoming' | 'outgoing' = record.direction
  const transport: TransportType = record.transport
  const senderId: string | undefined = record.senderId
  const ts: number = record.ts
  const message: unknown = record.message
  void direction
  void transport
  void senderId
  void ts
  void message
  // @ts-expect-error Incoming data has not yet been validated as a Beacon message.
  void record.message.id
  // @ts-expect-error Observer records are immutable snapshots.
  record.ts = 0
  // @ts-expect-error Observers cannot replace the captured message.
  record.message = null
}

export function subscribe(client: DAppClient): void {
  const unsubscribe: () => void = client.subscribeToMessages(inspect)
  unsubscribe()
  unsubscribe()
  client.subscribeToMessages((record) => {
    if (record.message !== null && typeof record.message === 'object' && 'id' in record.message) {
      const id: unknown = record.message.id
      void id
    }
  })
}
