import { LocalStorage } from '@ecadlabs/beacon-core'
import { ExposedPromise, generateGUID, getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import { StorageKey, TransportStatus } from '@ecadlabs/beacon-types'
import { P2PTransport } from '../src/P2PTransport'
import { P2PCommunicationClient } from '../src/communication-client/P2PCommunicationClient'
import { MatrixHttpClient } from '../src/matrix-client/MatrixHttpClient'
import { MatrixUserService } from '../src/matrix-client/services/MatrixUserService'
import { MatrixEventService } from '../src/matrix-client/services/MatrixEventService'
import { MatrixLoginResponse } from '../src/matrix-client/models/api/MatrixLogin'

vi.mock('@ecadlabs/beacon-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecadlabs/beacon-utils')>()
  return { ...actual, generateGUID: vi.fn(actual.generateGUID) }
})

const loginResponse = (token: string): MatrixLoginResponse => ({
  user_id: '@sdk:relay.example',
  device_id: 'device',
  access_token: token
})

describe('P2PTransport canceled startup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    localStorage.clear()
  })

  it.each(['success', 'failure'])(
    'retires a stopped login before its late %s can affect a newer connection',
    async (outcome) => {
      const storage = new LocalStorage('startup-cancellation')
      const keyPair = await getKeypairFromSeed('matrix-startup-cancellation')
      const oldTransport = new P2PTransport(
        'Old',
        keyPair,
        storage,
        {},
        StorageKey.TRANSPORT_P2P_PEERS_DAPP
      )
      const newTransport = new P2PTransport(
        'New',
        keyPair,
        storage,
        {},
        StorageKey.TRANSPORT_P2P_PEERS_DAPP
      )
      const entered = new ExposedPromise<void>()
      const oldLogin = new ExposedPromise<MatrixLoginResponse>()
      vi.spyOn(P2PCommunicationClient.prototype, 'getRelayServer').mockResolvedValue({
        server: 'relay.example',
        timestamp: 12345
      })
      const login = vi
        .spyOn(MatrixUserService.prototype, 'login')
        .mockImplementationOnce(() => {
          entered.resolve()
          return oldLogin.promise
        })
        .mockResolvedValue(loginResponse('new-token'))
      const sync = vi
        .spyOn(MatrixEventService.prototype, 'sync')
        .mockImplementation(async (token) => ({
          next_batch: token,
          rooms: {}
        }))
      const stop = vi.spyOn(MatrixHttpClient.prototype, 'cancelAllRequests')
      const oldConnection = oldTransport.connect()
      await entered.promise
      try {
        await oldTransport.disconnect()
        expect(stop).toHaveBeenCalledTimes(1)
        expect(oldTransport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
        await newTransport.connect()
        await storage.set(StorageKey.MATRIX_PEER_ROOM_IDS, { newer: '!new:relay.example' })
        await storage.set(StorageKey.MATRIX_PRESERVED_STATE, { syncToken: 'new-sync', rooms: {} })
        await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'new-relay.example')

        if (outcome === 'success') {
          oldLogin.resolve(loginResponse('old-token'))
        } else {
          oldLogin.reject(new Error('Late login failure'))
        }
        await expect(oldConnection).resolves.toBeUndefined()

        expect(oldTransport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
        expect(newTransport.connectionStatus).toBe(TransportStatus.CONNECTED)
        expect(login).toHaveBeenCalledTimes(2)
        expect(sync).toHaveBeenCalledTimes(1)
        expect(sync).toHaveBeenCalledWith('new-token', expect.anything())
        await expect(storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)).resolves.toEqual({
          newer: '!new:relay.example'
        })
        await expect(storage.get(StorageKey.MATRIX_PRESERVED_STATE)).resolves.toEqual({
          syncToken: 'new-sync',
          rooms: {}
        })
        await expect(storage.get(StorageKey.MATRIX_SELECTED_NODE)).resolves.toBe(
          'new-relay.example'
        )
      } finally {
        oldLogin.resolve(loginResponse('old-token'))
        await oldConnection.catch(() => undefined)
        await Promise.all([oldTransport.disconnect(), newTransport.disconnect()])
      }
    }
  )
  it('does not apply a stopped initial sync to a newer connection', async () => {
    const storage = new LocalStorage('sync-cancellation')
    const keyPair = await getKeypairFromSeed('matrix-sync-cancellation')
    const oldTransport = new P2PTransport(
      'Old',
      keyPair,
      storage,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    const newTransport = new P2PTransport(
      'New',
      keyPair,
      storage,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    const entered = new ExposedPromise<void>()
    const oldSync = new ExposedPromise<Awaited<ReturnType<MatrixEventService['sync']>>>()
    vi.spyOn(P2PCommunicationClient.prototype, 'getRelayServer').mockResolvedValue({
      server: 'relay.example',
      timestamp: 12345
    })
    vi.spyOn(MatrixUserService.prototype, 'login')
      .mockResolvedValueOnce(loginResponse('old-token'))
      .mockResolvedValue(loginResponse('new-token'))
    const sync = vi
      .spyOn(MatrixEventService.prototype, 'sync')
      .mockImplementationOnce(() => {
        entered.resolve()
        return oldSync.promise
      })
      .mockResolvedValue({ next_batch: 'new-sync', rooms: {} })
    const oldConnection = oldTransport.connect()
    await entered.promise
    try {
      await oldTransport.disconnect()
      await newTransport.connect()
      await storage.set(StorageKey.MATRIX_PRESERVED_STATE, { syncToken: 'new-sync', rooms: {} })
      oldSync.resolve({ next_batch: 'obsolete-sync', rooms: {} })
      await oldConnection

      expect(oldTransport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
      expect(newTransport.connectionStatus).toBe(TransportStatus.CONNECTED)
      expect(sync).toHaveBeenCalledTimes(2)
      await expect(storage.get(StorageKey.MATRIX_PRESERVED_STATE)).resolves.toEqual({
        syncToken: 'new-sync',
        rooms: {}
      })
    } finally {
      oldSync.resolve({ next_batch: 'obsolete-sync', rooms: {} })
      await oldConnection.catch(() => undefined)
      await Promise.all([oldTransport.disconnect(), newTransport.disconnect()])
    }
  })

  it('does not create a Matrix client or persist a relay after stopped discovery completes', async () => {
    const storage = new LocalStorage('relay-cancellation')
    const keyPair = await getKeypairFromSeed('matrix-relay-cancellation')
    const oldTransport = new P2PTransport(
      'Old',
      keyPair,
      storage,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    const newTransport = new P2PTransport(
      'New',
      keyPair,
      storage,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    const entered = new ExposedPromise<void>()
    const oldInfo = new ExposedPromise<
      Awaited<ReturnType<P2PCommunicationClient['getBeaconInfo']>>
    >()
    const info = { region: 'europe-west', known_servers: [], timestamp: 12345 }
    const beaconInfo = vi
      .spyOn(P2PCommunicationClient.prototype, 'getBeaconInfo')
      .mockImplementation(() => {
        entered.resolve()
        return oldInfo.promise
      })
    const login = vi
      .spyOn(MatrixUserService.prototype, 'login')
      .mockResolvedValue(loginResponse('new-token'))
    vi.spyOn(MatrixEventService.prototype, 'sync').mockResolvedValue({
      next_batch: 'new-sync',
      rooms: {}
    })
    const oldConnection = oldTransport.connect()
    await entered.promise
    try {
      await oldTransport.disconnect()
      beaconInfo.mockResolvedValue(info)
      await newTransport.connect()
      await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'new-relay.example')
      oldInfo.resolve(info)
      await oldConnection

      expect(login).toHaveBeenCalledTimes(1)
      expect(oldTransport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
      expect(newTransport.connectionStatus).toBe(TransportStatus.CONNECTED)
      await expect(storage.get(StorageKey.MATRIX_SELECTED_NODE)).resolves.toBe('new-relay.example')
    } finally {
      oldInfo.resolve(info)
      await oldConnection.catch(() => undefined)
      await Promise.all([oldTransport.disconnect(), newTransport.disconnect()])
    }
  })
  it('does not rotate the shared SDK identity after a deactivated startup is stopped', async () => {
    const storage = new LocalStorage('deactivated-cancellation')
    const keyPair = await getKeypairFromSeed('matrix-deactivated-cancellation')
    const oldTransport = new P2PTransport(
      'Old',
      keyPair,
      storage,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    const newTransport = new P2PTransport(
      'New',
      keyPair,
      storage,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    const entered = new ExposedPromise<void>()
    const oldSeed = new ExposedPromise<string>()
    vi.mocked(generateGUID).mockImplementationOnce(() => {
      entered.resolve()
      return oldSeed.promise
    })
    vi.spyOn(P2PCommunicationClient.prototype, 'getRelayServer').mockResolvedValue({
      server: 'relay.example',
      timestamp: 12345
    })
    vi.spyOn(MatrixUserService.prototype, 'login')
      .mockRejectedValueOnce({ errcode: 'M_USER_DEACTIVATED' })
      .mockResolvedValue(loginResponse('new-token'))
    vi.spyOn(MatrixEventService.prototype, 'sync').mockResolvedValue({
      next_batch: 'new-sync',
      rooms: {}
    })
    const write = vi.spyOn(storage, 'set')
    const oldConnection = oldTransport.connect()
    await entered.promise
    try {
      await oldTransport.disconnect()
      await storage.set(StorageKey.BEACON_SDK_SECRET_SEED, 'newer-sdk-seed')
      await newTransport.connect()
      oldSeed.resolve('obsolete-sdk-seed')
      await expect(oldConnection).resolves.toBeUndefined()

      await expect(storage.get(StorageKey.BEACON_SDK_SECRET_SEED)).resolves.toBe('newer-sdk-seed')
      expect(write).not.toHaveBeenCalledWith(StorageKey.BEACON_SDK_SECRET_SEED, 'obsolete-sdk-seed')
      expect(oldTransport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
      expect(newTransport.connectionStatus).toBe(TransportStatus.CONNECTED)
    } finally {
      oldSeed.resolve('obsolete-sdk-seed')
      await oldConnection.catch(() => undefined)
      await Promise.all([oldTransport.disconnect(), newTransport.disconnect()])
    }
  })

  it('warns about identity recovery without logging the private seed', async () => {
    const storage = new LocalStorage('deactivated-warning')
    const seed = 'private-recovery-seed'
    const transport = new P2PTransport(
      'Recovering',
      await getKeypairFromSeed('old-identity'),
      storage,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    vi.mocked(generateGUID).mockResolvedValueOnce(seed)
    vi.spyOn(P2PCommunicationClient.prototype, 'getRelayServer').mockResolvedValue({
      server: 'relay.example',
      timestamp: 12345
    })
    vi.spyOn(MatrixUserService.prototype, 'login')
      .mockRejectedValueOnce({ errcode: 'M_USER_DEACTIVATED' })
      .mockResolvedValue(loginResponse('recovered-token'))
    vi.spyOn(MatrixEventService.prototype, 'sync').mockResolvedValue({
      next_batch: 'recovered-sync',
      rooms: {}
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(transport.connect()).rejects.toThrow('The account is deactivated.')
      await expect(storage.get(StorageKey.BEACON_SDK_SECRET_SEED)).resolves.toBe(seed)
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[BEACON] The Matrix user was deactivated. Rotating the SDK identity.'
      )
      expect(JSON.stringify(warn.mock.calls)).not.toContain(seed)
    } finally {
      await transport.disconnect()
    }
  })
})
