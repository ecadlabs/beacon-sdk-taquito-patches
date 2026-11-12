import { Storage, StorageKey } from '@ecadlabs/beacon-types'

export class StorageValidator {
  constructor(private readonly storage: Storage) {}

  private innerValidate(value: unknown, type: 'num' | 'str' | 'bol' | 'wallet' | 'arr') {
    if (!value) {
      return true
    }

    switch (type) {
      case 'num':
        return typeof value === 'number' && !isNaN(value)
      case 'str':
        return typeof value === 'string'
      case 'bol':
        return typeof value === 'boolean'
      case 'wallet':
        return Object.prototype.hasOwnProperty.call(value, 'key')
      case 'arr':
        return Array.isArray(value)
      default:
        return false
    }
  }

  public async validate(): Promise<boolean> {
    if (!this.innerValidate(await this.storage.get(StorageKey.BEACON_SDK_VERSION), 'str')) {
      return false
    }
    if (!this.innerValidate(await this.storage.get(StorageKey.MATRIX_SELECTED_NODE), 'str')) {
      return false
    }
    if (!this.innerValidate(await this.storage.get(StorageKey.MULTI_NODE_SETUP_DONE), 'bol')) {
      return false
    }
    if (!this.innerValidate(await this.storage.get(StorageKey.TRANSPORT_P2P_PEERS_DAPP), 'arr')) {
      return false
    }
    if (!this.innerValidate(await this.storage.get(StorageKey.TRANSPORT_P2P_PEERS_WALLET), 'arr')) {
      return false
    }
    if (
      !this.innerValidate(
        await this.storage.get(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP),
        'arr'
      )
    ) {
      return false
    }
    if (
      !this.innerValidate(
        await this.storage.get(StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET),
        'arr'
      )
    ) {
      return false
    }
    if (
      !this.innerValidate(
        await this.storage.get(StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP),
        'arr'
      )
    ) {
      return false
    }
    if (!this.innerValidate(await this.storage.get(StorageKey.ACCOUNTS), 'arr')) {
      return false
    }
    if (!this.innerValidate(await this.storage.get(StorageKey.APP_METADATA_LIST), 'arr')) {
      return false
    }
    if (!this.innerValidate(await this.storage.get(StorageKey.PERMISSION_LIST), 'arr')) {
      return false
    }
    if (!this.innerValidate(await this.storage.get(StorageKey.ACTIVE_ACCOUNT), 'str')) {
      return false
    }
    if (!this.innerValidate(await this.storage.get(StorageKey.LAST_SELECTED_WALLET), 'wallet')) {
      return false
    }

    return true
  }
}
