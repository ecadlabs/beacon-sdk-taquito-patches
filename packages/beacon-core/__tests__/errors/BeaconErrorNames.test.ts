import { BeaconErrorType } from '@ecadlabs/beacon-types'
import getError from '../../src/errors/get-error'

// Integrators and logs identify errors by `name`. AbortedBeaconError used to call itself
// UnknownBeaconError, which made user aborts indistinguishable from unknown failures.
describe('BeaconError names', () => {
  it.each(Object.values(BeaconErrorType))('names the %s error after its class', (errorType) => {
    const error = getError(errorType, undefined)

    expect(error.name).toBe(error.constructor.name)
  })

  it('gives every error type a distinct name', () => {
    const names = Object.values(BeaconErrorType).map(
      (errorType) => getError(errorType, undefined).name
    )

    expect(new Set(names).size).toBe(names.length)
  })
})
