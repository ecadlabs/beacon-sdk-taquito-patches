import { ErrorResponse, TransportType } from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'

/** Completion capability passed to the existing candidate adapters. */
export class InitializationAttempt {
  private readonly result = new ExposedPromise<TransportType, unknown>()
  private readonly retirement = new AbortController()
  private readonly onAbort = () => {
    this.reject(this.aborted())
    this.cancel()
  }

  constructor(
    private readonly transition: AbortSignal,
    private readonly aborted: () => ErrorResponse,
    private readonly cancel: () => void,
    private readonly ownsAttempt: () => boolean,
    private readonly settled: (failed: boolean) => void
  ) {
    this.result.promise.catch(() => undefined)
    transition.addEventListener('abort', this.onAbort, { once: true })
  }

  public get promise(): Promise<TransportType> {
    return this.result.promise
  }

  public isCurrent(): boolean {
    return this.result.isPending() && !this.transition.aborted && this.ownsAttempt()
  }

  public resolve(value: TransportType): void {
    if (this.result.isSettled()) {
      return
    }
    if (!this.isCurrent()) {
      this.reject(this.aborted())

      return
    }
    this.result.resolve(value)
    this.finish(false)
  }

  public reject(error: unknown): void {
    if (this.result.isSettled()) {
      return
    }
    this.result.reject(error)
    this.finish(true)
  }

  /** Issued UI information settles even when its adapter is still completing. */
  public information(operation: () => Promise<string>): Promise<string> {
    return this.informationWithDefault(operation, '')
  }

  public informationWithDefault<T>(operation: () => Promise<T>, retiredValue: T): Promise<T> {
    if (this.retirement.signal.aborted) {
      return Promise.resolve(retiredValue)
    }

    return new Promise<T>((resolve, reject) => {
      const retired = () => resolve(retiredValue)
      this.retirement.signal.addEventListener('abort', retired, { once: true })
      const finish = () => this.retirement.signal.removeEventListener('abort', retired)
      Promise.resolve()
        .then(() => (this.retirement.signal.aborted ? retiredValue : operation()))
        .then(
          (value) => {
            finish()
            resolve(this.retirement.signal.aborted ? retiredValue : value)
          },
          (error: unknown) => {
            finish()
            if (this.retirement.signal.aborted) {
              resolve(retiredValue)
            } else {
              reject(error)
            }
          }
        )
    })
  }

  private finish(failed: boolean): void {
    this.transition.removeEventListener('abort', this.onAbort)
    this.retirement.abort()
    this.settled(failed)
  }
}
