import { ExposedPromise, ExposedPromiseStatus } from '../../src/utils/exposed-promise'
import { generateGUID } from '../../src/utils/generate-uuid'
import { keys } from '../../src/utils/keys'
import { toHex, getAddressFromPublicKey, isValidAddress } from '../../src/utils/crypto'

describe('utility contracts', () => {
  it('starts pending and preserves the first resolution', async () => {
    const p = new ExposedPromise<number>()
    expect(p.status).toBe(ExposedPromiseStatus.PENDING)
    expect([p.isPending(), p.isResolved(), p.isRejected(), p.isSettled()]).toEqual([
      true,
      false,
      false,
      false
    ])
    expect(p.promiseResult).toBeUndefined()
    expect(p.promiseError).toBeUndefined()
    p.resolve(42)
    p.resolve(7)
    p.reject(new Error('late'))
    await expect(p.promise).resolves.toBe(42)
    expect(p.status).toBe(ExposedPromiseStatus.RESOLVED)
    expect([p.isPending(), p.isResolved(), p.isRejected(), p.isSettled()]).toEqual([
      false,
      true,
      false,
      true
    ])
    expect(p.promiseResult).toBe(42)
    expect(p.promiseError).toBeUndefined()
  })
  it('preserves the first rejection and exposes its reason', async () => {
    const p = new ExposedPromise<number, Error>()
    const error = new Error('rejected')
    const result = expect(p.promise).rejects.toBe(error)
    p.reject(error)
    p.reject(new Error('late'))
    p.resolve(42)
    await result
    expect(p.status).toBe(ExposedPromiseStatus.REJECTED)
    expect([p.isPending(), p.isResolved(), p.isRejected(), p.isSettled()]).toEqual([
      false,
      false,
      true,
      true
    ])
    expect(p.promiseError).toBe(error)
    expect(p.promiseResult).toBeUndefined()
  })
  it('creates settled promises using the static factories', async () => {
    await expect(ExposedPromise.resolve('value').promise).resolves.toBe('value')
    await expect(ExposedPromise.reject('reason').promise).rejects.toBe('reason')
  })
  it('generates distinct GUIDs in the documented hexadecimal format', async () => {
    const ids = await Promise.all(Array.from({ length: 100 }, () => generateGUID()))
    expect(new Set(ids).size).toBe(100)
    ids.forEach((id) => expect(id).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/))
  })
  it('returns own enumerable keys', () => {
    expect(keys({ first: 1, second: 2 })).toEqual(['first', 'second'])
    expect(keys({})).toEqual([])
  })
  // Tezos and buffer helpers live in crypto.ts on this branch, not tz.ts or buffer.ts.
  it.each([
    ['hello', '68656c6c6f'],
    ['', ''],
    [new Uint8Array([0, 128, 255]), '0080ff'],
    [new Uint8Array([1, 255]).buffer, '01ff']
  ])('encodes %s as hex', (input, expected) => {
    expect(toHex(input)).toBe(expected)
  })
  it('derives a Tezos address and rejects malformed addresses', async () => {
    const address = await getAddressFromPublicKey(
      'edpkuSLWfVU1Vq7Jg9FucPyKmma6otcMHac9zG4oU1KMHSTBpJuGQ2'
    )
    expect(address).toBe('tz1TGu6TN5GSez2ndXXeDX6LgUDvLzPLqgYV')
    expect(isValidAddress(address)).toBe(true)
    expect(isValidAddress('tz1invalid')).toBe(false)
  })
})
