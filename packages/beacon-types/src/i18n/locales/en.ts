import { BeaconErrorType } from '../../types/BeaconErrorType'
import { BeaconLocaleMessages } from '../schema'
import { walletConnectionHelpUrl } from '../wallet-connection-help'

/**
 * Canonical English reference catalog for Beacon SDK messages.
 *
 * Contributors adding or reviewing another language can use this file as the
 * reference for where each string is displayed and which `{{placeholder}}`
 * tokens must be preserved.
 */
export const enMessages = {
  meta: {
    locale: 'en',
    name: 'English',
    direction: 'ltr',
    status: 'canonical'
  },
  errors: {
    [BeaconErrorType.BROADCAST_ERROR]: {
      title: 'Broadcast Error',
      description: 'The transaction could not be broadcast to the network. Please try again.'
    },
    [BeaconErrorType.NETWORK_NOT_SUPPORTED]: {
      title: 'Network Error',
      description: 'The wallet does not support this network. Please select another one.'
    },
    [BeaconErrorType.NO_ADDRESS_ERROR]: {
      title: 'No Address Error',
      description:
        'No matching account was found for this network. Please switch networks or accounts in your wallet and try again.'
    },
    [BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR]: {
      title: 'No Private Key Found',
      description:
        'The account you are trying to interact with is not available. Please make sure to add the account to your wallet and try again.'
    },
    [BeaconErrorType.NOT_GRANTED_ERROR]: {
      title: 'Permission Not Granted',
      description:
        'You do not have the necessary permissions to perform this action. Please initiate another permission request and give the necessary permissions.'
    },
    [BeaconErrorType.PARAMETERS_INVALID_ERROR]: {
      title: 'Parameters Invalid',
      description:
        'Some of the parameters you provided are invalid and the request could not be completed. Please check your inputs and try again.'
    },
    [BeaconErrorType.TOO_MANY_OPERATIONS]: {
      title: 'Too Many Operations',
      description:
        'The request contains too many transactions. Please include fewer operations and try again.'
    },
    [BeaconErrorType.TRANSACTION_INVALID_ERROR]: {
      title: 'Transaction Invalid',
      description: 'The transaction is invalid and the node did not accept it.'
    },
    [BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED]: {
      title: 'Signature Type Not Supported',
      description: 'The wallet is not able to sign payloads of this type.'
    },
    [BeaconErrorType.ABORTED_ERROR]: {
      title: 'Aborted',
      description: 'The action was aborted by the user.'
    },
    [BeaconErrorType.PEER_UNREACHABLE]: {
      title: 'No Response From Wallet',
      description:
        'The wallet did not respond in time. The request may still be open in the wallet and can still be approved there. Check the wallet and your recent account activity before trying again.'
    },
    [BeaconErrorType.UNKNOWN_ERROR]: {
      title: 'Error',
      description: 'An unknown error occured. Please try again or report it to a developer.'
    }
  },
  dapp: {
    requestSent: 'Request sent to\u00A0 {{wallet}}',
    noAnswerFromWallet:
      'No answer from your wallet received yet. Please make sure the wallet is open.',
    walletNotReceivingRequest: 'Wallet not receiving request?',
    resetConnection: 'Reset Connection',
    awaitingConfirmation: 'Awaiting confirmation in\u00A0 {{wallet}}',
    preparingRequestForWallet: 'Preparing Request for\u00A0 {{wallet}}...',
    preparingRequest: 'Preparing Request...',
    noPermissionTitle: 'No Permission',
    noPermissionBody: 'Please allow the wallet to handle this type of request.',
    invalidStateTitle: 'Wallet connection reset',
    invalidStateBody: 'Reconnect your wallet to continue.',
    errorTitle: 'Error',
    sessionExpiredBody: 'Your session has expired. Please pair with your wallet again.',
    pleaseTryAgain: 'Please try again.',
    walletReturnedError: '{{wallet}}\u00A0 has returned an error',
    walletDidNotRespond: '{{wallet}}\u00A0 did not respond',
    walletRequestCancelled: '{{wallet}}\u00A0 request was cancelled',
    walletRequestFailed: '{{wallet}}\u00A0 request failed',
    showDetails: 'Show Details',
    rateLimitReachedBody: 'Rate limit reached. Please slow down',
    done: 'Done',
    relayerErrorBody:
      'Failed to connect to the relayer. Please check that your system time is synchronized with the current time and reload the page.',
    lateBroadcastToast: '{{wallet}}\u00A0 broadcast the transaction after the request timed out',
    lateOperationToast: '{{wallet}}\u00A0 submitted the operation after the request timed out',
    copyToClipboard: 'Copy to clipboard',
    internalErrorTitle: 'Internal Error',
    choosePreferredWallet: 'Choose your preferred wallet',
    addressLabel: 'Address',
    networkLabel: 'Network',
    permissionsLabel: 'Permissions',
    permissionGrantedToast: '{{wallet}}\u00A0 has granted permission',
    challengeAcceptedToast: '{{wallet}}\u00A0 has accepted the challenge',
    challengeRefusedToast: '{{wallet}}\u00A0 has refused the challenge',
    payloadHashLabel: 'Payload hash: {{payloadHash}}',
    operationListReturnedToast: '{{wallet}}\u00A0 has returned the list of operation',
    operationListLabel: 'Operation list',
    errorMessageLabel: 'Error message',
    operationSubmittedToast: '{{wallet}}\u00A0 successfully submitted operation',
    openBlockexplorer: 'Open Blockexplorer',
    payloadSignedToast: '{{wallet}}\u00A0 successfully signed payload',
    signatureLabel: 'Signature: {{signature}}',
    blockchainRequestExecutedToast: '{{wallet}}\u00A0 request successfully executed',
    operationInjectedToast: '{{wallet}}\u00A0 successfully injected operation',
    unableToSendMessage:
      'Unable to send message. If this problem persists, please reset the connection and pair your wallet again.',
    noActiveAccount: 'No active account!',
    noActiveAccountSet: 'No active account set!',
    operationDetailsRequired: 'Operation details must be provided',
    signedTransactionRequired: 'Signed transaction must be provided',
    payloadRequired: 'Payload must be provided',
    beaconIdNotDefined: 'BeaconID not defined'
  },
  ui: {
    connectWallet: 'Connect Wallet',
    otherWallets: 'Other Wallets',
    otherWalletsDescription: 'See other wallets you can use to connect',
    showMore: 'Show more',
    showLess: 'Show less',
    pairWalletOnAnotherDevice: 'Pair wallet on another device',
    showQrCode: 'Show QR code',
    selectQrType: 'Select QR Type',
    beaconQrOption: 'Beacon',
    walletConnectQrOption: 'WalletConnect',
    scanQrCode: 'Scan QR code',
    notConnected: 'Not connected.',
    orScanToConnect: 'Or scan to connect',
    openWalletAndScan: 'Open {{wallet}} Wallet on your mobile phone and scan.',
    scanWithCompatibleWallet: 'Scan QR code with a {{standard}}-compatible wallet.',
    preparingQrCode: 'Preparing {{wallet}} QR code...',
    defaultWalletName: 'wallet',
    copyToClipboard: 'Copy to clipboard',
    copied: 'Copied!',
    openWallet: 'Open Wallet',
    connectWithBrowserExtension: 'Connect with {{wallet}} Browser Extension',
    installWallet: 'Install {{wallet}} Wallet',
    connectBrowserExtensionDescription:
      'Please connect below to use your {{wallet}} Wallet browser extension.',
    installBrowserExtensionDescription:
      'To connect your {{wallet}} Wallet, install the browser extension.',
    useExtension: 'Use Extension',
    installExtension: 'Install extension',
    connectWithWeb: 'Connect with {{wallet}} Web',
    connectWithWebDescription: '(It will open the wallet in a new tab)',
    useBrowser: 'Use Browser',
    connectWithDesktopApp: 'Connect with {{wallet}} Desktop App',
    connectWithDesktopDescription:
      "If you don't have the desktop app installed, click below to download it.",
    openDesktopApp: 'Open desktop app',
    downloadDesktopApp: 'Download desktop app',
    connectWithMobile: 'Connect with {{wallet}} Mobile',
    connectWithMobileApp: 'Connect with {{wallet}} {{suffix}}',
    useApp: 'Use App',
    getKukaiMobile: 'Get Kukai Mobile >',
    noTitle: 'No title',
    noDescription: 'No description',
    close: 'Close',
    walletTypes: {
      desktopApp: 'Desktop App',
      browserExtension: 'Browser Extension',
      mobileApp: 'Mobile App',
      webApp: 'Web App'
    },
    walletConnectErrors: {
      'relay-unreachable': {
        heading: 'A network error occurred.',
        body: 'Could not reach the WalletConnect relay. Check your internet connection and try again.',
        link: {
          label: 'View connection troubleshooting guide',
          url: walletConnectionHelpUrl
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
  },
  aria: {
    closeModal: 'Close',
    goBack: 'Back',
    closeToast: 'Dismiss notification',
    showQrCode: 'Show QR code',
    copyQrToClipboard: 'Copy pairing code to clipboard',
    copiedToClipboard: 'Copied to clipboard',
    qrCodeAlt: '{{standard}} pairing QR code for {{wallet}}',
    walletLogoAlt: '{{wallet}} logo',
    walletIconAlt: '{{wallet}} icon',
    otherWalletLogoAlt: 'Other Wallet {{index}}',
    loading: 'Loading'
  }
} as const satisfies BeaconLocaleMessages
