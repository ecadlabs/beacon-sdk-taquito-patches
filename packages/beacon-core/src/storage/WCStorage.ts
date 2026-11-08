import { StorageKey } from '@ecadlabs/beacon-types'
import { LocalStorage } from './LocalStorage'
import { IndexedDBStorage } from './IndexedDBStorage'

const parseStorageArray = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const hasNonEmptyWalletConnectStorageValue = (value: string | undefined): boolean => {
  if (!value) {
    return false
  }

  const parsedValue = parseStorageArray(value)

  return Array.isArray(parsedValue) && parsedValue.length > 0
}

const isWalletConnectLocalStorageKey = (key: string, name?: string): boolean => {
  if (!key.includes('wc@2:')) {
    return false
  }

  return name ? key.endsWith(name) : true
}

// WalletConnect owns its prefix; Airgap's StorageKey enum does not match WC's emitted key shape.
const getWalletConnectLocalStorageKeys = (name?: string): string[] => {
  const keys: string[] = []

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)

    if (key && isWalletConnectLocalStorageKey(key, name)) {
      keys.push(key)
    }
  }

  return keys
}

const hasNonEmptyWalletConnectLocalStorageEntries = (name: string): boolean =>
  getWalletConnectLocalStorageKeys(name).some((key) =>
    hasNonEmptyWalletConnectStorageValue(localStorage.getItem(key) ?? undefined)
  )

export class WCStorage {
  private readonly indexedDB = new IndexedDBStorage()
  private readonly channel: BroadcastChannel = new BroadcastChannel('WALLET_CONNECT_V2_INDEXED_DB')
  private closed = false
  public onMessageHandler: ((type: string) => void) | undefined
  public onErrorHandler: ((data: unknown) => void) | undefined

  constructor() {
    this.channel.onmessage = this.onMessage.bind(this)
    this.channel.onmessageerror = this.onError.bind(this)
  }

  public notify(type: string) {
    if (!this.closed) {
      this.channel.postMessage({ type })
    }
  }

  public close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.onMessageHandler = undefined
    this.onErrorHandler = undefined
    this.channel.onmessage = null
    this.channel.onmessageerror = null
    this.channel.close()
  }

  public async hasPairings() {
    const pairings = await this.indexedDB.get(StorageKey.WC_2_CORE_PAIRING)

    if (hasNonEmptyWalletConnectStorageValue(pairings)) {
      return true
    }

    if (await LocalStorage.isSupported()) {
      return hasNonEmptyWalletConnectLocalStorageEntries('pairing')
    }

    return false
  }

  public async hasSessions() {
    const sessions = await this.indexedDB.get(StorageKey.WC_2_CLIENT_SESSION)

    if (hasNonEmptyWalletConnectStorageValue(sessions)) {
      return true
    }

    if (await LocalStorage.isSupported()) {
      return hasNonEmptyWalletConnectLocalStorageEntries('session')
    }

    return false
  }

  public async resetState() {
    await this.indexedDB.clearStore()

    if (await LocalStorage.isSupported()) {
      getWalletConnectLocalStorageKeys().forEach((key) => localStorage.removeItem(key))
    }
  }

  private onMessage(message: MessageEvent) {
    if (!this.closed && this.onMessageHandler) {
      this.onMessageHandler(message.data.type)
    }
  }

  private onError({ data }: MessageEvent) {
    if (!this.closed && this.onErrorHandler) {
      this.onErrorHandler(data)
    }
  }
}
