import { MatrixClientStore } from '../../src/matrix-client/MatrixClientStore'
import { MatrixRoom } from '../../src/matrix-client/models/MatrixRoom'
import { MatrixClientEventEmitter } from '../../src/matrix-client/MatrixClientEventEmitter'
import { MatrixClientEventType } from '../../src/matrix-client/models/MatrixClientEvent'

const room = (count: number, offset = 0) =>
  MatrixRoom.fromSync({
    join: {
      '!room:relay': {
        state: {
          events: [
            { type: 'm.room.member', sender: '@wallet:relay', content: { membership: 'join' } }
          ]
        },
        timeline: {
          events: Array.from({ length: count }, (_, i) => ({
            type: 'm.room.message',
            sender: '@wallet:relay',
            event_id: `event-${offset + i}`,
            origin_server_ts: offset + i,
            content: { msgtype: 'm.text', body: `message-${offset + i}` }
          }))
        }
      }
    }
  } as any)[0]

const createStore = () =>
  new MatrixClientStore({ get: async () => ({}), set: async () => undefined } as any)

describe('Matrix state reliability', () => {
  it('stores false and zero when replacing earlier truthy values', async () => {
    const store = createStore()
    await store.update({ isRunning: true, pollingRetries: 3, pollingTimeout: 30000, txnNo: 10 })
    await store.update({ isRunning: false, pollingRetries: 0, pollingTimeout: 0, txnNo: 0 })
    expect(store.get('isRunning')).toBe(false)
    expect(store.get('pollingRetries')).toBe(0)
    expect(store.get('pollingTimeout')).toBe(0)
    expect(store.get('txnNo')).toBe(0)
  })

  it.each(['5', '11', '12'])('extracts the create event sender for room version %s', (version) => {
    const rooms = MatrixRoom.fromSync({
      invite: {
        '!room:relay': {
          invite_state: {
            events: [
              {
                type: 'm.room.create',
                sender: '@wallet:relay',
                content: { room_version: version }
              }
            ]
          }
        }
      }
    } as any)
    expect(rooms[0].members).toEqual(['@wallet:relay'])
  })

  it('bounds retained messages while delivering the complete incoming batch', async () => {
    const store = createStore()
    const emitter = new MatrixClientEventEmitter()
    const delivered = vi.fn()
    emitter.on(MatrixClientEventType.MESSAGE, delivered)
    store.onStateChanged(
      (oldState, newState, change) => emitter.onStateChanged(oldState, newState, change),
      'rooms'
    )
    await store.update({ rooms: [room(150)] })
    await store.update({ rooms: [room(150, 150)] })
    expect(delivered).toHaveBeenCalledTimes(300)
    const retained = store.getRoom('!room:relay').messages
    expect(retained.length).toBeLessThanOrEqual(100)
    expect(retained[retained.length - 1].content).toBe('message-299')
    expect(store.getRoom('!room:relay').members).toEqual(['@wallet:relay'])
  })
})
