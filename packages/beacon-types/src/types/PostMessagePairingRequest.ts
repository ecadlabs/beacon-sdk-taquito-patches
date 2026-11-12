import { ExtendedPeerInfo, PeerInfo } from './PeerInfo'

/**
 * @internalapi
 */
export class PostMessagePairingRequest implements PeerInfo {
  public readonly type: string = 'postmessage-pairing-request'
  public id: string
  public name: string
  public icon?: string | undefined
  public appUrl?: string | undefined
  public publicKey: string
  public version: string

  constructor(
    id: string,
    name: string,
    publicKey: string,
    version: string,
    icon?: string,
    appUrl?: string
  ) {
    this.id = id
    this.name = name
    this.icon = icon
    this.appUrl = appUrl
    this.publicKey = publicKey
    this.version = version
  }
}

/**
 * @internalapi
 */
export class ExtendedPostMessagePairingRequest
  extends PostMessagePairingRequest
  implements ExtendedPeerInfo
{
  public senderId: string

  constructor(
    id: string,
    name: string,
    publicKey: string,
    version: string,
    senderId: string,
    icon?: string,
    appUrl?: string
  ) {
    super(id, name, publicKey, version, icon, appUrl)
    this.senderId = senderId
  }
}
