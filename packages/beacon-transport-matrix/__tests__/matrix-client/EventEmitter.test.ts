import { Logger } from '@ecadlabs/beacon-core'
import { EventEmitter } from '../../src/matrix-client/EventEmitter'

describe('Matrix EventEmitter', () => {
  it('reports a rejected listener and still dispatches other listeners', async () => {
    const failure = new Error('handler rejected')
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const emitter = new EventEmitter<{ message: [value: string] }>()
    const nextListener = vi.fn()

    try {
      emitter.on('message', async () => {
        throw failure
      })
      emitter.on('message', nextListener)
      emitter.emit('message', 'data')
      await Promise.resolve()

      expect(nextListener).toHaveBeenCalledWith('data')
      expect(logger).toHaveBeenCalledWith('emit', 'message', failure)
    } finally {
      logger.mockRestore()
    }
  })

  it('reports an asynchronous once listener failure and removes it before the next emission', async () => {
    const failure = new Error('once handler rejected')
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const emitter = new EventEmitter<{ message: [value: string] }>()
    const listener = vi.fn().mockRejectedValue(failure)

    try {
      emitter.once('message', listener)
      emitter.emit('message', 'first')
      emitter.emit('message', 'second')
      await Promise.resolve()

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith('first')
      expect(logger).toHaveBeenCalledTimes(1)
      expect(logger).toHaveBeenCalledWith('emit', 'message', failure)
    } finally {
      logger.mockRestore()
    }
  })

  it('reports synchronous listener failures without stopping delivery', () => {
    const failure = new Error('handler threw')
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const emitter = new EventEmitter<{ message: [value: string] }>()
    const nextListener = vi.fn()

    try {
      emitter.on('message', () => {
        throw failure
      })
      emitter.on('message', nextListener)
      emitter.emit('message', 'data')

      expect(nextListener).toHaveBeenCalledWith('data')
      expect(logger).toHaveBeenCalledWith('emit', 'message', failure)
    } finally {
      logger.mockRestore()
    }
  })
})
