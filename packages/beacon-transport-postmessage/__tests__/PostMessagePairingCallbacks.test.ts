import { Logger, windowRef } from '@ecadlabs/beacon-core'
import {
  ExposedPromise,
  KeyPair,
  openCryptobox,
  secretbox_NONCEBYTES,
  secretbox_MACBYTES
} from '@ecadlabs/beacon-utils'
import { ExtensionMessageTarget } from '@ecadlabs/beacon-types'
import { PostMessageClient } from '../src/PostMessageClient'

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  windowRef: {
    addEventListener: vi.fn(),
    location: { origin: 'https://dapp.example' }
  },
  getSenderId: vi.fn().mockResolvedValue('beacon-sender-id')
}))

vi.mock('@ecadlabs/beacon-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-utils')>()),
  openCryptobox: vi.fn()
}))

const keyPair: KeyPair = {
  publicKey: new Uint8Array(32),
  secretKey: new Uint8Array(64)
}
const pairingResponse = {
  id: 'pairing-id',
  name: 'Wallet',
  publicKey: '00'.repeat(32),
  version: '2'
}
const openingEvent = () => ({
  source: windowRef,
  origin: windowRef.location.origin,
  data: {
    message: {
      target: ExtensionMessageTarget.PAGE,
      payload: 'aa'.repeat(secretbox_NONCEBYTES + secretbox_MACBYTES)
    },
    sender: { id: 'extension-id' }
  }
})

const dispatchMessage = async (): Promise<void> => {
  const listeners = vi
    .mocked(windowRef.addEventListener)
    .mock.calls.filter(([type]) => type === 'message')
    .map(([, listener]) => listener)
  expect(listeners).toHaveLength(2)
  const event = openingEvent()
  await Promise.all(listeners.map((listener) => listener(event)))
}

describe('PostMessageClient pairing callback failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(openCryptobox).mockResolvedValue(JSON.stringify(pairingResponse))
  })

  afterEach(() => vi.restoreAllMocks())

  it.each(['throw', 'reject'])(
    'logs a callback that fails by %s and handles the next message',
    async (mode) => {
      const client = new PostMessageClient('Dapp', keyPair)
      const error = new Error('Cannot save pairing peer')
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      const callback = vi.fn()
      if (mode === 'throw') {
        callback.mockImplementationOnce(() => {
          throw error
        })
      } else {
        callback.mockRejectedValueOnce(error)
      }
      await client.listenForChannelOpening(callback)

      await expect(dispatchMessage()).resolves.toBeUndefined()

      expect(callback).toHaveBeenCalledTimes(1)
      expect(logged).toHaveBeenCalledTimes(1)
      expect(logged).toHaveBeenCalledWith('listenForChannelOpening', error)

      await dispatchMessage()

      expect(callback).toHaveBeenCalledTimes(2)
      expect(logged).toHaveBeenCalledTimes(1)
    }
  )

  it('logs a callback rejection after asynchronous work before its handler settles', async () => {
    const client = new PostMessageClient('Dapp', keyPair)
    const entered = new ExposedPromise<void>()
    const completion = new ExposedPromise<void>()
    const error = new Error('Cannot finish saving pairing peer')
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const callback = vi.fn(async () => {
      entered.resolve()
      await completion.promise
      throw error
    })
    await client.listenForChannelOpening(callback)

    const dispatched = dispatchMessage()
    await entered.promise
    completion.resolve()
    await expect(dispatched).resolves.toBeUndefined()

    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith('listenForChannelOpening', error)
  })

  it.each(['cryptobox rejection', 'invalid JSON'])(
    'ignores %s without calling or blaming the callback',
    async (mode) => {
      const client = new PostMessageClient('Dapp', keyPair)
      const callback = vi.fn()
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      if (mode === 'cryptobox rejection') {
        vi.mocked(openCryptobox).mockRejectedValueOnce(new Error('Other recipient'))
      } else {
        vi.mocked(openCryptobox).mockResolvedValueOnce('invalid JSON')
      }
      await client.listenForChannelOpening(callback)

      await expect(dispatchMessage()).resolves.toBeUndefined()

      expect(callback).not.toHaveBeenCalled()
      expect(logged).not.toHaveBeenCalled()
    }
  )
})
