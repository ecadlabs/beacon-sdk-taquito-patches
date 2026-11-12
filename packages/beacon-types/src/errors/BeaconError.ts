import { BeaconErrorType } from '../types/BeaconErrorType'
import { BeaconMessageType } from '../types/beacon/BeaconMessageType'
import { ErrorOrigin } from '../types/ErrorOrigin'
import { RequestErrorResponse } from '../types/RequestErrorResponse'
import { BeaconErrorOptions } from './BeaconErrorOptions'

/**
 * @category Error
 */
export abstract class BeaconError extends Error implements RequestErrorResponse {
  public readonly type: BeaconMessageType.Error = BeaconMessageType.Error
  public readonly name: string
  public readonly errorType: BeaconErrorType
  public readonly id: string
  public readonly version: string
  public readonly senderId: string
  public readonly errorOrigin?: ErrorOrigin
  public readonly errorData?: unknown
  public readonly title: string
  public readonly description: string

  public get fullDescription(): { description: string; data?: string } {
    return { description: this.description }
  }

  constructor(
    errorType: BeaconErrorType,
    defaultDescription: string,
    defaultTitle: string = 'Error',
    name: string = 'BeaconError',
    options?: BeaconErrorOptions
  ) {
    const description = options?.description ?? defaultDescription
    const formattedMessage = `[${errorType}]:${description}`
    super(formattedMessage)
    Object.setPrototypeOf(this, new.target.prototype)

    this.name = name
    this.errorType = errorType
    this.title = defaultTitle
    this.description = description
    this.id = options?.id ?? ''
    this.version = options?.version ?? '2'
    this.senderId = options?.senderId ?? ''
    this.errorOrigin = options?.errorOrigin
    this.errorData = options?.errorData
  }
}
