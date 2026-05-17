import { Storage, StorageKey, StorageKeyReturnType } from '@ecadlabs/beacon-types'
import { normalizeParsedStoredValue } from './storage-normalization'

/**
 * @internalapi
 *
 * A storage that can be used in chrome extensions
 */
export class ChromeStorage implements Storage {
  public static async isSupported(): Promise<boolean> {
    return (
      typeof window !== 'undefined' &&
      typeof chrome !== 'undefined' &&
      Boolean(chrome) &&
      Boolean(chrome.runtime) &&
      Boolean(chrome.runtime.id)
    )
  }

  public async get<K extends StorageKey>(key: K): Promise<StorageKeyReturnType[K]> {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (storageContent) => {
        resolve(normalizeParsedStoredValue(key, storageContent[key]))
      })
    })
  }

  public async set<K extends StorageKey>(key: K, value: StorageKeyReturnType[K]): Promise<void> {
    if (value === undefined) {
      return this.delete(key)
    }

    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => {
        resolve()
      })
    })
  }

  public async delete<K extends StorageKey>(key: K): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.remove(String(key), () => {
        resolve()
      })
    })
  }

  public async subscribeToStorageChanged(
    _callback: (arg: {
      eventType: 'storageCleared' | 'entryModified'
      key: string | null
      oldValue: string | null
      newValue: string | null
    }) => {}
  ): Promise<void> {
    // TODO
  }

  public getPrefixedKey(key: string): string {
    return key
  }
}
