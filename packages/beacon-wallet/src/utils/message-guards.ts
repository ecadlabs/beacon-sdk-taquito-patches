import { BeaconMessageType, type BeaconMessageEnvelopeV3 } from '@ecadlabs/beacon-types'

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isBeaconMessageType = (value: unknown): value is BeaconMessageType =>
  Object.values<unknown>(BeaconMessageType).includes(value)

/** Validate the envelope only; chain-specific fields remain unknown. */
export const isV3Envelope = (value: unknown): value is BeaconMessageEnvelopeV3 => {
  if (!isRecord(value)) {
    return false
  }

  const message = value.message

  return (
    value.version === '3' &&
    typeof value.id === 'string' &&
    typeof value.senderId === 'string' &&
    isRecord(message) &&
    'type' in message
  )
}
