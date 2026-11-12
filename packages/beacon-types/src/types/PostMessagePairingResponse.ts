import { ExtendedPeerInfo, PeerInfo } from './PeerInfo'

/**
 * @internalapi
 */
export class PostMessagePairingResponse implements PeerInfo {
  public readonly type: string = 'postmessage-pairing-response'
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
export class ExtendedPostMessagePairingResponse
  extends PostMessagePairingResponse
  implements ExtendedPeerInfo
{
  public senderId: string
  public extensionId: string

  constructor(
    id: string,
    name: string,
    publicKey: string,
    version: string,
    senderId: string,
    extensionId: string,
    icon?: string,
    appUrl?: string
  ) {
    super(id, name, publicKey, version, icon, appUrl)
    this.senderId = senderId
    this.extensionId = extensionId
  }
}
// TODO: Rename to "WalletPeerInfo"?
