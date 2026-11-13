import { Logger } from '@ecadlabs/beacon-core'
import { MatrixHttpClient } from '../MatrixHttpClient'

import { MatrixEventSendRequest, MatrixEventSendResponse } from '../models/api/MatrixEventSend'
import { MatrixSyncResponse } from '../models/api/MatrixSync'

const logger = new Logger('MatrixEventService')

interface MatrixScheduledEvent {
  accessToken: string
  roomId: string
  type: MatrixEventType
  content: MatrixEventSendRequest
  txnId: string
  onSuccess(response: MatrixEventSendResponse): void | Promise<void>
  onError(error: unknown): void | Promise<void>
}

type MatrixEventType = 'm.room.message'

type CacheKeys = 'sync'

export const SYNC_TIMEOUT_GRACE_MS = 10_000

export interface MatrixSyncOptions {
  syncToken?: string
  pollingTimeout?: number
  signal?: AbortSignal
}

/**
 * A service to help with matrix event management
 */
export class MatrixEventService {
  private readonly cachedPromises: Map<CacheKeys, Promise<MatrixSyncResponse>> = new Map()

  constructor(private readonly httpClient: MatrixHttpClient) {}

  /**
   * Get the latest state from the matrix node
   *
   * @param accessToken
   * @param options
   */
  public async sync(accessToken: string, options?: MatrixSyncOptions): Promise<MatrixSyncResponse> {
    const pollingTimeout = options?.pollingTimeout

    return this.withCache('sync', () =>
      this.httpClient.get<MatrixSyncResponse>(
        '/sync',
        {
          timeout: pollingTimeout,
          since: options?.syncToken
        },
        {
          accessToken,
          timeoutMs:
            pollingTimeout !== undefined ? pollingTimeout + SYNC_TIMEOUT_GRACE_MS : undefined,
          signal: options?.signal
        }
      )
    )
  }

  /**
   * Send a message to a room
   *
   * @param accessToken
   * @param room
   * @param content
   * @param txnId
   */
  public async sendMessage(
    accessToken: string,
    roomId: string,
    content: MatrixEventSendRequest,
    txnId: string
  ): Promise<MatrixEventSendResponse> {
    return new Promise((resolve, reject) =>
      this.scheduleEvent({
        accessToken,
        roomId,
        type: 'm.room.message',
        content,
        txnId,
        onSuccess: resolve,
        onError: reject
      })
    )
  }

  /**
   * Schedules an event to be sent to the node
   *
   * @param event
   */
  public scheduleEvent(event: MatrixScheduledEvent) {
    // TODO: actual scheduling
    this.sendEvent(event).catch((error: unknown) =>
      logger.warn('scheduleEvent callback', event.roomId, event.txnId, error)
    )
  }

  /**
   * Send an event to the matrix node
   *
   * @param scheduledEvent
   */
  public async sendEvent(scheduledEvent: MatrixScheduledEvent): Promise<void> {
    const { roomId, type, txnId, content, accessToken } = scheduledEvent

    let response: MatrixEventSendResponse
    try {
      response = await this.httpClient.put<MatrixEventSendResponse>(
        `/rooms/${encodeURIComponent(roomId)}/send/${type}/${encodeURIComponent(txnId)}`,
        content,
        { accessToken }
      )
    } catch (error) {
      await scheduledEvent.onError(error)

      return
    }
    await scheduledEvent.onSuccess(response)
  }

  /**
   * Check the cache when interacting with the Matrix node, if there is an already ongoing call for the specified key, return its promise instead of duplicating the call.
   *
   * @param key
   * @param promiseProvider
   */
  private withCache(
    key: CacheKeys,
    promiseProvider: () => Promise<MatrixSyncResponse>
  ): Promise<MatrixSyncResponse> {
    let promise = this.cachedPromises.get(key)

    if (!promise) {
      promise = promiseProvider().finally(() => {
        this.cachedPromises.delete(key)
      })
      this.cachedPromises.set(key, promise)
    }

    return promise
  }
}
