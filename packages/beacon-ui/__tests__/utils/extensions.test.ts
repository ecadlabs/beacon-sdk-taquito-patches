import type { Mock } from 'vitest'
import { ExtensionMessageTarget } from '@ecadlabs/beacon-types'

type MessageHandler = (event: unknown) => void

interface LoadedExtensionsUtil {
  getAvailableExtensions: () => Promise<unknown[]>
  mockAddEventListener: Mock
  mockPostMessage: Mock
  mockWindowRef: {
    location: {
      origin: string
    }
  }
  getMessageHandler: () => MessageHandler | undefined
}

const loadExtensionsUtil = async (): Promise<LoadedExtensionsUtil> => {
  vi.resetModules()

  let messageHandler: MessageHandler | undefined
  const mockAddEventListener = vi.fn((event: string, handler: MessageHandler) => {
    if (event === 'message') {
      messageHandler = handler
    }
  })
  const mockPostMessage = vi.fn()
  const mockWindowRef = {
    location: {
      origin: 'https://dapp.example'
    },
    addEventListener: mockAddEventListener,
    postMessage: mockPostMessage
  }

  vi.doMock('@ecadlabs/beacon-core', () => ({
    Logger: vi.fn().mockImplementation(function () {
      return {
        log: vi.fn()
      }
    }),
    windowRef: mockWindowRef
  }))

  const { getAvailableExtensions } = await import('../../src/utils/extensions')

  return {
    getAvailableExtensions,
    mockAddEventListener,
    mockPostMessage,
    mockWindowRef,
    getMessageHandler: () => messageHandler
  }
}

describe('getAvailableExtensions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('@ecadlabs/beacon-core')
  })

  it('posts the extension ping using the Beacon extension message shape', async () => {
    const { getAvailableExtensions, mockAddEventListener, mockPostMessage } =
      await loadExtensionsUtil()

    const extensionsPromise = getAvailableExtensions()

    expect(mockAddEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    expect(mockPostMessage).toHaveBeenCalledWith(
      {
        target: ExtensionMessageTarget.EXTENSION,
        payload: 'ping'
      },
      'https://dapp.example'
    )

    vi.advanceTimersByTime(1000)
    await expect(extensionsPromise).resolves.toEqual([])
  })

  it('returns trusted extensions that respond with pong', async () => {
    const { getAvailableExtensions, mockPostMessage, mockWindowRef, getMessageHandler } =
      await loadExtensionsUtil()
    const extension = {
      id: 'temple',
      name: 'Temple Wallet',
      shortName: 'Temple'
    }

    const extensionsPromise = getAvailableExtensions()
    getMessageHandler()?.({
      source: mockWindowRef,
      origin: mockWindowRef.location.origin,
      data: {
        payload: 'pong',
        sender: extension
      }
    })

    vi.advanceTimersByTime(1000)

    await expect(extensionsPromise).resolves.toEqual([extension])
    expect(mockPostMessage).toHaveBeenCalledWith('extensionsUpdated', mockWindowRef.location.origin)
  })

  it('ignores extension responses from another origin', async () => {
    const { getAvailableExtensions, mockWindowRef, getMessageHandler } = await loadExtensionsUtil()

    const extensionsPromise = getAvailableExtensions()
    getMessageHandler()?.({
      source: mockWindowRef,
      origin: 'https://wallet.example',
      data: {
        payload: 'pong',
        sender: {
          id: 'fake',
          name: 'Fake Wallet'
        }
      }
    })

    vi.advanceTimersByTime(1000)

    await expect(extensionsPromise).resolves.toEqual([])
  })

  it('caches only canonical optional metadata, matching transport discovery', async () => {
    const { getAvailableExtensions, mockPostMessage, mockWindowRef, getMessageHandler } =
      await loadExtensionsUtil()
    const pending = getAvailableExtensions()
    const handler = getMessageHandler()
    if (!handler) {
      throw new Error('Expected the public discovery listener to be registered')
    }
    let invalidId = 0
    for (const field of ['shortName', 'iconUrl', 'color']) {
      for (const value of [null, 7, {}]) {
        handler({
          source: mockWindowRef,
          origin: mockWindowRef.location.origin,
          data: {
            payload: 'pong',
            sender: { id: `invalid-${invalidId++}`, name: 'Invalid', [field]: value }
          }
        })
      }
    }
    const valid = [
      { id: 'minimal', name: 'Minimal' },
      {
        id: 'undefined',
        name: 'Undefined',
        shortName: undefined,
        iconUrl: undefined,
        color: undefined
      },
      {
        id: 'full',
        name: 'Full',
        shortName: 'F',
        iconUrl: 'https://wallet.example/icon.svg',
        color: '#fff',
        extra: { kept: true }
      }
    ]
    for (const sender of valid) {
      handler({
        source: mockWindowRef,
        origin: mockWindowRef.location.origin,
        data: { payload: 'pong', sender }
      })
    }
    vi.advanceTimersByTime(1000)
    const available = await pending
    expect(available).toEqual(valid)
    valid.forEach((sender, index) => expect(available[index]).toBe(sender))
    expect(mockPostMessage).toHaveBeenCalledTimes(valid.length + 1)
  })
})
