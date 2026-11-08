import { LocalStorage } from '@ecadlabs/beacon-core'
import { Regions, StorageKey } from '@ecadlabs/beacon-types'
import { getKeypairFromSeed, toHex } from '@ecadlabs/beacon-utils'
import { P2PCommunicationClient } from '../../src/communication-client/P2PCommunicationClient'
import { MatrixClient } from '../../src/matrix-client/MatrixClient'
import { MatrixHttpClient } from '../../src/matrix-client/MatrixHttpClient'
import { MatrixClientEventType } from '../../src/matrix-client/models/MatrixClientEvent'
import { MatrixEventService } from '../../src/matrix-client/services/MatrixEventService'
import { MatrixUserService } from '../../src/matrix-client/services/MatrixUserService'

describe('P2P subscription ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    localStorage.clear()
  })

  it.each(['buffering', 'registered'])(
    'removes its exact callbacks when stopping a %s session',
    async (state) => {
      const storage = new LocalStorage('p2p-subscription-ownership')
      await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'relay.example')
      const client = new P2PCommunicationClient(
        'Test',
        await getKeypairFromSeed('p2p-subscription-ownership'),
        1,
        storage,
        { [Regions.EUROPE_WEST]: ['relay.example'] }
      )
      vi.spyOn(client, 'getBeaconInfo').mockResolvedValue({
        region: Regions.EUROPE_WEST,
        known_servers: [],
        timestamp: 12345
      })
      vi.spyOn(MatrixUserService.prototype, 'login').mockResolvedValue({
        user_id: '@sdk:relay.example',
        device_id: 'device',
        access_token: 'current-token'
      })
      vi.spyOn(MatrixEventService.prototype, 'sync').mockResolvedValue({
        next_batch: 'current-sync',
        rooms: {}
      })
      const allocatedClients: MatrixClient[] = []
      const create = MatrixClient.create
      vi.spyOn(MatrixClient, 'create').mockImplementation((options) => {
        const matrix = create(options)
        allocatedClients.push(matrix)
        return matrix
      })
      const subscribe = vi.spyOn(MatrixClient.prototype, 'subscribe')
      const unsubscribe = vi.spyOn(MatrixClient.prototype, 'unsubscribe')
      const unsubscribeAll = vi.spyOn(MatrixClient.prototype, 'unsubscribeAll')
      await client.start()
      const matrix = allocatedClients[0]
      try {
        if (state === 'registered') {
          const peer = await getKeypairFromSeed('p2p-subscription-peer')
          await client.listenForEncryptedMessage(toHex(peer.publicKey), vi.fn())
          await client.listenForChannelOpening(vi.fn())
        }
        const ownedSubscriptions = [...subscribe.mock.calls]
        const unrelated = vi.fn()
        matrix.subscribe(MatrixClientEventType.MESSAGE, unrelated)
        const cleanupError = new Error('HTTP cleanup failed')
        if (state === 'registered') {
          vi.spyOn(MatrixHttpClient.prototype, 'cancelAllRequests').mockRejectedValueOnce(
            cleanupError
          )
        }

        await client.stop()

        expect(ownedSubscriptions.length).toBe(state === 'buffering' ? 2 : 4)
        for (const [event, callback] of ownedSubscriptions) {
          expect(unsubscribe).toHaveBeenCalledWith(event, callback)
          const removal = unsubscribe.mock.calls.findIndex(
            ([type, listener]) => type === event && listener === callback
          )
          expect(unsubscribe.mock.contexts[removal]).toBe(matrix)
        }
        expect(unsubscribe).not.toHaveBeenCalledWith(MatrixClientEventType.MESSAGE, unrelated)
        expect(unsubscribeAll).not.toHaveBeenCalled()
      } finally {
        await client.stop()
      }
    }
  )
})
