/** @vitest-environment node */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MatrixHttpClient } from '../../src/matrix-client/MatrixHttpClient'

const within = async <T>(operation: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Local HTTP regression timed out')), 5000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

it('cancels real in-flight requests with AbortError and supports the next request', async () => {
  let ready!: () => void
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  let held = 0
  let respond = false
  const server = createServer((_request, response) => {
    if (!respond) {
      held += 1
      if (held === 2) ready()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ recovered: true }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const client = new MatrixHttpClient(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    )
    const one = client.get('/held-one').catch((error) => error)
    const two = client.get('/held-two').catch((error) => error)
    await within(started)
    await client.cancelAllRequests()
    for (const error of await within(Promise.all([one, two]))) {
      expect(error).toEqual(expect.objectContaining({ name: 'AbortError' }))
    }
    respond = true
    await expect(within(client.get('/next'))).resolves.toEqual({ recovered: true })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 10000)
