import { BeaconErrorType } from '../../types/BeaconErrorType'
import { BeaconLocaleMessages } from '../schema'

export const deMessages = {
  meta: {
    locale: 'de',
    name: 'Deutsch',
    direction: 'ltr',
    status: 'ai-draft'
  },
  errors: {
    [BeaconErrorType.BROADCAST_ERROR]: {
      title: 'Übertragungsfehler',
      description:
        'Die Transaktion konnte nicht an das Netzwerk übertragen werden. Bitte versuche es erneut.'
    },
    [BeaconErrorType.NETWORK_NOT_SUPPORTED]: {
      title: 'Netzwerkfehler',
      description: 'Die Wallet unterstützt dieses Netzwerk nicht. Bitte wähle ein anderes.'
    },
    [BeaconErrorType.NO_ADDRESS_ERROR]: {
      title: 'Keine Adresse gefunden',
      description:
        'Für dieses Netzwerk wurde kein passendes Konto gefunden. Bitte wechsle in deiner Wallet das Netzwerk oder Konto und versuche es erneut.'
    },
    [BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR]: {
      title: 'Kein privater Schlüssel gefunden',
      description:
        'Das Konto, mit dem du interagieren möchtest, ist nicht verfügbar. Bitte füge das Konto deiner Wallet hinzu und versuche es erneut.'
    },
    [BeaconErrorType.NOT_GRANTED_ERROR]: {
      title: 'Berechtigung nicht erteilt',
      description:
        'Du hast nicht die erforderlichen Berechtigungen für diese Aktion. Bitte starte eine neue Berechtigungsanfrage.'
    },
    [BeaconErrorType.PARAMETERS_INVALID_ERROR]: {
      title: 'Ungültige Parameter',
      description:
        'Einige der übergebenen Parameter sind ungültig und die Anfrage konnte nicht ausgeführt werden. Bitte überprüfe deine Eingaben und versuche es erneut.'
    },
    [BeaconErrorType.TOO_MANY_OPERATIONS]: {
      title: 'Zu viele Operationen',
      description:
        'Die Anfrage enthält zu viele Transaktionen. Bitte reduziere die Anzahl der Operationen und versuche es erneut.'
    },
    [BeaconErrorType.TRANSACTION_INVALID_ERROR]: {
      title: 'Transaktion ungültig',
      description: 'Die Transaktion ist ungültig und wurde vom Knoten abgelehnt.'
    },
    [BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED]: {
      title: 'Signaturtyp nicht unterstützt',
      description: 'Die Wallet kann Nutzdaten dieses Typs nicht signieren.'
    },
    [BeaconErrorType.ABORTED_ERROR]: {
      title: 'Abgebrochen',
      description: 'Die Aktion wurde vom Benutzer abgebrochen.'
    },
    [BeaconErrorType.PEER_UNREACHABLE]: {
      title: 'Keine Antwort von der Wallet',
      description:
        'Die Wallet hat nicht rechtzeitig geantwortet. Die Anfrage ist möglicherweise noch in der Wallet geöffnet und kann dort weiterhin bestätigt werden. Bitte prüfe deine Wallet und deine letzten Kontoaktivitäten, bevor du es erneut versuchst.'
    },
    [BeaconErrorType.UNKNOWN_ERROR]: {
      title: 'Fehler',
      description:
        'Ein unbekannter Fehler ist aufgetreten. Bitte versuche es erneut oder melde ihn einem Entwickler.'
    }
  },
  dapp: {
    requestSent: 'Anfrage gesendet an\u00A0 {{wallet}}',
    noAnswerFromWallet:
      'Noch keine Antwort von deiner Wallet erhalten. Bitte stelle sicher, dass die Wallet geöffnet ist.',
    walletNotReceivingRequest: 'Empfängt die Wallet keine Anfrage?',
    resetConnection: 'Verbindung zurücksetzen',
    awaitingConfirmation: 'Warte auf Bestätigung in\u00A0 {{wallet}}',
    preparingRequestForWallet: 'Anfrage für\u00A0 {{wallet}} wird vorbereitet...',
    preparingRequest: 'Anfrage wird vorbereitet...',
    noPermissionTitle: 'Keine Berechtigung',
    noPermissionBody: 'Bitte erlaube der Wallet, diese Art von Anfrage zu verarbeiten.',
    invalidStateTitle: 'Ungültiger Zustand',
    invalidStateBody: `Ein aktives Konto wurde empfangen, aber es wurde kein aktives Abonnement für BeaconEvent.ACTIVE_ACCOUNT_SET gefunden.
    Weitere Informationen unter: https://docs.walletbeacon.io/guides/migration-guide`,
    errorTitle: 'Fehler',
    sessionExpiredBody: 'Deine Sitzung ist abgelaufen. Bitte kopple deine Wallet erneut.',
    pleaseTryAgain: 'Bitte versuche es erneut.',
    walletReturnedError: '{{wallet}}\u00A0 hat einen Fehler zurückgegeben',
    walletDidNotRespond: '{{wallet}}\u00A0 hat nicht geantwortet',
    walletRequestCancelled: 'Anfrage an {{wallet}}\u00A0 wurde abgebrochen',
    walletRequestFailed: 'Anfrage an {{wallet}}\u00A0 ist fehlgeschlagen',
    showDetails: 'Details anzeigen',
    rateLimitReachedBody: 'Anfragelimit erreicht. Bitte warte kurz',
    done: 'Fertig',
    relayerErrorBody:
      'Verbindung zum Relayer fehlgeschlagen. Bitte überprüfe, ob deine Systemzeit synchronisiert ist, und lade die Seite neu.',
    lateBroadcastToast: '{{wallet}}\u00A0 hat die Transaktion nach Ablauf der Wartezeit übertragen',
    lateOperationToast: '{{wallet}}\u00A0 hat die Operation nach Ablauf der Wartezeit eingereicht',
    copyToClipboard: 'In die Zwischenablage kopieren',
    internalErrorTitle: 'Interner Fehler',
    choosePreferredWallet: 'Wähle deine bevorzugte Wallet',
    addressLabel: 'Adresse',
    networkLabel: 'Netzwerk',
    permissionsLabel: 'Berechtigungen',
    permissionGrantedToast: '{{wallet}}\u00A0 hat die Berechtigung erteilt',
    challengeAcceptedToast: '{{wallet}}\u00A0 hat die Challenge akzeptiert',
    challengeRefusedToast: '{{wallet}}\u00A0 hat die Challenge abgelehnt',
    payloadHashLabel: 'Payload-Hash: {{payloadHash}}',
    operationListReturnedToast: '{{wallet}}\u00A0 hat die Operationsliste zurückgegeben',
    operationListLabel: 'Operationsliste',
    errorMessageLabel: 'Fehlermeldung',
    operationSubmittedToast: '{{wallet}}\u00A0 hat die Operation erfolgreich eingereicht',
    openBlockexplorer: 'Blockexplorer öffnen',
    payloadSignedToast: '{{wallet}}\u00A0 hat die Nutzdaten erfolgreich signiert',
    signatureLabel: 'Signatur: {{signature}}',
    blockchainRequestExecutedToast: 'Anfrage von {{wallet}}\u00A0 erfolgreich ausgeführt',
    operationInjectedToast: '{{wallet}}\u00A0 hat die Operation erfolgreich übertragen',
    unableToSendMessage:
      'Nachricht konnte nicht gesendet werden. Wenn dieses Problem weiterhin besteht, setze bitte die Verbindung zurück und kopple deine Wallet erneut.',
    noActiveAccount: 'Kein aktives Konto!',
    noActiveAccountSet: 'Kein aktives Konto festgelegt!',
    operationDetailsRequired: 'Operationsdetails müssen angegeben werden',
    signedTransactionRequired: 'Signierte Transaktion muss angegeben werden',
    payloadRequired: 'Nutzdaten müssen angegeben werden',
    beaconIdNotDefined: 'BeaconID nicht definiert'
  },
  ui: {
    connectWallet: 'Wallet verbinden',
    otherWallets: 'Weitere Wallets',
    otherWalletsDescription: 'Weitere Wallets anzeigen, mit denen du dich verbinden kannst',
    showMore: 'Mehr anzeigen',
    showLess: 'Weniger anzeigen',
    pairWalletOnAnotherDevice: 'Wallet auf einem anderen Gerät koppeln',
    showQrCode: 'QR-Code anzeigen',
    selectQrType: 'QR-Typ auswählen',
    beaconQrOption: 'Beacon',
    walletConnectQrOption: 'WalletConnect',
    scanQrCode: 'QR-Code scannen',
    notConnected: 'Nicht verbunden.',
    orScanToConnect: 'Oder zum Verbinden scannen',
    openWalletAndScan: 'Öffne {{wallet}} Wallet auf deinem Mobiltelefon und scanne den Code.',
    scanWithCompatibleWallet: 'Scanne den QR-Code mit einer {{standard}}-kompatiblen Wallet.',
    preparingQrCode: '{{wallet}} QR-Code wird vorbereitet...',
    defaultWalletName: 'Wallet',
    copyToClipboard: 'In die Zwischenablage kopieren',
    copied: 'Kopiert!',
    openWallet: 'Wallet öffnen',
    connectWithBrowserExtension: 'Mit {{wallet}} Browser-Erweiterung verbinden',
    installWallet: '{{wallet}} Wallet installieren',
    connectBrowserExtensionDescription:
      'Bitte verbinde dich unten, um deine {{wallet}} Wallet Browser-Erweiterung zu nutzen.',
    installBrowserExtensionDescription:
      'Um deine {{wallet}} Wallet zu verbinden, installiere die Browser-Erweiterung.',
    useExtension: 'Erweiterung verwenden',
    installExtension: 'Erweiterung installieren',
    connectWithWeb: 'Mit {{wallet}} Web verbinden',
    connectWithWebDescription: '(Öffnet die Wallet in einem neuen Tab)',
    useBrowser: 'Browser verwenden',
    connectWithDesktopApp: 'Mit {{wallet}} Desktop-App verbinden',
    connectWithDesktopDescription:
      'Falls du die Desktop-App noch nicht installiert hast, klicke unten zum Herunterladen.',
    openDesktopApp: 'Desktop-App öffnen',
    downloadDesktopApp: 'Desktop-App herunterladen',
    connectWithMobile: 'Mit {{wallet}} Mobile verbinden',
    connectWithMobileApp: 'Mit {{wallet}} {{suffix}} verbinden',
    useApp: 'App verwenden',
    getKukaiMobile: 'Kukai Mobile laden >',
    noTitle: 'Kein Titel',
    noDescription: 'Keine Beschreibung',
    close: 'Schließen',
    walletTypes: {
      desktopApp: 'Desktop-App',
      browserExtension: 'Browser-Erweiterung',
      mobileApp: 'Mobile-App',
      webApp: 'Web-App'
    },
    walletConnectErrors: {
      'relay-unreachable': {
        heading: 'Ein Netzwerkfehler ist aufgetreten.',
        body: 'Der WalletConnect-Relayer konnte nicht erreicht werden. Überprüfe deine Internetverbindung oder versuche es erneut; möglicherweise blockiert auch eine Firewall oder dein Netzwerkanbieter Anfragen an den Relayer. Versuche alternativ eine Verbindung über ein VPN.',
        link: {
          label: 'Anleitung zur Fehlerbehebung bei Verbindungsproblemen anzeigen',
          url: 'https://docs.walletbeacon.io/guides/failed-to-connect'
        }
      },
      timeout: {
        heading: 'Zeitüberschreitung bei der WalletConnect-Verbindung.',
        body: 'Beim Vorbereiten der WalletConnect-Kopplungsanfrage ist eine Zeitüberschreitung aufgetreten. Bitte versuche es erneut.'
      },
      'origin-not-allowed': {
        heading: 'Ursprung (Origin) nicht erlaubt.',
        body: 'Der WalletConnect-Relayer hat diese Domain abgelehnt. Wenn du der dApp-Entwickler bist, füge diese Origin zur Allowlist in deinem Reown (WalletConnect) Cloud-Dashboard hinzu.'
      },
      'initialization-unavailable': {
        heading: 'WalletConnect ist nicht verfügbar.',
        body: 'WalletConnect schließt noch die Bereinigung einer vorherigen Sitzung ab. Bitte warte einen Moment und versuche es erneut.'
      },
      'client-replaced': {
        heading: 'WalletConnect-Sitzung wurde zurückgesetzt.',
        body: 'Der WalletConnect-Client wurde während der Vorbereitung des Kopplungscodes ersetzt. Bitte versuche erneut, dich zu verbinden.'
      },
      retired: {
        heading: 'Kopplung wurde abgebrochen.',
        body: 'Dieser WalletConnect-Kopplungsversuch ist nicht mehr aktiv. Bitte starte eine neue Verbindung.'
      }
    }
  },
  aria: {
    closeModal: 'Schließen',
    goBack: 'Zurück',
    closeToast: 'Benachrichtigung schließen',
    showQrCode: 'QR-Code anzeigen',
    copyQrToClipboard: 'Kopplungscode in die Zwischenablage kopieren',
    copiedToClipboard: 'In die Zwischenablage kopiert',
    qrCodeAlt: '{{standard}}-Kopplungs-QR-Code für {{wallet}}',
    walletLogoAlt: '{{wallet}}-Logo',
    walletIconAlt: '{{wallet}}-Symbol',
    otherWalletLogoAlt: 'Weitere Wallet {{index}}',
    loading: 'Wird geladen'
  }
} as const satisfies BeaconLocaleMessages
