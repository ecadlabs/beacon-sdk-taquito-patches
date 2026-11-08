import { setImmediate } from 'node:timers/promises'
import { LocalStorage } from '@ecadlabs/beacon-core'
import { StorageKey, StorageKeyReturnType, TransportStatus } from '@ecadlabs/beacon-types'
import { ExposedPromise, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { P2PTransport } from '../src/P2PTransport'
import { P2PCommunicationClient } from '../src/communication-client/P2PCommunicationClient'
import { MatrixEventService } from '../src/matrix-client/services/MatrixEventService'
import { MatrixUserService } from '../src/matrix-client/services/MatrixUserService'

class HeldPeerStorage extends LocalStorage {
  public readonly entered = new ExposedPromise<void>()
  public readonly release = new ExposedPromise<void>()
  private hold = true

  public override async get<K extends StorageKey>(key: K): Promise<StorageKeyReturnType[K]> {
    if (key === StorageKey.TRANSPORT_P2P_PEERS_DAPP && this.hold) {
      this.hold = false
      this.entered.resolve()
      await this.release.promise
    }

    return super.get(key)
  }
}

describe('P2P connection ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    vi.spyOn(P2PCommunicationClient.prototype, 'getRelayServer').mockResolvedValue({
      server: 'relay.example',
      timestamp: 12345
    })
    vi.spyOn(P2PCommunicationClient.prototype, 'getBeaconInfo').mockResolvedValue({
      region: 'europe-west',
      known_servers: [],
      timestamp: 12345
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    localStorage.clear()
  })

  it.each(['resolve', 'reject'])(
    'settles a stopped connection before its peer read can %s',
    async (outcome) => {
      const storage = new HeldPeerStorage()
      const transport = new P2PTransport(
        'DApp',
        await getKeypairFromSeed('connection-owner'),
        storage,
        {},
        StorageKey.TRANSPORT_P2P_PEERS_DAPP
      )
      const login = vi.spyOn(MatrixUserService.prototype, 'login').mockResolvedValue({
        user_id: '@sdk:relay.example',
        device_id: 'device',
        access_token: 'token'
      })
      vi.spyOn(MatrixEventService.prototype, 'sync').mockResolvedValue({
        next_batch: 'sync',
        rooms: {}
      })
      let finished = false
      const connection = transport.connect()
      const observed = connection.then(
        () => {
          finished = true
        },
        () => {
          finished = true
        }
      )
      await storage.entered.promise
      try {
        await transport.disconnect()
        await setImmediate()
        const finishedBeforeRead = finished
        expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)

        await transport.connect()
        expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
        if (outcome === 'resolve') {
          storage.release.resolve()
        } else {
          storage.release.reject(new Error('Prior peer read failed'))
        }
        await expect(connection).resolves.toBeUndefined()
        expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
        expect(login).toHaveBeenCalledTimes(2)
        expect(finishedBeforeRead).toBe(true)
      } finally {
        storage.release.resolve()
        await observed
        await transport.disconnect()
      }
    }
  )
})
