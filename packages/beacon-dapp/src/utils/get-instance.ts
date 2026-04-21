import { DAppClient } from '../dapp-client/DAppClient'
import { DAppClientOptions } from '../dapp-client/DAppClientOptions'

let _instance: DAppClient | undefined

/** Get a DAppClient instance. Will make sure only one dAppClient exists. After the first instance has been created, the config will be ignored, unless "reset" is set */
export const getDAppClientInstance = (config: DAppClientOptions, reset?: boolean): DAppClient => {
  if (_instance && reset) {
    // sync API — kick off cleanup but surface failures rather than swallow.
    _instance.disconnect().catch((error) => console.error('[DAppClient] disconnect on reset failed', error))
    _instance = undefined
  }

  if (_instance) {
    return _instance
  }

  if (!_instance) {
    _instance = new DAppClient(config)
  }

  return _instance
}
