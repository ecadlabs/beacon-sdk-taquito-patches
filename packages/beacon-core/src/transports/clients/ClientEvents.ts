import type { TransportStatusChangedInfo, TransportType } from '@ecadlabs/beacon-types'

export enum ClientEvents {
  CLOSE_ALERT = 'CLOSE_ALERT',
  RESET_STATE = 'RESET_STATE',
  WC_ACK_NOTIFICATION = 'WC_ACK_NOTIFICATION',
  ON_RELAYER_ERROR = 'ON_RELAYER_ERROR',
  TRANSPORT_STATUS = 'TRANSPORT_STATUS'
}

export interface ClientEventHandlers {
  [ClientEvents.CLOSE_ALERT]: (transport: TransportType) => void | Promise<void>
  [ClientEvents.RESET_STATE]: (transport: TransportType) => void | Promise<void>
  [ClientEvents.WC_ACK_NOTIFICATION]: (status: 'pending' | 'error') => void | Promise<void>
  [ClientEvents.ON_RELAYER_ERROR]: (transport: TransportType) => void | Promise<void>
  [ClientEvents.TRANSPORT_STATUS]: (
    update: Partial<
      Pick<TransportStatusChangedInfo, 'status' | 'health' | 'reason' | 'relayServer'>
    >
  ) => void | Promise<void>
}

/** Preserves Map operations while relating each event to its callback payload. */
export class ClientEventHandlerMap extends Map<ClientEvents, ClientEventHandlers[ClientEvents]> {
  constructor() {
    super()
  }

  public get<E extends ClientEvents>(event: E): ClientEventHandlers[E] | undefined
  public get(event: ClientEvents): ClientEventHandlers[ClientEvents] | undefined {
    return super.get(event)
  }

  public set<E extends ClientEvents>(event: E, handler: ClientEventHandlers[E]): this
  public set(event: ClientEvents, handler: ClientEventHandlers[ClientEvents]): this {
    return super.set(event, handler)
  }
}
