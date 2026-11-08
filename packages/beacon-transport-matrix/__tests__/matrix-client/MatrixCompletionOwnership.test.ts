import { setImmediate } from 'node:timers/promises'
import { LocalStorage } from '@ecadlabs/beacon-core'
import { ExposedPromise } from '@ecadlabs/beacon-utils'
import { MatrixClient } from '../../src/matrix-client/MatrixClient'
import { MatrixEventService } from '../../src/matrix-client/services/MatrixEventService'
import { MatrixUserService } from '../../src/matrix-client/services/MatrixUserService'

const user = { id: 'sdk', password: 'password', deviceId: 'device' }
const loginResponse = { user_id: '@sdk:relay.example', device_id: 'device', access_token: 'token' }

type Outcome =
  { status: 'pending' } | { status: 'resolved' } | { status: 'rejected'; reason: unknown }

function observe(promise: Promise<unknown>) {
  let outcome: Outcome = { status: 'pending' }
  const settled = promise.then(
    () => {
      outcome = { status: 'resolved' }
    },
    (reason: unknown) => {
      outcome = { status: 'rejected', reason }
    }
  )
  return {
    settled,
    get outcome(): Outcome {
      return outcome
    }
  }
}

function readinessWaiters(client: MatrixClient) {
  return [client.isConnected(), client.joinedRooms, client.invitedRooms, client.leftRooms].map(
    observe
  )
}

describe('Matrix readiness completion ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    localStorage.clear()
  })

  function setup() {
    const client = MatrixClient.create({
      baseUrl: 'https://relay.example',
      storage: new LocalStorage('matrix-completion-ownership')
    })
    const login = vi.spyOn(MatrixUserService.prototype, 'login').mockResolvedValue(loginResponse)
    const sync = vi.spyOn(MatrixEventService.prototype, 'sync').mockResolvedValue({
      next_batch: 'current-sync',
      rooms: {}
    })
    return { client, login, sync }
  }

  it.each(['login', 'initial sync'])(
    'rejects captured readiness and room waiters when %s fails',
    async (boundary) => {
      const { client, login, sync } = setup()
      const entered = new ExposedPromise<void>()
      const release = new ExposedPromise<void>()
      const failure = new Error(`${boundary} unavailable`)
      const fail = async (): Promise<never> => {
        entered.resolve()
        await release.promise
        throw failure
      }
      if (boundary === 'login') login.mockImplementationOnce(fail)
      else sync.mockImplementationOnce(fail)
      const waiters = readinessWaiters(client)
      const starting = observe(client.start(user))
      await entered.promise
      try {
        await setImmediate()
        expect(waiters.map((waiter) => waiter.outcome.status)).toEqual([
          'pending',
          'pending',
          'pending',
          'pending'
        ])
        release.resolve()
        await starting.settled
        await setImmediate()

        expect(starting.outcome).toEqual({ status: 'rejected', reason: failure })
        expect(waiters.map((waiter) => waiter.outcome)).toEqual(
          Array.from({ length: 4 }, () => ({ status: 'rejected', reason: failure }))
        )
      } finally {
        release.resolve()
        await starting.settled
        await client.stop()
      }
    }
  )

  it('settles stopped readiness before late login while a restart gets fresh completion', async () => {
    const { client, login } = setup()
    const entered = new ExposedPromise<void>()
    const release = new ExposedPromise<void>()
    login.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return { ...loginResponse, access_token: 'previous-token' }
    })
    const waiters = readinessWaiters(client)
    const starting = observe(client.start(user))
    await entered.promise
    try {
      await client.stop()
      await starting.settled
      await setImmediate()
      const stoppedOutcomes = waiters.map((waiter) => waiter.outcome)
      const replacement = readinessWaiters(client)
      await client.start(user)
      await Promise.all(replacement.map((waiter) => waiter.settled))
      release.resolve()
      await setImmediate()

      expect(starting.outcome).toMatchObject({
        status: 'rejected',
        reason: { name: 'AbortError' }
      })
      expect(stoppedOutcomes).toMatchObject(
        Array.from({ length: 4 }, () => ({ status: 'rejected', reason: { name: 'AbortError' } }))
      )
      expect(waiters.map((waiter) => waiter.outcome)).toEqual(stoppedOutcomes)
      expect(replacement.map((waiter) => waiter.outcome)).toEqual(
        Array.from({ length: 4 }, () => ({ status: 'resolved' }))
      )
      expect(login).toHaveBeenCalledTimes(2)
    } finally {
      release.resolve()
      await starting.settled
      await client.stop()
    }
  })
})
