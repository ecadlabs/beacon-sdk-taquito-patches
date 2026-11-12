import { ExtendedPeerInfo, PeerInfo } from './PeerInfo'

/**
 * @internalapi
 */
export class P2PPairingRequest implements PeerInfo {
  public readonly type: string = 'p2p-pairing-request'
  public relayServer: string
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
    relayServer: string,
    icon?: string,
    appUrl?: string
  ) {
    this.id = id
    this.name = name
    this.icon = icon
    this.appUrl = appUrl
    this.publicKey = publicKey
    this.version = version
    this.relayServer = relayServer
  }
}

/**
 * @internalapi
 */
export class ExtendedP2PPairingRequest extends P2PPairingRequest implements ExtendedPeerInfo {
  public senderId: string

  constructor(
    id: string,
    name: string,
    publicKey: string,
    version: string,
    relayServer: string,
    senderId: string,
    icon?: string,
    appUrl?: string
  ) {
    super(id, name, publicKey, version, relayServer, icon, appUrl)
    this.senderId = senderId
  }
}
