import { StorageKey, Storage, StorageKeyReturnType } from '@ecadlabs/beacon-types'

/** Type workaround for https://github.com/Microsoft/TypeScript/issues/7294#issuecomment-465794460 */
export type ArrayElem<A> = A extends (infer Elem)[] ? Elem : never

/* eslint-disable prefer-arrow/prefer-arrow-functions */
function fixArrayType<T>(array: T): ArrayElem<T>[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return array as any
}
/* eslint-enable prefer-arrow/prefer-arrow-functions */

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
    predicate: (element: ArrayElem<StorageKeyReturnType[T]>) => boolean
  ): Promise<ArrayElem<StorageKeyReturnType[T]> | undefined> {
    const entities = await this.storage.get(this.storageKey)

    return fixArrayType(entities).find(predicate)
  }

  public async addOne(
    element: ArrayElem<StorageKeyReturnType[T]>,
    predicate: (element: ArrayElem<StorageKeyReturnType[T]>) => boolean,
    overwrite: boolean = true
  ): Promise<void> {
    return this.enqueue(async () => {
      const entities = await this.storage.get(this.storageKey)

      if (!fixArrayType(entities).some(predicate)) {
        fixArrayType(entities).push(element)
      } else if (overwrite) {
        for (let i = 0; i < entities.length; i++) {
          if (predicate(fixArrayType(entities)[i])) {
            entities[i] = element
          }
        }
      }

      return this.storage.set(this.storageKey, entities)
    })
  }

  public async remove(
    predicate: (element: ArrayElem<StorageKeyReturnType[T]>) => boolean
  ): Promise<void> {
    return this.enqueue(async () => {
      const entities = await this.storage.get(this.storageKey)

      const filteredEntities = fixArrayType(entities).filter((entity) => !predicate(entity))

      return this.storage.set(this.storageKey, filteredEntities as StorageKeyReturnType[T])
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
