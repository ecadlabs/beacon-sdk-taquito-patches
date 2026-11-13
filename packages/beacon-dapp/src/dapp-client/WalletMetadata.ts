import {
  App,
  AppMetadata,
  Origin,
  PeerInfo,
  StoredAccountInfo,
  DesktopApp,
  ExtensionApp,
  NetworkType,
  StorageKey,
  StorageKeyReturnType,
  WalletInfo,
  WebApp
} from '@ecadlabs/beacon-types'

type StoredWallet = StorageKeyReturnType[StorageKey.LAST_SELECTED_WALLET]

type RegistryApp = App | WebApp | DesktopApp | ExtensionApp
interface WalletSelection {
  app: RegistryApp | undefined
  type: WalletInfo['type']
}

function organization(name?: string): string | undefined {
  return name
    ?.trim()
    .split(/[_\s]+/)[0]
    .toLowerCase()
}

function sameName(first?: string, second?: string): boolean {
  return Boolean(first && second && first.toLowerCase() === second.toLowerCase())
}

function matchStoredWallet({
  storageWallet,
  account,
  resolvedName,
  usedStorageWalletForName
}: {
  storageWallet: StoredWallet
  account: StoredAccountInfo | undefined
  resolvedName: string
  usedStorageWalletForName: boolean
}): StoredWallet {
  if (!storageWallet) {
    return undefined
  }

  return usedStorageWalletForName ||
    sameName(account?.walletKey?.trim(), storageWallet.key.trim()) ||
    sameName(organization(storageWallet.key), organization(resolvedName)) ||
    sameName(organization(storageWallet.name), organization(resolvedName))
    ? storageWallet
    : undefined
}

function resolveWalletName({
  metadata,
  peer,
  storageWallet
}: {
  metadata: AppMetadata | undefined
  peer: PeerInfo | undefined
  storageWallet: StoredWallet
}) {
  const metadataName = metadata?.name.trim() ? metadata.name : undefined
  const peerName = peer?.name.trim() || undefined
  const storageName = storageWallet?.name?.trim() || storageWallet?.key.trim() || undefined
  const resolvedName = metadataName ?? peerName ?? storageName ?? ''

  return {
    name: resolvedName,
    hasMetadataName: Boolean(metadataName),
    usedStorageWalletForName: !metadataName && !peerName && Boolean(storageName)
  }
}

/** Resolves sender, peer and matching storage metadata before registry enrichment. */
export function resolveWalletMetadata({
  metadata,
  peer,
  account,
  storageWallet
}: {
  metadata: AppMetadata | undefined
  peer: PeerInfo | undefined
  account: StoredAccountInfo | undefined
  storageWallet: StoredWallet
}) {
  const inferredPeerType: WalletInfo['type'] =
    account?.origin.type === Origin.EXTENSION ||
    peer?.type === 'postmessage-pairing-response' ||
    peer?.type === 'postmessage-pairing-request'
      ? 'extension'
      : undefined
  const { name, hasMetadataName, usedStorageWalletForName } = resolveWalletName({
    metadata,
    peer,
    storageWallet
  })
  const matchingStorageWallet = matchStoredWallet({
    storageWallet,
    account,
    resolvedName: name,
    usedStorageWalletForName
  })
  const icon = metadata?.icon ?? peer?.icon ?? matchingStorageWallet?.icon
  const type = inferredPeerType ?? matchingStorageWallet?.type
  const walletInfo: WalletInfo = {
    name,
    ...(icon ? { icon } : {}),
    ...(type ? { type } : {})
  }

  return { walletInfo, inferredPeerType, hasMetadataName }
}

function selectRegistryWallet({
  apps,
  storedType,
  isBrowser,
  isDesktop
}: {
  apps: RegistryApp[]
  storedType: WalletInfo['type']
  isBrowser: () => boolean
  isDesktop: () => boolean
}): WalletSelection | undefined {
  const mobileApp = apps.find(
    (entry) =>
      ('universalLink' in entry && entry.universalLink) ||
      entry.key.includes('ios') ||
      entry.key.includes('mobile')
  )
  const webApp = apps.find((entry) => 'links' in entry && entry.links)
  const desktopApp = apps.find((entry) => 'downloadLink' in entry && entry.downloadLink)
  const extensionApp = apps.find((entry) => 'id' in entry && entry.id)
  const selections = {
    web: { app: webApp, type: 'web' },
    desktop: { app: desktopApp, type: 'desktop' },
    extension: { app: extensionApp, type: 'extension' },
    mobile: { app: mobileApp, type: 'mobile' }
  } satisfies {
    [Kind in NonNullable<WalletInfo['type']>]: { app: RegistryApp | undefined; type: Kind }
  }

  const preferred = storedType ? selections[storedType] : undefined
  if (preferred?.app) {
    return preferred
  }
  if (isBrowser() && webApp) {
    return selections.web
  }
  if (isDesktop() && desktopApp) {
    return selections.desktop
  }
  if (isBrowser() && extensionApp) {
    return selections.extension
  }

  return mobileApp ? selections.mobile : undefined
}

/** Resolves registry presentation without reading or changing persisted wallet selections. */
export function enrichWalletInfo({
  walletInfo,
  inferredPeerType,
  apps,
  network,
  isBrowser,
  isDesktop
}: {
  walletInfo: WalletInfo
  inferredPeerType: WalletInfo['type']
  apps: RegistryApp[]
  network: NetworkType
  isBrowser: () => boolean
  isDesktop: () => boolean
}): WalletInfo {
  const walletOrganization = organization(walletInfo.name) ?? ''
  const matchingApps = apps.filter(
    (entry) => walletOrganization.length > 0 && organization(entry.key) === walletOrganization
  )
  const selection = selectRegistryWallet({
    apps: matchingApps,
    storedType: walletInfo.type,
    isBrowser,
    isDesktop
  })
  if (!selection?.app) {
    return walletInfo
  }

  const { app, type } = selection
  let deeplink: string | undefined
  if (Object.prototype.hasOwnProperty.call(app, 'links') && 'links' in app) {
    deeplink = app.links[network]
  } else if (Object.prototype.hasOwnProperty.call(app, 'deepLink') && 'deepLink' in app) {
    deeplink = app.deepLink
  }

  const icon = app.logo ?? walletInfo.icon
  const finalType = inferredPeerType ?? type ?? walletInfo.type

  return {
    name: app.name ?? walletInfo.name,
    ...(icon ? { icon } : {}),
    ...(deeplink ? { deeplink } : {}),
    ...(finalType ? { type: finalType } : {})
  }
}
