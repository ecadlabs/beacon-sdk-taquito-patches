import { describe, expect, it } from 'vitest'
import { broadcastErrorData } from '../../src/dapp-client/broadcast-messages'

describe('broadcast diagnostic copies', () => {
  it('copies repeated acyclic references by value', () => {
    const shared = { phase: 'pending' }
    const original = { first: shared, second: shared }
    const copied = broadcastErrorData(original)
    expect(copied).toEqual(original)
    expect(copied).not.toBe(original)
    if (
      typeof copied !== 'object' ||
      copied === null ||
      !('first' in copied) ||
      !('second' in copied)
    ) {
      throw new Error('Expected copied diagnostic fields')
    }
    expect(copied.first).not.toBe(shared)
    expect(copied.first).not.toBe(copied.second)
  })

  it('retains an own __proto__ field without changing the output prototype', () => {
    const original: unknown = JSON.parse('{"__proto__":{"polluted":true},"value":1}')
    const copied = broadcastErrorData(original)
    expect(copied).toEqual(original)
    if (typeof copied !== 'object' || copied === null) {
      throw new Error('Expected copied diagnostic record')
    }
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(copied, '__proto__')?.value).toEqual({ polluted: true })
    expect('polluted' in copied).toBe(false)
  })
})
