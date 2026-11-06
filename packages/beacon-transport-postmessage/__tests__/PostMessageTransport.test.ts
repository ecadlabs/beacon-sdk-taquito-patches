import { LocalStorage } from '@ecadlabs/beacon-core'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { PostMessageClient } from '../src/PostMessageClient'
import { Origin, StorageKey, TransportStatus } from '@ecadlabs/beacon-types'
import { PostMessageTransport } from '../src/PostMessageTransport'

describe('PostMessageTransport.connect', () => {
  it('fails instead of reporting connected when a peer listener cannot start', async () => {
    const transport = new PostMessageTransport(
      'test',
      { publicKey: 'public', secretKey: 'secret' } as any,
      {} as any,
      StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP
    )
    jest.spyOn(transport, 'getPeers').mockResolvedValue([{ publicKey: 'peer-1' }] as any)
    jest.spyOn(transport, 'listen').mockRejectedValue(new Error('listener failed'))
    const cleanup = jest.spyOn((transport as any).client, 'unsubscribeFromEncryptedMessages')

    await expect(transport.connect()).rejects.toThrow('listener failed')
    expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
  it('settles every peer registration before rollback, then permits reconnect', async () => {
    const transport = new PostMessageTransport(
      'test',
      { publicKey: 'public', secretKey: 'secret' } as any,
      {} as any,
      StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP
    )

    let finishRegistration!: () => void
    const pendingRegistration = new Promise<void>((resolve) => {
      finishRegistration = resolve
    })
    const failure = new Error('listener failed')
    jest
      .spyOn(transport, 'getPeers')
      .mockResolvedValue([{ publicKey: 'peer-1' }, { publicKey: 'peer-2' }] as any)
    const listen = jest
      .spyOn(transport, 'listen')
      .mockRejectedValueOnce(failure)
      .mockReturnValueOnce(pendingRegistration)
      .mockResolvedValue(undefined)
    const cleanup = jest
      .spyOn((transport as any).client, 'unsubscribeFromEncryptedMessages')
      .mockResolvedValue(undefined)
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
    const transport = new PostMessageTransport(
      'test',
      { publicKey: 'public', secretKey: 'secret' } as any,
      {} as any,
      StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP
    )

    jest.spyOn(transport, 'getPeers').mockRejectedValue(new Error('storage failed'))
    let finishCleanup!: () => void
    const pendingCleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    const cleanup = jest
      .spyOn((transport as any).client, 'unsubscribeFromEncryptedMessages')
      .mockReturnValue(pendingCleanup)
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
    const transport = new PostMessageTransport(
      'test',
      { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
      new LocalStorage(),
      StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP
    )
    let receive!: Parameters<PostMessageClient['listenForEncryptedMessage']>[1]
    const registration = jest
      .spyOn(PostMessageClient.prototype, 'listenForEncryptedMessage')
      .mockImplementation(async (_key, callback) => {
        receive = callback
      })
    const pending = new ExposedPromise<void>()
    const listener = jest.fn(() => pending.promise)
    const failure = new Error('listener failed')
    try {
      await transport.addListener(listener)
      await transport.listen('peer')
      const delivery = receive('message', { origin: Origin.EXTENSION, id: 'extension-id' })
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
      expect(listener).toHaveBeenCalledWith('message', {
        origin: Origin.EXTENSION,
        id: 'extension-id'
      })
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
})
