import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InternalLogger,
  LocalStorage,
  setLogger,
  windowRef,
  type LoggerDiagnostic
} from '@ecadlabs/beacon-core'
import { NetworkType } from '@ecadlabs/beacon-types'
import { getDAppClientInstance } from '../../src/utils/get-instance'
import type { DAppClient } from '../../src/dapp-client/DAppClient'

describe('getDAppClientInstance config mismatch warning (09-C)', () => {
  let diagnostics: LoggerDiagnostic[]
  let createdClients: DAppClient[]

  beforeEach(() => {
    localStorage.clear()
    windowRef.beaconCreatedClientInstance = false
    diagnostics = []
    createdClients = []
    setLogger({
      debug: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      time: vi.fn(),
      timeLog: vi.fn(),
      diagnostic: (entry: LoggerDiagnostic) => {
        diagnostics.push(entry)
      }
    })
  })

  afterEach(async () => {
    setLogger(new InternalLogger())
    for (const client of createdClients) {
      if (!client.isDestroyed()) {
        await client.destroy()
      }
    }
    localStorage.clear()
    windowRef.beaconCreatedClientInstance = false
  })

  it('does not warn when called a second time with a matching config', () => {
    const first = getDAppClientInstance(
      {
        name: 'MyDApp',
        storage: new LocalStorage('get-instance-match'),
        network: { type: NetworkType.MAINNET },
        disableDefaultEvents: true,
        walletConnectOptions: { projectId: 'test-project-id' }
      },
      true
    )
    createdClients.push(first)
    diagnostics.length = 0

    const second = getDAppClientInstance({
      name: 'MyDApp',
      network: { type: NetworkType.MAINNET },
      disableDefaultEvents: true,
      walletConnectOptions: { projectId: 'test-project-id' }
    })

    expect(second).toBe(first)
    expect(
      diagnostics.filter(
        (d) => d.service === 'DAppClient' && d.method === 'getDAppClientInstance' && d.level === 'warn'
      )
    ).toHaveLength(0)
  })

  it('emits a reportDiagnostic warning and returns the existing instance when called with a different name or network without reset', () => {
    const first = getDAppClientInstance(
      {
        name: 'FirstDApp',
        storage: new LocalStorage('get-instance-mismatch'),
        network: { type: NetworkType.MAINNET, rpcUrl: 'https://mainnet.example.tezos.com' },
        disableDefaultEvents: true,
        walletConnectOptions: { projectId: 'test-project-id' }
      },
      true
    )
    createdClients.push(first)
    diagnostics.length = 0

    const secondByName = getDAppClientInstance({
      name: 'SecondDApp',
      network: { type: NetworkType.MAINNET, rpcUrl: 'https://mainnet.example.tezos.com' },
      disableDefaultEvents: true,
      walletConnectOptions: { projectId: 'test-project-id' }
    })

    expect(secondByName).toBe(first)
    const nameWarnings = diagnostics.filter(
      (d) => d.service === 'DAppClient' && d.method === 'getDAppClientInstance' && d.level === 'warn'
    )
    expect(nameWarnings).toHaveLength(1)

    diagnostics.length = 0
    const thirdByNetwork = getDAppClientInstance({
      name: 'FirstDApp',
      network: { type: NetworkType.GHOSTNET },
      disableDefaultEvents: true,
      walletConnectOptions: { projectId: 'test-project-id' }
    })

    expect(thirdByNetwork).toBe(first)
    const networkWarnings = diagnostics.filter(
      (d) => d.service === 'DAppClient' && d.method === 'getDAppClientInstance' && d.level === 'warn'
    )
    expect(networkWarnings).toHaveLength(1)

    diagnostics.length = 0
    const fourthByRpcUrl = getDAppClientInstance({
      name: 'FirstDApp',
      network: { type: NetworkType.MAINNET, rpcUrl: 'https://other-rpc.example.tezos.com' },
      disableDefaultEvents: true,
      walletConnectOptions: { projectId: 'test-project-id' }
    })

    expect(fourthByRpcUrl).toBe(first)
    const rpcWarnings = diagnostics.filter(
      (d) => d.service === 'DAppClient' && d.method === 'getDAppClientInstance' && d.level === 'warn'
    )
    expect(rpcWarnings).toHaveLength(1)
  })

  it('does not emit a config mismatch warning when called with reset: true', () => {
    const first = getDAppClientInstance(
      {
        name: 'FirstDApp',
        storage: new LocalStorage('get-instance-reset-1'),
        network: { type: NetworkType.MAINNET },
        disableDefaultEvents: true,
        walletConnectOptions: { projectId: 'test-project-id' }
      },
      true
    )
    createdClients.push(first)
    diagnostics.length = 0

    const second = getDAppClientInstance(
      {
        name: 'ResetDApp',
        storage: new LocalStorage('get-instance-reset-2'),
        network: { type: NetworkType.GHOSTNET },
        disableDefaultEvents: true,
        walletConnectOptions: { projectId: 'test-project-id' }
      },
      true
    )
    createdClients.push(second)

    expect(second).not.toBe(first)
    expect(second.name).toBe('ResetDApp')
    expect(second.network.type).toBe(NetworkType.GHOSTNET)
    expect(
      diagnostics.filter(
        (d) => d.service === 'DAppClient' && d.method === 'getDAppClientInstance' && d.level === 'warn'
      )
    ).toHaveLength(0)
  })
})
