import { reportDiagnostic, windowRef } from '@ecadlabs/beacon-core'
import { Extension, NetworkType } from '@ecadlabs/beacon-types'
import { useEffect, useMemo, useState } from 'react'
import { getAvailableExtensions } from '../../../utils/extensions'
import { arrangeTopWallets, mergeWallets, parseWallets } from '../../../utils/wallets'
import { desktopList, extensionList, iOSList, webList } from '../wallet-lists'

const isExtensionsUpdatedMessage = (event: unknown): boolean =>
  typeof event === 'object' &&
  event !== null &&
  'data' in event &&
  event.data === 'extensionsUpdated'

export const useWallets = (networkType?: NetworkType, featuredWallets?: string[]) => {
  const [availableExtensions, setAvailableExtensions] = useState<Extension[]>([])

  // Fetch and listen for extension updates
  useEffect(() => {
    let disposed = false
    let latestRequest = 0

    const refreshExtensions = (): void => {
      const request = ++latestRequest
      getAvailableExtensions()
        .then((extensions) => {
          if (!disposed && request === latestRequest) {
            // Discovery reuses a mutable cache; each accepted refresh needs its own array.
            setAvailableExtensions([...extensions])
          }
        })
        .catch((error: unknown) => {
          reportDiagnostic({
            level: 'error',
            service: 'BeaconUIWallets',
            method: 'getAvailableExtensions',
            args: [error]
          })
        })
    }

    refreshExtensions()

    const handler = (event: unknown): void => {
      if (isExtensionsUpdatedMessage(event)) {
        refreshExtensions()
      }
    }

    windowRef.addEventListener('message', handler)

    return () => {
      disposed = true
      windowRef.removeEventListener('message', handler)
    }
  }, [])

  // Memoize wallet list creation
  const wallets = useMemo(() => {
    const merged = [
      // Desktop wallets filtered by available extensions
      ...desktopList
        .filter((w) => !availableExtensions.some((e) => w.name === e.name))
        .map((w) => ({
          id: w.key,
          key: w.key,
          name: w.shortName,
          image: w.logo,
          description: 'Desktop App',
          supportedInteractionStandards: w.supportedInteractionStandards,
          type: 'desktop' as const,
          link: w.downloadLink,
          deepLink: w.deepLink
        })),

      // Browser extensions
      ...extensionList.map((w) => ({
        id: w.id,
        key: w.key,
        name: w.shortName,
        image: w.logo,
        description: 'Browser Extension',
        supportedInteractionStandards: w.supportedInteractionStandards,
        type: 'extension' as const,
        link: w.link
      })),

      // iOS wallets
      ...iOSList.map((w) => ({
        id: w.key,
        key: w.key,
        name: w.shortName,
        image: w.logo,
        description: 'Mobile App',
        supportedInteractionStandards: w.supportedInteractionStandards,
        type: 'ios' as const,
        link: w.universalLink,
        deepLink: w.deepLink
      })),

      // Web wallets (networkType sensitive)
      ...webList
        .map((w) => {
          const link = w.links[networkType ?? NetworkType.MAINNET]

          return {
            id: w.key,
            key: w.key,
            name: w.shortName,
            image: w.logo,
            description: 'Web App',
            supportedInteractionStandards: w.supportedInteractionStandards,
            type: 'web' as const,
            link: link ?? w.links.mainnet
          }
        })
        .filter((w) => Boolean(w.link)),

      // Additional detected extensions
      ...availableExtensions
        .filter((e) => !extensionList.some((w) => w.id === e.id))
        .map((e) => {
          const link: unknown = Reflect.get(e, 'link')

          return {
            id: e.id,
            key: e.id,
            name: e.shortName ?? e.name ?? '',
            image: e.iconUrl ?? '',
            description: 'Browser Extension',
            type: 'extension' as const,
            link: typeof link === 'string' ? link : ''
          }
        })
    ]

    return arrangeTopWallets(
      mergeWallets(parseWallets(merged)),
      featuredWallets ?? ['kukai', 'temple', 'umami']
    )
  }, [availableExtensions, networkType, featuredWallets])

  // Expose both the merged wallet map and the extension probe results so the UI
  // can distinguish "known extension" from "extension actually responded".
  const walletsMap = useMemo(() => new Map(wallets.map((wallet) => [wallet.id, wallet])), [wallets])

  return { wallets: walletsMap, availableExtensions }
}
