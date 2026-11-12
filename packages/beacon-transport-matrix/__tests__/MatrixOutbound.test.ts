/** @vitest-environment node */

import {
  defaultValues,
  Storage,
  StorageKey,
  StorageKeyReturnDefaults,
  StorageKeyReturnType
} from '@ecadlabs/beacon-types'
import { Logger } from '@ecadlabs/beacon-core'
import { MatrixClient } from '../src/matrix-client/MatrixClient'
import { MatrixClientStore } from '../src/matrix-client/MatrixClientStore'
import { MatrixClientEventEmitter } from '../src/matrix-client/MatrixClientEventEmitter'
import { MatrixHttpClient } from '../src/matrix-client/MatrixHttpClient'
import { MatrixEventService } from '../src/matrix-client/services/MatrixEventService'
import { MatrixRoomService } from '../src/matrix-client/services/MatrixRoomService'
import { MatrixUserService } from '../src/matrix-client/services/MatrixUserService'
import { MatrixMessageType } from '../src/matrix-client/models/MatrixMessage'

class TestStorage extends Storage {
  private readonly values: StorageKeyReturnDefaults = {
    ...defaultValues,
    [StorageKey.MATRIX_PRESERVED_STATE]: {}
  }

  public async get<K extends StorageKey>(key: K): Promise<StorageKeyReturnType[K]> {
    return this.values[key]
  }

  public async set<K extends StorageKey>(key: K, value: StorageKeyReturnType[K]): Promise<void> {
    this.values[key] = value
  }

  public async delete<K extends StorageKey>(key: K): Promise<void> {
    this.values[key] = defaultValues[key]
  }

  public async subscribeToStorageChanged(
    _callback: Parameters<Storage['subscribeToStorageChanged']>[0]
  ): Promise<void> {}

  public getPrefixedKey<K extends StorageKey>(key: K): string {
    return key
  }
}

const response = (eventId = '$event') =>
  new Response(JSON.stringify({ event_id: eventId }), { status: 200 })
const createServices = () => {
  const http = new MatrixHttpClient('https://matrix.example/')
  const events = new MatrixEventService(http)
  return { http, events }
}

const createClient = async (accessToken?: string) => {
  const { http, events } = createServices()
  const store = new MatrixClientStore(new TestStorage())
  await store.update({ accessToken })
  const client = new MatrixClient(
    store,
    new MatrixClientEventEmitter(),
    new MatrixUserService(http),
    new MatrixRoomService(http),
    events,
    http
  )
  vi.spyOn(client, 'isConnected').mockResolvedValue(undefined)
  return client
}

describe('Matrix outbound text body contract', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['message', '', 'Tezos 💚 Καλημέρα 你好'])(
    'sends flat text content without a wrapper: %s',
    async (body) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
      const { events } = createServices()

      await expect(
        events.sendMessage('token', '!room:id', { msgtype: MatrixMessageType.TEXT, body }, 'txn')
      ).resolves.toEqual({ event_id: '$event' })

      expect(fetchMock).toHaveBeenCalledWith(
        'https://matrix.example/_matrix/client/r0/rooms/!room%3Aid/send/m.room.message/txn',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ msgtype: 'm.text', body }),
          signal: expect.any(AbortSignal)
        }
      )
    }
  )

  it('encodes room and transaction identifiers while preserving the body bytes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
    const { events } = createServices()
    const body = 'text with \"quotes\" & / ?'

    await events.sendMessage(
      'access token',
      '!room /?#',
      { msgtype: MatrixMessageType.TEXT, body },
      'txn /?#'
    )

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://matrix.example/_matrix/client/r0/rooms/!room%20%2F%3F%23/send/m.room.message/txn%20%2F%3F%23'
    )
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ msgtype: 'm.text', body }))
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer access token'
    })
  })

  it('carries public client text sends through the actual service and HTTP client', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
    const client = await createClient('client-token')
    const bodies = ['first', '', '🚀 Unicode']

    await expect(
      Promise.all(bodies.map((body) => client.sendTextMessage('!room:id', body)))
    ).resolves.toEqual([undefined, undefined, undefined])

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.map(([, init]) => init?.body)).toEqual(
      bodies.map((body) => JSON.stringify({ msgtype: 'm.text', body }))
    )
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(new Set(urls).size).toBe(3)
    expect(
      urls.every((url) =>
        /^https:\/\/matrix\.example\/_matrix\/client\/r0\/rooms\/!room%3Aid\/send\/m\.room\.message\/m\d+\.\d+$/.test(
          url
        )
      )
    ).toBe(true)
  })

  it('requires authorization before making a public client HTTP send', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
    const client = await createClient()

    await expect(client.sendTextMessage('!room:id', 'message')).rejects.toBe(
      'send requires authorization but no access token has been provided.'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['success', 'error'] as const)(
    'reports rejected scheduled %s callbacks without invoking another outcome',
    async (outcome) => {
      const callbackFailure = new Error('consumer callback failed')
      const networkFailure = new Error('network failed')
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      if (outcome === 'success') fetchMock.mockResolvedValue(response())
      else fetchMock.mockRejectedValue(networkFailure)
      const warn = vi.spyOn(Logger.prototype, 'warn')
      const { events } = createServices()
      const onSuccess = vi.fn(async () => {
        if (outcome === 'success') throw callbackFailure
      })
      const onError = vi.fn(async () => {
        throw callbackFailure
      })

      events.scheduleEvent({
        accessToken: 'token',
        roomId: '!room:id',
        type: 'm.room.message',
        content: { msgtype: MatrixMessageType.TEXT, body: 'message' },
        txnId: 'callback-txn',
        onSuccess,
        onError
      })

      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          'scheduleEvent callback',
          '!room:id',
          'callback-txn',
          callbackFailure
        )
      )
      if (outcome === 'success') {
        expect(onSuccess).toHaveBeenCalledWith({ event_id: '$event' })
        expect(onError).not.toHaveBeenCalled()
      } else {
        expect(onSuccess).not.toHaveBeenCalled()
        expect(onError).toHaveBeenCalledWith(networkFailure)
      }
    }
  )

  it('preserves network error identity through the service', async () => {
    const failure = new Error('network failed')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure)
    const { events } = createServices()

    await expect(
      events.sendMessage(
        'token',
        '!room:id',
        { msgtype: MatrixMessageType.TEXT, body: 'message' },
        'txn'
      )
    ).rejects.toBe(failure)
  })

  it('preserves network error identity through the public client', async () => {
    const failure = new Error('client network failed')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure)
    const client = await createClient('client-token')

    await expect(client.sendTextMessage('!room:id', 'message')).rejects.toBe(failure)
  })

  it('forwards a server error payload to the caller', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'not allowed' }), {
        status: 403
      })
    )
    const { events } = createServices()

    await expect(
      events.sendMessage(
        'token',
        '!room:id',
        { msgtype: MatrixMessageType.TEXT, body: 'message' },
        'txn'
      )
    ).rejects.toEqual({ errcode: 'M_FORBIDDEN', error: 'not allowed' })
  })

  it('forwards the complete successful response without reconstructing it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ event_id: '$result', extra: { preserved: true } }), {
        status: 200
      })
    )
    const { events } = createServices()

    await expect(
      events.sendMessage(
        'token',
        '!room:id',
        { msgtype: MatrixMessageType.TEXT, body: 'message' },
        'txn'
      )
    ).resolves.toEqual({ event_id: '$result', extra: { preserved: true } })
  })

  it('does not resolve the scheduled send before the HTTP response arrives', async () => {
    let completeResponse: (value: Response) => void = () => {
      throw new Error('Response resolver was not installed')
    }
    const pendingResponse = new Promise<Response>((resolve) => {
      completeResponse = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockReturnValue(pendingResponse)
    const { events } = createServices()
    let settled = false
    const send = events
      .sendMessage('token', '!room:id', { msgtype: MatrixMessageType.TEXT, body: 'message' }, 'txn')
      .then((value) => {
        settled = true
        return value
      })

    await Promise.resolve()
    expect(settled).toBe(false)
    completeResponse(response())
    await expect(send).resolves.toEqual({ event_id: '$event' })
    expect(settled).toBe(true)
  })
})
