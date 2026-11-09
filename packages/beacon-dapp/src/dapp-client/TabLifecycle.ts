import { ExposedPromise } from '@ecadlabs/beacon-utils'

/** Owns local route retirement and the elected tab's reconnect completion. */
export class TabLifecycle {
  private follower = new AbortController()
  private leader = new AbortController()
  private connection: Promise<void> | undefined
  private promotion:
    { state: 'Connecting' | 'Failed'; signal: AbortSignal; completion: Promise<void> } | undefined

  constructor(
    private readonly elected: () => boolean,
    private readonly aborted: () => unknown
  ) {}

  public get followerSignal(): AbortSignal {
    return this.follower.signal
  }

  public get leaderSignal(): AbortSignal {
    return this.leader.signal
  }

  public confirmLeader(): boolean {
    if (this.elected()) {
      return true
    }
    this.retireLeader()

    return false
  }

  public leaderDeparted(): void {
    const previous = this.follower
    this.follower = new AbortController()
    previous.abort()
    if (!this.elected()) {
      this.retireLeader()
    }
  }

  public reset(): void {
    const previous = this.follower
    this.follower = new AbortController()
    previous.abort()
    // Teardown owns captured adapters; its replacement need not await old callbacks.
    this.connection = undefined
    this.retireLeader()
  }

  public get promotionFailed(): boolean {
    return this.promotion?.state === 'Failed'
  }

  public async waitForPromotion(): Promise<void> {
    await this.promotion?.completion
  }

  public promote(operation: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    if (!this.confirmLeader()) {
      return Promise.resolve()
    }
    if (this.promotion?.state === 'Connecting') {
      return this.promotion.completion
    }
    const signal = this.leader.signal
    const result = new ExposedPromise<void, unknown>()
    const promotion: NonNullable<typeof this.promotion> = {
      state: 'Connecting',
      signal,
      completion: result.promise
    }
    this.promotion = promotion
    const abort = () => result.reject(this.aborted())
    signal.addEventListener('abort', abort, { once: true })
    const finish = (failed: boolean) => {
      signal.removeEventListener('abort', abort)
      if (this.promotion === promotion) {
        if (failed) {
          promotion.state = 'Failed'
        } else {
          this.promotion = undefined
        }
      }
    }
    result.promise.then(
      () => finish(false),
      () => finish(true)
    )
    const isCurrent = () =>
      this.promotion === promotion &&
      !signal.aborted &&
      signal === this.leader.signal &&
      this.confirmLeader()
    const run = async (): Promise<void> => {
      if (isCurrent()) {
        await operation(isCurrent)
      }
    }
    // A new elected lifetime joins any physical reconnect still draining from the old one.
    const connection = this.connection ? this.connection.then(run, run) : run()
    this.connection = connection
    const release = () => {
      if (this.connection === connection) {
        this.connection = undefined
      }
    }
    connection.then(release, release)
    connection.then(
      () => result.resolve(),
      (error: unknown) => result.reject(error)
    )

    return result.promise
  }

  private retireLeader(): void {
    const previous = this.leader
    this.leader = new AbortController()
    this.promotion = undefined
    previous.abort()
  }
}
