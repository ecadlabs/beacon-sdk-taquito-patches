import { WCStorage } from '../../src/storage/WCStorage'

const mockIndexedDBGet = jest.fn()
const mockIndexedDBClearStore = jest.fn()
const mockIndexedDBFillStore = jest.fn()

jest.mock('../../src/storage/IndexedDBStorage', () => ({
  IndexedDBStorage: jest.fn().mockImplementation(() => ({
    get: mockIndexedDBGet,
    clearStore: mockIndexedDBClearStore,
    fillStore: mockIndexedDBFillStore
  }))
}))

class MockBroadcastChannel extends EventTarget implements BroadcastChannel {
  onmessage: ((this: BroadcastChannel, ev: MessageEvent) => unknown) | null = null
  onmessageerror: ((this: BroadcastChannel, ev: MessageEvent) => unknown) | null = null

  constructor(public readonly name: string) {
    super()
  }

  close(): void {}

  postMessage(_message: unknown): void {}
}

describe('WCStorage', () => {
  const originalBroadcastChannel = globalThis.BroadcastChannel

  beforeAll(() => {
    globalThis.BroadcastChannel = MockBroadcastChannel
  })

  beforeEach(() => {
    localStorage.clear()
    mockIndexedDBGet.mockResolvedValue(undefined)
    mockIndexedDBClearStore.mockResolvedValue(undefined)
    mockIndexedDBFillStore.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  afterAll(() => {
    globalThis.BroadcastChannel = originalBroadcastChannel
  })

  it('hasPairings returns true for a non-empty default-prefixed WalletConnect pairing key', async () => {
    localStorage.setItem('wc@2:core:0.3//pairing', JSON.stringify([{ topic: 'pairing-topic' }]))

    await expect(new WCStorage().hasPairings()).resolves.toBe(true)
  })

  it('hasPairings returns true for a non-empty custom-prefixed WalletConnect pairing key', async () => {
    localStorage.setItem(
      'wc@2:core:0.3:beacon-sdk//pairing',
      JSON.stringify([{ topic: 'pairing-topic' }])
    )

    await expect(new WCStorage().hasPairings()).resolves.toBe(true)
  })

  it('hasPairings returns false for an empty WalletConnect pairing key', async () => {
    localStorage.setItem('wc@2:core:0.3:beacon-sdk//pairing', '[]')

    await expect(new WCStorage().hasPairings()).resolves.toBe(false)
  })

  it('hasPairings returns false when localStorage has no WalletConnect pairing keys', async () => {
    localStorage.setItem('beacon:unrelated', JSON.stringify([{ topic: 'pairing-topic' }]))

    await expect(new WCStorage().hasPairings()).resolves.toBe(false)
  })

  it('hasSessions returns true for a non-empty default-prefixed WalletConnect session key', async () => {
    localStorage.setItem('wc@2:client:0.3//session', JSON.stringify([{ topic: 'session-topic' }]))

    await expect(new WCStorage().hasSessions()).resolves.toBe(true)
  })

  it('hasSessions returns true for a non-empty custom-prefixed WalletConnect session key', async () => {
    localStorage.setItem(
      'wc@2:client:0.3:beacon-sdk//session',
      JSON.stringify([{ topic: 'session-topic' }])
    )

    await expect(new WCStorage().hasSessions()).resolves.toBe(true)
  })

  it('hasSessions returns false for an empty WalletConnect session key', async () => {
    localStorage.setItem('wc@2:client:0.3:beacon-sdk//session', '[]')

    await expect(new WCStorage().hasSessions()).resolves.toBe(false)
  })

  it('hasSessions returns false when localStorage has no WalletConnect session keys', async () => {
    localStorage.setItem('beacon:unrelated', JSON.stringify([{ topic: 'session-topic' }]))

    await expect(new WCStorage().hasSessions()).resolves.toBe(false)
  })

  it('resetState removes every WalletConnect localStorage key and leaves unrelated keys alone', async () => {
    localStorage.setItem('wc@2:core:0.3//pairing', JSON.stringify([{ topic: 'pairing-topic' }]))
    localStorage.setItem(
      'wc@2:core:0.3:beacon-sdk//keychain',
      JSON.stringify([{ topic: 'keychain-topic' }])
    )
    localStorage.setItem('prefix:wc@2:client:0.3:other//session', JSON.stringify([]))
    localStorage.setItem('beacon:unrelated', 'value')

    await new WCStorage().resetState()

    expect(localStorage.getItem('wc@2:core:0.3//pairing')).toBeNull()
    expect(localStorage.getItem('wc@2:core:0.3:beacon-sdk//keychain')).toBeNull()
    expect(localStorage.getItem('prefix:wc@2:client:0.3:other//session')).toBeNull()
    expect(localStorage.getItem('beacon:unrelated')).toBe('value')
    expect(mockIndexedDBClearStore).toHaveBeenCalledTimes(1)
  })
})
