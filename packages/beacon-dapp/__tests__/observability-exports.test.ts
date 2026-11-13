import { afterEach, describe, expect, it, vi } from 'vitest'
import { BeaconMessageType, Origin, SigningType } from '@ecadlabs/beacon-types'
import {
  DAppClient,
  getDebugEnabled,
  getLogger,
  InternalLogger,
  LocalStorage,
  Logger,
  reportDiagnostic,
  setDebugEnabled,
  setLogger,
  windowRef,
  type BeaconMessageDisposition,
  type BeaconMessageRecord,
  type LoggerDiagnostic,
  type LoggerInterface
} from '../src'

describe('@ecadlabs/beacon-dapp observability and logger root exports (09-B)', () => {
  afterEach(() => {
    setLogger(new InternalLogger())
    setDebugEnabled(false)
    localStorage.clear()
    windowRef.beaconCreatedClientInstance = false
  })

  it('re-exports Logger, InternalLogger, setLogger, getLogger, reportDiagnostic, setDebugEnabled, getDebugEnabled, and types from root index', () => {
    expect(typeof Logger).toBe('function')
    expect(typeof InternalLogger).toBe('function')
    expect(typeof setLogger).toBe('function')
    expect(typeof getLogger).toBe('function')
    expect(typeof reportDiagnostic).toBe('function')
    expect(typeof setDebugEnabled).toBe('function')
    expect(typeof getDebugEnabled).toBe('function')

    const dispositions: BeaconMessageDisposition[] = [
      'handled',
      'stale',
      'unknown-request',
      'invalid'
    ]
    expect(dispositions).toHaveLength(4)

    const sampleDiagnostic: LoggerDiagnostic = {
      level: 'warn',
      service: 'TestService',
      method: 'testMethod',
      args: ['test']
    }
    const receivedDiagnostics: LoggerDiagnostic[] = []
    const customLogger: LoggerInterface = {
      debug: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      time: vi.fn(),
      timeLog: vi.fn(),
      diagnostic: (entry) => {
        receivedDiagnostics.push(entry)
      }
    }
    setLogger(customLogger)
    reportDiagnostic(sampleDiagnostic)
    expect(receivedDiagnostics).toEqual([sampleDiagnostic])
  })

  it('routes DAppClient.handleResponse unknown-request warning to a custom logger installed via setLogger', async () => {
    const warnCalls: Array<{ service: string; method: string; args: unknown[] }> = []
    class CapturingLogger extends InternalLogger {
      public override warn(name: string, method: string, ...args: unknown[]): void {
        warnCalls.push({ service: name, method, args })
      }
    }
    setLogger(new CapturingLogger())

    const client = new DAppClient({
      name: 'ObservabilityExportTest',
      storage: new LocalStorage('obs-export-test'),
      disableDefaultEvents: true,
      walletConnectOptions: { projectId: 'test-project-id' }
    })

    const records: BeaconMessageRecord[] = []
    client.subscribeToMessages((record) => {
      records.push(record)
    })

    try {
      await (client as unknown as {
        handleResponse: (
          message: unknown,
          connectionInfo: { origin: Origin; id: string }
        ) => Promise<void>
      }).handleResponse(
        {
          id: 'unknown-req-id',
          version: '2',
          senderId: 'wallet-sender',
          type: BeaconMessageType.SignPayloadResponse,
          signingType: SigningType.RAW,
          signature: 'edsig...'
        },
        { origin: Origin.P2P, id: 'peer-pk' }
      )

      expect(
        warnCalls.some(
          (call) =>
            call.service === 'DAppClient' &&
            call.method === 'handleResponse' &&
            JSON.stringify(call.args).includes('unknown-req-id')
        )
      ).toBe(true)
    } finally {
      await client.destroy()
    }
  })
})
