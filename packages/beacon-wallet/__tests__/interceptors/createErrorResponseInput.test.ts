import { describe, it, expect } from 'vitest'
import { BeaconErrorType, BeaconMessageType } from '@ecadlabs/beacon-types'
import { createErrorResponseInput } from '../../src'

describe('createErrorResponseInput', () => {
  it('creates an ErrorResponseInput from a request object and BeaconErrorType', () => {
    const request = {
      id: 'req-object-1',
      senderId: 'dapp-sender',
      version: '2',
      type: BeaconMessageType.OperationRequest
    }

    const result = createErrorResponseInput(request, BeaconErrorType.NOT_GRANTED_ERROR)

    expect(result).toEqual({
      type: BeaconMessageType.Error,
      id: 'req-object-1',
      errorType: BeaconErrorType.NOT_GRANTED_ERROR
    })
  })

  it('creates an ErrorResponseInput from a request ID string and BeaconErrorType', () => {
    const result = createErrorResponseInput('req-string-2', BeaconErrorType.TRANSACTION_INVALID_ERROR)

    expect(result).toEqual({
      type: BeaconMessageType.Error,
      id: 'req-string-2',
      errorType: BeaconErrorType.TRANSACTION_INVALID_ERROR
    })
  })

  it('includes errorData when provided', () => {
    const rpcError = [{ kind: 'temporary', id: 'proto.michelson_v1.runtime_exhausted' }]
    const result = createErrorResponseInput(
      'req-string-3',
      BeaconErrorType.TRANSACTION_INVALID_ERROR,
      rpcError
    )

    expect(result).toEqual({
      type: BeaconMessageType.Error,
      id: 'req-string-3',
      errorType: BeaconErrorType.TRANSACTION_INVALID_ERROR,
      errorData: rpcError
    })
  })

  it('omits errorData when undefined or omitted', () => {
    const resultExplicitUndefined = createErrorResponseInput(
      'req-string-4',
      BeaconErrorType.NOT_GRANTED_ERROR,
      undefined
    )

    expect(resultExplicitUndefined).toEqual({
      type: BeaconMessageType.Error,
      id: 'req-string-4',
      errorType: BeaconErrorType.NOT_GRANTED_ERROR
    })
    expect(resultExplicitUndefined).not.toHaveProperty('errorData')

    const resultOmitted = createErrorResponseInput(
      'req-string-5',
      BeaconErrorType.NOT_GRANTED_ERROR
    )

    expect(resultOmitted).toEqual({
      type: BeaconMessageType.Error,
      id: 'req-string-5',
      errorType: BeaconErrorType.NOT_GRANTED_ERROR
    })
    expect(resultOmitted).not.toHaveProperty('errorData')
  })
})
