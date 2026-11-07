import { Logger } from '@ecadlabs/beacon-core'
import { EventEmitter } from '../src/matrix-client/EventEmitter'
import { MatrixClientEventEmitter } from '../src/matrix-client/MatrixClientEventEmitter'
import { MatrixStateStore, MatrixStateUpdate } from '../src/matrix-client/MatrixClientStore'
import { MatrixClientEventType } from '../src/matrix-client/models/MatrixClientEvent'
import { MatrixMessage, MatrixMessageType } from '../src/matrix-client/models/MatrixMessage'
import { MatrixRoom, MatrixRoomStatus } from '../src/matrix-client/models/MatrixRoom'

type Events = {
  message: [text: string, sequence: number]
  invite: [invitation: { roomId: string }]
}

describe('EventEmitter listener lifecycle', () => {
  it('delivers distinct argument tuples and uses the emitter as callback receiver', () => {
    const emitter = new EventEmitter<Events>()
    const received: unknown[] = []
    const invitation = { roomId: 'invited-room' }
    emitter.on('message', function (this: EventEmitter<Events>, text, sequence) {
      received.push(this, text, sequence)
    })
    emitter.on('invite', function (this: EventEmitter<Events>, value) {
      received.push(this, value)
    })

    emitter.emit('message', 'hello', 7)
    emitter.emit('invite', invitation)

    expect(received).toEqual([emitter, 'hello', 7, emitter, invitation])
    expect(received[4]).toBe(invitation)
  })

  it('disposes only the registered callback and tolerates repeated disposal', () => {
    const emitter = new EventEmitter<Events>()
    const first = vi.fn()
    const second = vi.fn()
    const dispose = emitter.on('message', first)
    emitter.on('message', second)

    dispose()
    dispose()
    emitter.emit('message', 'remaining', 1)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('remaining', 1)
  })

  it('ignores removal of an absent listener', () => {
    const emitter = new EventEmitter<Events>()
    const listener = vi.fn()
    emitter.on('message', listener)

    emitter.removeListener('message', () => undefined)
    emitter.removeListener('invite', () => undefined)
    emitter.emit('message', 'kept', 2)

    expect(listener).toHaveBeenCalledWith('kept', 2)
  })

  it('removes one duplicate registration at a time', () => {
    const emitter = new EventEmitter<Events>()
    const listener = vi.fn()
    emitter.on('message', listener)
    emitter.on('message', listener)

    emitter.removeListener('message', listener)
    emitter.emit('message', 'one registration', 3)

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('clears one event without clearing another event', () => {
    const emitter = new EventEmitter<Events>()
    const message = vi.fn()
    const invite = vi.fn()
    emitter.on('message', message)
    emitter.on('invite', invite)

    emitter.removeListener('message')
    emitter.emit('message', 'removed', 4)
    emitter.emit('invite', { roomId: 'kept-room' })

    expect(message).not.toHaveBeenCalled()
    expect(invite).toHaveBeenCalledWith({ roomId: 'kept-room' })
  })

  it('clears all events and permits new subscriptions afterward', () => {
    const emitter = new EventEmitter<Events>()
    const oldMessage = vi.fn()
    const oldInvite = vi.fn()
    const nextMessage = vi.fn()
    emitter.on('message', oldMessage)
    emitter.on('invite', oldInvite)

    emitter.removeAllListeners()
    emitter.on('message', nextMessage)
    emitter.emit('message', 'new subscription', 5)
    emitter.emit('invite', { roomId: 'removed-room' })

    expect(oldMessage).not.toHaveBeenCalled()
    expect(oldInvite).not.toHaveBeenCalled()
    expect(nextMessage).toHaveBeenCalledWith('new subscription', 5)
  })

  it('removes a once listener before a reentrant emission and preserves its receiver', () => {
    const emitter = new EventEmitter<Events>()
    const received: unknown[] = []
    emitter.once('message', function (this: EventEmitter<Events>, text, sequence) {
      received.push(this, text, sequence)
      emitter.emit('message', 'reentrant', 99)
    })

    emitter.emit('message', 'first', 6)
    emitter.emit('message', 'later', 7)

    expect(received).toEqual([emitter, 'first', 6])
  })

  it('can cancel a once listener before delivery', () => {
    const emitter = new EventEmitter<Events>()
    const listener = vi.fn()
    const dispose = emitter.once('invite', listener)

    dispose()
    emitter.emit('invite', { roomId: 'cancelled-room' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('dispatches the original snapshot when callbacks remove or add listeners', () => {
    const emitter = new EventEmitter<Events>()
    const order: string[] = []
    const sibling = () => {
      order.push('sibling')
    }
    const added = () => {
      order.push('added')
    }
    const first = () => {
      order.push('first')
      emitter.removeListener('message', first)
      emitter.removeListener('message', sibling)
      emitter.on('message', added)
    }
    emitter.on('message', first)
    emitter.on('message', sibling)

    emitter.emit('message', 'first dispatch', 8)
    expect(order).toEqual(['first', 'sibling'])

    emitter.emit('message', 'second dispatch', 9)
    expect(order).toEqual(['first', 'sibling', 'added'])
  })

  it('logs a thrown callback error and continues delivery', () => {
    const emitter = new EventEmitter<Events>()
    const failure = new Error('listener failed')
    const later = vi.fn()
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    try {
      emitter.on('message', () => {
        throw failure
      })
      emitter.on('message', later)

      expect(() => emitter.emit('message', 'failure', 10)).not.toThrow()
      expect(errorLog).toHaveBeenCalledWith('emit', 'message', failure)
      expect(later).toHaveBeenCalledWith('failure', 10)
    } finally {
      errorLog.mockRestore()
    }
  })

  it('handles the toString event before registration and after clearing', () => {
    const emitter = new EventEmitter<{ toString: [text: string]; constructor: [value: number] }>()
    const listener = vi.fn()

    expect(() => emitter.emit('toString', 'before registration')).not.toThrow()
    expect(() => emitter.removeListener('toString', listener)).not.toThrow()
    emitter.on('toString', listener)
    emitter.emit('toString', 'registered')
    emitter.removeListener('toString')
    emitter.emit('toString', 'after clearing')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('registered')
  })

  it('handles the constructor event before registration and after clearing all events', () => {
    const emitter = new EventEmitter<{ toString: [text: string]; constructor: [value: number] }>()
    const listener = vi.fn()

    expect(() => emitter.emit('constructor', 1)).not.toThrow()
    expect(() => emitter.removeListener('constructor', listener)).not.toThrow()
    emitter.on('constructor', listener)
    emitter.emit('constructor', 2)
    emitter.removeAllListeners()
    emitter.emit('constructor', 3)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(2)
  })
})

const state: MatrixStateStore = {
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

const textMessage = (body: string, timestamp: number): MatrixMessage<unknown> => {
  const message = MatrixMessage.from({
    type: 'm.room.message',
    sender: '@sender:matrix.example',
    origin_server_ts: timestamp,
    content: { msgtype: MatrixMessageType.TEXT, body }
  })
  if (!message) {
    throw new Error('Expected a Matrix text message')
  }

  return message
}

describe('MatrixClientEventEmitter state dispatch', () => {
  it('ignores updates without invitations or messages', () => {
    const emitter = new MatrixClientEventEmitter()
    const invite = vi.fn()
    const message = vi.fn()
    emitter.on(MatrixClientEventType.INVITE, invite)
    emitter.on(MatrixClientEventType.MESSAGE, message)

    emitter.onStateChanged(state, state, { syncToken: 'next-sync' })
    emitter.onStateChanged(state, state, { rooms: [] })
    emitter.onStateChanged(state, state, {
      rooms: [MatrixRoom.from('empty-joined-room', MatrixRoomStatus.JOINED)]
    })

    expect(invite).not.toHaveBeenCalled()
    expect(message).not.toHaveBeenCalled()
  })

  it('delivers invitations before messages and preserves room order and message identity', () => {
    const emitter = new MatrixClientEventEmitter()
    const received: unknown[] = []
    const first = textMessage('first text', 101)
    const second = textMessage('second text', 202)
    const third = textMessage('third text', 303)
    const joined = MatrixRoom.from('joined-room', MatrixRoomStatus.JOINED)
    joined.messages.push(first, second)
    const invited = MatrixRoom.from('invited-room', MatrixRoomStatus.INVITED)
    const invitedWithMessage = MatrixRoom.from('invited-with-message', MatrixRoomStatus.INVITED)
    invitedWithMessage.messages.push(third)
    emitter.on(MatrixClientEventType.INVITE, (event) => {
      received.push(event)
    })
    emitter.on(MatrixClientEventType.MESSAGE, (event) => {
      received.push(event)
    })

    emitter.onStateChanged(state, state, { rooms: [joined, invited, invitedWithMessage] })

    expect(received).toEqual([
      {
        type: MatrixClientEventType.INVITE,
        content: { roomId: 'invited-room', members: [], invitations: [] },
        timestamp: undefined
      },
      {
        type: MatrixClientEventType.INVITE,
        content: { roomId: 'invited-with-message', members: [], invitations: [] },
        timestamp: undefined
      },
      {
        type: MatrixClientEventType.MESSAGE,
        content: { roomId: 'joined-room', message: first },
        timestamp: 101
      },
      {
        type: MatrixClientEventType.MESSAGE,
        content: { roomId: 'joined-room', message: second },
        timestamp: 202
      },
      {
        type: MatrixClientEventType.MESSAGE,
        content: { roomId: 'invited-with-message', message: third },
        timestamp: 303
      }
    ])
    const delivered: MatrixMessage<unknown>[] = []
    emitter.on(MatrixClientEventType.MESSAGE, (event) => {
      delivered.push(event.content.message)
    })
    emitter.onStateChanged(state, state, { rooms: [joined] })
    expect(delivered[0]).toBe(first)
    expect(delivered[1]).toBe(second)
  })

  it('preserves invitation members from reconstructed rooms', () => {
    const emitter = new MatrixClientEventEmitter()
    const listener = vi.fn()
    emitter.on(MatrixClientEventType.INVITE, listener)
    const rooms = MatrixRoom.fromSync({
      invite: {
        'invited-room': {
          invite_state: {
            events: [
              {
                type: 'm.room.member',
                sender: '@member:matrix.example',
                origin_server_ts: 123,
                content: { membership: 'join' }
              }
            ]
          }
        }
      }
    })

    emitter.onStateChanged(state, state, { rooms })

    expect(listener).toHaveBeenCalledWith({
      type: MatrixClientEventType.INVITE,
      content: { roomId: 'invited-room', members: ['@member:matrix.example'], invitations: [] },
      timestamp: undefined
    })
  })

  it('materializes messages before callbacks mutate later rooms', () => {
    const emitter = new MatrixClientEventEmitter()
    const first = textMessage('first room text', 401)
    const second = textMessage('second room text', 402)
    const firstRoom = MatrixRoom.from('first-room', MatrixRoomStatus.JOINED)
    const secondRoom = MatrixRoom.from('second-room', MatrixRoomStatus.JOINED)
    firstRoom.messages.push(first)
    secondRoom.messages.push(second)
    const delivered: MatrixMessage<unknown>[] = []
    emitter.on(MatrixClientEventType.MESSAGE, (event) => {
      delivered.push(event.content.message)
      if (event.content.roomId === 'first-room') {
        secondRoom.messages.splice(0)
      }
    })

    emitter.onStateChanged(state, state, { rooms: [firstRoom, secondRoom] })

    expect(secondRoom.messages).toEqual([])
    expect(delivered).toHaveLength(2)
    expect(delivered[0]).toBe(first)
    expect(delivered[1]).toBe(second)
  })

  it('snapshots invitations but reads replacement rooms for the subsequent message pass', () => {
    const emitter = new MatrixClientEventEmitter()
    const firstInvite = MatrixRoom.from('first-invite', MatrixRoomStatus.INVITED)
    const secondInvite = MatrixRoom.from('second-invite', MatrixRoomStatus.INVITED)
    const originalRoom = MatrixRoom.from('original-room', MatrixRoomStatus.JOINED)
    originalRoom.messages.push(textMessage('original room text', 501))
    const replacementRoom = MatrixRoom.from('replacement-room', MatrixRoomStatus.JOINED)
    const replacementMessage = textMessage('replacement room text', 502)
    replacementRoom.messages.push(replacementMessage)
    const stateChange: Partial<MatrixStateUpdate> = {
      rooms: [firstInvite, secondInvite, originalRoom]
    }
    const received: unknown[] = []
    emitter.on(MatrixClientEventType.INVITE, (event) => {
      received.push(event)
      stateChange.rooms = [replacementRoom]
    })
    emitter.on(MatrixClientEventType.MESSAGE, (event) => {
      received.push(event)
    })

    emitter.onStateChanged(state, state, stateChange)

    expect(received).toEqual([
      {
        type: MatrixClientEventType.INVITE,
        content: { roomId: 'first-invite', members: [], invitations: [] },
        timestamp: undefined
      },
      {
        type: MatrixClientEventType.INVITE,
        content: { roomId: 'second-invite', members: [], invitations: [] },
        timestamp: undefined
      },
      {
        type: MatrixClientEventType.MESSAGE,
        content: { roomId: 'replacement-room', message: replacementMessage },
        timestamp: 502
      }
    ])
    expect(stateChange.rooms).toEqual([replacementRoom])
  })

  it('supports disposal and once delivery through the inherited public interface', () => {
    const emitter = new MatrixClientEventEmitter()
    const removed = vi.fn()
    const once = vi.fn()
    const dispose = emitter.on(MatrixClientEventType.INVITE, removed)
    emitter.once(MatrixClientEventType.INVITE, once)
    const rooms = [MatrixRoom.from('invited-room', MatrixRoomStatus.INVITED)]

    dispose()
    emitter.onStateChanged(state, state, { rooms })
    emitter.onStateChanged(state, state, { rooms })

    expect(removed).not.toHaveBeenCalled()
    expect(once).toHaveBeenCalledTimes(1)
  })
})
