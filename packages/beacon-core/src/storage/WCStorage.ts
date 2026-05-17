import { StorageKey } from '@ecadlabs/beacon-types'
import { LocalStorage } from './LocalStorage'
import { IndexedDBStorage } from './IndexedDBStorage'

export class WCStorage {
  private readonly indexedDB = new IndexedDBStorage()
  private readonly channel: BroadcastChannel = new BroadcastChannel('WALLET_CONNECT_V2_INDEXED_DB')
  onMessageHandler: ((type: string) => void) | undefined
  onErrorHandler: ((data: any) => void) | undefined

  constructor() {
    this.channel.onmessage = this.onMessage.bind(this)
    this.channel.onmessageerror = this.onError.bind(this)
  }

  private onMessage(message: MessageEvent) {
    this.onMessageHandler && this.onMessageHandler(message.data.type)
  }

  private onError({ data }: MessageEvent) {
    this.onErrorHandler && this.onErrorHandler(data)
  }

  notify(type: string) {
    this.channel?.postMessage({ type })
  }

  async hasPairings() {
    const pairings = await this.indexedDB.get(StorageKey.WC_2_CORE_PAIRING)

    if (hasNonEmptyWalletConnectStorageValue(pairings)) {
      return true
    }

    if (await LocalStorage.isSupported()) {
      return hasNonEmptyWalletConnectLocalStorageEntries('pairing')
    }

    return false
  }

  async hasSessions() {
    const sessions = await this.indexedDB.get(StorageKey.WC_2_CLIENT_SESSION)

    if (hasNonEmptyWalletConnectStorageValue(sessions)) {
      return true
    }

    if (await LocalStorage.isSupported()) {
      return hasNonEmptyWalletConnectLocalStorageEntries('session')
    }

    return false
  }

  backup() {
    this.indexedDB
      .fillStore('beacon', 'bug_report', [StorageKey.WC_2_CORE_KEYCHAIN])
      .catch((error) => console.error(error.message))
  }

  async resetState() {
    await this.indexedDB.clearStore()

    if (await LocalStorage.isSupported()) {
      getWalletConnectLocalStorageKeys().forEach((key) => localStorage.removeItem(key))
    }
  }
}

// WalletConnect owns its prefix; Airgap's StorageKey enum does not match WC's emitted key shape.
function getWalletConnectLocalStorageKeys(name?: string): string[] {
  const keys: string[] = []

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)

    if (key && isWalletConnectLocalStorageKey(key, name)) {
      keys.push(key)
    }
  }

  return keys
}

function isWalletConnectLocalStorageKey(key: string, name?: string): boolean {
  if (!key.includes('wc@2:')) {
    return false
  }

  return name ? key.endsWith(name) : true
}

function hasNonEmptyWalletConnectLocalStorageEntries(name: string): boolean {
  return getWalletConnectLocalStorageKeys(name).some((key) => {
    return hasNonEmptyWalletConnectStorageValue(localStorage.getItem(key) ?? undefined)
  })
}

function hasNonEmptyWalletConnectStorageValue(value: string | undefined): boolean {
  if (!value) {
    return false
  }

  const parsedValue = parseStorageArray(value)

  return Array.isArray(parsedValue) && parsedValue.length > 0
}

function parseStorageArray(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
