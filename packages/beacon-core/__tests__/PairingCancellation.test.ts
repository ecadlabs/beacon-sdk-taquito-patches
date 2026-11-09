import { PendingPairingRequests } from '../src/transports/clients/PendingPairingRequests'
import { Transport } from '../src/transports/Transport'
import { TransportStatus } from '@ecadlabs/beacon-types'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('pairing cancellation transactions', () => {
  it.each([false, true])(
    'rolls back an in-flight peer write and preserves previous peer=%s',
    async (existing) => {
      const registry = new PendingPairingRequests()
      const write = deferred()
      const started = deferred()
      const prior = { publicKey: 'wallet', name: 'previous', relayServer: 'old' }
      const fresh = { publicKey: 'wallet', name: 'new', relayServer: 'new' }
      let stored: any = existing ? { ...prior } : undefined
      let first = true
      const transport: any = Object.create(Transport.prototype)
      transport.peerWrite = Promise.resolve()
      transport.pairingPeers = new Map()
      transport._isConnected = TransportStatus.NOT_CONNECTED
      transport.peerManager = {
        getPeer: async () => stored,
        addPeer: async (peer: any) => {
          if (first) {
            first = false
            started.resolve()
            await write.promise
          }
          stored = peer
        },
        removePeer: async () => {
          stored = undefined
        }
      }
      transport.listen = jest.fn().mockResolvedValue(undefined)
      transport.client = { unsubscribeFromEncryptedMessage: jest.fn().mockResolvedValue(undefined) }
      const accepted = jest.fn()
      registry.add('request')
      const acceptance = registry.accept('request', (valid) =>
        transport.addPairingPeer(fresh, valid, accepted)
      )
      await started.promise
      const cancelled = registry.cancel()
      let drained = false
      cancelled.then(() => {
        drained = true
      })
      await Promise.resolve()
      expect(drained).toBe(false)
      write.resolve()
      await Promise.all([acceptance, cancelled])
      expect(stored).toEqual(existing ? prior : undefined)
      expect(accepted).not.toHaveBeenCalled()
      expect(transport.listen).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])('rolls back an explicit rejection, preserving prior peer=%s', async (existing) => {
    const prior = { publicKey: 'wallet', name: 'previous' }
    let stored: typeof prior | undefined = existing ? prior : undefined
    const transport = Object.create(Transport.prototype)
    transport.peerWrite = Promise.resolve()
    transport.pairingPeers = new Map()
    transport._isConnected = TransportStatus.NOT_CONNECTED
    transport.peerManager = {
      getPeer: async () => stored,
      addPeer: async (peer: typeof prior) => { stored = peer },
      removePeer: async () => { stored = undefined }
    }
    transport.listen = jest.fn()
    transport.client = { unsubscribeFromEncryptedMessage: jest.fn() }
    await transport.addPairingPeer({ publicKey: 'wallet', name: 'candidate' }, () => true, async () => false)
    expect(stored).toEqual(existing ? prior : undefined)
    expect(transport.client.unsubscribeFromEncryptedMessage).toHaveBeenCalledTimes(existing ? 0 : 1)
  })

  it.each(['one', 'all', 'replacement'])('does not restore a rejected peer after %s changes', async (removal) => {
    const prior = { publicKey: 'wallet', name: 'previous' }
    let stored: typeof prior | undefined = prior
    const transport = Object.create(Transport.prototype)
    transport.peerWrite = Promise.resolve()
    transport.pairingPeers = new Map()
    transport._isConnected = TransportStatus.NOT_CONNECTED
    transport.peerManager = {
      getPeer: async () => stored,
      addPeer: async (peer: typeof prior) => { stored = peer },
      removePeer: async () => { stored = undefined },
      removeAllPeers: async () => { stored = undefined }
    }
    const entered = deferred()
    const release = deferred()
    transport.listen = async () => { entered.resolve(); await release.promise }
    transport.client = {
      unsubscribeFromEncryptedMessage: jest.fn(),
      unsubscribeFromEncryptedMessages: jest.fn()
    }
    const pairing = transport.addPairingPeer({ publicKey: 'wallet', name: 'candidate' }, () => true, async () => false)
    await entered.promise
    const replacement = { publicKey: 'wallet', name: 'replacement' }
    const removed = removal === 'replacement'
      ? transport.addPeer(replacement)
      : removal === 'one' ? transport.removePeer(prior) : transport.removeAllPeers()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    release.resolve()
    await Promise.all([pairing, removed])
    expect(stored).toEqual(removal === 'replacement' ? replacement : undefined)
    if (removal !== 'replacement') {
      expect(removal === 'one' ? transport.client.unsubscribeFromEncryptedMessage : transport.client.unsubscribeFromEncryptedMessages).toHaveBeenCalled()
    } else {
      expect(transport.client.unsubscribeFromEncryptedMessage).not.toHaveBeenCalled()
    }
  })

  it('allows a replayed disconnect to remove a peer during listener registration', async () => {
    const peer = { publicKey: 'wallet', name: 'candidate' }
    let stored: typeof peer | undefined
    let listening = false
    const transport = Object.create(Transport.prototype)
    transport.peerWrite = Promise.resolve()
    transport.pairingPeers = new Map()
    transport._isConnected = TransportStatus.NOT_CONNECTED
    transport.peerManager = {
      getPeer: async () => stored,
      addPeer: async (value: typeof peer) => { stored = value },
      removePeer: async () => { stored = undefined }
    }
    transport.client = { unsubscribeFromEncryptedMessage: async () => { listening = false } }
    transport.listen = async () => {
      listening = true
      await transport.removePeer(peer)
    }
    const accepted = jest.fn().mockResolvedValue(false)
    let settled = false
    const pairing = transport.addPairingPeer(peer, () => true, accepted).then(() => { settled = true })
    for (let i = 0; i < 100; i++) await Promise.resolve()
    expect(settled).toBe(true)
    await pairing
    expect(stored).toBeUndefined()
    expect(listening).toBe(false)
    expect(accepted).not.toHaveBeenCalled()
  })

  it('restores status when a rejected selection loses its peer during the callback', async () => {
    const peer = { publicKey: 'wallet', name: 'candidate' }
    let stored: typeof peer | undefined
    const transport = Object.create(Transport.prototype)
    transport.peerWrite = Promise.resolve()
    transport.pairingPeers = new Map()
    transport._isConnected = TransportStatus.NOT_CONNECTED
    transport.peerManager = {
      getPeer: async () => stored,
      getPeers: async () => stored ? [stored] : [],
      addPeer: async (value: typeof peer) => { stored = value },
      removePeer: async () => { stored = undefined }
    }
    transport.listen = jest.fn()
    transport.client = { unsubscribeFromEncryptedMessage: jest.fn() }
    await transport.addPairingPeer(peer, () => true, async () => {
      transport._isConnected = TransportStatus.CONNECTED
      await transport.removePeer(peer)
      return false
    })
    expect(stored).toBeUndefined()
    expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
  })

  it.each(['write', 'selection'])('restores a prior peer after %s fails', async (failure) => {
    const prior = { publicKey: 'wallet', name: 'previous' }
    const fresh = { publicKey: 'wallet', name: 'new' }
    let stored = prior
    let first = true
    const error = new Error('storage or selection failed')
    const transport: any = Object.create(Transport.prototype)
    transport.peerWrite = Promise.resolve()
    transport.pairingPeers = new Map()
    transport._isConnected = TransportStatus.NOT_CONNECTED
    transport.peerManager = {
      getPeer: async () => stored,
      addPeer: async (peer: any) => {
        stored = peer
        if (first) {
          first = false
          if (failure === 'write') throw error
        }
      },
      removePeer: jest.fn()
    }
    transport.listen = jest.fn().mockResolvedValue(undefined)
    transport.client = { unsubscribeFromEncryptedMessage: jest.fn() }
    await expect(
      transport.addPairingPeer(
        fresh,
        () => true,
        async () => {
          throw error
        }
      )
    ).rejects.toBe(error)
    expect(stored).toEqual(prior)
  })

  it('reports a failed cancellation rollback and permits a later acceptance', async () => {
    const registry = new PendingPairingRequests()
    const started = deferred()
    const write = deferred()
    const error = new Error('rollback storage unavailable')
    const transport: any = Object.create(Transport.prototype)
    transport.peerWrite = Promise.resolve()
    transport.pairingPeers = new Map()
    transport._isConnected = TransportStatus.NOT_CONNECTED
    transport.peerManager = {
      getPeer: async () => undefined,
      addPeer: async () => {
        started.resolve()
        await write.promise
      },
      removePeer: async () => {
        throw error
      }
    }
    transport.listen = jest.fn()
    transport.client = { unsubscribeFromEncryptedMessage: jest.fn() }
    registry.add('request')
    const operation = registry.accept('request', (valid) =>
      transport.addPairingPeer({ publicKey: 'wallet' }, valid, jest.fn())
    )
    const rejectedOperation = expect(operation).rejects.toBe(error)
    await started.promise
    const cancelled = expect(registry.cancel()).rejects.toBe(error)
    write.resolve()
    await Promise.all([rejectedOperation, cancelled])
    registry.add('new-request')
    const accepted = jest.fn().mockResolvedValue(undefined)
    await registry.accept('new-request', accepted)
    expect(accepted).toHaveBeenCalledTimes(1)
  })

  it('does not hide an older rollback failure behind a newer queued operation', async () => {
    const registry = new PendingPairingRequests()
    const write = deferred()
    const started = deferred()
    const error = new Error('older rollback failed')
    registry.add('first')
    const first = registry.accept('first', async () => {
      started.resolve()
      await write.promise
      throw error
    })
    const failed = expect(first).rejects.toBe(error)
    await started.promise
    registry.add('next')
    const next = registry.accept('next', jest.fn().mockResolvedValue(undefined))
    const cancelled = expect(registry.cancel()).rejects.toBe(error)
    write.resolve()
    await Promise.all([failed, next, cancelled])
    await expect(registry.cancel()).resolves.toBeUndefined()
  })

  it('serializes a newer acceptance after cancellation rollback', async () => {
    const registry = new PendingPairingRequests()
    const write = deferred()
    const started = deferred()
    const events: string[] = []
    registry.add('first')
    const first = registry.accept('first', async (valid) => {
      started.resolve()
      await write.promise
      events.push(valid() ? 'committed' : 'rolled-back')
    })
    await started.promise
    const cancelled = registry.cancel()
    registry.add('next')
    const next = registry.accept('next', async (valid) => {
      if (valid()) events.push('new-commit')
    })
    write.resolve()
    await Promise.all([first, cancelled, next])
    expect(events).toEqual(['rolled-back', 'new-commit'])
  })
})
