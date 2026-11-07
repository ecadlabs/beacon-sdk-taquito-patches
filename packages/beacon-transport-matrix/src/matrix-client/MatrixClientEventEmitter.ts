import { EventEmitter } from './EventEmitter'
import { MatrixStateStore, MatrixStateUpdate } from './MatrixClientStore'
import { MatrixRoomStatus } from './models/MatrixRoom'
import { MatrixClientEventType, MatrixClientEvent } from './models/MatrixClientEvent'

type MatrixEventArguments = {
  [K in MatrixClientEventType]: [event: MatrixClientEvent<K>]
}

export class MatrixClientEventEmitter extends EventEmitter<MatrixEventArguments> {
  /**
   * This method is called every time the state is changed
   */
  public onStateChanged(
    _oldState: MatrixStateStore,
    _newState: MatrixStateStore,
    stateChange: Partial<MatrixStateUpdate>
  ): void {
    stateChange.rooms
      ?.filter((room) => room.status === MatrixRoomStatus.INVITED)
      .map((room) => ({
        roomId: room.id,
        members: room.members,
        invitations: room.invitations
      }))
      .forEach((content) => {
        this.emit(MatrixClientEventType.INVITE, {
          type: MatrixClientEventType.INVITE,
          content,
          timestamp: undefined
        })
      })

    stateChange.rooms
      ?.filter((room) => room.messages.length > 0)
      .flatMap((room) =>
        room.messages.map((message) => ({
          content: { roomId: room.id, message },
          timestamp: message.timestamp
        }))
      )
      .forEach(({ content, timestamp }) => {
        this.emit(MatrixClientEventType.MESSAGE, {
          type: MatrixClientEventType.MESSAGE,
          content,
          timestamp
        })
      })
  }
}
