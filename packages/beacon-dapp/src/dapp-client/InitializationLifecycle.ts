import { ErrorResponse, TransportType } from '@ecadlabs/beacon-types'
import { ExposedPromise } from '@ecadlabs/beacon-utils'

import { InitializationAttempt } from './InitializationAttempt'

/** Owns facade initialization, selection completion and local teardown admission. */
export class InitializationLifecycle {
  public completion: Promise<TransportType> | undefined
  public reject: ((reason: ErrorResponse) => void) | undefined
  public disconnectCompletion: Promise<void> | undefined
  private attempt: InitializationAttempt | undefined
  private teardown: Promise<unknown> | undefined
  private selection: { transition: AbortSignal; completion: Promise<unknown> } | undefined
  private readonly destruction = new AbortController()

  constructor(private readonly aborted: () => ErrorResponse) {}

  public start(
    transition: AbortSignal,
    cancel: () => void,
    operation: (attempt: InitializationAttempt) => Promise<void>
  ): Promise<TransportType> {
    if (this.completion) {
      return this.completion
    }
    this.attempt?.reject(this.aborted())
    const attempt: InitializationAttempt = new InitializationAttempt(
      transition,
      this.aborted,
      cancel,
      () => this.attempt === attempt,
      (failed) => {
        if (this.attempt !== attempt) {
          return
        }
        this.attempt = undefined
        this.reject = undefined
        if (failed && this.completion === attempt.promise) {
          this.completion = undefined
        }
      }
    )
    this.attempt = attempt
    this.completion = attempt.promise
    this.reject = (reason) => attempt.reject(reason)
    if (transition.aborted || this.destruction.signal.aborted) {
      attempt.reject(this.aborted())
    } else {
      operation(attempt).catch((error: unknown) => attempt.reject(error))
    }

    return attempt.promise
  }

  public abort(): void {
    this.reject?.(this.aborted())
    this.completion = undefined
    this.reject = undefined
  }

  public destroy(): void {
    this.destruction.abort()
    this.abort()
  }

  public get tearingDown(): boolean {
    return this.teardown !== undefined
  }

  public async waitForTeardown(): Promise<void> {
    while (this.teardown) {
      await this.untilDestroyed(this.teardown)
    }
    if (this.destruction.signal.aborted) {
      throw this.aborted()
    }
  }

  public async waitForSelection(transition: AbortSignal): Promise<void> {
    const selection = this.selection
    if (selection?.transition === transition) {
      await selection.completion
    }
  }

  public select<T>(transition: AbortSignal, operation: () => Promise<T>, cancelled: T): Promise<T> {
    if (transition.aborted) {
      return Promise.resolve(cancelled)
    }
    // Nested account recovery belongs to its outer selection, not a new barrier.
    if (this.selection?.transition === transition) {
      return operation()
    }
    const result = new ExposedPromise<T, unknown>()
    const selection = { transition, completion: result.promise }
    this.selection = selection
    const abort = () => result.resolve(cancelled)
    const finish = () => {
      transition.removeEventListener('abort', abort)
      if (this.selection === selection) {
        this.selection = undefined
      }
    }
    result.promise.then(finish, finish)
    transition.addEventListener('abort', abort, { once: true })
    operation().then(
      (value) => result.resolve(value),
      (error: unknown) => result.reject(error)
    )

    return result.promise
  }

  public cleanup<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.teardown
    const result = new ExposedPromise<T, unknown>()
    const completion = result.promise
    this.teardown = completion
    const finish = () => {
      if (this.teardown === completion) {
        this.teardown = undefined
      }
    }
    completion.then(finish, finish)
    const run = () =>
      operation().then(
        (value) => result.resolve(value),
        (error: unknown) => result.reject(error)
      )
    // A failed cleanup is reported to its caller but does not poison later admission.
    if (previous) {
      previous.then(run, run).catch((error: unknown) => result.reject(error))
    } else {
      try {
        run().catch((error: unknown) => result.reject(error))
      } catch (error: unknown) {
        result.reject(error)
      }
    }

    return completion
  }

  public disconnect(operation: () => Promise<void>): Promise<void> {
    if (this.disconnectCompletion) {
      return this.disconnectCompletion
    }
    const result = new ExposedPromise<void, unknown>()
    const completion = result.promise
    this.disconnectCompletion = completion
    completion.then(
      () => {
        if (this.disconnectCompletion === completion) {
          this.disconnectCompletion = undefined
        }
      },
      () => {
        if (this.disconnectCompletion === completion) {
          this.disconnectCompletion = undefined
        }
      }
    )
    this.cleanup(operation).then(
      () => result.resolve(),
      (error: unknown) => result.reject(error)
    )

    return completion
  }

  private untilDestroyed(work: Promise<unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(this.aborted())
      if (this.destruction.signal.aborted) {
        abort()

        return
      }
      this.destruction.signal.addEventListener('abort', abort, { once: true })
      const done = () => {
        this.destruction.signal.removeEventListener('abort', abort)
        resolve()
      }
      // Cleanup reports its own failure; admission waits for settlement, not success.
      work.then(done, done)
    })
  }
}
