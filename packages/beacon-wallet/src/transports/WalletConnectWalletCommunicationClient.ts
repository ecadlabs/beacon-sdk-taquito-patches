import { CommunicationClient } from '@ecadlabs/beacon-core'

export class WalletConnectWalletCommunicationClient extends CommunicationClient {
  public async listenForEncryptedMessage(): Promise<void> {
    // WalletWalletConnectTransport subscribes directly to SignClient events.
  }

  public async unsubscribeFromEncryptedMessage(): Promise<void> {
    // Unsubscription is handled by WalletWalletConnectTransport.
  }

  public async unsubscribeFromEncryptedMessages(): Promise<void> {
    // Unsubscription is handled by WalletWalletConnectTransport.
  }

  public async sendMessage(): Promise<void> {
    // Outbound messages are routed by WalletWalletConnectTransport.
  }
}
