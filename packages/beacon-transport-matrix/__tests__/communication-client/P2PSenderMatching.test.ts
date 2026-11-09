import { getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { P2PCommunicationClient } from '../../src/communication-client/P2PCommunicationClient'
import { MatrixClient } from '../../src/matrix-client/MatrixClient'

describe('relay session and sender matching', () => {
  it('stops an actual Matrix startup while its first sync is pending without retrying', async () => {
    const keyPair = await getKeypairFromSeed('pending-startup-regression')
    const state: any = { isRunning: false, pollingRetries: 0, rooms: {} }
    const store: any = {
      get: (key: string) => state[key],
      update: async (change: any) => Object.assign(state, change),
      onStateChanged: jest.fn()
    }
    let began!: () => void
    const syncing = new Promise<void>((resolve) => {
      began = resolve
    })
    let failSync!: (reason: any) => void
    const sync = jest.fn(() => {
      began()
      return new Promise((_, reject) => {
        failSync = reject
      })
    })
    const matrix = new MatrixClient(
      store,
      { onStateChanged: jest.fn(), on: jest.fn() } as any,
      { login: jest.fn().mockResolvedValue({ access_token: 'token' }) } as any,
      {} as any,
      { sync } as any,
      {
        cancelAllRequests: jest.fn(async () =>
          failSync?.(new DOMException('stopped', 'AbortError'))
        )
      } as any
    )
    const create = jest.spyOn(MatrixClient, 'create').mockReturnValue(matrix)
    const storage: any = {
      get: jest.fn().mockResolvedValue([]),
      set: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined)
    }
    const p2p = new P2PCommunicationClient('App', keyPair, 1, storage)
    jest.spyOn(p2p, 'getRelayServer').mockResolvedValue({ server: 'relay.test', timestamp: 1234 })
    jest.spyOn(p2p, 'getBeaconInfo').mockResolvedValue({ timestamp: 1234 } as any)
    const started = p2p.start()
    const rejected = expect(started).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await syncing
      await p2p.stop()
      await rejected
      expect(create).toHaveBeenCalledTimes(1)
      expect(state.isRunning).toBe(false)
    } finally {
      create.mockRestore()
    }
  })
})
