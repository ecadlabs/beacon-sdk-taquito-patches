import { BeaconErrorType } from '../../types/BeaconErrorType'
import { BeaconLocaleMessages } from '../schema'

export const frMessages = {
  meta: {
    locale: 'fr',
    name: 'Français',
    direction: 'ltr',
    status: 'ai-draft'
  },
  errors: {
    [BeaconErrorType.BROADCAST_ERROR]: {
      title: 'Erreur de diffusion',
      description: 'La transaction n’a pas pu être diffusée sur le réseau. Veuillez réessayer.'
    },
    [BeaconErrorType.NETWORK_NOT_SUPPORTED]: {
      title: 'Erreur de réseau',
      description:
        'Le portefeuille ne prend pas en charge ce réseau. Veuillez en sélectionner un autre.'
    },
    [BeaconErrorType.NO_ADDRESS_ERROR]: {
      title: 'Aucune adresse trouvée',
      description:
        'Aucun compte correspondant n’a été trouvé pour ce réseau. Veuillez changer de réseau ou de compte dans votre portefeuille et réessayer.'
    },
    [BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR]: {
      title: 'Clé privée introuvable',
      description:
        'Le compte avec lequel vous essayez d’interagir n’est pas disponible. Assurez-vous d’ajouter ce compte à votre portefeuille et réessayez.'
    },
    [BeaconErrorType.NOT_GRANTED_ERROR]: {
      title: 'Permission non accordée',
      description:
        'Vous ne disposez pas des autorisations nécessaires pour effectuer cette action. Veuillez lancer une nouvelle demande d’autorisation.'
    },
    [BeaconErrorType.PARAMETERS_INVALID_ERROR]: {
      title: 'Paramètres invalides',
      description:
        'Certains paramètres fournis sont invalides et la requête n’a pas pu aboutir. Veuillez vérifier vos données et réessayer.'
    },
    [BeaconErrorType.TOO_MANY_OPERATIONS]: {
      title: 'Trop d’opérations',
      description:
        'La requête contient trop de transactions. Veuillez inclure moins d’opérations et réessayer.'
    },
    [BeaconErrorType.TRANSACTION_INVALID_ERROR]: {
      title: 'Transaction invalide',
      description: 'La transaction est invalide et le nœud l’a refusée.'
    },
    [BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED]: {
      title: 'Type de signature non pris en charge',
      description: 'Le portefeuille ne peut pas signer des données de ce type.'
    },
    [BeaconErrorType.ABORTED_ERROR]: {
      title: 'Annulé',
      description: 'L’action a été annulée par l’utilisateur.'
    },
    [BeaconErrorType.PEER_UNREACHABLE]: {
      title: 'Aucune réponse du portefeuille',
      description:
        'Le portefeuille n’a pas répondu à temps. La requête est peut-être encore ouverte dans le portefeuille et peut toujours y être approuvée. Vérifiez votre portefeuille et l’activité récente de votre compte avant de réessayer.'
    },
    [BeaconErrorType.UNKNOWN_ERROR]: {
      title: 'Erreur',
      description:
        'Une erreur inconnue s’est produite. Veuillez réessayer ou la signaler à un développeur.'
    }
  },
  dapp: {
    requestSent: 'Requête envoyée à\u00A0 {{wallet}}',
    noAnswerFromWallet:
      'Aucune réponse de votre portefeuille pour le moment. Assurez-vous que le portefeuille est ouvert.',
    walletNotReceivingRequest: 'Le portefeuille ne reçoit pas la requête\u202F?',
    resetConnection: 'Réinitialiser la connexion',
    awaitingConfirmation: 'En attente de confirmation dans\u00A0 {{wallet}}',
    preparingRequestForWallet: 'Préparation de la requête pour\u00A0 {{wallet}}...',
    preparingRequest: 'Préparation de la requête...',
    noPermissionTitle: 'Aucune autorisation',
    noPermissionBody: 'Veuillez autoriser le portefeuille à traiter ce type de requête.',
    invalidStateTitle: 'État invalide',
    invalidStateBody: `Un compte actif a été reçu, mais aucun abonnement actif n'a été trouvé pour BeaconEvent.ACTIVE_ACCOUNT_SET.
    Pour plus d'informations, consultez : https://docs.walletbeacon.io/guides/migration-guide`,
    errorTitle: 'Erreur',
    sessionExpiredBody: 'Votre session a expiré. Veuillez jumeler à nouveau votre portefeuille.',
    pleaseTryAgain: 'Veuillez réessayer.',
    walletReturnedError: '{{wallet}}\u00A0 a renvoyé une erreur',
    walletDidNotRespond: '{{wallet}}\u00A0 n’a pas répondu',
    walletRequestCancelled: 'La requête vers {{wallet}}\u00A0 a été annulée',
    walletRequestFailed: 'La requête vers {{wallet}}\u00A0 a échoué',
    showDetails: 'Afficher les détails',
    rateLimitReachedBody: 'Limite de requêtes atteinte. Veuillez ralentir',
    done: 'Terminé',
    relayerErrorBody:
      'Échec de la connexion au relais. Veuillez vérifier que l’horloge de votre système est synchronisée et rechargez la page.',
    lateBroadcastToast:
      '{{wallet}}\u00A0 a diffusé la transaction après l’expiration du délai de la requête',
    lateOperationToast:
      '{{wallet}}\u00A0 a soumis l’opération après l’expiration du délai de la requête',
    copyToClipboard: 'Copier dans le presse-papiers',
    internalErrorTitle: 'Erreur interne',
    choosePreferredWallet: 'Choisissez votre portefeuille préféré',
    addressLabel: 'Adresse',
    networkLabel: 'Réseau',
    permissionsLabel: 'Autorisations',
    permissionGrantedToast: '{{wallet}}\u00A0 a accordé l’autorisation',
    challengeAcceptedToast: '{{wallet}}\u00A0 a accepté le défi',
    challengeRefusedToast: '{{wallet}}\u00A0 a refusé le défi',
    payloadHashLabel: 'Hachage de la charge utile : {{payloadHash}}',
    operationListReturnedToast: '{{wallet}}\u00A0 a renvoyé la liste des opérations',
    operationListLabel: 'Liste des opérations',
    errorMessageLabel: 'Message d’erreur',
    operationSubmittedToast: '{{wallet}}\u00A0 a soumis l’opération avec succès',
    openBlockexplorer: 'Ouvrir l’explorateur de blocs',
    payloadSignedToast: '{{wallet}}\u00A0 a signé la charge utile avec succès',
    signatureLabel: 'Signature : {{signature}}',
    blockchainRequestExecutedToast: 'Requête exécutée avec succès par {{wallet}}',
    operationInjectedToast: '{{wallet}}\u00A0 a injecté l’opération avec succès',
    unableToSendMessage:
      'Impossible d’envoyer le message. Si le problème persiste, veuillez réinitialiser la connexion et jumeler à nouveau votre portefeuille.',
    noActiveAccount: 'Aucun compte actif\u202F!',
    noActiveAccountSet: 'Aucun compte actif défini\u202F!',
    operationDetailsRequired: 'Les détails de l’opération doivent être fournis',
    signedTransactionRequired: 'La transaction signée doit être fournie',
    payloadRequired: 'Les données à signer doivent être fournies',
    beaconIdNotDefined: 'BeaconID non défini'
  },
  ui: {
    connectWallet: 'Connecter un portefeuille',
    otherWallets: 'Autres portefeuilles',
    otherWalletsDescription: 'Voir les autres portefeuilles que vous pouvez utiliser',
    showMore: 'Afficher plus',
    showLess: 'Afficher moins',
    pairWalletOnAnotherDevice: 'Jumeler un portefeuille sur un autre appareil',
    showQrCode: 'Afficher le code QR',
    selectQrType: 'Sélectionner le type de code QR',
    beaconQrOption: 'Beacon',
    walletConnectQrOption: 'WalletConnect',
    scanQrCode: 'Scanner le code QR',
    notConnected: 'Non connecté.',
    orScanToConnect: 'Ou scannez pour vous connecter',
    openWalletAndScan: 'Ouvrez le portefeuille {{wallet}} sur votre téléphone et scannez.',
    scanWithCompatibleWallet: 'Scannez le code QR avec un portefeuille compatible {{standard}}.',
    preparingQrCode: 'Préparation du code QR {{wallet}}...',
    defaultWalletName: 'portefeuille',
    copyToClipboard: 'Copier dans le presse-papiers',
    copied: 'Copié\u202F!',
    openWallet: 'Ouvrir le portefeuille',
    connectWithBrowserExtension: 'Se connecter avec l’extension {{wallet}}',
    installWallet: 'Installer le portefeuille {{wallet}}',
    connectBrowserExtensionDescription:
      'Veuillez vous connecter ci-dessous pour utiliser l’extension de navigateur {{wallet}}.',
    installBrowserExtensionDescription:
      'Pour connecter votre portefeuille {{wallet}}, installez l’extension de navigateur.',
    useExtension: 'Utiliser l’extension',
    installExtension: 'Installer l’extension',
    connectWithWeb: 'Se connecter avec {{wallet}} Web',
    connectWithWebDescription: '(Le portefeuille s’ouvrira dans un nouvel onglet)',
    useBrowser: 'Utiliser le navigateur',
    connectWithDesktopApp: 'Se connecter avec l’application de bureau {{wallet}}',
    connectWithDesktopDescription:
      'Si l’application de bureau n’est pas installée, cliquez ci-dessous pour la télécharger.',
    openDesktopApp: 'Ouvrir l’application de bureau',
    downloadDesktopApp: 'Télécharger l’application de bureau',
    connectWithMobile: 'Se connecter avec {{wallet}} Mobile',
    connectWithMobileApp: 'Se connecter avec {{wallet}} {{suffix}}',
    useApp: 'Utiliser l’application',
    getKukaiMobile: 'Obtenir Kukai Mobile >',
    noTitle: 'Sans titre',
    noDescription: 'Aucune description',
    close: 'Fermer',
    walletTypes: {
      desktopApp: 'Application de bureau',
      browserExtension: 'Extension de navigateur',
      mobileApp: 'Application mobile',
      webApp: 'Application web'
    },
    walletConnectErrors: {
      'relay-unreachable': {
        heading: 'Une erreur réseau est survenue.',
        body: 'Impossible de joindre le relais WalletConnect. Vérifiez votre connexion Internet ou réessayez ; un pare-feu ou votre opérateur réseau bloque peut-être les requêtes vers le relais WalletConnect. Vous pouvez essayer de vous connecter via un VPN.',
        link: {
          label: 'Consulter le guide de dépannage de connexion',
          url: 'https://docs.walletbeacon.io/guides/failed-to-connect'
        }
      },
      timeout: {
        heading: 'Délai de connexion WalletConnect dépassé.',
        body: 'La connexion a expiré lors de la préparation de la demande de jumelage WalletConnect. Veuillez réessayer.'
      },
      'origin-not-allowed': {
        heading: 'Origine non autorisée.',
        body: 'Le relais WalletConnect a rejeté ce domaine. Si vous êtes le développeur de la dApp, ajoutez cette origine à la liste autorisée de votre tableau de bord Reown (WalletConnect) Cloud.'
      },
      'initialization-unavailable': {
        heading: 'WalletConnect est indisponible.',
        body: 'WalletConnect termine le nettoyage d’une session précédente. Veuillez patienter un instant et réessayer.'
      },
      'client-replaced': {
        heading: 'La session WalletConnect a été réinitialisée.',
        body: 'Le client WalletConnect a été remplacé pendant la préparation du code de jumelage. Veuillez réessayer.'
      },
      retired: {
        heading: 'Le jumelage a été annulé.',
        body: 'Cette tentative de jumelage WalletConnect n’est plus active. Veuillez démarrer une nouvelle connexion.'
      }
    }
  },
  aria: {
    closeModal: 'Fermer',
    goBack: 'Retour',
    closeToast: 'Fermer la notification',
    showQrCode: 'Afficher le code QR',
    copyQrToClipboard: 'Copier le code de jumelage dans le presse-papiers',
    copiedToClipboard: 'Copié dans le presse-papiers',
    qrCodeAlt: 'Code QR de jumelage {{standard}} pour {{wallet}}',
    walletLogoAlt: 'Logo {{wallet}}',
    walletIconAlt: 'Icône {{wallet}}',
    otherWalletLogoAlt: 'Autre portefeuille {{index}}',
    loading: 'Chargement'
  }
} as const satisfies BeaconLocaleMessages
