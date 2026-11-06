import { getSenderId, Logger, windowRef } from '@ecadlabs/beacon-core'
import {
  ExposedPromise,
  KeyPair,
  openCryptobox,
  secretbox_NONCEBYTES,
  secretbox_MACBYTES
} from '@ecadlabs/beacon-utils'
import { ExtensionMessageTarget, Origin } from '@ecadlabs/beacon-types'
import { PostMessageClient } from '../src/PostMessageClient'

vi.mock('@ecadlabs/beacon-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-core')>()),
  windowRef: {
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    location: { origin: 'https://dapp.example' }
  },
  getSenderId: vi.fn().mockResolvedValue('beacon-sender-id')
}))

vi.mock('@ecadlabs/beacon-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecadlabs/beacon-utils')>()),
  openCryptobox: vi.fn()
}))

class TestClient extends PostMessageClient {
  readonly decrypt = vi
    .fn<(...args: [string, string]) => Promise<string>>()
    .mockResolvedValue('plaintext')

  protected override async decryptMessage(
    senderPublicKey: string,
    payload: string
  ): Promise<string> {
    return this.decrypt(senderPublicKey, payload)
  }
}

const keyPair: KeyPair = {
  publicKey: new Uint8Array(32),
  secretKey: new Uint8Array(64)
}
const minimumPairingPayloadBytes = secretbox_NONCEBYTES + secretbox_MACBYTES
const pairingPayload = 'aa'.repeat(minimumPairingPayloadBytes)
const pairingResponse = {
  id: 'pairing-id',
  name: 'Wallet',
  publicKey: '00'.repeat(32),
  version: '2'
}

const encryptedEvent = (includeTargetId = true) => ({
  source: windowRef,
  origin: windowRef.location.origin,
  data: {
    message: {
      target: ExtensionMessageTarget.PAGE,
      ...(includeTargetId ? { targetId: 'sdk-instance' } : {}),
      encryptedPayload: 'ciphertext'
    },
    sender: { id: 'extension-id' }
  }
})

const openingEvent = (includeTargetId = true) => ({
  source: windowRef,
  origin: windowRef.location.origin,
  data: {
    message: {
      target: ExtensionMessageTarget.PAGE,
      ...(includeTargetId ? { targetId: 'sdk-instance' } : {}),
      payload: pairingPayload
    },
    sender: { id: 'extension-id' }
  }
})

const dispatchMessage = async (event: unknown): Promise<void> => {
  const listeners = vi
    .mocked(windowRef.addEventListener)
    .mock.calls.filter(([name]) => name === 'message')
    .map(([, listener]) => listener)
  if (listeners.length === 0) {
    throw new Error('Expected the public API to register a message listener')
  }

  const operations = listeners.map((listener) => {
    try {
      return Promise.resolve(listener(event))
    } catch (error) {
      return Promise.reject(error)
    }
  })
  await Promise.all(operations)
}

describe('PostMessageClient inbound envelopes', () => {
  let client: TestClient

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(openCryptobox).mockResolvedValue(JSON.stringify(pairingResponse))
    client = new TestClient('Dapp', keyPair)
  })

  it.each([
    { sender: { id: 'extension-id' }, expectedId: 'extension-id' },
    { sender: {}, expectedId: '' }
  ])('forwards encrypted messages with sender $expectedId', async ({ sender, expectedId }) => {
    const notification = new ExposedPromise<void>()
    const callback = vi.fn(() => notification.resolve())
    await client.listenForEncryptedMessage('peer-public-key', callback)
    const openingCallback = vi.fn()
    await client.listenForChannelOpening(openingCallback)
    const event = {
      ...encryptedEvent(),
      data: { ...encryptedEvent().data, sender }
    }

    await dispatchMessage(event)
    await notification.promise

    expect(openCryptobox).not.toHaveBeenCalled()
    expect(openingCallback).not.toHaveBeenCalled()
    expect(client.decrypt).toHaveBeenCalledWith('peer-public-key', 'ciphertext')
    expect(callback).toHaveBeenCalledWith('plaintext', {
      origin: Origin.EXTENSION,
      id: expectedId
    })
  })

  it.each([
    { name: 'undefined event', make: () => undefined },
    { name: 'null event', make: () => null },
    {
      name: 'untrusted source',
      make: () => ({ ...encryptedEvent(), source: {} })
    },
    {
      name: 'untrusted origin',
      make: () => ({ ...encryptedEvent(), origin: 'https://other.example' })
    },
    {
      name: 'missing data',
      make: () => ({ ...encryptedEvent(), data: undefined })
    },
    { name: 'array data', make: () => ({ ...encryptedEvent(), data: [] }) },
    {
      name: 'extension target',
      make: () => ({
        ...encryptedEvent(),
        data: {
          ...encryptedEvent().data,
          message: {
            target: ExtensionMessageTarget.EXTENSION,
            encryptedPayload: 'ciphertext'
          }
        }
      })
    },
    {
      name: 'numeric encrypted payload',
      make: () => ({
        ...encryptedEvent(),
        data: {
          ...encryptedEvent().data,
          message: {
            target: ExtensionMessageTarget.PAGE,
            encryptedPayload: 42
          }
        }
      })
    },
    {
      name: 'missing sender',
      make: () => ({
        ...encryptedEvent(),
        data: { ...encryptedEvent().data, sender: undefined }
      })
    },
    {
      name: 'array sender',
      make: () => ({
        ...encryptedEvent(),
        data: { ...encryptedEvent().data, sender: [] }
      })
    },
    {
      name: 'numeric target id',
      make: () => ({
        ...encryptedEvent(),
        data: {
          ...encryptedEvent().data,
          message: { ...encryptedEvent().data.message, targetId: 42 }
        }
      })
    },
    {
      name: 'numeric sender id',
      make: () => ({
        ...encryptedEvent(),
        data: { ...encryptedEvent().data, sender: { id: 42 } }
      })
    },
    ...[
      { name: 'undefined message', message: undefined },
      { name: 'null message', message: null },
      { name: 'array message', message: [] },
      {
        name: 'missing encrypted payload property',
        message: { target: ExtensionMessageTarget.PAGE }
      }
    ].map(({ name, message }) => ({
      name,
      make: () => ({ ...encryptedEvent(), data: { ...encryptedEvent().data, message } })
    })),
    {
      name: 'null sender',
      make: () => ({ ...encryptedEvent(), data: { ...encryptedEvent().data, sender: null } })
    }
  ])('ignores encrypted input with $name before decryption', async ({ make }) => {
    const callback = vi.fn()
    const openingCallback = vi.fn()
    await client.listenForEncryptedMessage('peer-public-key', callback)
    await client.listenForChannelOpening(openingCallback)

    await expect(Promise.resolve().then(() => dispatchMessage(make()))).resolves.toBeUndefined()

    expect(client.decrypt).not.toHaveBeenCalled()
    expect(openCryptobox).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
    expect(openingCallback).not.toHaveBeenCalled()
  })

  it('delivers a channel opening at the production minimum with its extension identity', async () => {
    const callback = vi.fn()
    await client.listenForChannelOpening(callback)
    const encryptedCallback = vi.fn()
    await client.listenForEncryptedMessage('peer-public-key', encryptedCallback)

    await dispatchMessage(openingEvent())

    expect(client.decrypt).not.toHaveBeenCalled()
    expect(encryptedCallback).not.toHaveBeenCalled()

    expect(openCryptobox).toHaveBeenCalledWith(
      Buffer.from(pairingPayload, 'hex'),
      keyPair.publicKey,
      keyPair.secretKey
    )
    expect(getSenderId).toHaveBeenCalledWith(pairingResponse.publicKey)
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        ...pairingResponse,
        extensionId: 'extension-id',
        senderId: 'beacon-sender-id'
      })
    )
  })

  it.each([
    { name: 'null event', make: () => null },
    {
      name: 'missing data',
      make: () => ({ ...openingEvent(), data: undefined })
    },
    {
      name: 'untrusted source',
      make: () => ({ ...openingEvent(), source: {} })
    },
    {
      name: 'untrusted origin',
      make: () => ({ ...openingEvent(), origin: 'https://other.example' })
    },
    {
      name: 'extension target',
      make: () => ({
        ...openingEvent(),
        data: {
          ...openingEvent().data,
          message: {
            target: ExtensionMessageTarget.EXTENSION,
            payload: pairingPayload
          }
        }
      })
    },
    {
      name: 'numeric payload',
      make: () => ({
        ...openingEvent(),
        data: {
          ...openingEvent().data,
          message: { target: ExtensionMessageTarget.PAGE, payload: 42 }
        }
      })
    },
    {
      name: 'missing sender',
      make: () => ({
        ...openingEvent(),
        data: { ...openingEvent().data, sender: undefined }
      })
    },
    {
      name: 'missing sender id',
      make: () => ({
        ...openingEvent(),
        data: { ...openingEvent().data, sender: {} }
      })
    },
    {
      name: 'numeric target id',
      make: () => ({
        ...openingEvent(),
        data: {
          ...openingEvent().data,
          message: { ...openingEvent().data.message, targetId: 42 }
        }
      })
    },
    {
      name: 'numeric sender id',
      make: () => ({
        ...openingEvent(),
        data: { ...openingEvent().data, sender: { id: 42 } }
      })
    },
    ...[
      { name: 'undefined message', message: undefined },
      { name: 'null message', message: null },
      { name: 'array message', message: [] },
      { name: 'missing payload property', message: { target: ExtensionMessageTarget.PAGE } }
    ].map(({ name, message }) => ({
      name,
      make: () => ({ ...openingEvent(), data: { ...openingEvent().data, message } })
    })),
    {
      name: 'null sender',
      make: () => ({ ...openingEvent(), data: { ...openingEvent().data, sender: null } })
    }
  ])('ignores channel opening input with $name before cryptography', async ({ make }) => {
    const callback = vi.fn()
    const encryptedCallback = vi.fn()
    await client.listenForChannelOpening(callback)
    await client.listenForEncryptedMessage('peer-public-key', encryptedCallback)

    await expect(Promise.resolve().then(() => dispatchMessage(make()))).resolves.toBeUndefined()

    expect(openCryptobox).not.toHaveBeenCalled()
    expect(client.decrypt).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
    expect(encryptedCallback).not.toHaveBeenCalled()
  })

  it('delivers encrypted messages without a targetId', async () => {
    const notification = new ExposedPromise<void>()
    const callback = vi.fn(() => notification.resolve())
    const openingCallback = vi.fn()
    await client.listenForEncryptedMessage('peer-public-key', callback)
    await client.listenForChannelOpening(openingCallback)
    const event = encryptedEvent(false)

    expect(event.data.message).not.toHaveProperty('targetId')
    await dispatchMessage(event)
    await notification.promise

    expect(callback).toHaveBeenCalledWith('plaintext', {
      origin: Origin.EXTENSION,
      id: 'extension-id'
    })
    expect(openCryptobox).not.toHaveBeenCalled()
    expect(openingCallback).not.toHaveBeenCalled()
  })

  it('delivers channel openings without a targetId', async () => {
    const callback = vi.fn()
    const encryptedCallback = vi.fn()
    await client.listenForChannelOpening(callback)
    await client.listenForEncryptedMessage('peer-public-key', encryptedCallback)
    const event = openingEvent(false)

    expect(event.data.message).not.toHaveProperty('targetId')
    await dispatchMessage(event)

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        ...pairingResponse,
        extensionId: 'extension-id'
      })
    )
    expect(client.decrypt).not.toHaveBeenCalled()
    expect(encryptedCallback).not.toHaveBeenCalled()
  })

  it('rejects a pairing payload one byte below the production length precheck', async () => {
    const callback = vi.fn()
    await client.listenForChannelOpening(callback)
    const event = openingEvent()
    event.data.message.payload = 'aa'.repeat(minimumPairingPayloadBytes - 1)

    await dispatchMessage(event)

    expect(openCryptobox).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
  })

  it('logs a rejected encrypted callback and still delivers to another peer', async () => {
    const failure = new Error('consumer rejected the message')
    const logged = new ExposedPromise<void>()
    const delivered = new ExposedPromise<void>()
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => logged.resolve())
    const rejectedCallback = vi.fn(async () => {
      throw failure
    })
    const healthyCallback = vi.fn(() => delivered.resolve())
    await client.listenForEncryptedMessage('rejecting-peer', rejectedCallback)
    await client.listenForEncryptedMessage('healthy-peer', healthyCallback)
    await client.listenForChannelOpening(vi.fn())

    try {
      await dispatchMessage(encryptedEvent())
      await Promise.all([logged.promise, delivered.promise])

      expect(error).toHaveBeenCalledWith('subscribeToMessages', failure)
      expect(rejectedCallback).toHaveBeenCalledTimes(1)
      expect(healthyCallback).toHaveBeenCalledWith('plaintext', {
        origin: Origin.EXTENSION,
        id: 'extension-id'
      })
      expect(openCryptobox).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it.each([
    { name: 'null', value: null, expected: false },
    { name: 'primitive', value: 17, expected: false },
    {
      name: 'shadowed method and numeric payload',
      value: { payload: 17, hasOwnProperty: null },
      expected: true
    },
    {
      name: 'null-prototype own payload',
      value: Object.assign(Object.create(null), { payload: 'ciphertext' }),
      expected: true
    },
    {
      name: 'inherited payload',
      value: Object.create({ payload: 'ciphertext' }),
      expected: false
    },
    {
      name: 'array with own payload',
      value: Object.assign([], { payload: 17 }),
      expected: true
    }
  ])('recognizes only own payload presence for $name', async ({ value, expected }) => {
    await expect(client.isChannelOpenMessage(value)).resolves.toBe(expected)
  })

  it('captures validated pairing payload and identity before the asynchronous recognition step', async () => {
    const callback = vi.fn()
    await client.listenForChannelOpening(callback)
    const event = openingEvent()

    const operation = dispatchMessage(event)
    event.data.message.payload = 'bb'.repeat(minimumPairingPayloadBytes)
    event.data.sender.id = 'changed-after-dispatch'
    await operation

    expect(openCryptobox).toHaveBeenCalledWith(
      Buffer.from(pairingPayload, 'hex'),
      keyPair.publicKey,
      keyPair.secretKey
    )
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ extensionId: 'extension-id' }))
  })
})
