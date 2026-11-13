import { Logger } from '@ecadlabs/beacon-core'
import { BeaconMessageType, TransportType } from '@ecadlabs/beacon-types'
import { type ResponseMessage, responseOutput } from './request-error'

export type BeaconMessageDisposition = 'handled' | 'stale' | 'unknown-request' | 'invalid'

/** A detached snapshot of a plaintext Beacon protocol message, before incoming validation. */
export interface BeaconMessageRecord {
  readonly direction: 'outgoing' | 'incoming'
  readonly transport: TransportType
  /** Remote wallet identity, when known; incoming identities are untrusted. */
  readonly senderId?: string
  /** Epoch milliseconds at observation. Outgoing records describe attempts, not delivery. */
  readonly ts: number
  readonly message: unknown
  /** Outcome classification for incoming wire messages after routing. */
  readonly disposition?: BeaconMessageDisposition
}

const VALID_BEACON_MESSAGE_TYPES = new Set<unknown>(Object.values(BeaconMessageType))

/** @internal Validates whether an incoming deserialized payload has a routable Beacon message shape. */
export const isValidIncomingResponseMessage = (message: unknown): message is ResponseMessage => {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return false
  }
  if (!('id' in message) || typeof message.id !== 'string' || message.id.length === 0) {
    return false
  }
  if (
    !('version' in message) ||
    typeof message.version !== 'string' ||
    message.version.length === 0
  ) {
    return false
  }
  if (
    'senderId' in message &&
    message.senderId !== undefined &&
    typeof message.senderId !== 'string'
  ) {
    return false
  }
  const typedMessage = responseOutput(message as ResponseMessage)
  if (typeof typedMessage !== 'object' || typedMessage === null || Array.isArray(typedMessage)) {
    return false
  }

  return 'type' in typedMessage && VALID_BEACON_MESSAGE_TYPES.has(typedMessage.type)
}

const logger = new Logger('MessageObserver')

function deepFreeze(value: unknown, seen = new WeakSet()): unknown {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    // Frozen built-ins such as Map and Date still have mutable internal state.
    // Only JSON-shaped containers can safely be shared between observers.
    if (!Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Object]') {
      throw new TypeError('Message snapshots require plain objects and arrays')
    }
    seen.add(value)
    for (const child of Object.values(value)) {
      deepFreeze(child, seen)
    }
    Object.freeze(value)
  }

  return value
}

/** @internal Owns subscriptions and isolates their snapshots and callback failures. */
export class MessageObserver {
  private readonly listeners = new Map<(record: BeaconMessageRecord) => void, () => void>()

  public subscribe(listener: (record: BeaconMessageRecord) => void): () => void {
    const existing = this.listeners.get(listener)
    if (existing) {
      return existing
    }
    const unsubscribe = (): void => {
      if (this.listeners.get(listener) === unsubscribe) {
        this.listeners.delete(listener)
      }
    }
    this.listeners.set(listener, unsubscribe)

    return unsubscribe
  }

  public clear(): void {
    this.listeners.clear()
  }

  public notify(
    direction: BeaconMessageRecord['direction'],
    transport: TransportType,
    message: unknown,
    senderId?: string,
    disposition?: BeaconMessageDisposition
  ): void {
    if (this.listeners.size === 0) {
      return
    }
    let record: BeaconMessageRecord
    try {
      record = Object.freeze({
        direction,
        transport,
        senderId,
        ts: Date.now(),
        message: deepFreeze(structuredClone(message)),
        ...(disposition !== undefined ? { disposition } : {})
      })
    } catch (error: unknown) {
      // Unsupported caller-provided values must not turn tracing into a request failure.
      logger.error('snapshot', error)

      return
    }
    for (const listener of Array.from(this.listeners.keys())) {
      try {
        // A callback may return a promise even though the subscription signature returns void.
        Promise.resolve(listener(record)).catch((error: unknown) => logger.error('listener', error))
      } catch (error: unknown) {
        logger.error('listener', error)
      }
    }
  }

  public notifyIncoming(
    transport: TransportType | undefined,
    message: unknown,
    disposition?: BeaconMessageDisposition
  ): void {
    if (transport === undefined) {
      return
    }
    const senderId =
      message !== null &&
      typeof message === 'object' &&
      'senderId' in message &&
      typeof message.senderId === 'string'
        ? message.senderId
        : undefined
    this.notify('incoming', transport, message, senderId, disposition)
  }
}
