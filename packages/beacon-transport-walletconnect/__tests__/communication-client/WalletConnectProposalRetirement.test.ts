import { EventEmitter } from 'node:events'
import { NetworkType } from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { deriveSymKey, generateKeyPair, hashKey } from '@walletconnect/utils'
import {
  PairingTypes,
  ProposalTypes,
  SessionTypes,
  SignClientTypes,
  SubscriberTypes
} from '@walletconnect/types'
import { WalletConnectCommunicationClient } from '../../src/communication-client/WalletConnectCommunicationClient'

type Storage = NonNullable<SignClientTypes.Options['storage']>
const initialize = vi.hoisted(() => vi.fn<(options: SignClientTypes.Options) => Promise<Remote>>())
vi.mock('@walletconnect/sign-client', () => ({ default: { init: initialize } }))

class MemoryStorage implements Storage {
  private readonly values = new Map<string, unknown>()
  beforeWrite: ((key: string) => Promise<void>) | undefined

  async getKeys(): Promise<string[]> {
    return [...this.values.keys()]
  }
  async getEntries<T>(): Promise<[string, T][]> {
    return structuredClone([...this.values.entries()]) as [string, T][]
  }
  async getItem<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined
  }
  async setItem<T>(key: string, value: T): Promise<void> {
    await this.beforeWrite?.(key)
    this.values.set(key, structuredClone(value))
  }
  async removeItem(key: string): Promise<void> {
    this.values.delete(key)
  }
}

class LocalBroadcastChannel {
  onmessage: unknown
  onmessageerror: unknown
  postMessage(_message: unknown): void {}
  close(): void {}
}

const metadata = { name: 'Wallet', description: '', url: 'https://wallet.example', icons: [] }
const sdkProposalLifetimeMs = 300_000
const sessionKey = 'wc@2:client:0.3//session'
const walletKeys = generateKeyPair()

function session(topic: string): SessionTypes.Struct {
  return {
    topic,
    pairingTopic: `${topic}-pairing`,
    relay: { protocol: 'irn' },
    expiry: Math.floor(Date.now() / 1000) + 172800,
    acknowledged: true,
    controller: 'wallet',
    namespaces: {
      tezos: {
        accounts: ['tezos:mainnet:tz1account'],
        methods: ['tezos_getAccounts', 'tezos_send', 'tezos_sign'],
        events: []
      }
    },
    requiredNamespaces: {},
    optionalNamespaces: {},
    self: { publicKey: 'dapp-key', metadata },
    peer: { publicKey: `${topic}-wallet`, metadata }
  }
}

type HistoryEntry = {
  id: number
  topic: string
  request: { method: string; params: ProposalTypes.Struct }
  expiry: number
  response?: {
    id: number
    jsonrpc: '2.0'
    result: { responderPublicKey: string; relay: { protocol: string } }
  }
}
type ExpiryEntry = { target: string; expiry: number }

class Remote extends EventEmitter {
  private readonly initialStorage: Storage = new MemoryStorage()
  private readonly proposerKeys = generateKeyPair()
  readonly approvalTopic = hashKey(deriveSymKey(this.proposerKeys.privateKey, walletKeys.publicKey))
  private readonly sessions = new Map<string, SessionTypes.Struct>()
  private readonly proposals = new Map<number, ProposalTypes.Struct>()
  private readonly pairings = new Map<string, PairingTypes.Struct>()
  private readonly subscriptions = new Map<string, SubscriberTypes.Active>()
  private keychain: Record<string, string> = {}
  private history: HistoryEntry[] = []
  private expirations: ExpiryEntry[] = []
  private approval = new ExposedPromise<SessionTypes.Struct>()
  private currentProposal: ProposalTypes.Struct | undefined
  private open = true
  readonly trace: string[] = []
  proposalDelayMs = 0

  readonly session = {
    get: (topic: string) => this.sessions.get(topic),
    getAll: () => [...this.sessions.values()],
    keys: new Array<string>()
  }
  readonly proposal = { getAll: () => [...this.proposals.values()] }
  readonly pairing = { getAll: () => [...this.pairings.values()] }
  readonly ping = vi.fn(async ({ topic }: { topic: string }) => {
    if (!this.open || !this.keychain[topic] || !this.subscriptions.has(topic)) {
      throw new Error('Session subscription is unavailable')
    }
  })
  readonly extend = vi.fn(async () => {})
  readonly core = {
    storage: this.initialStorage,
    customStoragePrefix: '',
    events: new EventEmitter(),
    heartbeat: { stop: vi.fn() },
    pairing: {
      events: new EventEmitter(),
      getPairings: () => [...this.pairings.values()],
      ping: vi.fn(async () => {}),
      disconnect: vi.fn(async ({ topic }: { topic: string }) => {
        this.pairings.delete(topic)
        await this.persist('core', 'pairing', [...this.pairings.values()])
      })
    },
    relayer: {
      onProviderErrorHandler: (_error: Error): void => {},
      transportClose: vi.fn(async () => {
        this.trace.push('relay closed')
        this.open = false
      }),
      events: new EventEmitter(),
      provider: { events: new EventEmitter(), connection: { events: new EventEmitter() } },
      subscriber: { events: new EventEmitter(), topics: new Array<string>() }
    }
  }

  constructor(
    options: SignClientTypes.Options,
    private readonly id: number
  ) {
    super()
    this.core.storage = options.storage ?? this.initialStorage
    this.core.customStoragePrefix = options.customStoragePrefix
      ? `:${options.customStoragePrefix}`
      : ''
  }

  async restore(): Promise<void> {
    for (const entry of await this.read<SessionTypes.Struct>('client', 'session')) {
      this.sessions.set(entry.topic, entry)
    }
    for (const entry of await this.read<ProposalTypes.Struct>('client', 'proposal')) {
      this.proposals.set(entry.id, entry)
    }
    for (const entry of await this.read<PairingTypes.Struct>('core', 'pairing')) {
      this.pairings.set(entry.topic, entry)
    }
    for (const entry of await this.read<SubscriberTypes.Active>('core', 'subscription')) {
      this.subscriptions.set(entry.topic, entry)
    }
    this.keychain =
      (await this.core.storage.getItem<Record<string, string>>(this.key('core', 'keychain'))) ?? {}
    this.history = await this.read<HistoryEntry>('core', 'history')
    this.expirations = await this.read<ExpiryEntry>('core', 'expirer')
    this.syncIndexes()
  }

  readonly connect = vi.fn(async () => {
    const pairingTopic = `pairing-${this.id}`
    const pairingExpiry = Math.floor(Date.now() / 1000) + sdkProposalLifetimeMs / 1000
    if (this.proposalDelayMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.proposalDelayMs))
    }
    const proposal: ProposalTypes.Struct = {
      id: this.id,
      pairingTopic,
      proposer: { publicKey: this.proposerKeys.publicKey, metadata },
      expiryTimestamp: Math.floor(Date.now() / 1000) + sdkProposalLifetimeMs / 1000,
      relays: [{ protocol: 'irn' }],
      requiredNamespaces: {},
      optionalNamespaces: {}
    }
    this.currentProposal = proposal
    this.proposals.set(proposal.id, proposal)
    this.pairings.set(pairingTopic, {
      topic: pairingTopic,
      expiry: pairingExpiry,
      active: false,
      relay: { protocol: 'irn' }
    })
    this.subscriptions.set(pairingTopic, {
      id: `subscription-${this.id}`,
      topic: pairingTopic,
      relay: { protocol: 'irn' }
    })
    this.keychain[proposal.proposer.publicKey] = this.proposerKeys.privateKey
    this.keychain[pairingTopic] = 'ab'.repeat(32)
    this.history.push({
      id: proposal.id,
      topic: pairingTopic,
      request: { method: 'wc_sessionPropose', params: proposal },
      expiry: proposal.expiryTimestamp
    })
    this.expirations.push(
      { target: `id:${proposal.id}`, expiry: proposal.expiryTimestamp },
      { target: `topic:${pairingTopic}`, expiry: pairingExpiry }
    )
    await Promise.all([
      this.persist('client', 'proposal', [...this.proposals.values()]),
      this.persist('core', 'pairing', [...this.pairings.values()]),
      this.persist('core', 'subscription', [...this.subscriptions.values()]),
      this.persist('core', 'keychain', this.keychain),
      this.persist('core', 'history', this.history),
      this.persist('core', 'expirer', this.expirations)
    ])
    this.syncIndexes()
    return {
      uri: `wc:${pairingTopic}@2?symKey=key&expiryTimestamp=${pairingExpiry}`,
      approval: () => this.approval.promise
    }
  })

  async receiveApproval(proposalId: number): Promise<boolean> {
    const topic = await this.receiveProposalResponse(proposalId)
    if (!topic) {
      return false
    }
    return this.receiveSettle(session(topic))
  }

  async receiveProposalResponse(proposalId: number): Promise<string | undefined> {
    const proposal = this.proposals.get(proposalId)
    if (
      !this.open ||
      !proposal ||
      !this.subscriptions.has(proposal.pairingTopic) ||
      !this.keychain[proposal.proposer.publicKey]
    ) {
      return undefined
    }
    const record = this.history.find((entry) => entry.id === proposalId)
    if (!record) {
      return undefined
    }
    record.response = {
      id: proposalId,
      jsonrpc: '2.0',
      result: { responderPublicKey: walletKeys.publicKey, relay: { protocol: 'irn' } }
    }
    await this.persist('core', 'history', this.history)
    const sharedKey = deriveSymKey(this.keychain[proposal.proposer.publicKey], walletKeys.publicKey)
    const topic = hashKey(sharedKey)
    this.keychain[topic] = sharedKey
    this.subscriptions.set(topic, {
      id: `subscription-${topic}`,
      topic,
      relay: { protocol: 'irn' }
    })
    await this.persist('core', 'keychain', this.keychain)
    await this.persist('core', 'subscription', [...this.subscriptions.values()])
    this.history = this.history.filter((entry) => entry.id !== proposalId)
    await this.persist('core', 'history', this.history)
    this.syncIndexes()
    return topic
  }

  async receiveSettle(approved: SessionTypes.Struct): Promise<boolean> {
    if (
      !this.open ||
      !this.subscriptions.has(approved.topic) ||
      !this.keychain[approved.topic] ||
      !this.currentProposal
    ) {
      return false
    }
    // SDK session_connect delivery uses the current connect waiter after proposal intake.
    const accepted = { ...approved, pairingTopic: this.currentProposal.pairingTopic }
    this.sessions.set(accepted.topic, accepted)
    await this.persistSessionSnapshot([...this.sessions.values()])
    this.syncIndexes()
    this.approval.resolve(accepted)
    return true
  }

  readonly disconnect = vi.fn(async ({ topic }: { topic: string }) => {
    this.trace.push(`session deleted:${topic}`)
    this.sessions.delete(topic)
    this.pairings.delete(topic)
    await this.persistSessionSnapshot([...this.sessions.values()])
    this.syncIndexes()
  })

  async persistSessionSnapshot(snapshot: SessionTypes.Struct[]): Promise<void> {
    await this.persist('client', 'session', snapshot)
  }

  private key(scope: 'client' | 'core', name: string): string {
    return `wc@2:${scope}:0.3${this.core.customStoragePrefix}//${name}`
  }
  private async read<T>(scope: 'client' | 'core', name: string): Promise<T[]> {
    return (await this.core.storage.getItem<T[]>(this.key(scope, name))) ?? []
  }
  private async persist<T>(scope: 'client' | 'core', name: string, value: T): Promise<void> {
    await this.core.storage.setItem(this.key(scope, name), value)
  }
  private syncIndexes(): void {
    this.session.keys = [...this.sessions.keys()]
    this.core.relayer.subscriber.topics = [...this.subscriptions.keys()]
  }
}

describe('WalletConnect proposal retirement', () => {
  let storage: MemoryStorage
  const remotes: Remote[] = []
  const owners: Array<{ client: WalletConnectCommunicationClient; token: object }> = []

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-08T00:00:00Z'))
    vi.stubGlobal('BroadcastChannel', LocalBroadcastChannel)
    localStorage.clear()
    storage = new MemoryStorage()
    remotes.length = 0
    owners.length = 0
    Reflect.deleteProperty(WalletConnectCommunicationClient, 'instance')
    initialize.mockReset().mockImplementation(async (options) => {
      const remote = new Remote(options, remotes.length + 1)
      remotes.push(remote)
      await remote.restore()
      return remote
    })
  })

  afterEach(async () => {
    storage.beforeWrite = undefined
    for (const owner of owners) {
      await owner.client.releaseOwner(owner.token, false)
    }
    await vi.advanceTimersByTimeAsync(sdkProposalLifetimeMs + 10_000)
    Reflect.deleteProperty(WalletConnectCommunicationClient, 'instance')
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function owner() {
    const token = {}
    const client = WalletConnectCommunicationClient.getInstance(
      { network: NetworkType.MAINNET, opts: { projectId: 'project', storage } },
      () => true,
      token
    )
    const result = { client, token }
    owners.push(result)
    return result
  }

  it('settles owner release while its exposed proposal can still receive and discard approval', async () => {
    const first = owner()
    await first.client.init()
    const remote = remotes[0]
    const released = vi.fn()
    first.client.releaseOwner(first.token, false).then(released)
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(released).toHaveBeenCalledTimes(1)
    expect.soft(remote.core.relayer.transportClose).not.toHaveBeenCalled()

    expect.soft(await remote.receiveApproval(1)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect
      .soft(remote.disconnect)
      .toHaveBeenCalledWith(expect.objectContaining({ topic: remote.approvalTopic }))
    expect(remote.trace).toEqual([`session deleted:${remote.approvalTopic}`, 'relay closed'])
    expect(first.client.currentSession()).toBeUndefined()
  })

  it.each(['write', 'delete'])(
    'keeps the replacement session after a retired SDK collection %s',
    async (operation) => {
      const first = owner()
      await first.client.init()
      await first.client.releaseOwner(first.token, false)
      const next = owner()
      await next.client.listenForChannelOpening(async () => true)
      await next.client.init()
      await remotes[1].receiveApproval(2)
      await vi.advanceTimersByTimeAsync(0)
      expect(next.client.currentSession()?.topic).toBe(remotes[1].approvalTopic)

      await remotes[0].persistSessionSnapshot(
        operation === 'write' ? [session(remotes[0].approvalTopic)] : []
      )
      const stored = await storage.getItem<SessionTypes.Struct[]>(sessionKey)
      expect(stored?.map((entry) => entry.topic)).toEqual([remotes[1].approvalTopic])
      expect(next.client.currentSession()?.topic).toBe(remotes[1].approvalTopic)
    }
  )

  it.each([false, true])(
    'starts replacement intake without retiring records when session derivation is %s',
    async (derived) => {
      const first = owner()
      await first.client.init()
      if (derived) {
        await remotes[0].receiveProposalResponse(1)
      }
      await first.client.releaseOwner(first.token, false)
      const next = owner()
      const paired = vi.fn(async () => true)
      await next.client.listenForChannelOpening(paired)
      await next.client.init()
      const remote = remotes[1]
      expect.soft(remote.proposal.getAll().map((entry) => entry.id)).toEqual([2])
      expect
        .soft(remote.core.pairing.getPairings().map((entry) => entry.topic))
        .toEqual(['pairing-2'])
      expect.soft(remote.core.relayer.subscriber.topics).toEqual(['pairing-2'])
      expect.soft(await remote.receiveApproval(1)).toBe(false)
      if (derived) {
        expect.soft(await remote.receiveSettle(session(remotes[0].approvalTopic))).toBe(false)
      }
      await vi.advanceTimersByTimeAsync(0)
      expect.soft(paired).not.toHaveBeenCalled()
      expect.soft(next.client.currentSession()).toBeUndefined()

      await remote.receiveApproval(2)
      await vi.advanceTimersByTimeAsync(0)
      expect(next.client.currentSession()?.topic).toBe(remotes[1].approvalTopic)
      expect(paired).toHaveBeenCalledTimes(1)
    }
  )

  it('waits for an admitted storage write before starting the replacement SDK', async () => {
    const first = owner()
    await first.client.init()
    const write = new ExposedPromise<void>()
    storage.beforeWrite = async (key) => {
      if (key === sessionKey) {
        await write.promise
      }
    }
    const persisting = remotes[0].persistSessionSnapshot([])
    const released = vi.fn()
    const releasing = first.client.releaseOwner(first.token, false).then(released)
    const next = owner()
    await next.client.listenForChannelOpening(async () => true)
    const ready = vi.fn()
    const starting = next.client.init().then(ready)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect.soft(released).toHaveBeenCalledTimes(1)
      expect.soft(initialize).toHaveBeenCalledTimes(1)
      expect.soft(ready).not.toHaveBeenCalled()
    } finally {
      storage.beforeWrite = undefined
      write.resolve()
    }
    await Promise.all([persisting, releasing, starting])
    await remotes[1].receiveApproval(2)
    await vi.advanceTimersByTimeAsync(0)

    expect(ready).toHaveBeenCalledTimes(1)
    expect(next.client.currentSession()?.topic).toBe(remotes[1].approvalTopic)
    expect(
      (await storage.getItem<SessionTypes.Struct[]>(sessionKey))?.map((entry) => entry.topic)
    ).toEqual([remotes[1].approvalTopic])
  })

  it('restores an established session retained beside a retiring proposal', async () => {
    await storage.setItem(sessionKey, [
      session('retained'),
      { ...session('expired'), expiry: Math.floor(Date.now() / 1000) - 1 }
    ])
    await storage.setItem('wc@2:core:0.3//keychain', { retained: 'retained-session-key' })
    await storage.setItem('wc@2:core:0.3//subscription', [
      { id: 'retained-subscription', topic: 'retained', relay: { protocol: 'irn' } }
    ])
    const first = owner()
    await first.client.init()
    expect(first.client.currentSession()).toBeUndefined()
    expect(remotes[0].proposal.getAll()).toHaveLength(1)
    await first.client.releaseOwner(first.token, false)
    const next = owner()
    await next.client.init()

    expect(next.client.currentSession()?.topic).toBe('retained')
    expect(remotes[1].connect).not.toHaveBeenCalled()
    expect(remotes[0].disconnect).not.toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'retained' })
    )
  })

  it('closes an unresolved proposal at its SDK expiry after the earlier URI expiry', async () => {
    initialize.mockImplementationOnce(async (options) => {
      const remote = new Remote(options, 1)
      remote.proposalDelayMs = 5_000
      remotes.push(remote)
      await remote.restore()
      return remote
    })
    const first = owner()
    const starting = first.client.init()
    await vi.advanceTimersByTimeAsync(5_000)
    await starting
    await first.client.releaseOwner(first.token, false)
    const remote = remotes[0]

    await vi.advanceTimersByTimeAsync(sdkProposalLifetimeMs - 5_000)
    expect.soft(remote.core.relayer.transportClose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4_999)
    expect.soft(remote.core.relayer.transportClose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(remote.core.relayer.transportClose).toHaveBeenCalledTimes(1)
    expect(first.client.currentSession()).toBeUndefined()
  })
})
