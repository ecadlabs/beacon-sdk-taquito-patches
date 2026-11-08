import { ProposalTypes, SessionTypes, SignClientTypes } from '@walletconnect/types'
import { deriveSymKey, hashKey } from '@walletconnect/utils'

type Storage = NonNullable<SignClientTypes.Options['storage']>
type RecordValue = Record<string, unknown>

interface TrackedProposal {
  pairingTopic: string
  publicKey: string
  privateKey?: string
  derivedTopics: Set<string>
}

interface Retirement {
  proposalIds: Set<number>
  pairingTopics: Set<string>
  proposerKeys: Set<string>
  derivedTopics: Set<string>
  retainedSessions: readonly SessionTypes.Struct[]
  removedSessionTopics: Set<string>
}

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Storage for one SDK lifetime, including a proposal completing after retirement. */
export class WalletConnectStorageOwner implements Storage {
  private static readonly pending = new Set<WalletConnectStorageOwner>()

  private readonly backing: Storage
  private readonly persistenceDomain: object | string
  private preparation: Promise<void> | undefined
  private writes: Promise<void> = Promise.resolve()
  private retirement: Retirement | undefined
  private local: Map<string, unknown> | undefined
  private readonly proposals = new Map<number, TrackedProposal>()
  private readonly exposedProposals = new Set<number>()
  private keychain: unknown
  private history: unknown

  constructor(
    backing: Storage,
    private readonly corePrefix: string,
    persistenceDomain: object | string = backing
  ) {
    this.backing = backing instanceof WalletConnectStorageOwner ? backing.backing : backing
    this.persistenceDomain =
      backing instanceof WalletConnectStorageOwner ? backing.persistenceDomain : persistenceDomain
  }

  /** A failed preparation is retried by the next startup; it never permits an unsafe restore. */
  public static pendingHandoff(next: WalletConnectStorageOwner): Promise<void> | undefined {
    const owner = [...this.pending].find(
      (candidate) =>
        candidate.persistenceDomain === next.persistenceDomain &&
        candidate.corePrefix === next.corePrefix
    )
    if (!owner) {
      return undefined
    }
    if (!owner.preparation) {
      const preparation = owner.prepareRetirement().then(() => {
        this.pending.delete(owner)
      })
      const tracked = preparation.finally(() => {
        if (owner.preparation === tracked) {
          owner.preparation = undefined
        }
      })
      owner.preparation = tracked
    }

    return owner.preparation.then(() => this.pendingHandoff(next))
  }

  public trackProposal(proposal: ProposalTypes.Struct): void {
    this.exposedProposals.add(proposal.id)
    this.registerProposal(proposal.id, proposal.pairingTopic, proposal.proposer.publicKey)
    this.capturePrivateKeys()
    this.captureDerivedTopics()
  }

  public forgetProposal(id: number): void {
    this.exposedProposals.delete(id)
    this.proposals.delete(id)
  }

  public retire(
    proposals: readonly ProposalTypes.Struct[],
    retainedSessions: readonly SessionTypes.Struct[] = [],
    removedSessionTopics: readonly string[] = []
  ): Promise<void> {
    if (!this.retirement) {
      proposals.forEach((proposal) => this.trackProposal(proposal))
      this.retirement = {
        proposalIds: new Set(proposals.map((proposal) => proposal.id)),
        pairingTopics: new Set(proposals.map((proposal) => proposal.pairingTopic)),
        proposerKeys: new Set(proposals.map((proposal) => proposal.proposer.publicKey)),
        derivedTopics: new Set(
          proposals.flatMap((proposal) => [
            ...(this.proposals.get(proposal.id)?.derivedTopics ?? [])
          ])
        ),
        retainedSessions: structuredClone(retainedSessions),
        removedSessionTopics: new Set(removedSessionTopics)
      }
      WalletConnectStorageOwner.pending.add(this)
    } else if (
      removedSessionTopics.some((topic) => !this.retirement?.removedSessionTopics.has(topic))
    ) {
      if (this.local) {
        return Promise.reject(new Error('WalletConnect storage handoff is already sealed.'))
      }
      // A synchronous logout upgrade precedes the handoff snapshot and owns these exact topics.
      const removed = new Set([...this.retirement.removedSessionTopics, ...removedSessionTopics])
      this.retirement = {
        ...this.retirement,
        retainedSessions: this.retirement.retainedSessions.filter(
          (session) => !removed.has(session.topic)
        ),
        removedSessionTopics: removed
      }
    }

    return WalletConnectStorageOwner.pendingHandoff(this) ?? Promise.resolve()
  }

  public async getKeys(): Promise<string[]> {
    if (this.retirement) {
      return [...(await this.localView()).keys()]
    }
    await this.writes
    const keys = await this.backing.getKeys()

    return this.retirement ? [...(await this.localView()).keys()] : keys
  }

  public async getEntries<T>(): Promise<[string, T][]> {
    if (this.retirement) {
      return structuredClone([...(await this.localView()).entries()]) as [string, T][]
    }
    await this.writes
    const entries = await this.backing.getEntries<T>()
    if (this.retirement) {
      return structuredClone([...(await this.localView()).entries()]) as [string, T][]
    }
    entries.forEach(([key, value]) => this.observe(key, structuredClone(value)))

    return structuredClone(entries)
  }

  public async getItem<T>(key: string): Promise<T | undefined> {
    if (this.retirement) {
      return structuredClone((await this.localView()).get(key)) as T | undefined
    }
    await this.writes
    const value = await this.backing.getItem<T>(key)
    if (this.retirement) {
      return structuredClone((await this.localView()).get(key)) as T | undefined
    }
    this.observe(key, structuredClone(value))

    return structuredClone(value)
  }

  public setItem<T>(key: string, value: T): Promise<void> {
    const snapshot = structuredClone(value)
    // History must be captured before the SDK can remove it in a later queued write.
    this.observe(key, snapshot)
    if (this.retirement) {
      return this.localView().then((local) => {
        local.set(key, snapshot)
      })
    }

    return this.persist(() => this.backing.setItem(key, snapshot))
  }

  public removeItem(key: string): Promise<void> {
    this.observe(key, undefined)
    if (this.retirement) {
      return this.localView().then((local) => {
        local.delete(key)
      })
    }

    return this.persist(() => this.backing.removeItem(key))
  }

  private persist(operation: () => Promise<void>): Promise<void> {
    const write = this.writes.then(operation)
    this.writes = write.catch(() => undefined)

    return write
  }

  private async localView(): Promise<Map<string, unknown>> {
    if (!this.local) {
      await WalletConnectStorageOwner.pendingHandoff(this)
    }
    if (!this.local) {
      throw new Error('WalletConnect storage retirement has not completed.')
    }

    return this.local
  }

  private key(scope: 'core' | 'client', name: string): string {
    return `wc@2:${scope}:0.3${this.corePrefix}//${name}`
  }

  private observe(key: string, value: unknown): void {
    if (key === this.key('core', 'keychain')) {
      this.keychain = value
      this.capturePrivateKeys()
      this.captureDerivedTopics()
    } else if (key === this.key('core', 'history')) {
      this.history = value
      this.captureDerivedTopics()
    } else if (key === this.key('client', 'proposal') && Array.isArray(value)) {
      const present = new Set<number>()
      for (const entry of value) {
        if (
          isRecord(entry) &&
          typeof entry.id === 'number' &&
          typeof entry.pairingTopic === 'string' &&
          isRecord(entry.proposer) &&
          typeof entry.proposer.publicKey === 'string'
        ) {
          present.add(entry.id)
          this.registerProposal(entry.id, entry.pairingTopic, entry.proposer.publicKey)
        }
      }
      for (const id of this.proposals.keys()) {
        if (!present.has(id) && !this.exposedProposals.has(id)) {
          this.proposals.delete(id)
        }
      }
      this.capturePrivateKeys()
      this.captureDerivedTopics()
    }
  }

  private registerProposal(id: number, pairingTopic: string, publicKey: string): void {
    if (!this.proposals.has(id)) {
      this.proposals.set(id, { pairingTopic, publicKey, derivedTopics: new Set<string>() })
    }
  }

  private capturePrivateKeys(): void {
    if (!isRecord(this.keychain)) {
      return
    }
    for (const tracked of this.proposals.values()) {
      const key = this.keychain[tracked.publicKey]
      if (typeof key === 'string') {
        tracked.privateKey = key
      }
    }
  }

  private captureDerivedTopics(): void {
    if (!Array.isArray(this.history)) {
      return
    }
    for (const entry of this.history) {
      if (!isRecord(entry) || typeof entry.id !== 'number') {
        continue
      }
      const tracked = this.proposals.get(entry.id)
      if (
        !tracked?.privateKey ||
        entry.topic !== tracked.pairingTopic ||
        !isRecord(entry.request) ||
        entry.request.method !== 'wc_sessionPropose' ||
        !isRecord(entry.response) ||
        !isRecord(entry.response.result) ||
        typeof entry.response.result.responderPublicKey !== 'string'
      ) {
        continue
      }
      try {
        tracked.derivedTopics.add(
          hashKey(deriveSymKey(tracked.privateKey, entry.response.result.responderPublicKey))
        )
      } catch {
        // An invalid response provides no ownership evidence for another stored key.
      }
    }
  }

  private async prepareRetirement(): Promise<void> {
    if (!this.retirement) {
      return
    }
    await this.writes
    const entries = structuredClone(await this.backing.getEntries<unknown>())
    const retirement = this.retirement
    this.local ??= new Map(entries)
    const mask = this.retirementMask(
      retirement,
      new Map(entries).get(this.key('client', 'session'))
    )
    for (const [key, value] of entries) {
      const filtered = this.filterRetiredValue(key, value, retirement, mask)
      if (filtered !== value) {
        await this.backing.setItem(key, filtered)
      }
    }
  }

  private retirementMask(
    retirement: Retirement,
    sessions: unknown
  ): { topics: Set<string>; keys: Set<string> } {
    const topics = new Set([
      ...retirement.pairingTopics,
      ...retirement.derivedTopics,
      ...retirement.removedSessionTopics
    ])
    const sessionKeys = new Set<string>()
    const protectedTopics = new Set<string>()
    const protectedKeys = new Set<string>()
    const retained = new Map<string, RecordValue | SessionTypes.Struct>()
    for (const session of retirement.retainedSessions) {
      retained.set(session.topic, session)
    }
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        if (!isRecord(session) || typeof session.topic !== 'string') {
          continue
        }
        if (retirement.removedSessionTopics.has(session.topic)) {
          if (typeof session.pairingTopic === 'string') {
            topics.add(session.pairingTopic)
          }
          if (isRecord(session.self) && typeof session.self.publicKey === 'string') {
            sessionKeys.add(session.self.publicKey)
          }
        } else if (
          (typeof session.pairingTopic === 'string' &&
            retirement.pairingTopics.has(session.pairingTopic)) ||
          retirement.derivedTopics.has(session.topic)
        ) {
          topics.add(session.topic)
        } else {
          retained.set(session.topic, session)
        }
      }
    }
    for (const session of retained.values()) {
      for (const topic of [session.topic, session.pairingTopic]) {
        if (typeof topic === 'string') {
          protectedTopics.add(topic)
          protectedKeys.add(topic)
        }
      }
      for (const peer of [session.self, session.peer]) {
        if (isRecord(peer) && typeof peer.publicKey === 'string') {
          protectedKeys.add(peer.publicKey)
        }
      }
    }
    protectedTopics.forEach((topic) => topics.delete(topic))
    const keys = new Set([...topics, ...retirement.proposerKeys, ...sessionKeys])
    protectedKeys.forEach((key) => keys.delete(key))

    return { topics, keys }
  }

  private filterRetiredValue(
    key: string,
    value: unknown,
    retirement: Retirement,
    { topics, keys }: { topics: Set<string>; keys: Set<string> }
  ): unknown {
    const ownsTopic = (candidate: unknown): boolean =>
      typeof candidate === 'string' && topics.has(candidate)
    const ownsId = (candidate: unknown): boolean =>
      typeof candidate === 'number' && retirement.proposalIds.has(candidate)

    let filtered: unknown = value
    if (key === this.key('core', 'keychain') && isRecord(value)) {
      const kept = Object.entries(value).filter(([tag]) => !keys.has(tag))
      if (kept.length !== Object.keys(value).length) {
        filtered = Object.fromEntries(kept)
      }
    } else if (Array.isArray(value)) {
      let remove: ((entry: RecordValue) => boolean) | undefined
      if (key === this.key('client', 'proposal')) {
        remove = (entry) => ownsId(entry.id)
      } else if (
        key === this.key('client', 'session') ||
        key === this.key('core', 'pairing') ||
        key === this.key('core', 'subscription')
      ) {
        remove = (entry) => ownsTopic(entry.topic)
      } else if (key === this.key('core', 'history')) {
        remove = (entry) => ownsTopic(entry.topic) || ownsId(entry.id)
      } else if (key === this.key('core', 'expirer')) {
        const targets = new Set([...topics].map((topic) => `topic:${topic}`))
        retirement.proposalIds.forEach((id) => targets.add(`id:${id}`))
        remove = (entry) => typeof entry.target === 'string' && targets.has(entry.target)
      }
      if (remove) {
        const kept = value.filter((entry: unknown) => !isRecord(entry) || !remove(entry))
        if (kept.length !== value.length) {
          filtered = kept
        }
      }
    }

    return filtered
  }
}
