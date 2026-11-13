/** @vitest-environment node */

import { Console } from 'node:console'
import { Writable } from 'node:stream'
import { getDebugEnabled, setDebugEnabled } from '../src/debug'
import { InternalLogger, Logger, LoggerInterface, getLogger, setLogger } from '../src/utils/Logger'

type TimingCall =
  | { kind: 'timer'; start: boolean; label: string | undefined }
  | { kind: 'checkpoint'; label: string; args: unknown[] }

describe('logger timing', () => {
  const originalDebug = getDebugEnabled()
  let output: string[]
  let stream: Writable

  beforeEach(() => {
    output = []
    stream = new Writable({
      write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        if (!Buffer.isBuffer(chunk)) {
          callback(new Error('Expected console output bytes'))
          return
        }
        output.push(chunk.toString('utf8'))
        callback()
      }
    })
    const nativeConsole = new Console({ stdout: stream, stderr: stream })
    vi.spyOn(console, 'time').mockImplementation(nativeConsole.time.bind(nativeConsole))
    vi.spyOn(console, 'timeLog').mockImplementation(nativeConsole.timeLog.bind(nativeConsole))
    vi.spyOn(console, 'timeEnd').mockImplementation(nativeConsole.timeEnd.bind(nativeConsole))
    vi.spyOn(console, 'group').mockImplementation(() => undefined)
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined)
    setLogger(new InternalLogger())
    setDebugEnabled(true)
  })

  afterEach(() => {
    stream.end()
    setLogger(new InternalLogger())
    setDebugEnabled(originalDebug)
    vi.restoreAllMocks()
  })

  it('logs a checkpoint for the named native timer and keeps its payload', () => {
    const logger = new Logger('PairingService')
    logger.time(true, 'pairing')
    logger.timeLog('pairing', { status: 'waiting' })
    logger.time(false, 'pairing')

    const text = output.join('')
    expect(text.split('\n').filter((line) => line.startsWith('pairing:'))).toHaveLength(2)
    expect(text).toContain('waiting')
  })

  it('preserves the public custom logger timing and payload contract', () => {
    const calls: TimingCall[] = []
    const custom: LoggerInterface = {
      debug: () => undefined,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      time: (start, label) => {
        calls.push({ kind: 'timer', start, label })
      },
      timeLog: (label, ...args) => {
        calls.push({ kind: 'checkpoint', label, args })
      }
    }
    setLogger(custom)
    const logger = new Logger('PairingService')
    const payload = { status: 'waiting' }
    logger.time(true, 'pairing')
    logger.timeLog('pairing', payload)
    logger.time(false, 'pairing')

    expect(calls).toEqual([
      { kind: 'timer', start: true, label: 'pairing' },
      { kind: 'checkpoint', label: 'pairing', args: [[payload]] },
      { kind: 'timer', start: false, label: 'pairing' }
    ])
  })

  it('does not emit a timing checkpoint while debugging is disabled', () => {
    setDebugEnabled(false)
    new Logger('PairingService').timeLog('not-started', { status: 'waiting' })

    expect(console.timeLog).not.toHaveBeenCalled()
    expect(output).toEqual([])
  })

  it('keeps the shared logger facade attached to the current custom logger', () => {
    const facade = getLogger()
    const first = vi.fn()
    const second = vi.fn()
    const custom: LoggerInterface = {
      debug: () => undefined,
      log: first,
      warn: () => undefined,
      error: () => undefined,
      time: () => undefined,
      timeLog: () => undefined
    }
    const payload = { status: 'ready' }
    setLogger(custom)
    facade.log('first', payload)
    setLogger({ ...custom, log: second })
    expect(getLogger()).toBe(facade)
    facade.log('second', payload)
    expect(first).toHaveBeenCalledExactlyOnceWith('', 'first', [payload])
    expect(second).toHaveBeenCalledExactlyOnceWith('', 'second', [payload])
  })
})
