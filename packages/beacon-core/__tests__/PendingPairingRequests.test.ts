import { PendingPairingRequests } from '../src/transports/clients/PendingPairingRequests'

describe('PendingPairingRequests', () => {
  afterEach(() => vi.restoreAllMocks())

  it('revokes every displayed request after the first acceptance', () => {
    const pending = new PendingPairingRequests()
    pending.add('one')
    pending.add('two')
    expect(pending.consume('one')).toBe(true)
    expect(pending.consume('two')).toBe(false)
    expect(pending.consume('one')).toBe(false)
  })

  it('expires requests at 30 minutes', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100)
    const pending = new PendingPairingRequests()
    pending.add('one')
    now.mockReturnValue(100 + 30 * 60 * 1000)
    expect(pending.hasPending()).toBe(false)
    expect(pending.consume('one')).toBe(false)
  })

  it('bounds pending requests and drops the oldest', () => {
    const pending = new PendingPairingRequests()
    for (let i = 0; i < 33; i++) pending.add(String(i))
    expect(pending.consume('0')).toBe(false)
    expect(pending.consume('32')).toBe(true)
  })

  it('does not restore requests after cancellation during issuance', () => {
    const pending = new PendingPairingRequests()
    const generation = pending.generation
    pending.clear()
    expect(() => pending.add('one', generation)).toThrow('cancelled')
  })

  it('does not restore capabilities after reloading a client', () => {
    const pending = new PendingPairingRequests()
    pending.add('one')
    expect(new PendingPairingRequests().consume('one')).toBe(false)
  })
})
