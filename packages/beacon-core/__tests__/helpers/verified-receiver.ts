import { Client, LocalStorage, Transport } from '@ecadlabs/beacon-core'
import { vi } from 'vitest'

type ReceiverTransport = Pick<Transport, 'type' | 'addListener' | 'removeListener'>

export class VerifiedReceiver extends Client {
  readonly received = vi.fn()

  constructor(storage: LocalStorage) {
    super({ name: 'test-receiver', storage })
    this.handleResponse = this.received
  }

  protected override async initSDK(): Promise<void> {}

  register(transport: ReceiverTransport): Promise<void> {
    return this.addListener(transport)
  }
}
