import { keys } from '@ecadlabs/beacon-utils'
import { Logger } from '@ecadlabs/beacon-core'
import { Storage, StorageKey } from '@ecadlabs/beacon-types'
import { MatrixRoom, MatrixRoomStatus } from './models/MatrixRoom'

const logger = new Logger('MatrixClientStore')

type OnStateChangedListener = (
  oldState: MatrixStateStore,
  newState: MatrixStateStore,
  stateChange: Partial<MatrixStateUpdate>
) => void

export interface MatrixState {
  isRunning: boolean
  userId: string | undefined
  deviceId: string | undefined
  txnNo: number
  accessToken: string | undefined
  syncToken: string | undefined
  pollingTimeout: number | undefined
  pollingRetries: number
  rooms: MatrixRoom[] | Record<string, MatrixRoom>
}

export interface MatrixStateStore extends MatrixState {
  rooms: Record<string, MatrixRoom>
}

export interface MatrixStateUpdate extends MatrixState {
  rooms: MatrixRoom[]
}

/**
 * The class managing the local state of matrix
 */
export class MatrixClientStore {
  /**
   * The state of the matrix client
   */
  private state: MatrixStateStore = {
    isRunning: false,
    userId: undefined,
    deviceId: undefined,
    txnNo: 0,
    accessToken: undefined,
    syncToken: undefined,
    pollingTimeout: undefined,
    pollingRetries: 0,
    rooms: {}
  }

  /**
   * Listeners that will be called when the state changes
   */
  private readonly onStateChangedListeners: Map<keyof MatrixState | 'all', OnStateChangedListener> =
    new Map()

  /**
   * A promise that resolves once the client is ready
   */
  private readonly waitReadyPromise: Promise<void>
  private persistence: Promise<void> = Promise.resolve()

  constructor(private readonly storage: Storage) {
    this.waitReadyPromise = new Promise<void>(async (resolve, reject) => {
      try {
        await this.initFromStorage()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * Get an item from the state
   *
   * @param key
   */
  public get<T extends keyof MatrixStateStore>(key: T): MatrixStateStore[T] {
    return this.state[key]
  }

  /**
   * Get the room from an ID or room instance
   *
   * @param roomOrId
   */
  public getRoom(roomOrId: string | MatrixRoom): MatrixRoom {
    const room = MatrixRoom.from(roomOrId, MatrixRoomStatus.UNKNOWN)

    return this.state.rooms[room.id] || room
  }

  /**
   * Update the state with a partial state
   *
   * @param stateUpdate
   */
  public async update(stateUpdate: Partial<MatrixStateUpdate>): Promise<void> {
    await this.waitReady()

    const oldState = Object.assign({}, this.state)
    this.setState(stateUpdate)
    const persistence = this.updateStorage(stateUpdate)

    this.notifyListeners(oldState, this.state, stateUpdate)
    await persistence
  }

  /** Drain writes after the client has stopped producing state updates. */
  public async flush(): Promise<void> {
    // Failed initialization cannot enqueue writes, but must not prevent teardown.
    await this.waitReady().catch(() => undefined)
    await this.persistence
  }

  /**
   * Register listeners that are called once the state has changed
   *
   * @param listener
   * @param subscribed
   */
  public onStateChanged(
    listener: OnStateChangedListener,
    ...subscribed: (keyof MatrixState)[]
  ): void {
    if (subscribed.length > 0) {
      subscribed.forEach((key) => {
        this.onStateChangedListeners.set(key, listener)
      })
    } else {
      this.onStateChangedListeners.set('all', listener)
    }
  }

  /**
   * A promise that resolves once the client is ready
   */
  private async waitReady(): Promise<void> {
    return this.waitReadyPromise
  }

  /**
   * Read state from storage
   */
  private async initFromStorage(): Promise<void> {
    const preserved = await this.storage.get(StorageKey.MATRIX_PRESERVED_STATE)
    this.setState(preserved)
  }

  /**
   * Prepare data before persisting it in storage
   *
   * @param toStore
   */
  private prepareData(toStore: Partial<MatrixStateStore>): Partial<MatrixStateStore> {
    const requiresPreparation: (keyof MatrixStateStore)[] = ['rooms']

    const toStoreCopy: Partial<MatrixStateStore> = requiresPreparation.some(
      (key: keyof MatrixStateStore) => toStore[key] !== undefined
    )
      ? JSON.parse(JSON.stringify(toStore))
      : toStore

    // there is no need for saving messages in a persistent storage
    Object.values(toStoreCopy.rooms || {}).forEach((room: MatrixRoom) => {
      room.messages = []
    })

    return toStoreCopy
  }

  /**
   * Persist state in storage
   *
   * @param stateUpdate
   */
  private updateStorage(stateUpdate: Partial<MatrixStateUpdate>): Promise<void> {
    const preservedState = {
      syncToken: this.state.syncToken,
      rooms: this.state.rooms
    }
    const hasUpdatedCachedFields = Object.entries(stateUpdate).some(
      ([key, value]) => Object.prototype.hasOwnProperty.call(preservedState, key) && Boolean(value)
    )

    if (hasUpdatedCachedFields) {
      const snapshot = this.prepareData(preservedState)
      // Serialize snapshots and recover the queue so a failed write cannot block teardown.
      this.persistence = this.persistence
        .then(() => this.storage.set(StorageKey.MATRIX_PRESERVED_STATE, snapshot))
        .catch((error) => logger.error('updateStorage', 'failed to persist matrix state', error))

      return this.persistence
    }

    return Promise.resolve()
  }

  /**
   * Set the state
   *
   * @param partialState
   */
  private setState(partialState: Partial<MatrixState>): void {
    this.state = {
      isRunning: partialState.isRunning || this.state.isRunning,
      userId: partialState.userId || this.state.userId,
      deviceId: partialState.deviceId || this.state.deviceId,
      txnNo: partialState.txnNo || this.state.txnNo,
      accessToken: partialState.accessToken || this.state.accessToken,
      syncToken: partialState.syncToken || this.state.syncToken,
      pollingTimeout: partialState.pollingTimeout || this.state.pollingTimeout,
      pollingRetries: partialState.pollingRetries || this.state.pollingRetries,
      rooms: this.mergeRooms(this.state.rooms, partialState.rooms)
    }
  }

  /**
   * Merge room records and eliminate duplicates
   *
   * @param oldRooms
   * @param _newRooms
   */
  private mergeRooms(
    oldRooms: Record<string, MatrixRoom>,
    _newRooms?: MatrixRoom[] | Record<string, MatrixRoom>
  ): Record<string, MatrixRoom> {
    if (!_newRooms) {
      return oldRooms
    }

    const newRooms: MatrixRoom[] = Array.isArray(_newRooms) ? _newRooms : Object.values(_newRooms)

    const merged: Record<string, MatrixRoom> = Object.assign({}, oldRooms)
    newRooms.forEach((newRoom: MatrixRoom) => {
      merged[newRoom.id] = MatrixRoom.merge(newRoom, oldRooms[newRoom.id])
    })

    return merged
  }

  /**
   * Notify listeners of state changes
   *
   * @param oldState
   * @param newState
   * @param stateChange
   */
  private notifyListeners(
    oldState: MatrixStateStore,
    newState: MatrixStateStore,
    stateChange: Partial<MatrixStateUpdate>
  ): void {
    const listenForAll = this.onStateChangedListeners.get('all')
    if (listenForAll) {
      listenForAll(oldState, newState, stateChange)
    }

    keys(stateChange)
      .filter((key) => stateChange[key] !== undefined)
      .forEach((key) => {
        const listener = this.onStateChangedListeners.get(key)
        if (listener) {
          listener(oldState, newState, stateChange)
        }
      })
  }
}
