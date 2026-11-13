import { getKeypairFromSeed, getHexHash, toHex } from '@ecadlabs/beacon-utils'
import { hash } from '@stablelib/blake2b'
import { verify } from '@stablelib/ed25519'
import { encode } from '@stablelib/utf8'
import { P2PCommunicationClient } from '../../src/communication-client/P2PCommunicationClient'
import { MatrixClient } from '../../src/matrix-client/MatrixClient'

describe('relay authentication contract', () => {
  it('recovers an old session with a fresh signed challenge from the same relay', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
    const keyPair = await getKeypairFromSeed('local-session-recovery')
    const publicKey = toHex(keyPair.publicKey)
    const id = await getHexHash(keyPair.publicKey)
    const state: any = { isRunning: false, pollingRetries: 0, rooms: {} }
    const store: any = {
      get: (key: string) => state[key],
      update: async (change: any) => Object.assign(state, change),
      flush: vi.fn().mockResolvedValue(undefined),
      onStateChanged: vi.fn()
    }
    const passwords: string[] = []
    const identity: string[][] = []
    const login = vi.fn(async (user: string, password: string, device: string) => {
      const [, signature, key] = password.split(':')
      const bucket = Math.floor(Date.now() / 300000)
      const valid = [bucket - 1, bucket, bucket + 1].some((window) =>
        verify(
          Buffer.from(key, 'hex'),
          hash(encode(`login:${window}`), 32),
          Buffer.from(signature, 'hex')
        )
      )
      if (!valid) throw { errcode: 'M_FORBIDDEN' }
      expect(user).toBe(id)
      expect(key).toBe(publicKey)
      identity.push([user, device])
      passwords.push(password)
      return { access_token: `token-${passwords.length}` }
    })
    let expired = false
    const sync = vi.fn(async (token: string) => {
      if (expired && token === 'token-1') throw { errcode: 'M_UNKNOWN_TOKEN' }
      return { next_batch: 'batch', rooms: {} }
    })
    const matrix = new MatrixClient(
      store,
      { onStateChanged: vi.fn(), on: vi.fn() } as any,
      { login } as any,
      {} as any,
      { sync } as any,
      { cancelAllRequests: vi.fn().mockResolvedValue(undefined) } as any
    )
    const create = vi.spyOn(MatrixClient, 'create').mockReturnValue(matrix)
    const storage: any = { get: vi.fn().mockResolvedValue([]), set: vi.fn() }
    const p2p = new P2PCommunicationClient('App', keyPair, 1, storage)
    vi
      .spyOn(p2p, 'getRelayServer')
      .mockResolvedValue({ server: 'relay.test', timestamp: Date.now() / 1000 })
    const info = vi
      .spyOn(p2p, 'getBeaconInfo')
      .mockImplementation(
        async () =>
          ({ timestamp: Date.now() / 1000, region: 'europe-west', known_servers: [] }) as any
      )
    try {
      await p2p.start()
      expired = true
      vi.setSystemTime(Date.now() + 20 * 60 * 1000)
      await vi.runOnlyPendingTimersAsync()
      expect(state.accessToken).toBe('token-2')
      expect(passwords).toHaveLength(2)
      expect(passwords[1]).not.toBe(passwords[0])
      expect(identity[1]).toEqual(identity[0])
      expect(info.mock.calls).toEqual([['relay.test'], ['relay.test']])
      expect(sync.mock.calls.map((call) => call[0])).toEqual(['token-1', 'token-1', 'token-2'])
    } finally {
      await matrix.stop()
      await vi.runOnlyPendingTimersAsync()
      create.mockRestore()
      vi.useRealTimers()
    }
  })
  it('stops an actual Matrix startup while its first sync is pending without retrying', async () => {
    const keyPair = await getKeypairFromSeed('pending-startup-regression')
    const state: any = { isRunning: false, pollingRetries: 0, rooms: {} }
    const store: any = {
      get: (key: string) => state[key],
      update: async (change: any) => Object.assign(state, change),
      flush: vi.fn().mockResolvedValue(undefined),
      onStateChanged: vi.fn()
    }
    let began!: () => void
    const syncing = new Promise<void>((resolve) => {
      began = resolve
    })
    let failSync!: (reason: any) => void
    const sync = vi.fn(() => {
      began()
      return new Promise((_, reject) => {
        failSync = reject
      })
    })
    const matrix = new MatrixClient(
      store,
      { onStateChanged: vi.fn(), on: vi.fn() } as any,
      { login: vi.fn().mockResolvedValue({ access_token: 'token' }) } as any,
      {} as any,
      { sync } as any,
      {
        cancelAllRequests: vi.fn(async () =>
          failSync?.(new DOMException('stopped', 'AbortError'))
        )
      } as any
    )
    const create = vi.spyOn(MatrixClient, 'create').mockReturnValue(matrix)
    const storage: any = {
      get: vi.fn().mockResolvedValue([]),
      set: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined)
    }
    const p2p = new P2PCommunicationClient('App', keyPair, 1, storage)
    vi.spyOn(p2p, 'getRelayServer').mockResolvedValue({ server: 'relay.test', timestamp: 1234 })
    vi.spyOn(p2p, 'getBeaconInfo').mockResolvedValue({ timestamp: 1234 } as any)
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
