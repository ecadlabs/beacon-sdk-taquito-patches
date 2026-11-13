/** @vitest-environment node */

import {
  getDebugEnabled,
  setDebugEnabled,
  MessageBasedClient,
  InternalLogger,
  Logger,
  reportDiagnostic,
  setLogger,
  type LoggerDiagnostic,
  type LoggerInterface
} from '../src'
import { getKeypairFromSeed } from '@ecadlabs/beacon-utils'

const originalDebug = getDebugEnabled()
const makeSink = (): LoggerInterface => ({
  debug: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  time: vi.fn(),
  timeLog: vi.fn()
})
const failure = new Error('identity storage failed')
const diagnostic: LoggerDiagnostic = {
  level: 'error',
  service: 'BeaconClient',
  method: 'initSDK',
  args: [failure]
}

beforeEach(() => {
  setLogger(new InternalLogger())
  setDebugEnabled(false)
  for (const method of [
    'log',
    'warn',
    'error',
    'debug',
    'group',
    'groupCollapsed',
    'groupEnd'
  ] as const) {
    vi.spyOn(console, method).mockImplementation(() => undefined)
  }
})
afterEach(() => {
  setLogger(new InternalLogger())
  setDebugEnabled(originalDebug)
  vi.restoreAllMocks()
})

it('preserves native diagnostic levels and arguments regardless of debug mode', () => {
  for (const debug of [false, true]) {
    setDebugEnabled(debug)
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.clearAllMocks()
      reportDiagnostic({ ...diagnostic, level, args: ['startup failed', failure] })
      expect(console[level], `${level} with debug=${debug}`).toHaveBeenCalledExactlyOnceWith(
        'startup failed',
        failure
      )
      expect(console.group).not.toHaveBeenCalled()
      for (const other of ['log', 'warn', 'error'] as const) {
        if (other !== level) expect(console[other]).not.toHaveBeenCalled()
      }
    }
  }
})

it('keeps ordinary logger output gated when debugging is disabled', () => {
  const logger = new Logger('Probe')
  logger.debug('debug', failure)
  logger.log('log', failure)
  logger.warn('warn', failure)
  logger.error('error', failure)
  expect(console.debug).not.toHaveBeenCalled()
  expect(console.log).not.toHaveBeenCalled()
  expect(console.warn).not.toHaveBeenCalled()
  expect(console.error).not.toHaveBeenCalled()
})

it('uses the current legacy or structured custom sink exactly once', () => {
  const first = makeSink()
  const structured = vi.fn<(event: LoggerDiagnostic) => void>()
  const second = { ...makeSink(), diagnostic: structured }
  const report = reportDiagnostic
  setLogger(first)
  report(diagnostic)
  expect(first.error).toHaveBeenCalledExactlyOnceWith('BeaconClient', 'initSDK', [failure])
  setLogger(second)
  report(diagnostic)
  expect(structured).toHaveBeenCalledExactlyOnceWith(diagnostic)
  expect(structured.mock.contexts[0]).toBe(second)
  expect(structured.mock.calls[0][0].args[0]).toBe(failure)
  expect(second.error).not.toHaveBeenCalled()
  expect(first.error).toHaveBeenCalledTimes(1)
  expect(console.error).not.toHaveBeenCalled()
})

it('respects severity overrides on a custom InternalLogger subclass', () => {
  const calls = vi.fn()
  class CustomLogger extends InternalLogger {
    public override error(name: string, method: string, ...args: unknown[]): void {
      calls(name, method, ...args)
    }
  }
  setLogger(new CustomLogger())
  reportDiagnostic(diagnostic)
  expect(calls).toHaveBeenCalledExactlyOnceWith('BeaconClient', 'initSDK', [failure])
  expect(console.error).not.toHaveBeenCalled()
})

it('preserves the original diagnostic if a custom sink throws', () => {
  const rejected = () => {
    throw new Error('custom sink failed')
  }
  for (const sink of [
    { ...makeSink(), error: rejected },
    { ...makeSink(), diagnostic: rejected }
  ]) {
    vi.clearAllMocks()
    setLogger(sink)
    expect(() => reportDiagnostic(diagnostic)).not.toThrow()
    expect(console.error).toHaveBeenCalledExactlyOnceWith(failure)
  }
})

it('routes a detached constructor failure through the configured sink without debug', async () => {
  class RejectingMessageClient extends MessageBasedClient {
    protected readonly activeListeners = new Map<string, unknown>()
    public async init(): Promise<void> {
      throw failure
    }
    public async sendMessage(): Promise<void> {
      throw new Error('Not used by this fixture')
    }
  }
  const sink = makeSink()
  setLogger(sink)
  new RejectingMessageClient('Fixture', await getKeypairFromSeed('logger-diagnostic-fixture'))
  await vi.waitFor(() =>
    expect(sink.error).toHaveBeenCalledExactlyOnceWith('MessageBasedClient', 'init', [failure])
  )
  expect(console.error).not.toHaveBeenCalled()
})

it('observes rejected asynchronous diagnostic sinks and preserves the original failure', async () => {
  const rejected = async () => {
    throw new Error('asynchronous sink failed')
  }
  class AsyncLogger extends InternalLogger {
    public override async error(): Promise<void> {
      throw new Error('subclass sink failed')
    }
  }
  for (const sink of [
    { ...makeSink(), error: rejected },
    { ...makeSink(), diagnostic: rejected },
    new AsyncLogger()
  ]) {
    vi.clearAllMocks()
    setLogger(sink)
    reportDiagnostic(diagnostic)
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledExactlyOnceWith(failure))
  }
})
