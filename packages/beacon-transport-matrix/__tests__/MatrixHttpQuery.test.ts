/** @jest-environment node */

import { MatrixHttpClient } from '../src/matrix-client/MatrixHttpClient'
import {
  MatrixSyncRequestParams,
  MatrixSyncResponse
} from '../src/matrix-client/models/api/MatrixSync'

describe('MatrixHttpClient sync query requests', () => {
  const response = { next_batch: 'next-sync', rooms: {} }
  let fetchMock: jest.SpyInstance<ReturnType<typeof fetch>, Parameters<typeof fetch>>

  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json(response))
  })

  afterEach(() => jest.restoreAllMocks())

  it('encodes defined query values and sends authentication with the existing GET request', async () => {
    const client = new MatrixHttpClient('https://matrix.example/')

    await expect(
      client.get<MatrixSyncResponse>(
        'sync',
        { timeout: 30000, since: 'a b&/?:+' },
        {
          accessToken: 'access-token'
        }
      )
    ).resolves.toEqual(response)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://matrix.example/_matrix/client/r0/sync?timeout=30000&since=a+b%26%2F%3F%3A%2B',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer access-token' },
        body: undefined,
        signal: expect.any(AbortSignal)
      }
    )
  })

  it('preserves zero timeout and an empty sync token', async () => {
    const client = new MatrixHttpClient('https://matrix.example')

    await client.get<MatrixSyncResponse>('/sync', { timeout: 0, since: '' })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://matrix.example/_matrix/client/r0/sync?timeout=0&since='
    )
  })

  it('preserves serialization of extra enumerable fields on a structurally compatible object', async () => {
    const client = new MatrixHttpClient('https://matrix.example')
    const params = {
      timeout: 5,
      since: 'last',
      full_state: false,
      omitted: undefined,
      optional_filter: null,
      custom_filter: { toString: () => '#tag?' }
    }

    await client.get<MatrixSyncResponse>('/sync', params)

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://matrix.example/_matrix/client/r0/sync?timeout=5&since=last&full_state=false&optional_filter=null&custom_filter=%23tag%3F'
    )
  })

  it('serializes an own enumerable prototype-named query field', async () => {
    const client = new MatrixHttpClient('https://matrix.example')
    const params: MatrixSyncRequestParams = { timeout: 1 }
    Object.defineProperty(params, '__proto__', {
      value: 'prototype filter',
      enumerable: true
    })

    await client.get<MatrixSyncResponse>('/sync', params)

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://matrix.example/_matrix/client/r0/sync?timeout=1&__proto__=prototype+filter'
    )
  })

  it('omits a query suffix when no parameters are supplied', async () => {
    const client = new MatrixHttpClient('https://matrix.example')

    await client.get<MatrixSyncResponse>('/sync')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://matrix.example/_matrix/client/r0/sync')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({})
  })

  it('omits undefined values from the URL', async () => {
    const client = new MatrixHttpClient('https://matrix.example')

    await client.get<MatrixSyncResponse>('/sync', { timeout: undefined, since: 'previous' })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://matrix.example/_matrix/client/r0/sync?since=previous'
    )
  })

  it('keeps explicitly undefined properties on the caller object', async () => {
    const client = new MatrixHttpClient('https://matrix.example')
    const params: MatrixSyncRequestParams = { timeout: undefined, since: 'previous' }

    await client.get<MatrixSyncResponse>('/sync', params)

    expect(params).toStrictEqual({ timeout: undefined, since: 'previous' })
  })

  it('accepts frozen parameters containing an undefined property', async () => {
    const client = new MatrixHttpClient('https://matrix.example')
    const params = Object.freeze({ timeout: undefined, since: 'frozen-sync' })

    await expect(client.get<MatrixSyncResponse>('/sync', params)).resolves.toEqual(response)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://matrix.example/_matrix/client/r0/sync?since=frozen-sync'
    )
    expect(params).toStrictEqual({ timeout: undefined, since: 'frozen-sync' })
  })

  it('reuses a caller object across requests without deleting its own keys', async () => {
    const client = new MatrixHttpClient('https://matrix.example')
    const params: MatrixSyncRequestParams = { timeout: undefined, since: 'first' }

    await client.get<MatrixSyncResponse>('/sync', params)
    params.since = 'second'
    await client.get<MatrixSyncResponse>('/sync', params)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://matrix.example/_matrix/client/r0/sync?since=first',
      'https://matrix.example/_matrix/client/r0/sync?since=second'
    ])
    expect(params).toStrictEqual({ timeout: undefined, since: 'second' })
  })

  it('does not add a query suffix for an object containing only undefined values', async () => {
    const client = new MatrixHttpClient('https://matrix.example')

    await client.get<MatrixSyncResponse>('/sync', { timeout: undefined, since: undefined })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://matrix.example/_matrix/client/r0/sync')
  })

  it('forwards a server error body unchanged through the existing rejection policy', async () => {
    const client = new MatrixHttpClient('https://matrix.example')
    const failure = { errcode: 'M_FORBIDDEN', error: 'Access denied' }
    fetchMock.mockResolvedValueOnce(Response.json(failure, { status: 403 }))

    await expect(client.get<MatrixSyncResponse>('/sync', { since: 'last' })).rejects.toEqual(
      failure
    )
  })

  it('preserves the exact fetch rejection', async () => {
    const client = new MatrixHttpClient('https://matrix.example')
    const failure = new Error('Connection failed')
    fetchMock.mockRejectedValueOnce(failure)

    await expect(client.get<MatrixSyncResponse>('/sync', { timeout: 1 })).rejects.toBe(failure)
  })

  it('aborts issued requests with a native AbortError', async () => {
    const client = new MatrixHttpClient('https://matrix.example')
    await client.get<MatrixSyncResponse>('/sync', { timeout: 1 })
    const signal = fetchMock.mock.calls[0]?.[1]?.signal

    expect(signal?.aborted).toBe(false)
    await client.cancelAllRequests()

    expect(signal?.aborted).toBe(true)
    expect(signal?.reason).toBeInstanceOf(DOMException)
    expect(signal?.reason.name).toBe('AbortError')
  })

  it('rejects with AbortError when cancelled after headers while reading the body', async () => {
    const client = new MatrixHttpClient('https://matrix.example')
    let bodyReadStarted!: () => void
    const readingBody = new Promise<void>((resolve) => {
      bodyReadStarted = resolve
    })
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        }
      })
      const pendingResponse = new Response(body)
      const readText = pendingResponse.text.bind(pendingResponse)
      jest.spyOn(pendingResponse, 'text').mockImplementation(() => {
        const pendingText = readText()
        bodyReadStarted()
        return pendingText
      })
      return pendingResponse
    })

    const request = client.get<MatrixSyncResponse>('/sync')
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await readingBody
    await client.cancelAllRequests()
    await rejection
    await expect(client.get<MatrixSyncResponse>('/sync')).resolves.toEqual(response)
    expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(false)
  })

  it('allows subsequent requests after repeated cancellations', async () => {
    const client = new MatrixHttpClient('https://matrix.example')
    fetchMock.mockImplementation(async (_url, init) => {
      init?.signal?.throwIfAborted()
      return Response.json(response)
    })

    for (let attempt = 0; attempt < 2; attempt++) {
      await client.cancelAllRequests()
      await expect(client.get<MatrixSyncResponse>('/sync')).resolves.toEqual(response)
    }
  })
})
