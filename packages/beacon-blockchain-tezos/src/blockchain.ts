import {
  Blockchain,
  BlockchainMessage,
  PermissionResponseV3,
  ResponseInput,
  App,
  DesktopApp,
  ExtensionApp,
  WebApp
} from '@ecadlabs/beacon-types'
import { desktopList, extensionList, iOSList, webList } from './ui/alert/wallet-lists'

export class TezosBlockchain implements Blockchain {
  public readonly identifier: string = 'xtz'
  public async validateRequest(input: BlockchainMessage): Promise<void> {
    // TODO: Validation
    if (input) {
      return
    }
  }
  public async handleResponse(input: ResponseInput): Promise<void> {
    // TODO: Validation
    if (input) {
      return
    }
  }

  public async getWalletLists(): Promise<{
    extensionList: ExtensionApp[]
    desktopList: DesktopApp[]
    webList: WebApp[]
    iOSList: App[]
  }> {
    return {
      extensionList,
      desktopList,
      webList,
      iOSList
    }
  }

  public async getAccountInfosFromPermissionResponse(
    _permissionResponse: PermissionResponseV3<'tezos'>
  ): Promise<{ accountId: string; address: string; publicKey: string }[]> {
    return [{ accountId: '', address: '', publicKey: '' }]
  }
}
