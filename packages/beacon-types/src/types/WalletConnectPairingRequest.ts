import { ExtendedPeerInfo, PeerInfo } from './PeerInfo'

/**
 * @internalapi
 */
export class WalletConnectPairingRequest implements PeerInfo {
  public readonly type: string = 'walletconnect-pairing-request'
  public uri: string
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
    uri: string,
    icon?: string,
    appUrl?: string
  ) {
    this.id = id
    this.name = name
    this.icon = icon
    this.appUrl = appUrl
    this.publicKey = publicKey
    this.version = version
    this.uri = uri
  }
}

/**
 * @internalapi
 */
export class ExtendedWalletConnectPairingRequest
  extends WalletConnectPairingRequest
  implements ExtendedPeerInfo
{
  public senderId: string

  constructor(
    id: string,
    name: string,
    publicKey: string,
    version: string,
    senderId: string,
    uri: string,
    icon?: string,
    appUrl?: string
  ) {
    super(id, name, publicKey, version, uri, icon, appUrl)
    this.senderId = senderId
  }
}
