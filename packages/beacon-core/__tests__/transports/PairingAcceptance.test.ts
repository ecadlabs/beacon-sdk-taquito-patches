import {
  PeerInfoType,
  PostMessagePairingRequest,
  StorageKey,
  StorageKeyReturnType,
  TransportStatus
} from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { PeerManager } from '../../src/managers/PeerManager'
import { LocalStorage } from '../../src/storage/LocalStorage'
import { Transport } from '../../src/transports/Transport'
import { CommunicationClient } from '../../src/transports/clients/CommunicationClient'

class Gate {
  readonly entered = new ExposedPromise<void>()
  readonly release = new ExposedPromise<void>()

  async wait(): Promise<void> {
    this.entered.resolve()
    await this.release.promise
  }
}

class PairingStorage extends LocalStorage {
  private nextWrite?: Gate

  holdNextWrite(): Gate {
    const gate = new Gate()
    this.nextWrite = gate
    return gate
  }

  async set<K extends StorageKey>(key: K, value: StorageKeyReturnType[K]): Promise<void> {
    const gate = this.nextWrite
    this.nextWrite = undefined
    await gate?.wait()
    await super.set(key, value)
  }
}

class PairingClient extends CommunicationClient {
  readonly subscriptions = new Set<string>()
  readonly removed: string[] = []

  async unsubscribeFromEncryptedMessage(publicKey: string): Promise<void> {
    this.removed.push(publicKey)
    this.subscriptions.delete(publicKey)
  }

  async unsubscribeFromEncryptedMessages(): Promise<void> {
    this.subscriptions.clear()
  }

  async sendMessage(_message: string, _peer?: PeerInfoType): Promise<void> {}
}

class PairingTransport extends Transport<
  PostMessagePairingRequest,
  StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP,
  PairingClient
> {
  onListen: (publicKey: string) => Promise<void> = async () => undefined

  async listen(publicKey: string): Promise<void> {
    await this.onListen(publicKey)
    this.client.subscriptions.add(publicKey)
  }

  accept(
    peer: PostMessagePairingRequest,
    isActive: () => boolean,
    accepted: () => boolean | Promise<boolean>
  ): Promise<boolean> {
    return this.addPairingPeer(peer, isActive, accepted)
  }
}

function peer(publicKey: string, name: string = publicKey): PostMessagePairingRequest {
  return {
    id: publicKey,
    name,
    type: 'postmessage-pairing-request',
    publicKey,
    version: '3'
  }
}

function setup() {
  const storage = new PairingStorage('pairing-acceptance')
  const client = new PairingClient()
  const manager = new PeerManager(storage, StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP)
  const transport = new PairingTransport('Pairing acceptance', client, manager)
  return { storage, client, transport }
}

describe('Transport pairing acceptance', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it.each(['peer', 'all peers'])(
    'does not accept a candidate after removal of %s is requested behind another write',
    async (removal) => {
      const { storage, client, transport } = setup()
      const candidate = peer('candidate')
      const other = peer('other')
      const listening = new Gate()
      transport.onListen = (publicKey) =>
        publicKey === candidate.publicKey ? listening.wait() : Promise.resolve()
      const accepted = vi.fn(async () => true)
      const pairing = transport.accept(candidate, () => true, accepted)
      await listening.entered.promise

      const writing = storage.holdNextWrite()
      const addition = transport.addPeer(other)
      await writing.entered.promise
      const removed =
        removal === 'peer' ? transport.removePeer(candidate) : transport.removeAllPeers()
      listening.release.resolve()
      await vi.advanceTimersByTimeAsync(0)
      const acceptedBeforeRemoval = accepted.mock.calls.length

      writing.release.resolve()
      await Promise.all([addition, removed])
      const result = await pairing

      expect(acceptedBeforeRemoval).toBe(0)
      expect(accepted).not.toHaveBeenCalled()
      expect(result).toBe(false)
      expect(await transport.getPeers()).toEqual(removal === 'peer' ? [other] : [])
      expect(client.subscriptions.has(candidate.publicKey)).toBe(false)
      if (removal === 'peer') expect(client.subscriptions.has(other.publicKey)).toBe(true)
    }
  )

  it.each(['peer', 'all peers'])(
    'does not accept after removal of %s is requested while confirmation waits for an earlier write',
    async (removal) => {
      const { storage, client, transport } = setup()
      const candidate = peer('candidate')
      const other = peer('other')
      const listening = new Gate()
      transport.onListen = (publicKey) =>
        publicKey === candidate.publicKey ? listening.wait() : Promise.resolve()
      const accepted = vi.fn(async () => true)
      const pairing = transport.accept(candidate, () => true, accepted)
      await listening.entered.promise

      const writing = storage.holdNextWrite()
      const addition = transport.addPeer(other)
      await writing.entered.promise
      listening.release.resolve()
      await vi.advanceTimersByTimeAsync(0)
      const acceptedBeforeRemoval = accepted.mock.calls.length

      const removed =
        removal === 'peer' ? transport.removePeer(candidate) : transport.removeAllPeers()
      await vi.advanceTimersByTimeAsync(0)
      const acceptedBeforeWrite = accepted.mock.calls.length
      writing.release.resolve()
      await Promise.all([addition, removed])
      const result = await pairing

      expect(acceptedBeforeRemoval).toBe(0)
      expect(acceptedBeforeWrite).toBe(0)
      expect(accepted).not.toHaveBeenCalled()
      expect(result).toBe(false)
      expect(await transport.getPeers()).toEqual(removal === 'peer' ? [other] : [])
      expect([...client.subscriptions]).toEqual(removal === 'peer' ? [other.publicKey] : [])
    }
  )

  it('waits for earlier peer writes before invoking acceptance', async () => {
    const { storage, transport } = setup()
    const candidate = peer('candidate')
    const other = peer('other')
    const listening = new Gate()
    transport.onListen = (publicKey) =>
      publicKey === candidate.publicKey ? listening.wait() : Promise.resolve()
    let observed: PostMessagePairingRequest[] = []
    const accepted = vi.fn(async () => {
      observed = await transport.getPeers()
      return true
    })
    const pairing = transport.accept(candidate, () => true, accepted)
    await listening.entered.promise
    const writing = storage.holdNextWrite()
    const addition = transport.addPeer(other)
    await writing.entered.promise

    listening.release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    const acceptedBeforeWrite = accepted.mock.calls.length
    writing.release.resolve()
    await addition
    const result = await pairing

    expect(acceptedBeforeWrite).toBe(0)
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(observed).toEqual([candidate, other])
    expect(result).toBe(true)
  })

  it('allows acceptance callbacks to await peer removal without retaining the candidate', async () => {
    const { client, transport } = setup()
    const candidate = peer('candidate')
    const other = peer('other')
    await transport.addPeer(other)
    const accepted = vi.fn(async () => {
      await transport.removePeer(candidate)
      return true
    })

    await expect(transport.accept(candidate, () => true, accepted)).resolves.toBe(false)

    expect(accepted).toHaveBeenCalledTimes(1)
    expect(await transport.getPeers()).toEqual([other])
    expect(client.subscriptions.has(candidate.publicKey)).toBe(false)
    expect(client.subscriptions.has(other.publicKey)).toBe(true)
  })

  it('restores a retained peer after callback failure without reverting unrelated writes', async () => {
    const { client, transport } = setup()
    const retained = peer('wallet', 'Retained wallet')
    const candidate = peer('wallet', 'Candidate wallet')
    const other = peer('other')
    const failure = new Error('Selection did not finish')
    await transport.addPeer(retained)
    const accepted = vi.fn(async () => {
      await transport.connect()
      await transport.addPeer(other)
      throw failure
    })

    await expect(transport.accept(candidate, () => true, accepted)).rejects.toBe(failure)

    expect(await transport.getPeers()).toEqual([retained, other])
    expect(transport.connectionStatus).toBe(TransportStatus.NOT_CONNECTED)
    expect(client.subscriptions.has(retained.publicKey)).toBe(true)
    expect(client.subscriptions.has(other.publicKey)).toBe(true)
    expect(client.removed).toEqual([])
  })

  it('leaves a replacement peer subscribed when earlier registration finishes after removal', async () => {
    const { client, transport } = setup()
    const candidate = peer('wallet', 'Candidate wallet')
    const replacement = peer('wallet', 'Replacement wallet')
    const listening = new Gate()
    transport.onListen = () => listening.wait()
    const accepted = vi.fn(async () => true)
    const pairing = transport.accept(candidate, () => true, accepted)
    await listening.entered.promise

    await transport.removePeer(candidate)
    transport.onListen = async () => undefined
    await transport.addPeer(replacement)
    const removalsBeforeCompletion = client.removed.length
    listening.release.resolve()
    const result = await pairing

    expect(result).toBe(false)
    expect(accepted).not.toHaveBeenCalled()
    expect(await transport.getPeers()).toEqual([replacement])
    expect(client.subscriptions.has(replacement.publicKey)).toBe(true)
    expect(client.removed).toHaveLength(removalsBeforeCompletion)
  })

  it('retains an accepted peer when its callback retires pairing intake', async () => {
    const { client, transport } = setup()
    const candidate = peer('candidate')
    let active = true
    const accepted = vi.fn(async () => {
      active = false
      await transport.connect()
      return true
    })

    await expect(transport.accept(candidate, () => active, accepted)).resolves.toBe(true)

    expect(accepted).toHaveBeenCalledTimes(1)
    expect(await transport.getPeers()).toEqual([candidate])
    expect(transport.connectionStatus).toBe(TransportStatus.CONNECTED)
    expect(client.subscriptions.has(candidate.publicKey)).toBe(true)
    expect(client.removed).toEqual([])
  })
})
