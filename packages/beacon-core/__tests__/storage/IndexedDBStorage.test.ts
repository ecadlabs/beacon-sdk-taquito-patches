import { IDBFactory, IDBDatabase as FakeIDBDatabase } from 'fake-indexeddb'
import { IndexedDBStorage } from '../../src/storage/IndexedDBStorage'
import { StorageKey } from '@ecadlabs/beacon-types'

let databases: IndexedDBStorage[]
let connections: Set<IDBDatabase>
beforeEach(() => {
  const factory = new IDBFactory()
  const open = factory.open.bind(factory)
  connections = new Set()
  vi.spyOn(factory, 'open').mockImplementation((...args) => {
    const request = open(...args)
    request.addEventListener('success', () => connections.add(request.result))
    return request
  })
  vi.stubGlobal('indexedDB', factory)
  databases = []
})
afterEach(async () => {
  for (const storage of databases) {
    await vi.waitFor(() => expect(storage['db']).not.toBeNull())
    storage['db']?.close()
  }
  connections.forEach((connection) => connection.close())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function create(name = 'test', stores = ['values', 'other']) {
  const storage = new IndexedDBStorage(name, stores)
  databases.push(storage)
  return storage
}
async function initialized(name = 'test') {
  const storage = create(name)
  await vi.waitFor(() => expect(storage['db']).not.toBeNull())
  return storage
}
it('sets, replaces, retrieves and deletes values after initialization', async () => {
  const storage = await initialized()
  expect(await storage.get('missing')).toBeUndefined()
  await storage.set('key', 'first')
  expect(await storage.get('key')).toBe('first')
  await storage.set('key', 'second')
  expect(await storage.get('key')).toBe('second')
  await storage.delete('key')
  expect(await storage.get('key')).toBeUndefined()
  await storage.delete('missing')
})
it('lists keys and values and clears only the selected store', async () => {
  const storage = await initialized()
  await storage.set('b', 'second')
  await storage.set('a', 'first')
  await storage.set('a', 'other value', 'other')
  expect(await storage.getAll()).toEqual(['first', 'second'])
  expect(await storage.getAllKeys()).toEqual(['a', 'b'])
  expect(await storage.get('a', 'other')).toBe('other value')
  await storage.clearStore()
  expect(await storage.getAll()).toEqual([])
  expect(await storage.getAllKeys()).toEqual([])
  expect(await storage.getAll('other')).toEqual(['other value'])
  await storage.clearStore('other')
  expect(await storage.getAll('other')).toEqual([])
})
it('normalizes Beacon keys and treats undefined as deletion', async () => {
  const storage = await initialized()
  expect(await storage.get(StorageKey.ACCOUNTS)).toEqual([])
  await storage.set(StorageKey.ACTIVE_ACCOUNT, 'account')
  expect(await storage.get(StorageKey.ACTIVE_ACCOUNT)).toBe('account')
  await storage.set(StorageKey.ACTIVE_ACCOUNT, undefined)
  expect(await storage.get(StorageKey.ACTIVE_ACCOUNT)).toBeUndefined()
})
it('rejects operations against a nonexistent store', async () => {
  const storage = await initialized()
  await expect(storage.get('key', 'absent')).rejects.toContain('absent not found')
})
it('fills another initialized store, preserving unrelated entries and skipping a trailing key', async () => {
  const source = await initialized('source')
  const target = await initialized('target')
  await source.set('a', 'first')
  await source.set('z', 'excluded')
  await target.set('existing', 'retained')
  await source.fillStore('target', 'values', ['z'])
  expect(await target.get('a')).toBe('first')
  expect(await target.get('z')).toBeUndefined()
  expect(await target.get('existing')).toBe('retained')
})
it('supports get immediately after construction', async () => {
  const storage = create()
  await expect(storage.get('missing')).resolves.toBeUndefined()
})
it('supports set immediately after construction', async () => {
  const storage = create()
  await storage.set('key', 'value')
  expect(await storage.get('key')).toBe('value')
})
it('returns a storage key instead of throwing Method not implemented', async () => {
  const storage = await initialized()
  expect(storage.getPrefixedKey(StorageKey.ACTIVE_ACCOUNT)).toBe(StorageKey.ACTIVE_ACCOUNT)
})
it('accepts a storage change subscription', async () => {
  const storage = await initialized()
  await expect(storage.subscribeToStorageChanged(() => ({}))).resolves.toBeUndefined()
})

it('finishes copying before fillStore resolves', async () => {
  const source = await initialized('source')
  const target = await initialized('target')
  await source.set('a', 'first')
  await source.fillStore('target', 'values')
  const valueAtResolution = await target.get('a')
  expect(valueAtResolution).toBe('first')
})
it('copies the correct values when skipping the first key', async () => {
  const source = await initialized('source')
  const target = await initialized('target')
  await source.set('a', 'excluded')
  await source.set('b', 'retained')
  await source.fillStore('target', 'values', ['a'])
  expect(await target.getAllKeys()).toEqual(['b'])
  expect(await target.get('b')).toBe('retained')
})

it.each(['delete', 'clearStore', 'getAll', 'getAllKeys'] as const)(
  'supports cold-start %s',
  async (operation) => {
    const storage = create()
    const result = operation === 'delete' ? storage.delete('missing') : storage[operation]()
    await expect(result).resolves.toEqual(
      operation === 'getAll' || operation === 'getAllKeys' ? [] : undefined
    )
  }
)
it('upgrades an existing database to add a missing store without losing values', async () => {
  const original = create('upgrade', ['values'])
  await vi.waitFor(() => expect(original['db']).not.toBeNull())
  await original.set('key', 'retained')
  original['db']?.close()
  const upgraded = create('upgrade', ['values', 'added'])
  await vi.waitFor(() => expect(upgraded['db']).not.toBeNull())
  expect(await upgraded.get('key')).toBe('retained')
  await upgraded.set('key', 'new store', 'added')
  expect(await upgraded.get('key', 'added')).toBe('new store')
})
it('closes the fillStore target connection after copying', async () => {
  const source = await initialized('source')
  const target = await initialized('target')
  await source.set('a', 'copied')
  const initialConnections = new Set(connections)
  const close = vi.spyOn(FakeIDBDatabase.prototype, 'close')
  await source.fillStore('target', 'values')
  expect(await target.get('a')).toBe('copied')
  const ownedConnections = [...connections].filter(
    (db) => !initialConnections.has(db) && db.name === 'target'
  )
  expect(ownedConnections).toHaveLength(1)
  expect(close.mock.contexts).toContain(ownedConnections[0])
  expect(close.mock.contexts).not.toContain(source['db'])
  expect(close.mock.contexts).not.toContain(target['db'])
})

it('rejects operations cleanly when IndexedDB is unavailable', async () => {
  vi.stubGlobal('window', undefined)
  const storage = new IndexedDBStorage()
  await expect(storage.get('key')).rejects.toBe('IndexedDB is not supported.')
  await expect(storage.set('key', 'value')).rejects.toBe('IndexedDB is not supported.')
})

it('closes the target connection when copying to a missing store fails', async () => {
  const source = await initialized('source')
  await initialized('target')
  const initialConnections = new Set(connections)
  const close = vi.spyOn(FakeIDBDatabase.prototype, 'close')
  await expect(source.fillStore('target', 'missing')).rejects.toThrow('missing not found')
  const owned = [...connections].filter((db) => !initialConnections.has(db))
  expect(owned).toHaveLength(1)
  expect(close.mock.contexts).toContain(owned[0])
})

it('finishes initialization before opening the same database as a copy target', async () => {
  const original = await initialized('upgrade-copy')
  await original.set('key', 'value')
  original['db']?.close()
  const upgraded = create('upgrade-copy', ['values', 'other', 'added'])
  let completed = false
  const copying = upgraded.fillStore('upgrade-copy', 'added').then(() => {
    completed = true
  })
  copying.catch(() => undefined)
  try {
    await vi.waitFor(() => expect(completed).toBe(true))
    await copying
    expect(await upgraded.get('key', 'added')).toBe('value')
  } finally {
    connections.forEach((connection) => connection.close())
    await copying.catch(() => undefined)
  }
})
