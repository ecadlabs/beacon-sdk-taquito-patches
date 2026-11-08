import { ExposedPromise } from '@ecadlabs/beacon-utils'
import {
  OpenRequestInput,
  OpenRequestState,
  RequestDeadline,
  transitionRequest
} from './OpenRequestMachine'

export interface RequestKey {
  readonly id: string
  readonly instance: symbol
}
export type RequestRoute = 'Direct' | 'Follower' | 'LeaderProxy'
export type RequestResult<Response, Failure> =
  | { readonly tag: 'Resolved'; readonly response: Response }
  | { readonly tag: 'Rejected' | 'TimedOut' | 'Aborted'; readonly error: Failure }

interface RequestRecord<Response, Failure> {
  readonly key: RequestKey
  readonly route: RequestRoute
  state: OpenRequestState
  readonly completion: ExposedPromise<RequestResult<Response, Failure>>
  readonly settle: (result: RequestResult<Response, Failure>) => void
  timer?: ReturnType<typeof setTimeout>
  readonly cleanups: Set<() => void>
}

interface RequestView<Response, Failure> {
  readonly key: RequestKey
  readonly route: RequestRoute
  readonly state: OpenRequestState['tag']
  readonly deadline: RequestDeadline
  readonly completion: Promise<RequestResult<Response, Failure>>
}

export class RequestTracker<Response, Failure> {
  private readonly records = new Map<string, RequestRecord<Response, Failure>>()

  constructor(private readonly options: { onError?: (error: unknown) => void } = {}) {}

  public get size(): number {
    return this.records.size
  }

  public admit(
    id: string,
    route: RequestRoute,
    settle: (result: RequestResult<Response, Failure>) => void
  ): RequestKey | undefined {
    if (this.records.has(id)) {
      return undefined
    }
    const key = Object.freeze({ id, instance: Symbol(id) })
    this.records.set(id, {
      key,
      route,
      state: {
        tag: route === 'Follower' ? 'ForwardedToLeader' : 'Dispatched',
        deadline: 'Disabled'
      },
      completion: new ExposedPromise<RequestResult<Response, Failure>>(),
      settle,
      cleanups: new Set()
    })

    return key
  }

  public get(id: string): RequestView<Response, Failure> | undefined {
    const record = this.records.get(id)
    if (!record || !('deadline' in record.state)) {
      return undefined
    }

    return {
      key: record.key,
      route: record.route,
      state: record.state.tag,
      deadline: record.state.deadline,
      completion: record.completion.promise
    }
  }

  public isCurrent(key: RequestKey): boolean {
    return this.current(key) !== undefined
  }

  public armDeadline(key: RequestKey, timeoutMs: number, error: Failure): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return
    }
    const record = this.advance(key, 'ArmDeadline')
    if (!record) {
      return
    }
    record.timer = setTimeout(() => {
      this.finish(key, 'Deadline', { tag: 'TimedOut', error })
    }, timeoutMs)
  }

  public acknowledge(key: RequestKey): boolean {
    const record = this.advance(key, 'Acknowledge')
    if (!record) {
      return false
    }
    this.detachTimer(record)

    return true
  }

  public beginPreparation(key: RequestKey): boolean {
    return this.advance(key, 'BeginPreparation') !== undefined
  }

  public resolve(key: RequestKey, response: Response): boolean {
    return this.finish(key, 'Resolve', { tag: 'Resolved', response })
  }

  public prepared(key: RequestKey, response: Response): boolean {
    return this.finish(key, 'Prepared', { tag: 'Resolved', response })
  }

  public reject(key: RequestKey, error: Failure): boolean {
    return this.finish(key, 'Reject', { tag: 'Rejected', error })
  }

  public preparationFailed(key: RequestKey, error: Failure): boolean {
    return this.finish(key, 'PreparationFailed', { tag: 'Rejected', error })
  }

  public abort(key: RequestKey, error: Failure): boolean {
    return this.finish(key, 'Abort', { tag: 'Aborted', error })
  }

  public abortAll(errorForKey: (key: RequestKey) => Failure): void {
    const keys = Array.from(this.records.values(), (record) => record.key)
    for (const key of keys) {
      this.abort(key, errorForKey(key))
    }
  }

  public attachCleanup(key: RequestKey, disposer: () => void): void {
    const record = this.current(key)
    if (record) {
      record.cleanups.add(disposer)
    } else {
      this.invoke(disposer)
    }
  }

  private current(key: RequestKey): RequestRecord<Response, Failure> | undefined {
    const record = this.records.get(key.id)

    return record?.key.instance === key.instance ? record : undefined
  }

  private advance(
    key: RequestKey,
    input: OpenRequestInput
  ): RequestRecord<Response, Failure> | undefined {
    const record = this.current(key)
    if (!record) {
      return undefined
    }
    const state = transitionRequest(record.state, input)
    if (!state) {
      return undefined
    }
    record.state = state

    return record
  }

  private finish(
    key: RequestKey,
    input: OpenRequestInput,
    result: RequestResult<Response, Failure>
  ): boolean {
    const record = this.advance(key, input)
    if (!record) {
      return false
    }

    // Remove ownership before cancellation or delivery can reenter the tracker.
    this.records.delete(key.id)
    this.detachTimer(record)
    const cleanups = Array.from(record.cleanups)
    record.cleanups.clear()
    for (const cleanup of cleanups) {
      this.invoke(cleanup)
    }
    record.completion.resolve(result)
    this.invoke(() => record.settle(result))

    return true
  }

  private detachTimer(record: RequestRecord<Response, Failure>): void {
    if (record.timer !== undefined) {
      clearTimeout(record.timer)
      record.timer = undefined
    }
  }

  private invoke(effect: () => void): void {
    try {
      effect()
    } catch (error) {
      try {
        this.options.onError?.(error)
      } catch {
        // Reporting failures cannot retain ownership or prevent settlement.
      }
    }
  }
}
