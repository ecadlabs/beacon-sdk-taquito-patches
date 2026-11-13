import { Storage } from '@ecadlabs/beacon-types'
import { Logger } from '@ecadlabs/beacon-core'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { MatrixClientStore } from './MatrixClientStore'
import { MatrixHttpClient } from './MatrixHttpClient'
import { MatrixRoom, MatrixRoomStatus } from './models/MatrixRoom'
import { MatrixMessageType } from './models/MatrixMessage'
import { MatrixRoomService } from './services/MatrixRoomService'
import { MatrixUserService } from './services/MatrixUserService'
import { MatrixEventService } from './services/MatrixEventService'
import { MatrixSyncResponse } from './models/api/MatrixSync'
import { MatrixClientEventEmitter } from './MatrixClientEventEmitter'
import { MatrixClientEventType, MatrixClientEvent } from './models/MatrixClientEvent'

const logger = new Logger('MatrixClient')

interface MatrixClientOptions {
  baseUrl: string
  storage: Storage
}

interface MatrixLoginConfig {
  id: string
  password: string | (() => Promise<string>)
  deviceId: string
}

const IMMEDIATE_POLLING_RETRIES = 3
const RETRY_INTERVAL = 5000
const MIN_WAKE_SYNC_AGE_MS = 1000

interface ActiveSyncAttempt {
  controller: AbortController
  startedAt: number
  canAbortOnWake: boolean
  abortedByWake: boolean
}

const WAKE_REFRESH_SENTINEL = Symbol('MatrixWakeRefresh')

export type MatrixHealthTransition =
  | { health: 'degraded'; reason: 'sync_failing' }
  | { health: 'ok' }
  | { reason: 'token_renewed' }

/**
 * The matrix client used to connect to the matrix network
 */
export class MatrixClient {
  private isActive: boolean = true
  private session: number = 0
  private cancelStartup: (() => void) | undefined
  private pollingRetry: { timer: ReturnType<typeof setTimeout>; complete: () => void } | undefined
  private activeSync: ActiveSyncAttempt | undefined
  private cleanupWakeListeners: (() => void) | undefined
  private _isReady: ExposedPromise<void> = this.createReadiness()
  private txnIdLock: Promise<void> = Promise.resolve()
  private healthListener?: (event: MatrixHealthTransition) => void | Promise<void>

  public onHealthTransition(
    listener: (event: MatrixHealthTransition) => void | Promise<void>
  ): void {
    this.healthListener = listener
  }

  constructor(
    private readonly store: MatrixClientStore,
    private readonly eventEmitter: MatrixClientEventEmitter,
    private readonly userService: MatrixUserService,
    private readonly roomService: MatrixRoomService,
    private readonly eventService: MatrixEventService,
    private readonly httpClient: MatrixHttpClient
  ) {
    this.store.onStateChanged((oldState, newState, stateChange) => {
      this.eventEmitter.onStateChanged(oldState, newState, stateChange)
    }, 'rooms')
  }

  /**
   * Create a matrix client based on the options provided
   *
   * @param config
   */
  public static create(config: MatrixClientOptions): MatrixClient {
    const store = new MatrixClientStore(config.storage)
    const eventEmitter = new MatrixClientEventEmitter()

    const httpClient = new MatrixHttpClient(config.baseUrl)

    const accountService = new MatrixUserService(httpClient)
    const roomService = new MatrixRoomService(httpClient)
    const eventService = new MatrixEventService(httpClient)

    return new MatrixClient(
      store,
      eventEmitter,
      accountService,
      roomService,
      eventService,
      httpClient
    )
  }

  /**
   * Return all the rooms we are currently part of
   */
  public get joinedRooms(): Promise<MatrixRoom[]> {
    return this.isConnected().then(() =>
      Object.values(this.store.get('rooms')).filter(
        (room) => room.status === MatrixRoomStatus.JOINED
      )
    )
  }

  /**
   * Return all the rooms to which we have received invitations
   */
  public get invitedRooms(): Promise<MatrixRoom[]> {
    return this.isConnected().then(() =>
      Object.values(this.store.get('rooms')).filter(
        (room) => room.status === MatrixRoomStatus.INVITED
      )
    )
  }

  /**
   * Return all the rooms that we left
   */
  public get leftRooms(): Promise<MatrixRoom[]> {
    return this.isConnected().then(() =>
      Object.values(this.store.get('rooms')).filter((room) => room.status === MatrixRoomStatus.LEFT)
    )
  }

  /**
   * Initiate the connection to the matrix node and log in
   *
   * @param user
   */
  public start(user: MatrixLoginConfig): Promise<void> {
    this.cancelStartup?.()
    this.clearPollingRetry()
    this.abortActiveSync()
    const session = ++this.session
    this.isActive = true
    this.registerWakeListeners()
    if (this._isReady.isSettled()) {
      this._isReady = this.createReadiness()
    }
    const ready = this._isReady
    const isCurrent = (): boolean => this.isActive && session === this.session

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const rejectStartup = (error: unknown, cancelRef?: () => void): void => {
        if (!settled) {
          settled = true
          if (cancelRef && this.cancelStartup === cancelRef) {
            this.cancelStartup = undefined
          }
          ready.reject(error)
          reject(error)
        }
      }
      const cancel = (): void =>
        rejectStartup(new DOMException('Matrix startup cancelled', 'AbortError'), cancel)
      const rejectWithCancel = (error: unknown): void => rejectStartup(error, cancel)
      this.cancelStartup = cancel
      const login = async (): Promise<void> => {
        if (!isCurrent()) {
          return
        }
        const password = typeof user.password === 'function' ? await user.password() : user.password
        if (!isCurrent()) {
          return
        }
        const response = await this.userService.login(user.id, password, user.deviceId)
        if (!isCurrent()) {
          return
        }
        await this.store.update({ accessToken: response.access_token })
      }

      const initialize = async (): Promise<void> => {
        let degraded = false
        await login()
        if (!isCurrent()) {
          return
        }
        this.poll(
          0,
          session,
          () => settled,
          login,
          async (pollingResponse: MatrixSyncResponse) => {
            if (!isCurrent()) {
              return
            }
            const wasSettled = settled
            await this.store.update({
              isRunning: true,
              syncToken: pollingResponse.next_batch,
              pollingTimeout: 30000,
              pollingRetries: 0,
              rooms: MatrixRoom.fromSync(pollingResponse.rooms)
            })
            if (!isCurrent()) {
              return
            }
            if (!settled) {
              settled = true
              if (this.cancelStartup === cancel) {
                this.cancelStartup = undefined
              }
              ready.resolve()
              resolve()
            } else if (wasSettled && degraded) {
              degraded = false
              await this.healthListener?.({ health: 'ok' })
            }
          },
          async (error) => {
            if (!isCurrent()) {
              return
            }
            const wasSettled = settled
            rejectWithCancel(error)
            const nextRetries = this.store.get('pollingRetries') + 1
            await this.store.update({
              isRunning: false,
              pollingRetries: nextRetries
            })
            if (!isCurrent()) {
              return
            }
            if (wasSettled && !degraded && nextRetries >= IMMEDIATE_POLLING_RETRIES) {
              degraded = true
              await this.healthListener?.({ health: 'degraded', reason: 'sync_failing' })
            }
          }
        ).catch(rejectWithCancel)
      }
      initialize().catch((error) => {
        if (isCurrent()) {
          this.cleanupWakeListeners?.()
        }
        rejectWithCancel(error)
      })
    })
  }

  public async isConnected(): Promise<void> {
    return this._isReady.promise
  }

  /**
   * Stop all running requests
   */
  public async stop(): Promise<void> {
    logger.log(`MATRIX CLIENT STOPPED`)
    this.isActive = false
    this.cleanupWakeListeners?.()
    this.cancelStartup?.()
    ++this.session
    this.clearPollingRetry()
    this.abortActiveSync()
    this._isReady.reject(new DOMException('Matrix client stopped', 'AbortError'))
    this._isReady = this.createReadiness()

    try {
      await this.httpClient.cancelAllRequests()
    } finally {
      await this.store
        .update({ isRunning: false })
        .catch((error) => logger.error('stop', 'failed to update stopped state', error))
      // P2P reset deletes preserved state after stop; older writes must settle first.
      await this.store.flush()
    }
  }

  /**
   * Subscribe to new matrix events
   *
   * @param event
   * @param listener
   */
  public subscribe<T extends MatrixClientEventType>(
    event: T,
    listener: (event: MatrixClientEvent<T>) => void
  ): void {
    this.eventEmitter.on(event, listener)
  }

  /**
   * Unsubscribe from matrix events
   *
   * @param event
   * @param listener
   */
  public unsubscribe<T extends MatrixClientEventType>(
    event: T,
    listener: (clientEvent: MatrixClientEvent<T>) => void
  ): void {
    if (listener) {
      this.eventEmitter.removeListener(event, listener)
    }
  }

  /**
   * Unsubscribe from all matrix events of this type
   *
   * @param event
   * @param listener
   */
  public unsubscribeAll(event: MatrixClientEventType): void {
    this.eventEmitter.removeListener(event)
  }

  public async getRoomById(id: string): Promise<MatrixRoom> {
    await this.isConnected()

    return this.store.getRoom(id)
  }

  /**
   * Create a private room with the supplied members
   *
   * @param members Members that will be in the room
   */
  public async createTrustedPrivateRoom(...members: string[]): Promise<string> {
    await this.isConnected()

    return this.requiresAuthorization('createRoom', async (accessToken) => {
      const response = await this.roomService.createRoom(accessToken, {
        room_version: '5',
        invite: members,
        preset: 'public_chat',
        is_direct: true
      })

      return response.room_id
    })
  }

  /**
   * Invite user to rooms
   *
   * @param user The user to be invited
   * @param roomsOrIds The rooms the user will be invited to
   */
  public async inviteToRooms(user: string, ...roomsOrIds: string[] | MatrixRoom[]): Promise<void> {
    await this.isConnected()

    await this.requiresAuthorization('invite', (accessToken) =>
      Promise.all(
        roomsOrIds.map((roomOrId) => {
          const room = this.store.getRoom(roomOrId)

          return this.roomService
            .inviteToRoom(accessToken, user, room)
            .catch((error) => logger.warn('inviteToRooms', error))
        })
      )
    )
  }

  /**
   * Join rooms
   *
   * @param roomsOrIds
   */
  public async joinRooms(...roomsOrIds: string[] | MatrixRoom[]): Promise<void> {
    await this.isConnected()

    await this.requiresAuthorization('join', (accessToken) =>
      Promise.all(
        roomsOrIds.map((roomOrId) => {
          const room = this.store.getRoom(roomOrId)

          return this.roomService.joinRoom(accessToken, room)
        })
      )
    )
  }

  /**
   * Send a text message
   *
   * @param roomOrId
   * @param message
   */
  public async sendTextMessage(roomId: string, message: string): Promise<void> {
    await this.isConnected()

    await this.requiresAuthorization('send', async (accessToken) => {
      const txnId = await this.createTxnId()

      // Stop may run while the transaction ID is being persisted.
      if (!this.isActive) {
        throw new DOMException('Matrix client stopped', 'AbortError')
      }

      return this.eventService.sendMessage(
        accessToken,
        roomId,
        {
          msgtype: MatrixMessageType.TEXT,
          body: message
        },
        txnId
      )
    })
  }

  private createReadiness(): ExposedPromise<void> {
    const ready = new ExposedPromise<void>()
    // Startup can fail before a caller begins waiting for connection readiness.
    ready.promise.catch(() => undefined)

    return ready
  }

  private clearPollingRetry(): void {
    const retry = this.pollingRetry
    this.pollingRetry = undefined
    if (retry) {
      clearTimeout(retry.timer)
      retry.complete()
    }
  }

  private abortActiveSync(): void {
    const active = this.activeSync
    this.activeSync = undefined
    if (active) {
      active.controller.abort(new DOMException('Matrix sync cancelled', 'AbortError'))
    }
  }

  private handleWakeTrigger(): void {
    if (!this.isActive) {
      return
    }
    this.clearPollingRetry()
    const active = this.activeSync
    if (
      active &&
      active.canAbortOnWake &&
      !active.controller.signal.aborted &&
      Date.now() - active.startedAt >= MIN_WAKE_SYNC_AGE_MS
    ) {
      active.abortedByWake = true
      active.controller.abort(new DOMException('Matrix sync refreshed on wake', 'AbortError'))
    }
  }

  private registerWakeListeners(): void {
    this.cleanupWakeListeners?.()
    const onWake = (): void => {
      this.handleWakeTrigger()
    }
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        this.handleWakeTrigger()
      }
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', onWake)
      window.addEventListener('focus', onWake)
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    this.cleanupWakeListeners = () => {
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('online', onWake)
        window.removeEventListener('focus', onWake)
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
      this.cleanupWakeListeners = undefined
    }
  }

  /**
   * Poll the server to get the latest data and get notified of changes
   *
   * @param interval
   * @param onSyncSuccess
   * @param onSyncError
   */
  private async poll(
    interval: number,
    session: number,
    isStartupSettled: () => boolean,
    renewAuthorization: () => Promise<void>,
    onSyncSuccess: (response: MatrixSyncResponse) => void | Promise<void>,
    onSyncError: (error: unknown) => void | Promise<void>
  ): Promise<void> {
    // Stop clears the owned retry and wakes this loop without reporting an error.
    while (this.isActive && session === this.session) {
      let syncingRetries = 0
      try {
        const response = await this.syncWithRenewal(
          session,
          isStartupSettled,
          renewAuthorization
        )
        if (!response) {
          return
        }
        if (this.isActive && session === this.session) {
          await onSyncSuccess(response)
        }
      } catch (error) {
        if (!this.isActive || session !== this.session) {
          return
        }
        if (error === WAKE_REFRESH_SENTINEL) {
          continue
        }
        await onSyncError(error)
        syncingRetries = this.store.get('pollingRetries')
        if (this.isActive && session === this.session) {
          logger.log(`Retry syncing... ${syncingRetries} retries so far`)
        }
      }
      if (!this.isActive || session !== this.session) {
        return
      }
      await this.waitForNextPoll(interval, syncingRetries)
    }
  }

  private async syncWithRenewal(
    session: number,
    isStartupSettled: () => boolean,
    renewAuthorization: () => Promise<void>
  ): Promise<MatrixSyncResponse | undefined> {
    try {
      return await this.sync(isStartupSettled())
    } catch (error) {
      if (
        (error as { errcode?: string })?.errcode !== 'M_UNKNOWN_TOKEN' ||
        !this.isActive ||
        session !== this.session
      ) {
        throw error
      }
      await renewAuthorization()
      if (!this.isActive || session !== this.session) {
        return undefined
      }
      await this.healthListener?.({ reason: 'token_renewed' })

      return this.sync(isStartupSettled())
    }
  }

  private async waitForNextPoll(interval: number, syncingRetries: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => {
          if (this.pollingRetry?.timer === timer) {
            this.pollingRetry = undefined
          }
          resolve()
        },
        syncingRetries >= IMMEDIATE_POLLING_RETRIES ? RETRY_INTERVAL + interval : interval
      )
      this.pollingRetry = { timer, complete: resolve }
    })
  }

  /**
   * Get state from server
   */
  private async sync(canAbortOnWake = false): Promise<MatrixSyncResponse> {
    return this.requiresAuthorization('sync', async (accessToken) => {
      const syncAttempt: ActiveSyncAttempt = {
        controller: new AbortController(),
        startedAt: Date.now(),
        canAbortOnWake,
        abortedByWake: false
      }
      this.activeSync = syncAttempt
      try {
        return await this.eventService.sync(accessToken, {
          pollingTimeout: this.store.get('pollingTimeout'),
          syncToken: this.store.get('syncToken'),
          signal: syncAttempt.controller.signal
        })
      } catch (error) {
        if (syncAttempt.abortedByWake) {
          throw WAKE_REFRESH_SENTINEL
        }
        throw error
      } finally {
        if (this.activeSync === syncAttempt) {
          this.activeSync = undefined
        }
      }
    })
  }

  /**
   * A helper method that makes sure an access token is provided
   *
   * @param name
   * @param action
   */
  private async requiresAuthorization<T>(
    name: string,
    action: (accessToken: string) => Promise<T>
  ): Promise<T> {
    if (!this.isActive) {
      throw new DOMException('Matrix client stopped', 'AbortError')
    }

    const storedToken: string | undefined = this.store.get('accessToken')

    if (!storedToken) {
      return Promise.reject(`${name} requires authorization but no access token has been provided.`)
    }

    return action(storedToken)
  }

  /**
   * Create a transaction ID
   */
  private async createTxnId(): Promise<string> {
    const previousTxnIdLock = this.txnIdLock
    let unlockTxnId!: () => void
    this.txnIdLock = new Promise<void>((resolve) => {
      unlockTxnId = resolve
    })

    await previousTxnIdLock

    try {
      const timestamp = new Date().getTime()
      const counter = this.store.get('txnNo')

      await this.store.update({
        txnNo: counter + 1
      })

      return `m${timestamp}.${counter}`
    } finally {
      unlockTxnId()
    }
  }
}
