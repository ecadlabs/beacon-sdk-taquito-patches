import { isCreateEvent, isJoinEvent, isMessageEvent } from '../utils/events'
import {
  MatrixSyncJoinedRoom,
  MatrixSyncInvitedRoom,
  MatrixSyncLeftRoom,
  MatrixSyncRooms
} from './api/MatrixSync'
import { MatrixMessage } from './MatrixMessage'
import { MatrixStateEvent } from './MatrixStateEvent'

export enum MatrixRoomStatus {
  UNKNOWN,
  JOINED,
  INVITED,
  LEFT
}

// Retain a small recent history; event delivery uses the complete incoming sync batch.
const RETAINED_MESSAGE_LIMIT = 100

export class MatrixRoom {
  /**
   * Reconstruct rooms from a sync response
   *
   * @param roomSync
   */
  public static fromSync(roomSync?: MatrixSyncRooms): MatrixRoom[] {
    if (!roomSync) {
      return []
    }

    function create<T>(
      rooms: { [key: string]: T },
      creator: (id: string, room: T) => MatrixRoom
    ): MatrixRoom[] {
      return Object.entries(rooms).map(([id, room]) => creator(id, room))
    }

    return [
      ...create(roomSync.join ?? {}, MatrixRoom.fromJoined),
      ...create(roomSync.invite ?? {}, MatrixRoom.fromInvited),
      ...create(roomSync.leave ?? {}, MatrixRoom.fromLeft)
    ]
  }

  /**
   * Reconstruct a room from an ID or object
   *
   * @param roomOrId
   * @param status
   */
  public static from(roomOrId: string | MatrixRoom, status?: MatrixRoomStatus): MatrixRoom {
    return typeof roomOrId === 'string'
      ? new MatrixRoom(roomOrId, status || MatrixRoomStatus.UNKNOWN)
      : status !== undefined
        ? new MatrixRoom(
            roomOrId.id,
            status,
            roomOrId.members,
            roomOrId.messages,
            roomOrId.invitations
          )
        : roomOrId
  }

  /**
   * Merge new and old state and remove duplicates
   *
   * @param newState
   * @param previousState
   */
  public static merge(newState: MatrixRoom, previousState?: MatrixRoom): MatrixRoom {
    if (!previousState || previousState.id !== newState.id) {
      return new MatrixRoom(
        newState.id,
        newState.status,
        newState.members,
        newState.messages.slice(-RETAINED_MESSAGE_LIMIT),
        newState.invitations
      )
    }

    return new MatrixRoom(
      newState.id,
      newState.status,
      [...previousState.members, ...newState.members].filter(
        (member, index, array) => array.indexOf(member) === index
      ),
      [...previousState.messages, ...newState.messages].slice(-RETAINED_MESSAGE_LIMIT),
      newState.invitations
    )
  }

  /**
   * Create a room from a join
   *
   * @param id
   * @param joined
   */
  private static fromJoined(this: void, id: string, joined: MatrixSyncJoinedRoom): MatrixRoom {
    const events = [...joined.state.events, ...joined.timeline.events]
    const members = MatrixRoom.getMembersFromEvents(events)
    const messages = MatrixRoom.getMessagesFromEvents(events)

    return new MatrixRoom(id, MatrixRoomStatus.JOINED, members, messages)
  }

  /**
   * Create a room from an invite
   *
   * @param id
   * @param invited
   */
  private static fromInvited(this: void, id: string, invited: MatrixSyncInvitedRoom): MatrixRoom {
    const members = MatrixRoom.getMembersFromEvents(invited.invite_state.events)

    const memberEventsByTarget = new Map<
      string,
      { sender: string; membership: string | undefined }[]
    >()
    for (const event of invited.invite_state.events) {
      if (event.type === 'm.room.member' && typeof event.state_key === 'string') {
        const existing = memberEventsByTarget.get(event.state_key) ?? []
        existing.push({
          sender: event.sender,
          membership: (event.content as { membership?: string })?.membership
        })
        memberEventsByTarget.set(event.state_key, existing)
      }
    }

    const rejectedTargets: string[] = []
    const invitations = Array.from(memberEventsByTarget.entries()).flatMap(([target, events]) => {
      if (events.length === 0) {
        return []
      }
      const firstSender = events[0].sender
      const allValidInviteFromSameSender =
        typeof firstSender === 'string' &&
        firstSender.length > 0 &&
        events.every((entry) => entry.membership === 'invite' && entry.sender === firstSender)
      if (!allValidInviteFromSameSender) {
        rejectedTargets.push(target)

        return []
      }

      return [{ sender: firstSender, target }]
    })
    Object.defineProperty(invitations, 'rejectedTargets', {
      value: rejectedTargets,
      enumerable: false
    })

    return new MatrixRoom(id, MatrixRoomStatus.INVITED, members, [], invitations)
  }

  /**
   * Create a room from a leave
   *
   * @param id
   * @param left
   */
  private static fromLeft(this: void, id: string, left: MatrixSyncLeftRoom): MatrixRoom {
    const events = [...left.state.events, ...left.timeline.events]
    const members = MatrixRoom.getMembersFromEvents(events)
    const messages = MatrixRoom.getMessagesFromEvents(events)

    return new MatrixRoom(id, MatrixRoomStatus.LEFT, members, messages)
  }

  /**
   * Extract members from an event
   *
   * @param events
   */
  private static getMembersFromEvents(events: MatrixStateEvent[]): string[] {
    return MatrixRoom.getUniqueEvents(
      events.filter((event) => isCreateEvent(event) || isJoinEvent(event))
    )
      .map((event) => event.sender)
      .filter((member, index, array) => array.indexOf(member) === index)
  }

  /**
   * Extract messages from an event
   *
   * @param events
   */
  private static getMessagesFromEvents(events: MatrixStateEvent[]): MatrixMessage<unknown>[] {
    return MatrixRoom.getUniqueEvents(events.filter(isMessageEvent))
      .map((event) => MatrixMessage.from(event))
      .filter((message) => message !== undefined)
  }

  /**
   * Get unique events and remove duplicates
   *
   * @param events
   */
  private static getUniqueEvents(events: MatrixStateEvent[]): MatrixStateEvent[] {
    const eventIds: Record<string, number> = {}
    const uniqueEvents: MatrixStateEvent[] = []

    events.forEach((event: MatrixStateEvent, index: number) => {
      const eventId = event.event_id
      if (eventId === undefined || !(eventId in eventIds)) {
        if (eventId !== undefined) {
          eventIds[eventId] = index
        }

        uniqueEvents.push(event)
      }
    })

    return uniqueEvents
  }

  private constructor(
    public readonly id: string,
    public readonly status: MatrixRoomStatus = MatrixRoomStatus.UNKNOWN,
    public readonly members: string[] = [],
    public messages: MatrixMessage<unknown>[] = [],
    public readonly invitations: { sender: string; target: string }[] = []
  ) {}
}
