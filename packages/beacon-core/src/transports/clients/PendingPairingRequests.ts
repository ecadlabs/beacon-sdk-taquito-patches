/** In-memory pairing capabilities. A reload requires a fresh pairing request. */
export class PendingPairingRequests {
  private readonly requests = new Map<string, number>()

  private acceptance: Promise<void> = Promise.resolve()
  private readonly operations = new Set<{ promise: Promise<void>; observed: boolean }>()
  private failure: { reason: unknown } | undefined

  public generation = 0

  public add(id: string, generation = this.generation): void {
    if (generation !== this.generation) {
      throw new Error('Pairing request cancelled')
    }
    this.prune()
    this.requests.set(id, Date.now() + 30 * 60 * 1000)
    while (this.requests.size > 32) {
      const oldestKey = this.requests.keys().next().value
      if (oldestKey !== undefined) {
        this.requests.delete(oldestKey)
      }
    }
  }

  public hasPending(): boolean {
    this.prune()

    return this.requests.size > 0
  }

  public consume(id: string): boolean {
    this.prune()
    if (!this.requests.has(id)) {
      return false
    }
    this.clear()

    return true
  }

  public accept(
    id: string,
    operation: (checkActive: () => boolean) => Promise<void>
  ): Promise<void> {
    if (!this.consume(id)) {
      return Promise.resolve()
    }
    const generation = this.generation
    const isActive = () => generation === this.generation
    const acceptance = this.acceptance.then(async () => {
      if (isActive()) {
        await operation(isActive)
      }
    })
    const record = { promise: acceptance, observed: false }
    this.operations.add(record)
    acceptance.then(
      () => this.operations.delete(record),
      (reason) => {
        if (!record.observed) {
          this.failure ??= { reason }
        }
        this.operations.delete(record)
      }
    )
    this.acceptance = acceptance.catch(() => undefined)

    return acceptance
  }

  public cancel(): Promise<void> {
    this.clear()
    const operations = [...this.operations]
    for (const operation of operations) {
      operation.observed = true
    }
    const previousFailure = this.failure
    this.failure = undefined

    return Promise.allSettled(operations.map((operation) => operation.promise)).then((results) => {
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      if (previousFailure) {
        throw previousFailure.reason
      }
      if (rejected) {
        throw rejected.reason
      }
    })
  }

  public clear(): void {
    this.generation++
    this.requests.clear()
  }

  private prune(): void {
    for (const [id, expiry] of this.requests) {
      if (expiry <= Date.now()) {
        this.requests.delete(id)
      }
    }
  }
}
