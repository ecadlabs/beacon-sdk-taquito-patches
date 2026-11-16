import { ExtendedPeerInfo, PeerInfo } from './PeerInfo'

export type WalletConnectPairingFailureReason =
  | 'superseded'
  | 'client-replaced'
  | 'retired'
  | 'initialization-unavailable'
  | 'relay-unreachable'
  | 'origin-not-allowed'
  | 'timeout'

export type WalletConnectPairingResult =
  { ok: true; uri: string } | { ok: false; reason: WalletConnectPairingFailureReason }

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
  public failureReason?: WalletConnectPairingFailureReason | undefined

  constructor(
    id: string,
    name: string,
    publicKey: string,
    version: string,
    uri: string,
    icon?: string,
    appUrl?: string,
    failureReason?: WalletConnectPairingFailureReason
  ) {
    this.id = id
    this.name = name
    this.icon = icon
    this.appUrl = appUrl
    this.publicKey = publicKey
    this.version = version
    this.uri = uri
    this.failureReason = failureReason
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
    appUrl?: string,
    failureReason?: WalletConnectPairingFailureReason
  ) {
    super(id, name, publicKey, version, uri, icon, appUrl, failureReason)
    this.senderId = senderId
  }
}
