import { describe, expect, it } from 'vitest'
import {
  BeaconErrorType,
  BeaconMessageType,
  isErrorResponse,
  isRequestErrorResponse,
  NotGrantedBeaconError,
  TransactionInvalidBeaconError,
  getError
} from '@ecadlabs/beacon-types'

const response = {
  type: BeaconMessageType.Error,
  errorType: BeaconErrorType.NOT_GRANTED_ERROR,
  id: 'request-id',
  version: '2',
  senderId: 'wallet-sender'
}

describe('public error guards', () => {
  it.each([isErrorResponse, isRequestErrorResponse])(
    'accepts complete wire responses and BeaconError instances',
    (guard) => {
      expect(guard(response)).toBe(true)
      expect(guard(Object.assign([], response))).toBe(false)
      expect(guard(new NotGrantedBeaconError())).toBe(true)
      expect(guard({ ...response, id: '', version: '', senderId: '' })).toBe(true)
    }
  )

  it.each(['id', 'version', 'senderId'] as const)('rejects missing or non-string %s', (header) => {
    const incomplete: Record<string, unknown> = { ...response }
    delete incomplete[header]
    for (const guard of [isErrorResponse, isRequestErrorResponse]) {
      expect(guard(incomplete)).toBe(false)
      for (const value of [undefined, null, 42, {}, []]) {
        expect(guard({ ...response, [header]: value })).toBe(false)
      }
    }
  })

  it.each([
    null,
    undefined,
    [],
    {},
    'error',
    { ...response, errorType: 'FUTURE_ERROR' },
    { ...response, type: BeaconMessageType.Acknowledge }
  ])('rejects values outside the asserted error envelope: %j', (value) => {
    expect(isErrorResponse(value)).toBe(false)
    expect(isRequestErrorResponse(value)).toBe(false)
  })

  it.each([isErrorResponse, isRequestErrorResponse])(
    'does not inspect unrelated exception metadata',
    (guard) => {
      const error = new Error('driver unavailable')
      Object.defineProperty(error, 'id', {
        get() {
          throw new Error('unreadable optional id')
        }
      })
      expect(guard(error)).toBe(false)
    }
  )

  it.each(['type', 'id', 'version', 'senderId', 'errorType'] as const)(
    'rejects an unreadable %s without throwing',
    (field) => {
      const value = Object.defineProperty({ ...response }, field, {
        get() {
          throw new Error('unreadable error field')
        }
      })
      expect(isErrorResponse(value)).toBe(false)
      expect(isRequestErrorResponse(value)).toBe(false)
    }
  )

  it('contains proxy inspection failures in both public response guards', () => {
    const revoked = Proxy.revocable({ ...response }, {})
    revoked.revoke()
    const unreadable = new Proxy(response, {
      has() {
        throw new Error('unreadable response')
      }
    })
    for (const value of [revoked.proxy, unreadable]) {
      expect(isErrorResponse(value)).toBe(false)
      expect(isRequestErrorResponse(value)).toBe(false)
    }
  })

  it('rejects an unreadable request-error origin without throwing', () => {
    const value = Object.defineProperty({ ...response }, 'errorOrigin', {
      get() {
        throw new Error('unreadable origin')
      }
    })
    expect(isErrorResponse(value)).toBe(true)
    expect(isRequestErrorResponse(value)).toBe(false)
  })

  it('reads error type and origin once per guard invocation', () => {
    let codeReads = 0
    let originReads = 0
    const value = Object.defineProperties(
      { ...response },
      {
        errorType: {
          get() {
            codeReads++
            return BeaconErrorType.NOT_GRANTED_ERROR
          }
        },
        errorOrigin: {
          get() {
            originReads++
            return 'local'
          }
        }
      }
    )
    expect(isRequestErrorResponse(value)).toBe(true)
    expect(codeReads).toBe(1)
    expect(originReads).toBe(1)
  })

  it('checks request-error origin without restricting unrelated wire extensions', () => {
    for (const errorOrigin of [undefined, 'wallet', 'local']) {
      expect(isRequestErrorResponse({ ...response, errorOrigin })).toBe(true)
    }
    for (const errorOrigin of [null, 42, 'other']) {
      expect(isErrorResponse({ ...response, errorOrigin })).toBe(true)
      expect(isRequestErrorResponse({ ...response, errorOrigin })).toBe(false)
    }
  })
})

describe('transaction error legacy data and explicit options', () => {
  it.each(
    [
      { kind: 'temporary', id: 'proto.example' },
      { id: 'arbitrary-legacy-data' },
      { errorData: 'legacy-field', description: 'legacy-description' },
      [{ kind: 'temporary', id: 'proto.example' }],
      {},
      null,
      'legacy-data',
      42
    ].map((data) => ({ data }))
  )('preserves any single data argument: $data', ({ data }) => {
    const error = new TransactionInvalidBeaconError(data)
    expect(error.data).toBe(data)
    expect(error.errorData).toBe(data)
    expect(error.id).toBe('')
    expect(error.description).not.toBe('legacy-description')
  })

  it('accepts envelope metadata explicitly as the second argument', () => {
    const data = { kind: 'temporary', id: 'proto.example' }
    const options = {
      ...response,
      description: 'Invalid transaction',
      errorOrigin: 'wallet' as const
    }
    const error = new TransactionInvalidBeaconError(data, options)
    expect(error.data).toBe(data)
    expect(error.errorData).toBe(data)
    expect(error.id).toBe('request-id')
    expect(error.senderId).toBe('wallet-sender')
    expect(error.description).toBe('Invalid transaction')
    expect(error.errorOrigin).toBe('wallet')
  })

  it('accepts explicit options with omitted data', () => {
    const error = new TransactionInvalidBeaconError(undefined, {
      id: 'request-id',
      errorOrigin: 'local'
    })
    expect(error.id).toBe('request-id')
    expect(error.errorOrigin).toBe('local')
    expect(error.data).toBeUndefined()
    expect(error.errorData).toBeUndefined()
  })

  it('does not invent transaction data when omitted directly or through getError', () => {
    for (const error of [
      new TransactionInvalidBeaconError(),
      getError(BeaconErrorType.TRANSACTION_INVALID_ERROR)
    ]) {
      expect(error.errorData).toBeUndefined()
      expect(error).toBeInstanceOf(TransactionInvalidBeaconError)
      if (error instanceof TransactionInvalidBeaconError) expect(error.data).toBeUndefined()
    }
    const data = { id: 'rpc-only' }
    const error = getError(BeaconErrorType.TRANSACTION_INVALID_ERROR, undefined, {
      id: 'request-id',
      errorData: data
    })
    expect(error.id).toBe('request-id')
    expect(error.errorData).toBe(data)
    if (error instanceof TransactionInvalidBeaconError) expect(error.data).toBe(data)
  })
})
