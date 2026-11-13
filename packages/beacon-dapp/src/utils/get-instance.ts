import { DAppClient } from '../dapp-client/DAppClient'
import { DAppClientOptions } from '../dapp-client/DAppClientOptions'

let instance: DAppClient | undefined

/** Get a DAppClient instance. Will make sure only one dAppClient exists. After the first instance has been created, the config will be ignored, unless "reset" is set */
export const getDAppClientInstance = (config: DAppClientOptions, reset?: boolean): DAppClient => {
  if (instance?.isDestroyed()) {
    instance = undefined
  }

  if (instance && reset) {
    // sync API — kick off cleanup but surface failures rather than swallow.
    instance
      .disconnect()
      .catch((error) => console.error('[DAppClient] disconnect on reset failed', error))
    instance = undefined
  }

  if (instance) {
    return instance
  }

  if (!instance) {
    instance = new DAppClient(config)
  }

  return instance
}
