import { reportDiagnostic } from '@ecadlabs/beacon-core'
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
      .catch((error: unknown) =>
      reportDiagnostic({
        level: 'error',
        service: 'DAppClient',
        method: 'getDAppClientInstance',
        args: ['[DAppClient] disconnect on reset failed', error]
      })
    )
    instance = undefined
  }

  if (instance) {
    const requestedNetworkType = config.network?.type ?? config.preferredNetwork
    const hasConfigMismatch =
      config.name !== instance.name ||
      (requestedNetworkType !== undefined && requestedNetworkType !== instance.network.type) ||
      (config.network?.name !== undefined && config.network.name !== instance.network.name) ||
      (config.network?.rpcUrl !== undefined && config.network.rpcUrl !== instance.network.rpcUrl)
    if (hasConfigMismatch) {
      reportDiagnostic({
        level: 'warn',
        service: 'DAppClient',
        method: 'getDAppClientInstance',
        args: [
          '[DAppClient] getDAppClientInstance called with a different config while an instance already exists; returning existing instance without applying new config. Pass reset: true to recreate.',
          {
            existing: { name: instance.name, network: instance.network },
            requested: {
              name: config.name,
              network:
                config.network ??
                (config.preferredNetwork ? { type: config.preferredNetwork } : undefined)
            }
          }
        ]
      })
    }

    return instance
  }

  if (!instance) {
    instance = new DAppClient(config)
  }

  return instance
}
