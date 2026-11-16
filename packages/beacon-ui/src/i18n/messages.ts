import { WalletConnectPairingFailureReason } from '@ecadlabs/beacon-types'

export type DisplayableWalletConnectFailureReason = Exclude<
  WalletConnectPairingFailureReason,
  'superseded'
>

export interface WalletConnectErrorCopy {
  readonly heading: string
  readonly body: string
  readonly link?: {
    readonly label: string
    readonly url: string
  }
}

export interface BeaconUIMessageCatalog {
  readonly walletConnectPairingErrors: Readonly<
    Record<DisplayableWalletConnectFailureReason, WalletConnectErrorCopy>
  >
}

export const enMessages: BeaconUIMessageCatalog = {
  walletConnectPairingErrors: {
    'relay-unreachable': {
      heading: 'A network error occurred.',
      body: 'Could not reach the WalletConnect relayer. Check your internet connection or try again; a firewall or network provider may also be blocking requests to the WalletConnect relayer. As a workaround, try connecting through a VPN as shown',
      link: {
        label: 'here',
        url: 'https://docs.walletbeacon.io/guides/failed-to-connect'
      }
    },
    timeout: {
      heading: 'WalletConnect connection timed out.',
      body: 'The connection timed out while preparing the WalletConnect pairing request. Please try again.'
    },
    'origin-not-allowed': {
      heading: 'Origin not allowed.',
      body: 'The WalletConnect relay rejected this domain. If you are the dApp developer, add this origin to the project allowlist in your Reown (WalletConnect) Cloud dashboard.'
    },
    'initialization-unavailable': {
      heading: 'WalletConnect is unavailable.',
      body: 'WalletConnect is still finishing cleanup from a previous session. Please wait a moment and try again.'
    },
    'client-replaced': {
      heading: 'WalletConnect session was reset.',
      body: 'The WalletConnect client was replaced while preparing the pairing code. Please try connecting again.'
    },
    retired: {
      heading: 'Pairing was cancelled.',
      body: 'This WalletConnect pairing attempt is no longer active. Please start a new connection.'
    }
  }
}

export const getWalletConnectErrorCopy = (
  reason?: WalletConnectPairingFailureReason
): WalletConnectErrorCopy => {
  const key: DisplayableWalletConnectFailureReason =
    reason && reason !== 'superseded' ? reason : 'relay-unreachable'

  return enMessages.walletConnectPairingErrors[key]
}
