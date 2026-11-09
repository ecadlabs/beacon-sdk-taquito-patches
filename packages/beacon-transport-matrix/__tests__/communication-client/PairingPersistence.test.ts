import { DappPostMessageTransport } from '../../../beacon-dapp/src/transports/DappPostMessageTransport'
import { DappP2PTransport } from '../../../beacon-dapp/src/transports/DappP2PTransport'
import { PendingPairingRequests } from '@ecadlabs/beacon-core'
import { StorageKey, TransportStatus } from '@ecadlabs/beacon-types'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('actual dApp peer persistence cancellation', () => {
  it.each([
    ['matrix', false],
    ['matrix', true],
    ['extension', false],
    ['extension', true]
  ] as const)(
    'undoes a pending %s write, preserving prior same-key peer=%s',
    async (kind, existing) => {
      const pending = new PendingPairingRequests()
      const key =
        kind === 'matrix'
          ? StorageKey.TRANSPORT_P2P_PEERS_DAPP
          : StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP
      const prior = {
        publicKey: '11'.repeat(32),
        name: 'previous',
        relayServer: 'old',
        version: '2',
        type: 'p2p-pairing-response',
        senderId: 'sender'
      }
      const peer = { ...prior, name: 'new', relayServer: 'new', id: 'issued' }
      const state: Record<string, any> = { [key]: existing ? [prior] : [] }
      const write = deferred()
      const started = deferred()
      let pause = true
      const storage = {
        get: async (name: string) => JSON.parse(JSON.stringify(state[name] ?? [])),
        set: async (name: string, value: unknown) => {
          if (name === key && pause) {
            pause = false
            started.resolve()
            await write.promise
          }
          state[name] = JSON.parse(JSON.stringify(value))
        }
      }
      const keyPair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) } as any
      const transport =
        kind === 'matrix'
          ? new DappP2PTransport(
              'app',
              keyPair,
              storage as any,
              {} as any,
              undefined,
              undefined,
              pending
            )
          : new DappPostMessageTransport('app', keyPair, storage as any, pending)
      const client = (transport as any).client
      let deliver!: (peer: any, valid: () => boolean) => Promise<void>
      client.listenForChannelOpening = jest.fn(async (callback) => {
        deliver = callback
      })
      client.listenForEncryptedMessage = jest.fn().mockResolvedValue(undefined)
      client.unsubscribeFromEncryptedMessage = jest.fn().mockResolvedValue(undefined)
      const accepted = jest.fn()
      await transport.listenForNewPeer(accepted)
      await transport.startOpenChannelListener()
      pending.add('issued')
      const acceptance = pending.accept('issued', (valid) => deliver(peer, valid))
      await started.promise
      const cancelled = transport.stopListeningForNewPeers()
      write.resolve()
      await Promise.all([acceptance, cancelled])
      expect(state[key]).toEqual(existing ? [prior] : [])
      expect(accepted).not.toHaveBeenCalled()
      expect(client.listenForEncryptedMessage).not.toHaveBeenCalled()
    }
  )
  it.each(['matrix', 'extension'])('still shuts down %s when rollback fails', async (kind) => {
    const pending = new PendingPairingRequests()
    const keyPair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) } as any
    const storage = {
      get: async () => [],
      set: async () => undefined,
      delete: async () => undefined
    } as any
    const transport =
      kind === 'matrix'
        ? new DappP2PTransport('app', keyPair, storage, {} as any, undefined, undefined, pending)
        : new DappPostMessageTransport('app', keyPair, storage, pending)
    const client = (transport as any).client
    const error = new Error('rollback failed')
    client.cancelPairingRequests = jest.fn().mockRejectedValue(error)
    const stopped = jest.fn().mockResolvedValue(undefined)
    if (kind === 'matrix') {
      client.client.resolve({ stop: stopped })
      client.reset = jest.fn().mockResolvedValue(undefined)
    } else client.unsubscribeFromEncryptedMessages = stopped
    await expect(transport.disconnect()).rejects.toBe(error)
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
  })

  it.each([
    ['matrix', false],
    ['matrix', true],
    ['extension', false],
    ['extension', true]
  ] as const)(
    'rolls back %s persistence if selection fails, previous peer=%s',
    async (kind, existing) => {
      const pending = new PendingPairingRequests()
      const key =
        kind === 'matrix'
          ? StorageKey.TRANSPORT_P2P_PEERS_DAPP
          : StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP
      const prior = { publicKey: '11'.repeat(32), name: 'previous', relayServer: 'old' }
      const peer = { ...prior, name: 'new', id: 'request' }
      const state: Record<string, any> = { [key]: existing ? [prior] : [] }
      const storage = {
        get: async (name: string) => JSON.parse(JSON.stringify(state[name] ?? [])),
        set: async (name: string, value: any) => {
          state[name] = JSON.parse(JSON.stringify(value))
        }
      }
      const keyPair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) } as any
      const transport =
        kind === 'matrix'
          ? new DappP2PTransport(
              'app',
              keyPair,
              storage as any,
              {} as any,
              undefined,
              undefined,
              pending
            )
          : new DappPostMessageTransport('app', keyPair, storage as any, pending)
      const client = (transport as any).client
      let deliver!: (peer: any, valid: () => boolean) => Promise<void>
      client.listenForChannelOpening = jest.fn(async (callback) => {
        deliver = callback
      })
      client.listenForEncryptedMessage = jest.fn().mockResolvedValue(undefined)
      client.unsubscribeFromEncryptedMessage = jest.fn().mockResolvedValue(undefined)
      const error = new Error('selection failed')
      await transport.listenForNewPeer(jest.fn().mockRejectedValue(error))
      await transport.startOpenChannelListener()
      pending.add('request')
      await expect(pending.accept('request', (valid) => deliver(peer, valid))).rejects.toBe(error)
      expect(state[key]).toEqual(existing ? [prior] : [])
      expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
    }
  )
})
