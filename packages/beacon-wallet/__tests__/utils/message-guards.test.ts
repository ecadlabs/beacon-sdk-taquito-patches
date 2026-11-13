import { describe, it, expect, expectTypeOf } from 'vitest'
import {
  BeaconMessageType,
  NetworkType,
  PermissionScope,
  type BeaconMessageEnvelopeV3,
  type BeaconRequestOutputMessage,
  type PermissionRequestOutput
} from '@ecadlabs/beacon-types'
import {
  isV3Envelope,
  isBeaconMessageType,
  type WalletRequestOutputMessage
} from '../../src'

const asWalletRequest = (
  message: WalletRequestOutputMessage
): WalletRequestOutputMessage => message

describe('message-guards public exports', () => {
  const v3Envelope: BeaconMessageEnvelopeV3 = {
    id: 'req-v3-1',
    version: '3',
    senderId: 'dapp-sender',
    message: {
      type: BeaconMessageType.PermissionRequest
    }
  }

  const v2Request: PermissionRequestOutput = {
    id: 'req-v2-1',
    version: '2',
    senderId: 'dapp-sender',
    type: BeaconMessageType.PermissionRequest,
    appMetadata: { senderId: 'dapp-sender', name: 'DApp V2' },
    network: { type: NetworkType.MAINNET },
    scopes: [PermissionScope.SIGN]
  }

  it('returns true for a valid BeaconMessageEnvelopeV3 and narrows WalletRequestOutputMessage to BeaconMessageEnvelopeV3', () => {
    const message = asWalletRequest(v3Envelope)

    expect(isV3Envelope(message)).toBe(true)

    if (isV3Envelope(message)) {
      expectTypeOf(message).toEqualTypeOf<BeaconMessageEnvelopeV3>()
      expect(message.version).toBe('3')
      expect(message.message.type).toBe(BeaconMessageType.PermissionRequest)
    } else {
      expect.unreachable('Expected V3 envelope branch')
    }
  })

  it('returns false for a V2 BeaconRequestOutputMessage and narrows WalletRequestOutputMessage to BeaconRequestOutputMessage', () => {
    const message = asWalletRequest(v2Request)

    expect(isV3Envelope(message)).toBe(false)

    if (isV3Envelope(message)) {
      expect.unreachable('Expected V2 request branch')
    } else {
      expectTypeOf(message).toEqualTypeOf<BeaconRequestOutputMessage>()
      expect(message.type).toBe(BeaconMessageType.PermissionRequest)
      expect(message.appMetadata.name).toBe('DApp V2')
    }
  })

  it('returns false for malformed or non-V3 values', () => {
    expect(isV3Envelope(null)).toBe(false)
    expect(isV3Envelope(undefined)).toBe(false)
    expect(isV3Envelope('not-an-envelope')).toBe(false)
    expect(isV3Envelope([])).toBe(false)
    expect(
      isV3Envelope({
        id: 'req-1',
        version: '2',
        senderId: 'dapp-sender',
        message: { type: BeaconMessageType.PermissionRequest }
      })
    ).toBe(false)
    expect(
      isV3Envelope({
        id: 'req-1',
        version: '3',
        senderId: 'dapp-sender',
        message: {}
      })
    ).toBe(false)
  })

  it('exports isBeaconMessageType and validates BeaconMessageType values', () => {
    const rawType: unknown = BeaconMessageType.OperationRequest

    expect(isBeaconMessageType(rawType)).toBe(true)
    if (isBeaconMessageType(rawType)) {
      expectTypeOf(rawType).toEqualTypeOf<BeaconMessageType>()
    }

    expect(isBeaconMessageType('invalid_message_type')).toBe(false)
    expect(isBeaconMessageType(null)).toBe(false)
  })
})
