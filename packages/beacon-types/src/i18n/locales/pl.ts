import { BeaconErrorType } from '../../types/BeaconErrorType'
import { BeaconLocaleMessages } from '../schema'

export const plMessages = {
  meta: {
    locale: 'pl',
    name: 'Polski',
    direction: 'ltr',
    status: 'human-reviewed'
  },
  errors: {
    [BeaconErrorType.BROADCAST_ERROR]: {
      title: 'Błąd wysyłania do sieci',
      description: 'Nie udało się wysłać transakcji do sieci. Spróbuj ponownie.'
    },
    [BeaconErrorType.NETWORK_NOT_SUPPORTED]: {
      title: 'Błąd sieci',
      description: 'Portfel nie obsługuje tej sieci. Wybierz inną.'
    },
    [BeaconErrorType.NO_ADDRESS_ERROR]: {
      title: 'Nie znaleziono adresu',
      description:
        'Nie znaleziono pasującego konta dla tej sieci. Zmień sieć lub konto w portfelu i spróbuj ponownie.'
    },
    [BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR]: {
      title: 'Nie znaleziono klucza prywatnego',
      description:
        'Konto, z którego próbujesz skorzystać, jest niedostępne. Dodaj to konto do portfela i spróbuj ponownie.'
    },
    [BeaconErrorType.NOT_GRANTED_ERROR]: {
      title: 'Nie przyznano uprawnień',
      description:
        'Nie masz uprawnień wymaganych do wykonania tej czynności. Wyślij nowe żądanie uprawnień i przyznaj wymagane uprawnienia.'
    },
    [BeaconErrorType.PARAMETERS_INVALID_ERROR]: {
      title: 'Nieprawidłowe parametry',
      description:
        'Część podanych parametrów jest nieprawidłowa, więc nie udało się zrealizować żądania. Sprawdź wprowadzone dane i spróbuj ponownie.'
    },
    [BeaconErrorType.TOO_MANY_OPERATIONS]: {
      title: 'Zbyt wiele operacji',
      description:
        'Żądanie zawiera zbyt wiele transakcji. Zmniejsz liczbę operacji i spróbuj ponownie.'
    },
    [BeaconErrorType.TRANSACTION_INVALID_ERROR]: {
      title: 'Nieprawidłowa transakcja',
      description: 'Transakcja jest nieprawidłowa i węzeł jej nie przyjął.'
    },
    [BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED]: {
      title: 'Nieobsługiwany typ podpisu',
      description: 'Portfel nie może podpisywać payloadów tego typu.'
    },
    [BeaconErrorType.ABORTED_ERROR]: {
      title: 'Przerwano',
      description: 'Czynność została przerwana przez użytkownika.'
    },
    [BeaconErrorType.PEER_UNREACHABLE]: {
      title: 'Brak odpowiedzi z portfela',
      description:
        'Portfel nie odpowiedział na czas. Żądanie może być nadal otwarte w portfelu i wciąż można je tam zatwierdzić. Zanim spróbujesz ponownie, sprawdź portfel i ostatnią aktywność na koncie.'
    },
    [BeaconErrorType.UNKNOWN_ERROR]: {
      title: 'Błąd',
      description: 'Wystąpił nieznany błąd. Spróbuj ponownie lub zgłoś go deweloperowi.'
    }
  },
  dapp: {
    requestSent: 'Wysłano żądanie do\u00A0 {{wallet}}',
    noAnswerFromWallet: 'Portfel jeszcze nie odpowiedział. Upewnij się, że portfel jest otwarty.',
    walletNotReceivingRequest: 'Portfel nie otrzymuje żądania?',
    resetConnection: 'Zresetuj połączenie',
    awaitingConfirmation: 'Oczekiwanie na potwierdzenie w\u00A0 {{wallet}}',
    preparingRequestForWallet: 'Przygotowywanie żądania dla\u00A0 {{wallet}}...',
    preparingRequest: 'Przygotowywanie żądania...',
    noPermissionTitle: 'Brak uprawnień',
    noPermissionBody: 'Zezwól portfelowi na obsługę tego typu żądań.',
    invalidStateTitle: 'Nieprawidłowy stan',
    invalidStateBody: `Odebrano aktywne konto, ale nie znaleziono aktywnej subskrypcji zdarzenia BeaconEvent.ACTIVE_ACCOUNT_SET.
    Więcej informacji: https://docs.walletbeacon.io/guides/migration-guide`,
    errorTitle: 'Błąd',
    sessionExpiredBody: 'Twoja sesja wygasła. Sparuj portfel ponownie.',
    pleaseTryAgain: 'Spróbuj ponownie.',
    walletReturnedError: '{{wallet}}\u00A0 zwrócił błąd',
    walletDidNotRespond: 'Brak odpowiedzi od\u00A0 {{wallet}}',
    walletRequestCancelled: 'Żądanie do {{wallet}}\u00A0 zostało anulowane',
    walletRequestFailed: 'Żądanie do {{wallet}}\u00A0 nie powiodło się',
    showDetails: 'Pokaż szczegóły',
    rateLimitReachedBody: 'Osiągnięto limit żądań. Odczekaj chwilę',
    done: 'Gotowe',
    relayerErrorBody:
      'Nie udało się połączyć z serwerem przekaźnikowym (relayer). Sprawdź, czy czas systemowy jest zsynchronizowany, i odśwież stronę.',
    lateBroadcastToast:
      'Transakcja została wysłana do sieci przez {{wallet}}\u00A0 po upływie limitu czasu żądania',
    lateOperationToast:
      'Operacja została przesłana przez {{wallet}}\u00A0 po upływie limitu czasu żądania',
    copyToClipboard: 'Kopiuj do schowka',
    internalErrorTitle: 'Błąd wewnętrzny',
    choosePreferredWallet: 'Wybierz preferowany portfel',
    addressLabel: 'Adres',
    networkLabel: 'Sieć',
    permissionsLabel: 'Uprawnienia',
    permissionGrantedToast: 'Uprawnienia przyznane przez\u00A0 {{wallet}}',
    challengeAcceptedToast: 'Wyzwanie zaakceptowane przez\u00A0 {{wallet}}',
    challengeRefusedToast: 'Wyzwanie odrzucone przez\u00A0 {{wallet}}',
    payloadHashLabel: 'Hash payloadu: {{payloadHash}}',
    operationListReturnedToast: 'Lista operacji zwrócona przez\u00A0 {{wallet}}',
    operationListLabel: 'Lista operacji',
    errorMessageLabel: 'Komunikat błędu',
    operationSubmittedToast: 'Operacja pomyślnie przesłana przez\u00A0 {{wallet}}',
    openBlockexplorer: 'Otwórz eksplorator bloków',
    payloadSignedToast: 'Payload pomyślnie podpisany przez\u00A0 {{wallet}}',
    signatureLabel: 'Podpis: {{signature}}',
    blockchainRequestExecutedToast: 'Żądanie do {{wallet}}\u00A0 zostało pomyślnie wykonane',
    operationInjectedToast: 'Operacja pomyślnie wysłana do sieci przez\u00A0 {{wallet}}',
    unableToSendMessage:
      'Nie udało się wysłać wiadomości. Jeśli problem będzie się powtarzał, zresetuj połączenie i ponownie sparuj portfel.',
    noActiveAccount: 'Brak aktywnego konta!',
    noActiveAccountSet: 'Nie ustawiono aktywnego konta!',
    operationDetailsRequired: 'Należy podać szczegóły operacji',
    signedTransactionRequired: 'Należy podać podpisaną transakcję',
    payloadRequired: 'Należy podać payload',
    beaconIdNotDefined: 'Nie zdefiniowano BeaconID'
  },
  ui: {
    connectWallet: 'Połącz portfel',
    otherWallets: 'Inne portfele',
    otherWalletsDescription: 'Zobacz inne portfele, których możesz użyć do połączenia',
    showMore: 'Pokaż więcej',
    showLess: 'Pokaż mniej',
    pairWalletOnAnotherDevice: 'Sparuj portfel na innym urządzeniu',
    showQrCode: 'Pokaż kod QR',
    selectQrType: 'Wybierz typ kodu QR',
    beaconQrOption: 'Beacon',
    walletConnectQrOption: 'WalletConnect',
    scanQrCode: 'Zeskanuj kod QR',
    notConnected: 'Brak połączenia.',
    orScanToConnect: 'Lub zeskanuj, aby się połączyć',
    openWalletAndScan: 'Otwórz portfel {{wallet}} na telefonie i zeskanuj kod.',
    scanWithCompatibleWallet: 'Zeskanuj kod QR portfelem zgodnym z {{standard}}.',
    preparingQrCode: 'Przygotowywanie kodu QR dla {{wallet}}...',
    // Genitive on purpose: only used as the {{wallet}} fallback in preparingQrCode ("dla portfela").
    defaultWalletName: 'portfela',
    copyToClipboard: 'Kopiuj do schowka',
    copied: 'Skopiowano!',
    openWallet: 'Otwórz portfel',
    connectWithBrowserExtension: 'Połącz przez rozszerzenie przeglądarki {{wallet}}',
    installWallet: 'Zainstaluj portfel {{wallet}}',
    connectBrowserExtensionDescription:
      'Połącz się poniżej, aby użyć rozszerzenia przeglądarki portfela {{wallet}}.',
    installBrowserExtensionDescription:
      'Aby połączyć portfel {{wallet}}, zainstaluj rozszerzenie przeglądarki.',
    useExtension: 'Użyj rozszerzenia',
    installExtension: 'Zainstaluj rozszerzenie',
    connectWithWeb: 'Połącz przez {{wallet}} Web',
    connectWithWebDescription: '(Portfel otworzy się w nowej karcie)',
    useBrowser: 'Użyj przeglądarki',
    connectWithDesktopApp: 'Połącz przez aplikację desktopową {{wallet}}',
    connectWithDesktopDescription:
      'Jeśli nie masz zainstalowanej aplikacji desktopowej, kliknij poniżej, aby ją pobrać.',
    openDesktopApp: 'Otwórz aplikację desktopową',
    downloadDesktopApp: 'Pobierz aplikację desktopową',
    connectWithMobile: 'Połącz przez {{wallet}} Mobile',
    connectWithMobileApp: 'Połącz przez {{wallet}} {{suffix}}',
    useApp: 'Użyj aplikacji',
    getKukaiMobile: 'Pobierz Kukai Mobile >',
    noTitle: 'Brak tytułu',
    noDescription: 'Brak opisu',
    close: 'Zamknij',
    walletTypes: {
      desktopApp: 'Aplikacja desktopowa',
      browserExtension: 'Rozszerzenie przeglądarki',
      mobileApp: 'Aplikacja mobilna',
      webApp: 'Aplikacja webowa'
    },
    walletConnectErrors: {
      'relay-unreachable': {
        heading: 'Wystąpił błąd sieci.',
        body: 'Nie udało się połączyć z serwerem przekaźnikowym WalletConnect. Sprawdź połączenie z internetem lub spróbuj ponownie; żądania do serwera WalletConnect może też blokować zapora sieciowa lub dostawca internetu. Możesz też spróbować połączyć się przez VPN.',
        link: {
          label: 'Zobacz przewodnik rozwiązywania problemów z połączeniem',
          url: 'https://docs.walletbeacon.io/guides/failed-to-connect'
        }
      },
      timeout: {
        heading: 'Przekroczono limit czasu połączenia WalletConnect.',
        body: 'Podczas przygotowywania żądania parowania WalletConnect przekroczono limit czasu. Spróbuj ponownie.'
      },
      'origin-not-allowed': {
        heading: 'Domena niedozwolona.',
        body: 'Serwer przekaźnikowy WalletConnect odrzucił tę domenę. Jeśli tworzysz tę aplikację dApp, dodaj tę domenę (origin) do listy dozwolonych w panelu projektu Reown (WalletConnect) Cloud.'
      },
      'initialization-unavailable': {
        heading: 'WalletConnect jest niedostępny.',
        body: 'WalletConnect wciąż kończy porządkowanie po poprzedniej sesji. Poczekaj chwilę i spróbuj ponownie.'
      },
      'client-replaced': {
        heading: 'Sesja WalletConnect została zresetowana.',
        body: 'Klient WalletConnect został zastąpiony podczas przygotowywania kodu parowania. Spróbuj połączyć się ponownie.'
      },
      retired: {
        heading: 'Parowanie zostało anulowane.',
        body: 'Ta próba parowania WalletConnect nie jest już aktywna. Rozpocznij nowe połączenie.'
      }
    }
  },
  aria: {
    closeModal: 'Zamknij',
    goBack: 'Wstecz',
    closeToast: 'Zamknij powiadomienie',
    showQrCode: 'Pokaż kod QR',
    copyQrToClipboard: 'Kopiuj kod parowania do schowka',
    copiedToClipboard: 'Skopiowano do schowka',
    qrCodeAlt: 'Kod QR parowania {{standard}} dla {{wallet}}',
    walletLogoAlt: 'Logo {{wallet}}',
    walletIconAlt: 'Ikona {{wallet}}',
    otherWalletLogoAlt: 'Inny portfel {{index}}',
    loading: 'Ładowanie'
  }
} as const satisfies BeaconLocaleMessages
