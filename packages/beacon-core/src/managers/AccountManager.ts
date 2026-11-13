import {
  Storage,
  StorageKey,
  AccountInfo,
  StoredAccountInfo,
  BeaconMessage
} from '@ecadlabs/beacon-types'
import { StorageManager } from './StorageManager'
import { PermissionValidator } from './PermissionValidator'
import { decodeStoredAccount } from './stored-account'

/**
 * @internalapi
 *
 * The AccountManager provides CRUD functionality for account entities and persists them to the provided storage.
 */
export class AccountManager {
  private readonly storageManager: StorageManager<StorageKey.ACCOUNTS>

  constructor(storage: Storage) {
    this.storageManager = new StorageManager(storage, StorageKey.ACCOUNTS)
  }

  public async getAccounts(): Promise<StoredAccountInfo[]> {
    const accounts: unknown = await this.storageManager.getAll()
    if (!Array.isArray(accounts)) {
      throw new Error('Invalid stored account collection')
    }

    return Array.from(accounts, decodeStoredAccount)
  }

  public async getAccount(accountIdentifier: string): Promise<StoredAccountInfo | undefined> {
    return (await this.getAccounts()).find(
      (account) => account.accountIdentifier === accountIdentifier
    )
  }

  public async addAccount(accountInfo: StoredAccountInfo): Promise<void> {
    await this.getAccounts()

    return this.storageManager.addOne(
      decodeStoredAccount(accountInfo),
      (account) => account.accountIdentifier === accountInfo.accountIdentifier
    )
  }

  public async updateAccount(
    accountIdentifier: string,
    accountInfo: Partial<StoredAccountInfo>
  ): Promise<StoredAccountInfo | undefined> {
    const account = await this.getAccount(accountIdentifier)

    if (!account) {
      return undefined
    }

    const newAccount = decodeStoredAccount({ ...account, ...accountInfo })
    await this.storageManager.addOne(
      newAccount,
      (candidate) => candidate.accountIdentifier === accountIdentifier,
      true
    )

    return newAccount
  }

  public async removeAccount(accountIdentifier: string): Promise<void> {
    return this.storageManager.remove((account) => account.accountIdentifier === accountIdentifier)
  }

  public async removeAccounts(accountIdentifiers: string[]): Promise<void> {
    return this.storageManager.remove((account) =>
      accountIdentifiers.includes(account.accountIdentifier)
    )
  }

  public async removeAllAccounts(): Promise<void> {
    return this.storageManager.removeAll()
  }

  public async hasPermission(message: BeaconMessage): Promise<boolean> {
    return PermissionValidator.hasPermission(
      message,
      async (id) => {
        const account = await this.getAccount(id)

        return account?.network ? account : undefined
      },
      async () =>
        (await this.getAccounts()).filter(
          (account): account is AccountInfo => account.network !== undefined
        )
    )
  }
}
