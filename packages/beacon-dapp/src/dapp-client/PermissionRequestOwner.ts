import { ErrorResponse } from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'

/** Owns the public permission result after transport correlation has finished. */
export class PermissionRequestOwner {
  private readonly cancelled = new ExposedPromise<never, ErrorResponse>()
  private id: string | undefined
  private transition: AbortSignal | undefined
  private cancelRequest: (() => void) | undefined
  private closed = false
  private readonly onAbort = () => this.abort()

  constructor(private readonly errorForId: (id?: string) => ErrorResponse) {
    this.cancelled.promise.catch(() => undefined)
  }

  public admit(id: string, transition: AbortSignal, cancelRequest: () => void): void {
    this.assertCurrent()
    this.id = id
    this.cancelRequest = cancelRequest
    this.follow(transition)
    this.assertCurrent()
  }

  public isCurrent(): boolean {
    return !this.closed
  }

  public wasRevoked(): boolean {
    return this.cancelled.isRejected()
  }

  public complete(): void {
    this.assertCurrent()
    // Observers may synchronously select another account after success is published.
    this.close()
  }

  public assertCurrent(): void {
    if (this.closed) {
      throw this.cancelled.promiseError ?? this.errorForId(this.id)
    }
  }

  public follow(transition: AbortSignal): void {
    this.assertCurrent()
    this.detach()
    this.transition = transition
    if (transition.aborted) {
      this.abort()
    } else {
      transition.addEventListener('abort', this.onAbort, { once: true })
    }
  }

  public abort(): void {
    if (this.closed || this.id === undefined) {
      return
    }
    this.closed = true
    this.detach()
    this.cancelled.reject(this.errorForId(this.id))
    const cancel = this.cancelRequest
    this.cancelRequest = undefined
    cancel?.()
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      // Observe both outcomes even when cancellation wins while work remains pending.
      return await Promise.race([this.cancelled.promise, operation()])
    } finally {
      this.close()
    }
  }

  private close(): void {
    this.closed = true
    this.detach()
    this.cancelRequest = undefined
  }

  private detach(): void {
    this.transition?.removeEventListener('abort', this.onAbort)
    this.transition = undefined
  }
}
