/** @vitest-environment node */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { getKeypairFromSeed } from '@ecadlabs/beacon-utils'
import {
  defaultValues,
  Regions,
  Storage,
  StorageKey,
  StorageKeyReturnDefaults,
  StorageKeyReturnType
} from '@ecadlabs/beacon-types'
import { P2PCommunicationClient } from '../../src/communication-client/P2PCommunicationClient'

class TestStorage extends Storage {
  private readonly values: StorageKeyReturnDefaults = {
    ...defaultValues,
    [StorageKey.MATRIX_PRESERVED_STATE]: {}
  }

  public async get<K extends StorageKey>(key: K): Promise<StorageKeyReturnType[K]> {
    return this.values[key]
  }

  public async set<K extends StorageKey>(key: K, value: StorageKeyReturnType[K]): Promise<void> {
    this.values[key] = value
  }

  public async delete<K extends StorageKey>(key: K): Promise<void> {
    this.values[key] = defaultValues[key]
  }

  public async subscribeToStorageChanged(
    _callback: Parameters<Storage['subscribeToStorageChanged']>[0]
  ): Promise<void> {}

  public getPrefixedKey<K extends StorageKey>(key: K): string {
    return key
  }
}

describe('P2PCommunicationClient.getRelayServer() validation against ENABLED_RELAY_SERVERS (Issue #145)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('deletes stale MATRIX_SELECTED_NODE and calls findBestRegionAndGetServer when stored node is not in non-empty ENABLED_RELAY_SERVERS', async () => {
    const storage = new TestStorage()
    await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'stale-removed-node.example.com')
    const deleteSpy = vi.spyOn(storage, 'delete')

    const keys = await getKeypairFromSeed('relay-validation-seed-1')
    const client = new P2PCommunicationClient('RelayTest', keys, 2, storage, {
      [Regions.EUROPE_WEST]: ['active-node-1.example.com', 'active-node-2.example.com']
    })

    const getBeaconInfoSpy = vi
      .spyOn(client as unknown as { getBeaconInfo: (server: string) => Promise<{ region: string; known_servers: string[]; timestamp: number }> }, 'getBeaconInfo')
      .mockResolvedValue({
        region: Regions.EUROPE_WEST,
        known_servers: ['active-node-1.example.com'],
        timestamp: 123456
      })

    const findBestSpy = vi
      .spyOn(client, 'findBestRegionAndGetServer')
      .mockResolvedValue({ server: 'active-node-1.example.com', timestamp: 999999 })

    const result = await client.getRelayServer()

    expect(deleteSpy).toHaveBeenCalledWith(StorageKey.MATRIX_SELECTED_NODE)
    expect(getBeaconInfoSpy).not.toHaveBeenCalledWith('stale-removed-node.example.com')
    expect(findBestSpy).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ server: 'active-node-1.example.com', timestamp: 999999 })
    await expect(storage.get(StorageKey.MATRIX_SELECTED_NODE)).resolves.toBe(
      'active-node-1.example.com'
    )
  })

  it('uses stored MATRIX_SELECTED_NODE when ENABLED_RELAY_SERVERS contains it', async () => {
    const storage = new TestStorage()
    await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'active-node-2.example.com')
    const deleteSpy = vi.spyOn(storage, 'delete')

    const keys = await getKeypairFromSeed('relay-validation-seed-2')
    const client = new P2PCommunicationClient('RelayTest', keys, 2, storage, {
      [Regions.EUROPE_WEST]: ['active-node-1.example.com', 'active-node-2.example.com']
    })

    const getBeaconInfoSpy = vi
      .spyOn(client as unknown as { getBeaconInfo: (server: string) => Promise<{ region: string; known_servers: string[]; timestamp: number }> }, 'getBeaconInfo')
      .mockResolvedValue({
        region: Regions.EUROPE_WEST,
        known_servers: ['active-node-2.example.com'],
        timestamp: 222222
      })

    const findBestSpy = vi.spyOn(client, 'findBestRegionAndGetServer')

    const result = await client.getRelayServer()

    expect(deleteSpy).not.toHaveBeenCalled()
    expect(getBeaconInfoSpy).toHaveBeenCalledWith('active-node-2.example.com')
    expect(findBestSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ server: 'active-node-2.example.com', timestamp: 222222 })
  })

  it('uses stored MATRIX_SELECTED_NODE when ENABLED_RELAY_SERVERS is empty with region keys having empty arrays', async () => {
    const storage = new TestStorage()
    await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'custom-stored-node.example.com')
    const deleteSpy = vi.spyOn(storage, 'delete')

    const keys = await getKeypairFromSeed('relay-validation-seed-3')
    const client = new P2PCommunicationClient('RelayTest', keys, 2, storage, {
      [Regions.EUROPE_WEST]: []
    })

    const getBeaconInfoSpy = vi
      .spyOn(client as unknown as { getBeaconInfo: (server: string) => Promise<{ region: string; known_servers: string[]; timestamp: number }> }, 'getBeaconInfo')
      .mockResolvedValue({
        region: Regions.EUROPE_WEST,
        known_servers: ['custom-stored-node.example.com'],
        timestamp: 333333
      })

    const findBestSpy = vi.spyOn(client, 'findBestRegionAndGetServer')

    const result = await client.getRelayServer()

    expect(deleteSpy).not.toHaveBeenCalled()
    expect(getBeaconInfoSpy).toHaveBeenCalledWith('custom-stored-node.example.com')
    expect(findBestSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ server: 'custom-stored-node.example.com', timestamp: 333333 })
  })

  it('deletes stale retired MATRIX_SELECTED_NODE without calling getBeaconInfo when matrixNodes is omitted (default ENABLED_RELAY_SERVERS)', async () => {
    const storage = new TestStorage()
    await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'beacon-node-1.sky.papers.tech')
    const deleteSpy = vi.spyOn(storage, 'delete')

    const keys = await getKeypairFromSeed('relay-validation-seed-default-stale')
    const client = new P2PCommunicationClient('RelayTest', keys, 2, storage)

    const getBeaconInfoSpy = vi
      .spyOn(client as unknown as { getBeaconInfo: (server: string) => Promise<{ region: string; known_servers: string[]; timestamp: number }> }, 'getBeaconInfo')
      .mockResolvedValue({
        region: Regions.EUROPE_WEST,
        known_servers: ['beacon-node-1.octez.io'],
        timestamp: 444440
      })

    const findBestSpy = vi
      .spyOn(client, 'findBestRegionAndGetServer')
      .mockResolvedValue({ server: 'beacon-node-1.octez.io', timestamp: 444441 })

    const result = await client.getRelayServer()

    expect(deleteSpy).toHaveBeenCalledWith(StorageKey.MATRIX_SELECTED_NODE)
    expect(getBeaconInfoSpy).not.toHaveBeenCalledWith('beacon-node-1.sky.papers.tech')
    expect(findBestSpy).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ server: 'beacon-node-1.octez.io', timestamp: 444441 })
    await expect(storage.get(StorageKey.MATRIX_SELECTED_NODE)).resolves.toBe(
      'beacon-node-1.octez.io'
    )
  })

  it('deletes stale retired MATRIX_SELECTED_NODE without calling getBeaconInfo when matrixNodes is {} (merged with default ENABLED_RELAY_SERVERS)', async () => {
    const storage = new TestStorage()
    await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'beacon-node-1.sky.papers.tech')
    const deleteSpy = vi.spyOn(storage, 'delete')

    const keys = await getKeypairFromSeed('relay-validation-seed-4')
    const client = new P2PCommunicationClient('RelayTest', keys, 2, storage, {})

    const getBeaconInfoSpy = vi
      .spyOn(client as unknown as { getBeaconInfo: (server: string) => Promise<{ region: string; known_servers: string[]; timestamp: number }> }, 'getBeaconInfo')
      .mockResolvedValue({
        region: Regions.EUROPE_WEST,
        known_servers: ['beacon-node-1.octez.io'],
        timestamp: 444442
      })

    const findBestSpy = vi
      .spyOn(client, 'findBestRegionAndGetServer')
      .mockResolvedValue({ server: 'beacon-node-1.octez.io', timestamp: 444443 })

    const result = await client.getRelayServer()

    expect(deleteSpy).toHaveBeenCalledWith(StorageKey.MATRIX_SELECTED_NODE)
    expect(getBeaconInfoSpy).not.toHaveBeenCalledWith('beacon-node-1.sky.papers.tech')
    expect(findBestSpy).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ server: 'beacon-node-1.octez.io', timestamp: 444443 })
  })

  it('uses stored MATRIX_SELECTED_NODE when matrixNodes is omitted and stored node is in default ENABLED_RELAY_SERVERS', async () => {
    const storage = new TestStorage()
    await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'beacon-node-1.octez.io')
    const deleteSpy = vi.spyOn(storage, 'delete')

    const keys = await getKeypairFromSeed('relay-validation-seed-default-valid')
    const client = new P2PCommunicationClient('RelayTest', keys, 2, storage)

    const getBeaconInfoSpy = vi
      .spyOn(client as unknown as { getBeaconInfo: (server: string) => Promise<{ region: string; known_servers: string[]; timestamp: number }> }, 'getBeaconInfo')
      .mockResolvedValue({
        region: Regions.EUROPE_WEST,
        known_servers: ['beacon-node-1.octez.io'],
        timestamp: 444444
      })

    const findBestSpy = vi.spyOn(client, 'findBestRegionAndGetServer')

    const result = await client.getRelayServer()

    expect(deleteSpy).not.toHaveBeenCalled()
    expect(getBeaconInfoSpy).toHaveBeenCalledWith('beacon-node-1.octez.io')
    expect(findBestSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ server: 'beacon-node-1.octez.io', timestamp: 444444 })
  })

  it('uses stored MATRIX_SELECTED_NODE when ENABLED_RELAY_SERVERS has an undefined region value', async () => {
    const storage = new TestStorage()
    await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'undefined-region-stored-node.example.com')
    const deleteSpy = vi.spyOn(storage, 'delete')

    const keys = await getKeypairFromSeed('relay-validation-seed-4b')
    const client = new P2PCommunicationClient('RelayTest', keys, 2, storage, {
      [Regions.EUROPE_WEST]: undefined as unknown as string[]
    })

    const getBeaconInfoSpy = vi
      .spyOn(client as unknown as { getBeaconInfo: (server: string) => Promise<{ region: string; known_servers: string[]; timestamp: number }> }, 'getBeaconInfo')
      .mockResolvedValue({
        region: Regions.EUROPE_WEST,
        known_servers: ['undefined-region-stored-node.example.com'],
        timestamp: 444445
      })

    const findBestSpy = vi.spyOn(client, 'findBestRegionAndGetServer')

    const result = await client.getRelayServer()

    expect(deleteSpy).not.toHaveBeenCalled()
    expect(getBeaconInfoSpy).toHaveBeenCalledWith('undefined-region-stored-node.example.com')
    expect(findBestSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ server: 'undefined-region-stored-node.example.com', timestamp: 444445 })
  })

  it('uses stored MATRIX_SELECTED_NODE when configured with multi-region ENABLED_RELAY_SERVERS and stored node is in a non-first region', async () => {
    const storage = new TestStorage()
    await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'na-node-2.example.com')
    const deleteSpy = vi.spyOn(storage, 'delete')

    const keys = await getKeypairFromSeed('relay-validation-seed-5')
    const client = new P2PCommunicationClient('RelayTest', keys, 2, storage, {
      [Regions.EUROPE_WEST]: ['eu-node-1.example.com'],
      [Regions.NORTH_AMERICA_EAST]: ['na-node-1.example.com', 'na-node-2.example.com'],
      [Regions.ASIA_EAST]: ['asia-node-1.example.com']
    })

    const getBeaconInfoSpy = vi
      .spyOn(client as unknown as { getBeaconInfo: (server: string) => Promise<{ region: string; known_servers: string[]; timestamp: number }> }, 'getBeaconInfo')
      .mockResolvedValue({
        region: Regions.NORTH_AMERICA_EAST,
        known_servers: ['na-node-2.example.com'],
        timestamp: 555555
      })

    const findBestSpy = vi.spyOn(client, 'findBestRegionAndGetServer')

    const result = await client.getRelayServer()

    expect(deleteSpy).not.toHaveBeenCalled()
    expect(getBeaconInfoSpy).toHaveBeenCalledWith('na-node-2.example.com')
    expect(findBestSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ server: 'na-node-2.example.com', timestamp: 555555 })
  })

  it('deletes stale MATRIX_SELECTED_NODE and calls findBestRegionAndGetServer when stored node is not in any region of multi-region ENABLED_RELAY_SERVERS', async () => {
    const storage = new TestStorage()
    await storage.set(StorageKey.MATRIX_SELECTED_NODE, 'stale-multi-region.example.com')
    const deleteSpy = vi.spyOn(storage, 'delete')

    const keys = await getKeypairFromSeed('relay-validation-seed-6')
    const client = new P2PCommunicationClient('RelayTest', keys, 2, storage, {
      [Regions.EUROPE_WEST]: ['eu-node-1.example.com'],
      [Regions.NORTH_AMERICA_EAST]: ['na-node-1.example.com', 'na-node-2.example.com'],
      [Regions.ASIA_EAST]: ['asia-node-1.example.com']
    })

    const getBeaconInfoSpy = vi
      .spyOn(client as unknown as { getBeaconInfo: (server: string) => Promise<{ region: string; known_servers: string[]; timestamp: number }> }, 'getBeaconInfo')
      .mockResolvedValue({
        region: Regions.NORTH_AMERICA_EAST,
        known_servers: ['na-node-1.example.com'],
        timestamp: 666666
      })

    const findBestSpy = vi
      .spyOn(client, 'findBestRegionAndGetServer')
      .mockResolvedValue({ server: 'na-node-1.example.com', timestamp: 666666 })

    const result = await client.getRelayServer()

    expect(deleteSpy).toHaveBeenCalledWith(StorageKey.MATRIX_SELECTED_NODE)
    expect(getBeaconInfoSpy).not.toHaveBeenCalledWith('stale-multi-region.example.com')
    expect(findBestSpy).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ server: 'na-node-1.example.com', timestamp: 666666 })
    await expect(storage.get(StorageKey.MATRIX_SELECTED_NODE)).resolves.toBe('na-node-1.example.com')
  })
})
