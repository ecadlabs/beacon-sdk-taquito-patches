import { StorageKey, Storage, StorageKeyReturnType } from '@ecadlabs/beacon-types'

export type ArrayElem<A> = A extends (infer Elem)[] ? Elem : never

/**
 * @internalapi
 *
 * The StorageManager provides CRUD functionality for specific entities and persists them to the provided storage.
 */
export class StorageManager<
  T extends
    | StorageKey.ACCOUNTS
    | StorageKey.APP_METADATA_LIST
    | StorageKey.PERMISSION_LIST
    | StorageKey.TRANSPORT_P2P_PEERS_DAPP
    | StorageKey.TRANSPORT_P2P_PEERS_WALLET
    | StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP
    | StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET
    | StorageKey.TRANSPORT_WALLETCONNECT_PEERS_DAPP
    | StorageKey.TRANSPORT_WALLETCONNECT_PEERS_WALLET
> {
  private mutations: Promise<void> = Promise.resolve()
  private readonly storage: Storage
  private readonly storageKey: T

  constructor(storage: Storage, storageKey: T) {
    this.storage = storage
    this.storageKey = storageKey
  }

  public async getAll(): Promise<StorageKeyReturnType[T]> {
    return (await this.storage.get(this.storageKey)) ?? []
  }

  public async getOne(
    predicate: (element: StorageKeyReturnType[T][number]) => boolean
  ): Promise<StorageKeyReturnType[T][number] | undefined> {
    const entities = await this.storage.get(this.storageKey)

    return entities.find(predicate)
  }

  public async addOne(
    element: StorageKeyReturnType[T][number],
    predicate: (element: StorageKeyReturnType[T][number]) => boolean,
    overwrite: boolean = true
  ): Promise<void> {
    return this.enqueue(async () => {
      const entities = await this.storage.get(this.storageKey)

      if (!entities.some(predicate)) {
        entities[entities.length] = element
      } else if (overwrite) {
        for (let i = 0; i < entities.length; i++) {
          if (predicate(entities[i])) {
            entities[i] = element
          }
        }
      }

      return this.storage.set(this.storageKey, entities)
    })
  }

  public async remove(
    predicate: (element: StorageKeyReturnType[T][number]) => boolean
  ): Promise<void> {
    return this.enqueue(async () => {
      const entities = await this.storage.get(this.storageKey)

      const filteredEntities: StorageKeyReturnType[T] = []
      entities.forEach((entity) => {
        if (!predicate(entity)) {
          filteredEntities[filteredEntities.length] = entity
        }
      })

      return this.storage.set(this.storageKey, filteredEntities)
    })
  }

  public async removeAll(): Promise<void> {
    return this.enqueue(() => this.storage.delete(this.storageKey))
  }

  private enqueue(mutation: () => Promise<void>): Promise<void> {
    const result = this.mutations.then(mutation)
    // Keep later mutations runnable even when this caller receives a rejection.
    this.mutations = result.catch(() => undefined)

    return result
  }
}
