import { describe, it, expect } from 'vitest'
import {
  BeaconMessageType,
  BeaconErrorType,
  RequestErrorResponse
} from '@ecadlabs/beacon-types'
import {
  BeaconError,
  getError,
  AbortedBeaconError,
  BroadcastBeaconError,
  NetworkNotSupportedBeaconError,
  NoAddressBeaconError,
  NoPrivateKeyBeaconError,
  NotGrantedBeaconError,
  ParametersInvalidBeaconError,
  PeerUnreachableBeaconError,
  SignatureTypeNotSupportedBeaconError,
  TooManyOperationsBeaconError,
  TransactionInvalidBeaconError,
  UnknownBeaconError,
  isBeaconError,
  isRequestErrorResponse,
  isTezosRpcError
} from '../../src'
import {
  isBeaconError as isBeaconErrorFromTypes,
  isRequestErrorResponse as isRequestErrorResponseFromTypes,
  isTezosRpcError as isTezosRpcErrorFromTypes
} from '@ecadlabs/beacon-types'

describe('BeaconError hierarchy and runtime behavior', () => {
  const errorMappings: Array<{
    errorType: BeaconErrorType
    subclass: new (...args: any[]) => BeaconError
  }> = [
    { errorType: BeaconErrorType.ABORTED_ERROR, subclass: AbortedBeaconError },
    { errorType: BeaconErrorType.BROADCAST_ERROR, subclass: BroadcastBeaconError },
    { errorType: BeaconErrorType.NETWORK_NOT_SUPPORTED, subclass: NetworkNotSupportedBeaconError },
    { errorType: BeaconErrorType.NO_ADDRESS_ERROR, subclass: NoAddressBeaconError },
    { errorType: BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR, subclass: NoPrivateKeyBeaconError },
    { errorType: BeaconErrorType.NOT_GRANTED_ERROR, subclass: NotGrantedBeaconError },
    { errorType: BeaconErrorType.PARAMETERS_INVALID_ERROR, subclass: ParametersInvalidBeaconError },
    { errorType: BeaconErrorType.PEER_UNREACHABLE, subclass: PeerUnreachableBeaconError },
    { errorType: BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED, subclass: SignatureTypeNotSupportedBeaconError },
    { errorType: BeaconErrorType.TOO_MANY_OPERATIONS, subclass: TooManyOperationsBeaconError },
    { errorType: BeaconErrorType.TRANSACTION_INVALID_ERROR, subclass: TransactionInvalidBeaconError },
    { errorType: BeaconErrorType.UNKNOWN_ERROR, subclass: UnknownBeaconError }
  ]

  describe('inheritance and error mapping via getError', () => {
    it.each(errorMappings)(
      'maps $errorType to an instance of Error, BeaconError, and its specific subclass',
      ({ errorType, subclass }) => {
        const error = getError(errorType, undefined)

        expect(error).toBeInstanceOf(Error)
        expect(error).toBeInstanceOf(BeaconError)
        expect(error).toBeInstanceOf(subclass)
      }
    )
  })

  describe('property exposure and metadata preservation', () => {
    const metadata = {
      id: 'test-request-id-123',
      version: '2',
      senderId: 'wallet-sender-id',
      errorOrigin: 'wallet' as const,
      errorData: [{ kind: 'temporary', id: 'proto.error' }]
    }

    it.each(errorMappings)(
      'exposes type, errorType, clean title, clean description, message, and metadata on $errorType via getError',
      ({ errorType }) => {
        const error = getError(errorType, metadata.errorData, metadata)

        expect(error.type).toBe(BeaconMessageType.Error)
        expect(error.errorType).toBe(errorType)
        expect(error.title).toBeDefined()
        expect(error.title).not.toContain(`[${errorType}]:`)
        expect(error.description).toBeDefined()
        expect(error.description).not.toContain(`[${errorType}]:`)
        expect(error.message).toBe(`[${errorType}]:${error.description}`)
        expect(error.id).toBe(metadata.id)
        expect(error.version).toBe(metadata.version)
        expect(error.senderId).toBe(metadata.senderId)
        expect(error.errorOrigin).toBe(metadata.errorOrigin)
        expect(error.errorData).toEqual(metadata.errorData)
      }
    )

    it.each(errorMappings)(
      'preserves metadata when passed directly to subclass constructor for $errorType',
      ({ errorType, subclass }) => {
        const error = new subclass(metadata)

        expect(error.type).toBe(BeaconMessageType.Error)
        expect(error.errorType).toBe(errorType)
        expect(error.id).toBe(metadata.id)
        expect(error.version).toBe(metadata.version)
        expect(error.senderId).toBe(metadata.senderId)
        expect(error.errorOrigin).toBe(metadata.errorOrigin)
        expect(error.errorData).toEqual(metadata.errorData)
      }
    )
  })

  describe('TransactionInvalidBeaconError payload exposure', () => {
    it('exposes RPC error payload on both .data and .errorData', () => {
      const rpcPayload = [{ kind: 'temporary', id: 'proto.michelson_v1.runtime_exhausted' }]
      const error = new TransactionInvalidBeaconError(rpcPayload)

      expect(error.data).toBe(rpcPayload)
      expect(error.errorData).toBe(rpcPayload)

      const fromGetError = getError(
        BeaconErrorType.TRANSACTION_INVALID_ERROR,
        rpcPayload
      ) as TransactionInvalidBeaconError

      expect(fromGetError.data).toBe(rpcPayload)
      expect(fromGetError.errorData).toBe(rpcPayload)
    })
  })

  describe('unknown errorType fallback', () => {
    it('falls back to UnknownBeaconError when given an unknown runtime errorType string', () => {
      const unknownType = 'UNKNOWN_CUSTOM_ERROR_TYPE' as unknown as BeaconErrorType
      const error = getError(unknownType, undefined)

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BeaconError)
      expect(error).toBeInstanceOf(UnknownBeaconError)
      expect(error.errorType).toBe(BeaconErrorType.UNKNOWN_ERROR)
    })
  })

  describe('runtime type guards', () => {
    const guards = [
      { name: 'beacon-core exports', isBeaconError, isRequestErrorResponse, isTezosRpcError },
      {
        name: 'beacon-types exports',
        isBeaconError: isBeaconErrorFromTypes,
        isRequestErrorResponse: isRequestErrorResponseFromTypes,
        isTezosRpcError: isTezosRpcErrorFromTypes
      }
    ]

    describe.each(guards)('$name', ({ isBeaconError: checkBeaconError, isRequestErrorResponse: checkRequestErrorResponse, isTezosRpcError: checkTezosRpcError }) => {
      describe('isBeaconError', () => {
        it('returns true for BeaconError subclasses', () => {
          expect(checkBeaconError(new UnknownBeaconError())).toBe(true)
          expect(checkBeaconError(new AbortedBeaconError())).toBe(true)
          expect(checkBeaconError(new NotGrantedBeaconError())).toBe(true)
          expect(checkBeaconError(getError(BeaconErrorType.TRANSACTION_INVALID_ERROR, undefined))).toBe(true)
        })

        it('returns false for plain Error or plain RequestErrorResponse objects', () => {
          expect(checkBeaconError(new Error('plain error'))).toBe(false)
          expect(
            checkBeaconError({
              type: BeaconMessageType.Error,
              id: 'req-1',
              errorType: BeaconErrorType.UNKNOWN_ERROR
            })
          ).toBe(false)
          expect(
            checkBeaconError({
              type: BeaconMessageType.Error,
              id: 'req-2',
              errorType: BeaconErrorType.NOT_GRANTED_ERROR,
              errorOrigin: 'wallet'
            })
          ).toBe(false)
          expect(checkBeaconError(null)).toBe(false)
          expect(checkBeaconError(undefined)).toBe(false)
          expect(checkBeaconError('some error string')).toBe(false)
          expect(checkBeaconError({})).toBe(false)
        })
      })

      describe('isRequestErrorResponse', () => {
        it('returns true for both plain RequestErrorResponse wire objects and BeaconError instances', () => {
          const plainWalletError: RequestErrorResponse = {
            type: BeaconMessageType.Error,
            id: 'req-1',
            errorType: BeaconErrorType.NOT_GRANTED_ERROR,
            errorOrigin: 'wallet'
          }
          const plainLocalError: RequestErrorResponse = {
            type: BeaconMessageType.Error,
            id: 'req-2',
            errorType: BeaconErrorType.PEER_UNREACHABLE,
            errorOrigin: 'local'
          }
          const plainWithoutOrigin: RequestErrorResponse = {
            type: BeaconMessageType.Error,
            id: 'req-3',
            errorType: BeaconErrorType.UNKNOWN_ERROR
          }

          expect(checkRequestErrorResponse(plainWalletError)).toBe(true)
          expect(checkRequestErrorResponse(plainLocalError)).toBe(true)
          expect(checkRequestErrorResponse(plainWithoutOrigin)).toBe(true)

          expect(checkRequestErrorResponse(new NotGrantedBeaconError())).toBe(true)
          expect(checkRequestErrorResponse(new PeerUnreachableBeaconError())).toBe(true)
          expect(checkRequestErrorResponse(getError(BeaconErrorType.ABORTED_ERROR, undefined))).toBe(true)
        })

        it('returns false when errorOrigin is invalid or type !== BeaconMessageType.Error', () => {
          expect(
            checkRequestErrorResponse({
              type: BeaconMessageType.Error,
              id: 'req-1',
              errorType: BeaconErrorType.NOT_GRANTED_ERROR,
              errorOrigin: 'somewhere'
            })
          ).toBe(false)

          expect(
            checkRequestErrorResponse({
              type: BeaconMessageType.Acknowledge,
              id: 'req-2',
              errorType: BeaconErrorType.NOT_GRANTED_ERROR
            })
          ).toBe(false)

          expect(checkRequestErrorResponse(new Error('plain error'))).toBe(false)
          expect(checkRequestErrorResponse(null)).toBe(false)
          expect(checkRequestErrorResponse(undefined)).toBe(false)
          expect(checkRequestErrorResponse('string error')).toBe(false)
          expect(checkRequestErrorResponse({})).toBe(false)
        })
      })

      describe('isTezosRpcError', () => {
        it('returns true when value is a non-null object with non-empty string kind and id', () => {
          expect(
            checkTezosRpcError({
              kind: 'temporary',
              id: 'proto.012-PsITHACA.michelson_v1.runtime_exhausted'
            })
          ).toBe(true)

          expect(
            checkTezosRpcError({
              kind: 'permanent',
              id: 'node.bootstrap.unknown',
              extraDetail: 123
            })
          ).toBe(true)
        })

        it('returns false when kind or id is empty, non-string, missing, or value is not an object', () => {
          expect(checkTezosRpcError({ kind: '', id: 'proto.error' })).toBe(false)
          expect(checkTezosRpcError({ kind: 'temporary', id: '' })).toBe(false)
          expect(checkTezosRpcError({ kind: 123, id: 'proto.error' })).toBe(false)
          expect(checkTezosRpcError({ kind: 'temporary', id: 456 })).toBe(false)
          expect(checkTezosRpcError({ kind: 'temporary' })).toBe(false)
          expect(checkTezosRpcError({ id: 'proto.error' })).toBe(false)
          expect(checkTezosRpcError(null)).toBe(false)
          expect(checkTezosRpcError(undefined)).toBe(false)
          expect(checkTezosRpcError('string')).toBe(false)
          expect(checkTezosRpcError(123)).toBe(false)
          expect(checkTezosRpcError([])).toBe(false)
        })
      })
    })
  })
})
