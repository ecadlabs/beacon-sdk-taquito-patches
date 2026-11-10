import { BeaconErrorType } from '@ecadlabs/beacon-types'
import getError from '../../src/errors/get-error'
import { PeerUnreachableBeaconError } from '../../src/errors/PeerUnreachableBeaconError'

// PEER_UNREACHABLE is produced locally by the dApp when its request deadline fires.
// The wallet is never told, so it can still show, sign and inject the request later.
// The copy must say the outcome is unknown, and must not send the user off to re-pair
// and retry, which is how a slow wallet turns into a double payment.
const TITLE = 'No Response From Wallet'
const DESCRIPTION =
  'The wallet did not respond in time. The request may still be open in the wallet and can ' +
  'still be approved there. Check the wallet and your recent account activity before trying again.'

describe('PeerUnreachableBeaconError', () => {
  it('is what getError returns for PEER_UNREACHABLE', () => {
    expect(getError(BeaconErrorType.PEER_UNREACHABLE, undefined)).toBeInstanceOf(
      PeerUnreachableBeaconError
    )
  })

  it('titles the error by what the user saw, not by transport jargon', () => {
    expect(new PeerUnreachableBeaconError().title).toBe(TITLE)
  })

  it('tells the user the request may still complete in the wallet', () => {
    const error = new PeerUnreachableBeaconError()

    expect(error.description).toBe(DESCRIPTION)
    expect(error.fullDescription).toEqual({ description: DESCRIPTION })
    expect(error.message).toBe(`[${BeaconErrorType.PEER_UNREACHABLE}]:${DESCRIPTION}`)
  })

  it('does not tell the user to reset or re-pair the connection', () => {
    const { description } = new PeerUnreachableBeaconError()

    expect(description).not.toMatch(/\bre-?pair|pair the wallet|reset the connection/i)
  })
})
