import { BeaconErrorType } from '../types/BeaconErrorType'
import { WalletConnectPairingFailureReason } from '../types/WalletConnectPairingRequest'

export type BeaconTextDirection = 'ltr' | 'rtl' | 'auto'

export type BeaconResolvedDirection = 'ltr' | 'rtl'

export type BeaconLocaleStatus = 'canonical' | 'ai-draft' | 'human-reviewed'

export type DisplayableWalletConnectFailureReason = Exclude<
  WalletConnectPairingFailureReason,
  'superseded'
>

export interface BeaconLocaleMetadata {
  /** BCP-47 language tag (for example: 'en', 'fr', 'es', 'de', 'ja', 'ar') */
  readonly locale: string
  /** Native display name of the language (for example: 'English', 'Français', 'العربية') */
  readonly name: string
  /** Default text direction for this locale */
  readonly direction: 'ltr' | 'rtl'
  /** Translation provenance status to guide community review */
  readonly status: BeaconLocaleStatus
}

export interface BeaconErrorCopy {
  readonly title: string
  readonly description: string
}

export interface WalletConnectErrorCopy {
  readonly heading: string
  readonly body: string
  readonly link?: {
    readonly label: string
    readonly url: string
  }
}

export interface BeaconDAppMessages {
  /** Toast body when a request has been dispatched to the wallet. Placeholders: {{wallet}} */
  readonly requestSent: string
  /** Toast hint when waiting for the wallet to respond */
  readonly noAnswerFromWallet: string
  /** Toast prompt asking if the wallet is not receiving the request */
  readonly walletNotReceivingRequest: string
  /** Action button in toast to reset the active wallet connection */
  readonly resetConnection: string
  /** Toast body after wallet acknowledges receipt. Placeholders: {{wallet}} */
  readonly awaitingConfirmation: string
  /** Toast body while preparing a request for a known wallet. Placeholders: {{wallet}} */
  readonly preparingRequestForWallet: string
  /** Toast body while preparing a request before a wallet is selected */
  readonly preparingRequest: string
  /** Alert title when wallet lacks required permission scope */
  readonly noPermissionTitle: string
  /** Alert body when wallet lacks required permission scope */
  readonly noPermissionBody: string
  /** Alert title when active account state is invalid */
  readonly invalidStateTitle: string
  /** Alert body when active account state is invalid */
  readonly invalidStateBody: string
  /** Generic error alert title */
  readonly errorTitle: string
  /** Alert body when persisted wallet session has expired */
  readonly sessionExpiredBody: string
  /** Generic retry prompt in error alerts */
  readonly pleaseTryAgain: string
  /** Toast body when the wallet returns a protocol error. Placeholders: {{wallet}} */
  readonly walletReturnedError: string
  /** Toast body when a local request times out waiting for the wallet. Placeholders: {{wallet}} */
  readonly walletDidNotRespond: string
  /** Toast body when a request is cancelled locally. Placeholders: {{wallet}} */
  readonly walletRequestCancelled: string
  /** Toast body when a local request fails. Placeholders: {{wallet}} */
  readonly walletRequestFailed: string
  /** Toast action button to open the full error detail modal */
  readonly showDetails: string
  /** Alert body when the local rate limit is reached */
  readonly rateLimitReachedBody: string
  /** Dismiss button label on informational/error alerts */
  readonly done: string
  /** Alert body when the Matrix relayer connection fails */
  readonly relayerErrorBody: string
  /** Toast body when a broadcast completes after local timeout. Placeholders: {{wallet}} */
  readonly lateBroadcastToast: string
  /** Toast body when an operation completes after local timeout. Placeholders: {{wallet}} */
  readonly lateOperationToast: string
  /** Action button label to copy a hash, signature, or payload to the clipboard */
  readonly copyToClipboard: string
  /** Alert title for internal SDK errors */
  readonly internalErrorTitle: string
  /** Pairing modal title */
  readonly choosePreferredWallet: string
  /** Label for the connected account address in the permission toast */
  readonly addressLabel: string
  /** Label for the connected network in the permission toast */
  readonly networkLabel: string
  /** Label for granted permission scopes in the permission toast */
  readonly permissionsLabel: string
  /** Toast body when the wallet grants permissions. Placeholders: {{wallet}} */
  readonly permissionGrantedToast: string
  /** Toast body when proof-of-event challenge is accepted. Placeholders: {{wallet}} */
  readonly challengeAcceptedToast: string
  /** Toast body when proof-of-event challenge is refused. Placeholders: {{wallet}} */
  readonly challengeRefusedToast: string
  /** Label prefix for the proof-of-event payload hash. Placeholders: {{payloadHash}} */
  readonly payloadHashLabel: string
  /** Toast body when simulated proof-of-event returns an operation list. Placeholders: {{wallet}} */
  readonly operationListReturnedToast: string
  /** Label for the simulated proof-of-event operation list */
  readonly operationListLabel: string
  /** Label for simulated proof-of-event error message */
  readonly errorMessageLabel: string
  /** Toast body when wallet submits an operation. Placeholders: {{wallet}} */
  readonly operationSubmittedToast: string
  /** Action button label to open transaction in a block explorer */
  readonly openBlockexplorer: string
  /** Toast body when wallet signs a payload. Placeholders: {{wallet}} */
  readonly payloadSignedToast: string
  /** Label prefix for the shortened signature. Placeholders: {{signature}} */
  readonly signatureLabel: string
  /** Toast body when a V3 blockchain request succeeds. Placeholders: {{wallet}} */
  readonly blockchainRequestExecutedToast: string
  /** Toast body when wallet injects a broadcast operation. Placeholders: {{wallet}} */
  readonly operationInjectedToast: string
  /** Alert body when dispatching a message over the active transport fails */
  readonly unableToSendMessage: string
  /** Internal error message when no active account is connected */
  readonly noActiveAccount: string
  /** Internal error message when no active account is set */
  readonly noActiveAccountSet: string
  /** Internal error message when operationDetails are missing */
  readonly operationDetailsRequired: string
  /** Internal error message when signedTransaction is missing */
  readonly signedTransactionRequired: string
  /** Internal error message when payload is missing */
  readonly payloadRequired: string
  /** Internal error message when beaconId is not defined */
  readonly beaconIdNotDefined: string
}

export interface BeaconWalletTypeMessages {
  /** Label for desktop wallet applications */
  readonly desktopApp: string
  /** Label for browser extension wallets */
  readonly browserExtension: string
  /** Label for mobile wallet applications */
  readonly mobileApp: string
  /** Label for web wallet applications */
  readonly webApp: string
}

export interface BeaconUIMessages {
  /** Heading for the main wallet selection list */
  readonly connectWallet: string
  /** Card title to reveal additional wallets on mobile */
  readonly otherWallets: string
  /** Card subtitle to reveal additional wallets on mobile */
  readonly otherWalletsDescription: string
  /** Footer toggle in desktop modal to expand the full wallet list */
  readonly showMore: string
  /** Footer toggle in desktop modal to collapse the full wallet list */
  readonly showLess: string
  /** Button label on mobile wallet list to pair with another device */
  readonly pairWalletOnAnotherDevice: string
  /** Button label on desktop wallet list to show QR code */
  readonly showQrCode: string
  /** Heading when choosing between Beacon P2P and WalletConnect QR codes */
  readonly selectQrType: string
  /** Button label for TZIP-10 Beacon P2P QR code */
  readonly beaconQrOption: string
  /** Button label for WalletConnect QR code */
  readonly walletConnectQrOption: string
  /** Title for QR code error or scan view */
  readonly scanQrCode: string
  /** Fallback status message when neither QR transport is connected */
  readonly notConnected: string
  /** Desktop QR section heading */
  readonly orScanToConnect: string
  /** Desktop QR instruction. Placeholders: {{wallet}} */
  readonly openWalletAndScan: string
  /** Mobile/generic QR instruction. Placeholders: {{standard}} */
  readonly scanWithCompatibleWallet: string
  /** Status text while generating a pairing QR code. Placeholders: {{wallet}} */
  readonly preparingQrCode: string
  /** Fallback generic wallet noun when no specific wallet is selected */
  readonly defaultWalletName: string
  /** Button label under QR code to copy sync URI */
  readonly copyToClipboard: string
  /** Confirmation text after copying QR sync URI */
  readonly copied: string
  /** Action button inside toast to launch the connected wallet */
  readonly openWallet: string
  /** Heading when connecting with an installed browser extension. Placeholders: {{wallet}} */
  readonly connectWithBrowserExtension: string
  /** Heading when prompting user to install a browser extension. Placeholders: {{wallet}} */
  readonly installWallet: string
  /** Description when connecting with an installed browser extension. Placeholders: {{wallet}} */
  readonly connectBrowserExtensionDescription: string
  /** Description when prompting user to install a browser extension. Placeholders: {{wallet}} */
  readonly installBrowserExtensionDescription: string
  /** Primary button to connect with an installed browser extension */
  readonly useExtension: string
  /** Primary button to open extension installation page */
  readonly installExtension: string
  /** Heading for web wallet connection card. Placeholders: {{wallet}} */
  readonly connectWithWeb: string
  /** Subtitle for web wallet connection card */
  readonly connectWithWebDescription: string
  /** Button to open web wallet in a browser tab */
  readonly useBrowser: string
  /** Heading for desktop app connection card. Placeholders: {{wallet}} */
  readonly connectWithDesktopApp: string
  /** Description for desktop app connection card */
  readonly connectWithDesktopDescription: string
  /** Primary button to launch desktop wallet app */
  readonly openDesktopApp: string
  /** Secondary button to download desktop wallet app */
  readonly downloadDesktopApp: string
  /** Heading for mobile wallet connection card or error view. Placeholders: {{wallet}} */
  readonly connectWithMobile: string
  /** Heading for mobile deep-link pairing card. Placeholders: {{wallet}}, {{suffix}} */
  readonly connectWithMobileApp: string
  /** Primary button to launch mobile wallet app via deep link */
  readonly useApp: string
  /** Download link label for Kukai iOS app */
  readonly getKukaiMobile: string
  /** Fallback title in InfoAlert when none is provided */
  readonly noTitle: string
  /** Fallback description in InfoAlert when none is provided */
  readonly noDescription: string
  /** Primary button label to close an InfoAlert modal */
  readonly close: string
  /** Localized labels for wallet platform categories */
  readonly walletTypes: BeaconWalletTypeMessages
  /** Localized WalletConnect pairing failure messages */
  readonly walletConnectErrors: Readonly<
    Record<DisplayableWalletConnectFailureReason, WalletConnectErrorCopy>
  >
}

export interface BeaconAriaMessages {
  /** Accessible label for the modal close icon button */
  readonly closeModal: string
  /** Accessible label for the modal back navigation icon button */
  readonly goBack: string
  /** Accessible label for the toast dismiss icon button */
  readonly closeToast: string
  /** Accessible label for the icon button that switches to the QR code view */
  readonly showQrCode: string
  /** Accessible label for the clickable QR code copy container */
  readonly copyQrToClipboard: string
  /** Screen-reader announcement when pairing code is copied to clipboard */
  readonly copiedToClipboard: string
  /** Accessible label for the rendered QR code SVG. Placeholders: {{standard}}, {{wallet}} */
  readonly qrCodeAlt: string
  /** Alt text for a wallet card logo image. Placeholders: {{wallet}} */
  readonly walletLogoAlt: string
  /** Alt text for a wallet icon inside a toast. Placeholders: {{wallet}} */
  readonly walletIconAlt: string
  /** Alt text for preview icons in the "Other Wallets" card. Placeholders: {{index}} */
  readonly otherWalletLogoAlt: string
  /** Accessible label for loading progress indicator */
  readonly loading: string
}

export interface BeaconLocaleMessages {
  readonly meta: BeaconLocaleMetadata
  readonly errors: Readonly<Record<BeaconErrorType, BeaconErrorCopy>>
  readonly dapp: BeaconDAppMessages
  readonly ui: BeaconUIMessages
  readonly aria: BeaconAriaMessages
}

export type DeepPartial<T> = {
  readonly [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export type BeaconTranslationOverrides = DeepPartial<Omit<BeaconLocaleMessages, 'meta'>>

export interface BeaconI18nConfig {
  readonly locale?: string
  readonly direction?: BeaconTextDirection
  readonly translations?: BeaconTranslationOverrides
}
