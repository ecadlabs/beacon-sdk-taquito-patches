import type { Mock } from 'vitest'
// __tests__/communication-client/PostMessageClient.test.ts

import { windowRef, Serializer } from '@ecadlabs/beacon-core'
import { openCryptobox, secretbox_NONCEBYTES, secretbox_MACBYTES } from '@ecadlabs/beacon-utils'
import {
  ExtensionMessageTarget,
  Origin,
  ExtendedPostMessagePairingResponse
} from '@ecadlabs/beacon-types'
import { PostMessageClient } from '../src/PostMessageClient'

// --- 1) Mocks for @ecadlabs/beacon-core ---
vi.mock('@ecadlabs/beacon-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecadlabs/beacon-core')>()

  const windowRef = {
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    location: { origin: 'http://test-origin' }
  }

  const Serializer = vi.fn().mockImplementation(function () {
    return {
      serialize: vi.fn().mockResolvedValue('serialized-payload'),
      deserialize: vi.fn().mockResolvedValue({ senderId: 'sender-id' })
    }
  })

  const getSenderId = vi.fn().mockResolvedValue('sender-id')

  class MessageBasedClient {
    public keyPair: any
    protected getKeyPair() {
      return this.keyPair
    }
    async getPairingRequestInfo() {
      return { id: 'id1' }
    }
    constructor(_name: string, keyPair: any) {
      this.keyPair = keyPair
    }
  }

  return {
    ...actual,
    windowRef,
    Serializer,
    getSenderId,
    MessageBasedClient
  }
})

// --- 2) Mocks for @ecadlabs/beacon-utils ---
vi.mock('@ecadlabs/beacon-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecadlabs/beacon-utils')>()
  return {
    ...actual,
    openCryptobox: vi.fn(),
    secretbox_NONCEBYTES: 8,
    secretbox_MACBYTES: 16
  }
})

describe('PostMessageClient', () => {
  let client: any // PostMessageClient
  const fakeKeyPair: any = { publicKey: 'pub', secretKey: 'sec' }

  beforeEach(() => {
    vi.clearAllMocks()
    client = new PostMessageClient('my-app', fakeKeyPair)
  })

  describe('init()', () => {
    it('registers a message listener', async () => {
      await client.init()
      expect(windowRef.addEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    })
  })

  describe('listenForEncryptedMessage()', () => {
    it('adds a listener and calls back when decrypt succeeds', async () => {
      const cb = vi.fn()
      client.decryptMessage = vi.fn().mockResolvedValue('decrypted-text')

      await client.listenForEncryptedMessage('sender-pub', cb)
      expect((client as any).activeListeners.has('sender-pub')).toBe(true)

      const listener = (client as any).activeListeners.get('sender-pub')!
      await listener({ encryptedPayload: 'payload' }, { origin: Origin.EXTENSION, id: 'ctx' })

      expect(client.decryptMessage).toHaveBeenCalledWith('sender-pub', 'payload')
      expect(cb).toHaveBeenCalledWith('decrypted-text', { origin: Origin.EXTENSION, id: 'ctx' })
    })

    it('rejects an encrypted message claiming another sender', async () => {
      const cb = vi.fn()
      client.decryptMessage = vi.fn().mockResolvedValue('decrypted-text')
      ;(Serializer as Mock).mockImplementationOnce(function () {
        return {
          deserialize: vi.fn().mockResolvedValue({ senderId: 'mismatched-sender' })
        }
      })
      await client.listenForEncryptedMessage('sender-pub', cb)
      await client.activeListeners.get('sender-pub')(
        { encryptedPayload: 'payload' },
        { origin: Origin.EXTENSION, id: 'ctx' }
      )
      expect(cb).not.toHaveBeenCalled()
    })

    it('does not register the same listener twice', async () => {
      const cb = vi.fn()
      client.decryptMessage = vi.fn().mockResolvedValue('x')

      await client.listenForEncryptedMessage('sender-pub', cb)
      await client.listenForEncryptedMessage('sender-pub', cb)

      expect((client as any).activeListeners.size).toBe(1)
    })

    it('silently ignores decryption errors', async () => {
      const cb = vi.fn()
      client.decryptMessage = vi.fn().mockRejectedValue(new Error('fail'))

      await client.listenForEncryptedMessage('sender-pub', cb)
      const listener = (client as any).activeListeners.get('sender-pub')!
      await listener({ encryptedPayload: 'bad' }, { origin: Origin.EXTENSION, id: 'ctx' })

      expect(cb).not.toHaveBeenCalled()
    })
  })

  it('propagates an asynchronous message handler failure after decryption', async () => {
    client.decryptMessage = vi.fn().mockResolvedValue('decrypted-text')
    const handler = vi.fn().mockRejectedValue(new Error('handler failed'))
    await client.listenForEncryptedMessage('sender-pub', handler)
    const listener = (client as any).activeListeners.get('sender-pub')!

    await expect(
      listener({ encryptedPayload: 'payload' }, { origin: Origin.EXTENSION, id: 'ctx' })
    ).rejects.toThrow('handler failed')
  })

  describe('sendMessage()', () => {
    beforeEach(() => {
      client.encryptMessage = vi.fn().mockResolvedValue('enc-payload')
    })

    it('encrypts and posts with extensionId', async () => {
      const peer = { publicKey: 'peer-pub', extensionId: 'ext-1' } as any
      await client.sendMessage('hello', peer)

      expect(client.encryptMessage).toHaveBeenCalledWith('peer-pub', 'hello')
      expect(windowRef.postMessage).toHaveBeenCalledWith(
        {
          target: ExtensionMessageTarget.EXTENSION,
          encryptedPayload: 'enc-payload',
          targetId: 'ext-1'
        },
        windowRef.location.origin
      )
    })

    it('encrypts and posts without extensionId', async () => {
      const peer = { publicKey: 'peer-pub' } as any
      await client.sendMessage('world', peer)

      expect(windowRef.postMessage).toHaveBeenCalledWith(
        {
          target: ExtensionMessageTarget.EXTENSION,
          encryptedPayload: 'enc-payload',
          targetId: undefined
        },
        windowRef.location.origin
      )
    })
  })

  describe('listenForChannelOpening()', () => {
    it('registers a message listener', async () => {
      const cb = vi.fn()
      await client.getPairingRequestInfo()
      await client.listenForChannelOpening(cb)
      expect(windowRef.addEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    })

    it('deduplicates repeated channel-opening registrations', async () => {
      const pairingClient = new PostMessageClient('pairing', {
        publicKey: new Uint8Array(32), secretKey: new Uint8Array(64)
      })
      const callback = vi.fn()
      await pairingClient.listenForChannelOpening(callback)
      await pairingClient.listenForChannelOpening(callback)
      expect(windowRef.addEventListener).toHaveBeenCalledTimes(1)
    })

    it('decrypts a valid channel-open event and calls back', async () => {
      await client.getPairingRequestInfo()
      const raw = { id: 'id1', name: 'n', publicKey: '11'.repeat(32), version: 'v' }
      ;(openCryptobox as Mock).mockResolvedValueOnce(JSON.stringify(raw))

      const cb = vi.fn()
      await client.listenForChannelOpening(cb)

      const listener = (windowRef.addEventListener as Mock).mock.calls.find(
        ([e]) => e === 'message'
      )![1] as (e: any) => Promise<void>

      const payloadHex = Buffer.alloc(secretbox_NONCEBYTES + secretbox_MACBYTES).toString('hex')
      const fakeEvent = {
        source: windowRef,
        origin: windowRef.location.origin,
        data: {
          message: { target: ExtensionMessageTarget.PAGE, payload: payloadHex },
          sender: { id: 'sender-ext' }
        }
      }

      await listener(fakeEvent)

      expect(openCryptobox).toHaveBeenCalledWith(Buffer.from(payloadHex, 'hex'), 'pub', 'sec')

      expect(cb).toHaveBeenCalledTimes(1)
      const resp = cb.mock.calls[0][0] as ExtendedPostMessagePairingResponse
      expect(resp.id).toBe('id1')
      expect(resp.name).toBe('n')
      expect(resp.publicKey).toBe('11'.repeat(32))
      expect(resp.version).toBe('v')
      expect(resp.senderId).toBe('sender-id')
      expect(resp.extensionId).toBe('sender-ext')
    })

    it('ignores events from the wrong source or origin', async () => {
      const cb = vi.fn()
      await client.listenForChannelOpening(cb)
      const listener = (windowRef.addEventListener as Mock).mock.calls.find(
        ([e]) => e === 'message'
      )![1] as (e: any) => Promise<void>

      await listener({ source: {}, origin: windowRef.location.origin, data: {} })
      await listener({ source: windowRef, origin: 'bad', data: {} })

      expect(openCryptobox).not.toHaveBeenCalled()
      expect(cb).not.toHaveBeenCalled()
    })

    it('rejects non-hex or odd-length hex channel-open payloads without calling openCryptobox', async () => {
      await client.getPairingRequestInfo()
      const cb = vi.fn()
      await client.listenForChannelOpening(cb)
      const listener = (windowRef.addEventListener as Mock).mock.calls.find(
        ([e]) => e === 'message'
      )![1] as (e: any) => Promise<void>

      const validHexPrefixWithNonHexSuffix = `${Buffer.alloc(
        secretbox_NONCEBYTES + secretbox_MACBYTES
      ).toString('hex')}zz`
      for (const badPayload of [
        'zz'.repeat(32),
        'a'.repeat(49),
        '',
        validHexPrefixWithNonHexSuffix
      ]) {
        await listener({
          source: windowRef,
          origin: windowRef.location.origin,
          data: {
            message: { target: ExtensionMessageTarget.PAGE, payload: badPayload },
            sender: { id: 'sender-ext' }
          }
        })
      }

      expect(openCryptobox).not.toHaveBeenCalled()
      expect(cb).not.toHaveBeenCalled()
    })
  })

  describe('sendPairingRequest()', () => {
    it('serializes the pairing request and posts it', async () => {
      ;(client.getPairingRequestInfo as Mock) = vi.fn().mockResolvedValue({ foo: 'bar' })
      ;(Serializer as Mock).mockImplementationOnce(function () {
        return {
          serialize: vi.fn().mockResolvedValue('ser-payload')
        }
      })

      await client.sendPairingRequest('ext-id')

      expect((Serializer as Mock).mock.results[0].value.serialize).toHaveBeenCalledWith({
        foo: 'bar'
      })
      expect(windowRef.postMessage).toHaveBeenCalledWith(
        {
          target: ExtensionMessageTarget.EXTENSION,
          payload: 'ser-payload',
          targetId: 'ext-id'
        },
        windowRef.location.origin
      )
    })
  })

  describe('isChannelOpenMessage()', () => {
    it('returns true for objects with a payload key', async () => {
      await expect(client.isChannelOpenMessage({ payload: 'x' })).resolves.toBe(true)
      await expect(client.isChannelOpenMessage({ foo: 'bar' })).resolves.toBe(false)
    })
  })
})
