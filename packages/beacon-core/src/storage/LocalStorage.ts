import { Storage, StorageKey, StorageKeyReturnType } from '@ecadlabs/beacon-types'
import { normalizeStoredValue } from './storage-normalization'

/**
 * @internalapi
 *
 * A storage that can be used in the browser
 */
export class LocalStorage extends Storage {
  constructor(private readonly prefix?: string) {
    super()
  }
  public static async isSupported(): Promise<boolean> {
    return Promise.resolve(Boolean(typeof window !== 'undefined') && Boolean(window.localStorage))
  }

  public async get<K extends StorageKey>(key: K): Promise<StorageKeyReturnType[K]> {
    const value = localStorage.getItem(this.getPrefixedKey(key))

    return normalizeStoredValue(key, value)
  }

  public async set<K extends StorageKey>(key: K, value: StorageKeyReturnType[K]): Promise<void> {
    if (value === undefined) {
      return this.delete(key)
    }

    if (typeof value === 'string') {
      return localStorage.setItem(this.getPrefixedKey(key), value)
    } else {
      return localStorage.setItem(this.getPrefixedKey(key), JSON.stringify(value))
    }
  }

  public async delete<K extends StorageKey>(key: K): Promise<void> {
    return Promise.resolve(localStorage.removeItem(this.getPrefixedKey(key)))
  }

  public async subscribeToStorageChanged(
    callback: (arg: {
      eventType: 'storageCleared' | 'entryModified'
      key: string | null
      oldValue: string | null
      newValue: string | null
    }) => {}
  ): Promise<void> {
    window.addEventListener(
      'storage',
      (event) => {
        if (!event.key) {
          callback({
            eventType: 'storageCleared',
            key: null,
            oldValue: null,
            newValue: null
          })
        } else {
          callback({
            eventType: 'entryModified',
            key: this.getPrefixedKey(event.key),
            oldValue: event.oldValue,
            newValue: event.newValue
          })
        }
      },
      false
    )
  }

  public getPrefixedKey(key: string): string {
    return this.prefix ? `${this.prefix}-${key}` : key
  }
}
