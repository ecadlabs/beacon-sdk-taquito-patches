import { reportDiagnostic } from '@ecadlabs/beacon-core'
import { setColorMode } from '@ecadlabs/beacon-ui'
import { DAppClient } from '../dapp-client/DAppClient'
import { DAppClientOptions } from '../dapp-client/DAppClientOptions'

type UiOptionKey = 'colorMode' | 'locale' | 'direction' | 'translations'

interface UiConfigSnapshot {
  seen: Set<UiOptionKey>
  values: Partial<Pick<DAppClientOptions, UiOptionKey>>
}

const I18N_OPTION_KEYS = ['locale', 'direction', 'translations'] as const

let instance: DAppClient | undefined
let lastAppliedUiConfig: UiConfigSnapshot | undefined

const snapshotUiConfig = (config: DAppClientOptions): UiConfigSnapshot => {
  const seen = new Set<UiOptionKey>()
  const values: Partial<Pick<DAppClientOptions, UiOptionKey>> = {}
  for (const key of ['colorMode', ...I18N_OPTION_KEYS] as const) {
    if (key in config) {
      seen.add(key)
      values[key] = config[key] as never
    }
  }

  return { seen, values }
}

const takeChangedUiOption = <K extends UiOptionKey>(
  config: DAppClientOptions,
  key: K
): { changed: boolean; value: DAppClientOptions[K] } => {
  if (!(key in config)) {
    return { changed: false, value: undefined }
  }
  const nextValue = config[key]
  const unchanged =
    lastAppliedUiConfig !== undefined &&
    lastAppliedUiConfig.seen.has(key) &&
    lastAppliedUiConfig.values[key] === nextValue
  if (unchanged) {
    return { changed: false, value: nextValue }
  }
  if (lastAppliedUiConfig) {
    lastAppliedUiConfig.seen.add(key)
    lastAppliedUiConfig.values[key] = nextValue as never
  }

  return { changed: true, value: nextValue }
}

const applyRuntimeUiConfig = (client: DAppClient, config: DAppClientOptions): void => {
  const colorModeUpdate = takeChangedUiOption(config, 'colorMode')
  if (colorModeUpdate.changed && colorModeUpdate.value !== undefined) {
    setColorMode(colorModeUpdate.value)
  }

  const i18nConfig: Partial<Pick<DAppClientOptions, (typeof I18N_OPTION_KEYS)[number]>> = {}
  let hasI18nChanges = false
  for (const key of I18N_OPTION_KEYS) {
    const update = takeChangedUiOption(config, key)
    if (update.changed) {
      i18nConfig[key] = update.value as never
      hasI18nChanges = true
    }
  }

  if (hasI18nChanges) {
    client.configureI18n(i18nConfig)
  }
}

/** Get a DAppClient instance. Will make sure only one dAppClient exists. After the first instance has been created, identity/network config will be ignored unless "reset" is set, while changed UI/i18n options (colorMode, locale, direction, translations) are applied to the existing instance. */
export const getDAppClientInstance = (config: DAppClientOptions, reset?: boolean): DAppClient => {
  if (instance?.isDestroyed()) {
    instance = undefined
    lastAppliedUiConfig = undefined
  }

  if (instance && reset) {
    instance.releaseI18n()
    // sync API; kick off cleanup but surface failures rather than swallow.
    instance.disconnect().catch((error: unknown) =>
      reportDiagnostic({
        level: 'error',
        service: 'DAppClient',
        method: 'getDAppClientInstance',
        args: ['[DAppClient] disconnect on reset failed', error]
      })
    )
    instance = undefined
    lastAppliedUiConfig = undefined
  }

  if (instance) {
    applyRuntimeUiConfig(instance, config)

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
          '[DAppClient] getDAppClientInstance called with a different name/network config while an instance already exists; returning existing instance without applying new name/network config. Pass reset: true to recreate.',
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
    lastAppliedUiConfig = snapshotUiConfig(config)
  }

  return instance
}
