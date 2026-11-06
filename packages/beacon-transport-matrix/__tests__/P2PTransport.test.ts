import { LocalStorage } from '@ecadlabs/beacon-core'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { P2PCommunicationClient } from '../src/communication-client/P2PCommunicationClient'
import { Origin, P2PPairingRequest, StorageKey, TransportStatus } from '@ecadlabs/beacon-types'
import { P2PTransport } from '../src/P2PTransport'

describe('P2PTransport.connect', () => {
  it('fails instead of reporting connected when a peer listener cannot start', async () => {
    const transport = new P2PTransport(
      'test',
      { publicKey: 'public', secretKey: 'secret' } as any,
      {} as any,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    vi.spyOn((transport as any).client, 'start').mockResolvedValue(undefined)
    const stop = vi.spyOn((transport as any).client, 'stop').mockResolvedValue(undefined)
    vi.spyOn(transport, 'getPeers').mockResolvedValue([{ publicKey: 'peer-1' }] as any)
    vi.spyOn(transport, 'listen').mockRejectedValue(new Error('listener failed'))

    await expect(transport.connect()).rejects.toThrow('listener failed')
    expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
    expect(stop).toHaveBeenCalledTimes(1)
  })
  it('settles every peer registration before rollback, then permits reconnect', async () => {
    const transport = new P2PTransport(
      'test',
      { publicKey: 'public', secretKey: 'secret' } as any,
      {} as any,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    vi.spyOn((transport as any).client, 'start').mockResolvedValue(undefined)
    let finishRegistration!: () => void
    const pendingRegistration = new Promise<void>((resolve) => {
      finishRegistration = resolve
    })
    const failure = new Error('listener failed')
    vi.spyOn(transport, 'getPeers').mockResolvedValue([
      { publicKey: 'peer-1' },
      { publicKey: 'peer-2' }
    ] as any)
    const listen = vi
      .spyOn(transport, 'listen')
      .mockRejectedValueOnce(failure)
      .mockReturnValueOnce(pendingRegistration)
      .mockResolvedValue(undefined)
    const cleanup = vi.spyOn((transport as any).client, 'stop').mockResolvedValue(undefined)
    const connect = transport.connect()
    const outcome = expect(connect).rejects.toBe(failure)
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
    }
    expect(listen).toHaveBeenCalledTimes(2)
    expect(cleanup).not.toHaveBeenCalled()
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTING)
    finishRegistration()
    await outcome
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
    await transport.connect()
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    expect(listen).toHaveBeenCalledTimes(4)
  })

  it('keeps CONNECTING until failed connection cleanup finishes', async () => {
    const transport = new P2PTransport(
      'test',
      { publicKey: 'public', secretKey: 'secret' } as any,
      {} as any,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    vi.spyOn((transport as any).client, 'start').mockResolvedValue(undefined)
    vi.spyOn(transport, 'getPeers').mockRejectedValue(new Error('storage failed'))
    let finishCleanup!: () => void
    const pendingCleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    const cleanup = vi.spyOn((transport as any).client, 'stop').mockReturnValue(pendingCleanup)
    const connect = transport.connect()
    const outcome = expect(connect).rejects.toThrow('storage failed')
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
    }
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTING)
    await transport.connect()
    expect(cleanup).toHaveBeenCalledTimes(1)
    finishCleanup()
    await outcome
    expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
  })
  it.each(['resolve', 'reject'] as const)('preserves listener %s completion', async (outcome) => {
    const transport = new P2PTransport(
      'test',
      { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
      new LocalStorage(),
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    let receive!: Parameters<P2PCommunicationClient['listenForEncryptedMessage']>[1]
    const registration = vi
      .spyOn(P2PCommunicationClient.prototype, 'listenForEncryptedMessage')
      .mockImplementation(async (_key, callback) => {
        receive = callback
      })
    const pending = new ExposedPromise<void>()
    const listener = vi.fn(() => pending.promise)
    const failure = new Error('listener failed')
    try {
      await transport.addListener(listener)
      await transport.listen('peer')
      const delivery = receive('message')
      expect(delivery).toBeInstanceOf(Promise)
      let completed = false
      const observed = Promise.resolve(delivery).finally(() => {
        completed = true
      })
      const assertion =
        outcome === 'reject'
          ? expect(observed).rejects.toBe(failure)
          : expect(observed).resolves.toBeUndefined()
      await Promise.resolve()
      expect(completed).toBe(false)
      expect(listener).toHaveBeenCalledWith('message', { origin: Origin.P2P, id: 'peer' })
      if (outcome === 'reject') {
        pending.reject(failure)
      } else {
        pending.resolve()
      }
      await assertion
      expect(completed).toBe(true)
    } finally {
      registration.mockRestore()
    }
  })

  it('fails and cleans up connect when an awaited initial replay listener rejects', async () => {
    const transport = new P2PTransport(
      'test',
      { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
      new LocalStorage(),
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    const start = vi.spyOn(P2PCommunicationClient.prototype, 'start').mockResolvedValue(undefined)
    const stop = vi.spyOn(P2PCommunicationClient.prototype, 'stop').mockResolvedValue(undefined)
    const registration = vi
      .spyOn(P2PCommunicationClient.prototype, 'listenForEncryptedMessage')
      .mockImplementation(async (_key, callback) => {
        // The communication client awaits its buffered message before registration returns.
        await callback('buffered message')
      })
    const peers = vi
      .spyOn(transport, 'getPeers')
      .mockResolvedValue([new P2PPairingRequest('peer-id', 'Wallet', 'peer', '2', 'relay.example')])
    const failure = new Error('replayed message listener failed')
    const listener = vi.fn().mockRejectedValue(failure)
    try {
      await transport.addListener(listener)
      await expect(transport.connect()).rejects.toBe(failure)
      expect(listener).toHaveBeenCalledWith('buffered message', { origin: Origin.P2P, id: 'peer' })
      expect(stop).toHaveBeenCalledTimes(1)
      expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)

      listener.mockResolvedValue(undefined)
      await transport.connect()
      expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    } finally {
      start.mockRestore()
      stop.mockRestore()
      registration.mockRestore()
      peers.mockRestore()
    }
  })

  it('cleans up the initial buffer when a peer is added after a no-peer connection', async () => {
    const transport = new P2PTransport(
      'test',
      { publicKey: 'public', secretKey: 'secret' } as any,
      {} as any,
      {},
      StorageKey.TRANSPORT_P2P_PEERS_DAPP
    )
    const communication = (transport as any).client
    const matrix = { subscribe: vi.fn(), unsubscribe: vi.fn() }
    const buffer = vi.fn()
    communication.client.resolve(matrix)
    communication.initialListener = buffer
    vi.spyOn(communication, 'start').mockResolvedValue(undefined)
    vi.spyOn(communication, 'createCryptoBoxServer').mockResolvedValue({ receive: 'key' })
    vi.spyOn(transport, 'getPeers').mockResolvedValue([])
    vi.spyOn((transport as any).peerManager, 'addPeer').mockResolvedValue(undefined)
    await transport.connect()
    expect(matrix.unsubscribe).not.toHaveBeenCalled()
    await transport.addPeer({ publicKey: 'peer' } as any)
    expect(matrix.unsubscribe).toHaveBeenCalledWith('message', buffer)
    expect(communication.initialListener).toBeUndefined()
  })
})
