import {
  BeaconErrorType,
  BeaconMessageType,
  ErrorResponse,
  OperationResponse,
  SigningType
} from '@ecadlabs/beacon-types'
import {
  classifyLateResponse,
  toRequestError,
  WireErrorMessage
} from '../../src/dapp-client/request-error'

// The error a caller gets and the error a late-response event carries are built by the same
// helper, so a dApp sees one shape for one wallet answer whichever path it arrives on.

const envelope = { id: 'one', senderId: 'wallet', version: '2' }
const hash = 'ooLateOperationHash'

function v3<T extends { type: unknown }>(message: T) {
  return { ...envelope, version: '3', message: { blockchainIdentifier: 'tezos', ...message } }
}

describe('toRequestError', () => {
  it('returns undefined for a message that is not an error', () => {
    expect(
      toRequestError(
        { ...envelope, type: BeaconMessageType.OperationResponse, transactionHash: hash },
        false
      )
    ).toBeUndefined()
    expect(
      toRequestError(
        v3({
          type: BeaconMessageType.BlockchainResponse,
          blockchainData: { transactionHash: hash }
        }),
        false
      )
    ).toBeUndefined()
  })

  // Routing used to require a string errorType, so these resolved as successes.
  it.each([
    ['V2', { ...envelope, type: BeaconMessageType.Error }],
    ['V3', v3({ type: BeaconMessageType.Error })]
  ] as const)('builds an error from a %s error message with no errorType', (_version, message) => {
    expect(toRequestError(message, false)).toEqual(
      expect.objectContaining({
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.UNKNOWN_ERROR,
        errorOrigin: 'wallet'
      })
    )
  })

  it.each([42, null, ''])('treats errorType %j as UNKNOWN_ERROR', (errorType) => {
    expect(
      toRequestError({ ...envelope, type: BeaconMessageType.Error, errorType }, false)
    ).toEqual(expect.objectContaining({ errorType: BeaconErrorType.UNKNOWN_ERROR }))
  })

  it('keeps the wallet errorType and errorData', () => {
    const error: ErrorResponse = {
      ...envelope,
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.TRANSACTION_INVALID_ERROR,
      errorData: [{ kind: 'temporary' }]
    }
    expect(toRequestError(error, false)).toEqual({ ...error, errorOrigin: 'wallet' })
  })

  it('takes id, version and senderId from a V3 envelope', () => {
    expect(
      toRequestError(
        v3({ type: BeaconMessageType.Error, errorType: BeaconErrorType.ABORTED_ERROR }),
        false
      )
    ).toEqual(
      expect.objectContaining({
        id: envelope.id,
        version: '3',
        senderId: envelope.senderId,
        errorType: BeaconErrorType.ABORTED_ERROR
      })
    )
  })

  it.each([
    ['an untrusted local claim', false, 'local', 'wallet'],
    ['a trusted local claim', true, 'local', 'local'],
    ['a trusted wallet claim', true, 'wallet', 'wallet'],
    ['a trusted malformed claim', true, 'somewhere', 'wallet'],
    ['a trusted missing claim', true, undefined, 'wallet']
  ] as const)('attributes %s', (_case, trusted, claimed, expected) => {
    const message: WireErrorMessage = {
      ...envelope,
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.PEER_UNREACHABLE,
      ...(claimed === undefined ? {} : { errorOrigin: claimed })
    }
    expect(toRequestError(message, trusted)?.errorOrigin).toBe(expected)
    expect(toRequestError(v3(message), trusted)?.errorOrigin).toBe(expected)
  })
})

describe('classifyLateResponse', () => {
  it.each([
    [
      'V2 operation',
      { ...envelope, type: BeaconMessageType.OperationResponse, transactionHash: hash },
      hash
    ],
    [
      'V2 broadcast',
      { ...envelope, type: BeaconMessageType.BroadcastResponse, transactionHash: hash },
      hash
    ],
    [
      'V2 signature',
      {
        ...envelope,
        type: BeaconMessageType.SignPayloadResponse,
        signingType: SigningType.RAW,
        signature: 'late-signature'
      },
      undefined
    ],
    [
      // Wallets add free-text fields; a V2 `message` field is not a V3 wrapper.
      'V2 operation with an extra message field',
      Object.assign<OperationResponse, { message: { note: string } }>(
        { ...envelope, type: BeaconMessageType.OperationResponse, transactionHash: hash },
        { message: { note: 'injected' } }
      ),
      hash
    ]
  ] as const)('reports a %s as a success with the message as output', (_case, message, txHash) => {
    expect(classifyLateResponse(message, false)).toEqual({
      kind: 'success',
      message,
      output: message,
      transactionHash: txHash
    })
  })

  it('reports a V3 operation as a success with the inner message as output', () => {
    const message = v3({
      type: BeaconMessageType.BlockchainResponse,
      blockchainData: { transactionHash: hash }
    })
    expect(classifyLateResponse(message, false)).toEqual({
      kind: 'success',
      message,
      output: message.message,
      transactionHash: hash
    })
  })

  // V3 blockchainData is untyped; only a non-empty string transactionHash is an operation.
  it.each([
    ['V3 signature', { signature: 'late-signature' }],
    ['V3 null payload', null],
    ['V3 string payload', 'edsigtLateSignature'],
    ['V3 empty transaction hash', { transactionHash: '' }],
    ['V3 non-string transaction hash', { transactionHash: 42 }]
  ])('reports no transaction hash for a %s', (_case, blockchainData) => {
    const result = classifyLateResponse(
      v3({ type: BeaconMessageType.BlockchainResponse, blockchainData }),
      false
    )
    expect(result.kind).toBe('success')
    expect(result.kind === 'success' ? result.transactionHash : 'not a success').toBeUndefined()
  })

  it('reports no transaction hash for an empty V2 hash', () => {
    const result = classifyLateResponse(
      { ...envelope, type: BeaconMessageType.OperationResponse, transactionHash: '' },
      false
    )
    expect(result.kind === 'success' ? result.transactionHash : 'not a success').toBeUndefined()
  })

  it('reports a V2 wallet error as an error, stamped as the rejection path stamps it', () => {
    const message: WireErrorMessage = {
      ...envelope,
      type: BeaconMessageType.Error,
      errorType: BeaconErrorType.PEER_UNREACHABLE,
      errorOrigin: 'local'
    }
    const result = classifyLateResponse(message, false)

    expect(result.kind).toBe('error')
    expect(result).toEqual({
      kind: 'error',
      message: { ...message, errorOrigin: 'wallet' },
      error: { ...message, errorOrigin: 'wallet' }
    })
  })

  it('reports a V3 wallet error with the stamp inside the envelope', () => {
    const message = v3({ type: BeaconMessageType.Error, errorOrigin: 'local' })
    const result = classifyLateResponse(message, false)

    expect(result.kind).toBe('error')
    expect(result).toEqual({
      kind: 'error',
      message: { ...message, message: { ...message.message, errorOrigin: 'wallet' } },
      error: expect.objectContaining({
        id: envelope.id,
        errorType: BeaconErrorType.UNKNOWN_ERROR,
        errorOrigin: 'wallet'
      })
    })
  })

  it('keeps a trusted local stamp', () => {
    const result = classifyLateResponse(
      {
        ...envelope,
        type: BeaconMessageType.Error,
        errorType: BeaconErrorType.ABORTED_ERROR,
        errorOrigin: 'local'
      },
      true
    )
    expect(result.kind === 'error' ? result.error.errorOrigin : 'not an error').toBe('local')
  })
})
