import { StorageKey, defaultValues } from '@ecadlabs/beacon-types'
import { ChromeStorage } from '../../src/storage/ChromeStorage'
import { IndexedDBStorage } from '../../src/storage/IndexedDBStorage'
import { LocalStorage } from '../../src/storage/LocalStorage'
import {
  STRING_STORAGE_KEYS,
  assertStorageKeyNormalizationIsExhaustive
} from '../../src/storage/storage-normalization'

describe('storage undefined writes', () => {
  afterEach(() => {
    localStorage.clear()
    jest.restoreAllMocks()
    delete (globalThis as any).chrome
  })

  it('removes LocalStorage entries instead of persisting undefined', async () => {
    const storage = new LocalStorage()

    await storage.set(StorageKey.ACTIVE_ACCOUNT, 'account-id')
    await storage.set(StorageKey.ACTIVE_ACCOUNT, undefined)

    expect(localStorage.getItem(StorageKey.ACTIVE_ACCOUNT)).toBeNull()
    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
  })

  it('treats literal undefined LocalStorage sentinels as missing values', async () => {
    const storage = new LocalStorage()

    localStorage.setItem(StorageKey.ACTIVE_ACCOUNT, 'undefined')

    await expect(storage.get(StorageKey.ACTIVE_ACCOUNT)).resolves.toBeUndefined()
  })

  it('returns defaults when LocalStorage array keys contain non-arrays', async () => {
    const storage = new LocalStorage()

    localStorage.setItem(StorageKey.ACCOUNTS, '{"not":"an array"}')
    localStorage.setItem(StorageKey.PERMISSION_LIST, 'undefined')

    await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toEqual([])
    await expect(storage.get(StorageKey.PERMISSION_LIST)).resolves.toEqual([])
  })

  it('returns defaults when LocalStorage object keys contain arrays or sentinels', async () => {
    const storage = new LocalStorage()

    localStorage.setItem(StorageKey.LAST_SELECTED_WALLET, '[]')
    localStorage.setItem(StorageKey.MATRIX_PEER_ROOM_IDS, 'null')

    await expect(storage.get(StorageKey.LAST_SELECTED_WALLET)).resolves.toBeUndefined()
    await expect(storage.get(StorageKey.MATRIX_PEER_ROOM_IDS)).resolves.toEqual({})
  })

  it('returns defaults when LocalStorage boolean keys contain non-booleans', async () => {
    const storage = new LocalStorage()

    localStorage.setItem(StorageKey.ENABLE_METRICS, '"true"')

    await expect(storage.get(StorageKey.ENABLE_METRICS)).resolves.toBeUndefined()
  })

  it('accepts raw and JSON-encoded strings for LocalStorage string keys', async () => {
    const storage = new LocalStorage()

    localStorage.setItem(StorageKey.USER_ID, 'raw-user-id')
    localStorage.setItem(StorageKey.BEACON_SDK_VERSION, '"4.8.3-ecad"')

    await expect(storage.get(StorageKey.USER_ID)).resolves.toBe('raw-user-id')
    await expect(storage.get(StorageKey.BEACON_SDK_VERSION)).resolves.toBe('4.8.3-ecad')
  })

  it('round-trips JSON-looking raw strings for LocalStorage string keys', async () => {
    const storage = new LocalStorage()
    const pairings = '[{"topic":"abc"}]'

    await storage.set(StorageKey.WC_2_CORE_PAIRING, pairings)

    await expect(storage.get(StorageKey.WC_2_CORE_PAIRING)).resolves.toBe(pairings)
  })

  it('round-trips every LocalStorage string key as raw and JSON-encoded strings', async () => {
    const storage = new LocalStorage()

    for (const key of STRING_STORAGE_KEYS) {
      if (typeof defaultValues[key] === 'string' || defaultValues[key] === undefined) {
        const rawValue = `raw:${key}`
        const encodedValue = `encoded:${key}`

        localStorage.setItem(key, rawValue)
        await expect(storage.get(key)).resolves.toBe(rawValue)

        localStorage.setItem(key, JSON.stringify(encodedValue))
        await expect(storage.get(key)).resolves.toBe(encodedValue)
      }
    }
  })

  it('removes Chrome storage entries instead of setting undefined', async () => {
    const remove = jest.fn((_key: string, callback: () => void) => callback())
    const set = jest.fn((_value: Record<string, unknown>, callback: () => void) => callback())
    ;(globalThis as any).chrome = {
      storage: {
        local: {
          get: jest.fn(),
          remove,
          set
        }
      }
    }

    await new ChromeStorage().set(StorageKey.ACTIVE_ACCOUNT, undefined)

    expect(remove).toHaveBeenCalledWith(StorageKey.ACTIVE_ACCOUNT, expect.any(Function))
    expect(set).not.toHaveBeenCalled()
  })

  it('normalizes Chrome storage reads', async () => {
    ;(globalThis as any).chrome = {
      storage: {
        local: {
          get: jest.fn((_key: null, callback: (value: Record<string, unknown>) => void) =>
            callback({
              [StorageKey.ACCOUNTS]: { not: 'an array' },
              [StorageKey.WC_2_CORE_PAIRING]: '[{"topic":"abc"}]'
            })
          ),
          remove: jest.fn(),
          set: jest.fn()
        }
      }
    }

    const storage = new ChromeStorage()

    await expect(storage.get(StorageKey.ACCOUNTS)).resolves.toEqual([])
    await expect(storage.get(StorageKey.WC_2_CORE_PAIRING)).resolves.toBe('[{"topic":"abc"}]')
  })

  it('removes IndexedDB entries instead of putting undefined', async () => {
    const storage = Object.create(IndexedDBStorage.prototype) as IndexedDBStorage
    const remove = jest.spyOn(storage, 'delete').mockResolvedValue(undefined)

    await storage.set(StorageKey.ACTIVE_ACCOUNT, undefined, 'keyvaluestorage')

    expect(remove).toHaveBeenCalledWith(StorageKey.ACTIVE_ACCOUNT, 'keyvaluestorage')
  })

  it('normalizes IndexedDB storage reads', async () => {
    const storage = Object.create(IndexedDBStorage.prototype) as IndexedDBStorage

    Object.defineProperty(storage, 'transaction', {
      value: () => Promise.resolve({ not: 'an array' })
    })

    await expect(storage.get(StorageKey.ACCOUNTS, 'keyvaluestorage')).resolves.toEqual([])
  })

  it('catches storage keys missing from normalization', () => {
    expect(() =>
      assertStorageKeyNormalizationIsExhaustive([
        ...Object.values(StorageKey),
        'beacon:missing-key'
      ])
    ).toThrow('beacon:missing-key')
  })
})
