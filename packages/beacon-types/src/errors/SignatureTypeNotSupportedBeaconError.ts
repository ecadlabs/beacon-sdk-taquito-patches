import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconError } from './BeaconError'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export class SignatureTypeNotSupportedBeaconError extends BeaconError {
  public override readonly name: string = 'SignatureTypeNotSupportedBeaconError'
  public override readonly title: string = 'Signature Type Not Supported'

  constructor(options?: BeaconErrorOptions) {
    super(
      BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED,
      'The wallet is not able to sign payloads of this type.',
      'Signature Type Not Supported',
      'SignatureTypeNotSupportedBeaconError',
      options
    )
  }
}
