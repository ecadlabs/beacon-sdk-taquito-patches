import { BeaconErrorType } from '../../types/BeaconErrorType'
import { BeaconLocaleMessages } from '../schema'

export const esMessages = {
  meta: {
    locale: 'es',
    name: 'Español',
    direction: 'ltr',
    status: 'ai-draft'
  },
  errors: {
    [BeaconErrorType.BROADCAST_ERROR]: {
      title: 'Error de transmisión',
      description: 'La transacción no pudo transmitirse a la red. Inténtalo de nuevo.'
    },
    [BeaconErrorType.NETWORK_NOT_SUPPORTED]: {
      title: 'Error de red',
      description: 'La billetera no admite esta red. Selecciona otra.'
    },
    [BeaconErrorType.NO_ADDRESS_ERROR]: {
      title: 'Error de dirección',
      description:
        'No se encontró ninguna cuenta coincidente para esta red. Cambia de red o de cuenta en tu billetera e inténtalo de nuevo.'
    },
    [BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR]: {
      title: 'Clave privada no encontrada',
      description:
        'La cuenta con la que intentas interactuar no está disponible. Asegúrate de agregar la cuenta a tu billetera e inténtalo de nuevo.'
    },
    [BeaconErrorType.NOT_GRANTED_ERROR]: {
      title: 'Permiso no concedido',
      description:
        'No tienes los permisos necesarios para realizar esta acción. Inicia otra solicitud de permisos y otorga el acceso requerido.'
    },
    [BeaconErrorType.PARAMETERS_INVALID_ERROR]: {
      title: 'Parámetros no válidos',
      description:
        'Algunos de los parámetros proporcionados no son válidos y no se pudo completar la solicitud. Revisa los datos e inténtalo de nuevo.'
    },
    [BeaconErrorType.TOO_MANY_OPERATIONS]: {
      title: 'Demasiadas operaciones',
      description:
        'La solicitud contiene demasiadas transacciones. Incluye menos operaciones e inténtalo de nuevo.'
    },
    [BeaconErrorType.TRANSACTION_INVALID_ERROR]: {
      title: 'Transacción no válida',
      description: 'La transacción no es válida y el nodo no la aceptó.'
    },
    [BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED]: {
      title: 'Tipo de firma no compatible',
      description: 'La billetera no puede firmar cargas útiles de este tipo.'
    },
    [BeaconErrorType.ABORTED_ERROR]: {
      title: 'Cancelado',
      description: 'La acción fue cancelada por el usuario.'
    },
    [BeaconErrorType.PEER_UNREACHABLE]: {
      title: 'Sin respuesta de la billetera',
      description:
        'La billetera no respondió a tiempo. Es posible que la solicitud siga abierta en la billetera y aún pueda aprobarse allí. Revisa tu billetera y la actividad reciente de tu cuenta antes de volver a intentarlo.'
    },
    [BeaconErrorType.UNKNOWN_ERROR]: {
      title: 'Error',
      description:
        'Ocurrió un error desconocido. Inténtalo de nuevo o infórmalo a un desarrollador.'
    }
  },
  dapp: {
    requestSent: 'Solicitud enviada a\u00A0 {{wallet}}',
    noAnswerFromWallet:
      'Aún no se recibió respuesta de tu billetera. Asegúrate de que la billetera esté abierta.',
    walletNotReceivingRequest: '¿La billetera no recibe la solicitud?',
    resetConnection: 'Restablecer conexión',
    awaitingConfirmation: 'Esperando confirmación en\u00A0 {{wallet}}',
    preparingRequestForWallet: 'Preparando solicitud para\u00A0 {{wallet}}...',
    preparingRequest: 'Preparando solicitud...',
    noPermissionTitle: 'Sin permiso',
    noPermissionBody: 'Permite que la billetera gestione este tipo de solicitud.',
    invalidStateTitle: 'Estado no válido',
    invalidStateBody: `Se recibió una cuenta activa, pero no se encontró ninguna suscripción activa para BeaconEvent.ACTIVE_ACCOUNT_SET.
    Para obtener más información, visita: https://docs.walletbeacon.io/guides/migration-guide`,
    errorTitle: 'Error',
    sessionExpiredBody: 'Tu sesión ha expirado. Vuelve a vincular tu billetera.',
    pleaseTryAgain: 'Inténtalo de nuevo.',
    walletReturnedError: '{{wallet}}\u00A0 devolvió un error',
    walletDidNotRespond: '{{wallet}}\u00A0 no respondió',
    walletRequestCancelled: 'La solicitud a {{wallet}}\u00A0 fue cancelada',
    walletRequestFailed: 'La solicitud a {{wallet}}\u00A0 falló',
    showDetails: 'Mostrar detalles',
    rateLimitReachedBody: 'Límite de solicitudes alcanzado. Reduce la velocidad',
    done: 'Listo',
    relayerErrorBody:
      'No se pudo conectar al repetidor. Verifica que la hora de tu sistema esté sincronizada y recarga la página.',
    lateBroadcastToast:
      '{{wallet}}\u00A0 transmitió la transacción después de que agotara el tiempo de espera',
    lateOperationToast:
      '{{wallet}}\u00A0 envió la operación después de que agotara el tiempo de espera',
    copyToClipboard: 'Copiar al portapapeles',
    internalErrorTitle: 'Error interno',
    choosePreferredWallet: 'Elige tu billetera preferida',
    addressLabel: 'Dirección',
    networkLabel: 'Red',
    permissionsLabel: 'Permisos',
    permissionGrantedToast: '{{wallet}}\u00A0 ha concedido permiso',
    challengeAcceptedToast: '{{wallet}}\u00A0 ha aceptado el desafío',
    challengeRefusedToast: '{{wallet}}\u00A0 ha rechazado el desafío',
    payloadHashLabel: 'Hash de carga útil: {{payloadHash}}',
    operationListReturnedToast: '{{wallet}}\u00A0 devolvió la lista de operaciones',
    operationListLabel: 'Lista de operaciones',
    errorMessageLabel: 'Mensaje de error',
    operationSubmittedToast: '{{wallet}}\u00A0 envió la operación correctamente',
    openBlockexplorer: 'Abrir explorador de bloques',
    payloadSignedToast: '{{wallet}}\u00A0 firmó la carga útil correctamente',
    signatureLabel: 'Firma: {{signature}}',
    blockchainRequestExecutedToast: 'Solicitud de {{wallet}}\u00A0 ejecutada correctamente',
    operationInjectedToast: '{{wallet}}\u00A0 inyectó la operación correctamente',
    unableToSendMessage:
      'No se pudo enviar el mensaje. Si el problema persiste, restablece la conexión y vuelve a vincular tu billetera.',
    noActiveAccount: '¡No hay ninguna cuenta activa!',
    noActiveAccountSet: '¡No se ha establecido ninguna cuenta activa!',
    operationDetailsRequired: 'Se deben proporcionar los detalles de la operación',
    signedTransactionRequired: 'Se debe proporcionar la transacción firmada',
    payloadRequired: 'Se debe proporcionar la carga útil',
    beaconIdNotDefined: 'BeaconID no definido'
  },
  ui: {
    connectWallet: 'Conectar billetera',
    otherWallets: 'Otras billeteras',
    otherWalletsDescription: 'Ver otras billeteras que puedes usar para conectarte',
    showMore: 'Mostrar más',
    showLess: 'Mostrar menos',
    pairWalletOnAnotherDevice: 'Vincular billetera en otro dispositivo',
    showQrCode: 'Mostrar código QR',
    selectQrType: 'Seleccionar tipo de QR',
    beaconQrOption: 'Beacon',
    walletConnectQrOption: 'WalletConnect',
    scanQrCode: 'Escanear código QR',
    notConnected: 'No conectado.',
    orScanToConnect: 'O escanea para conectar',
    openWalletAndScan: 'Abre la billetera {{wallet}} en tu teléfono móvil y escanea.',
    scanWithCompatibleWallet: 'Escanea el código QR con una billetera compatible con {{standard}}.',
    preparingQrCode: 'Preparando código QR de {{wallet}}...',
    defaultWalletName: 'billetera',
    copyToClipboard: 'Copiar al portapapeles',
    copied: '¡Copiado!',
    openWallet: 'Abrir billetera',
    connectWithBrowserExtension: 'Conectar con la extensión de navegador {{wallet}}',
    installWallet: 'Instalar billetera {{wallet}}',
    connectBrowserExtensionDescription:
      'Conéctate a continuación para usar la extensión de navegador de tu billetera {{wallet}}.',
    installBrowserExtensionDescription:
      'Para conectar tu billetera {{wallet}}, instala la extensión del navegador.',
    useExtension: 'Usar extensión',
    installExtension: 'Instalar extensión',
    connectWithWeb: 'Conectar con {{wallet}} Web',
    connectWithWebDescription: '(Se abrirá la billetera en una nueva pestaña)',
    useBrowser: 'Usar navegador',
    connectWithDesktopApp: 'Conectar con la aplicación de escritorio {{wallet}}',
    connectWithDesktopDescription:
      'Si no tienes instalada la aplicación de escritorio, haz clic abajo para descargarla.',
    openDesktopApp: 'Abrir aplicación de escritorio',
    downloadDesktopApp: 'Descargar aplicación de escritorio',
    connectWithMobile: 'Conectar con {{wallet}} Móvil',
    connectWithMobileApp: 'Conectar con {{wallet}} {{suffix}}',
    useApp: 'Usar aplicación',
    getKukaiMobile: 'Obtener Kukai Mobile >',
    noTitle: 'Sin título',
    noDescription: 'Sin descripción',
    close: 'Cerrar',
    walletTypes: {
      desktopApp: 'Aplicación de escritorio',
      browserExtension: 'Extensión de navegador',
      mobileApp: 'Aplicación móvil',
      webApp: 'Aplicación web'
    },
    walletConnectErrors: {
      'relay-unreachable': {
        heading: 'Ocurrió un error de red.',
        body: 'No se pudo conectar con el repetidor de WalletConnect. Verifica tu conexión a Internet o inténtalo de nuevo; un firewall o proveedor de red también podría estar bloqueando las solicitudes. Como alternativa, intenta conectarte mediante una VPN.',
        link: {
          label: 'Ver guía de solución de problemas de conexión',
          url: 'https://docs.walletbeacon.io/guides/failed-to-connect'
        }
      },
      timeout: {
        heading: 'Tiempo de espera de WalletConnect agotado.',
        body: 'La conexión agotó el tiempo de espera al preparar la solicitud de vinculación de WalletConnect. Inténtalo de nuevo.'
      },
      'origin-not-allowed': {
        heading: 'Origen no permitido.',
        body: 'El repetidor de WalletConnect rechazó este dominio. Si eres el desarrollador de la dApp, agrega este origen a la lista permitida en tu panel de Reown (WalletConnect) Cloud.'
      },
      'initialization-unavailable': {
        heading: 'WalletConnect no está disponible.',
        body: 'WalletConnect aún está finalizando la limpieza de una sesión anterior. Espera un momento e inténtalo de nuevo.'
      },
      'client-replaced': {
        heading: 'La sesión de WalletConnect se restableció.',
        body: 'El cliente de WalletConnect fue reemplazado mientras se preparaba el código de vinculación. Intenta conectarte de nuevo.'
      },
      retired: {
        heading: 'La vinculación fue cancelada.',
        body: 'Este intento de vinculación de WalletConnect ya no está activo. Inicia una nueva conexión.'
      }
    }
  },
  aria: {
    closeModal: 'Cerrar',
    goBack: 'Atrás',
    closeToast: 'Cerrar notificación',
    showQrCode: 'Mostrar código QR',
    copyQrToClipboard: 'Copiar código de vinculación al portapapeles',
    copiedToClipboard: 'Copiado al portapapeles',
    qrCodeAlt: 'Código QR de vinculación {{standard}} para {{wallet}}',
    walletLogoAlt: 'Logo de {{wallet}}',
    walletIconAlt: 'Icono de {{wallet}}',
    otherWalletLogoAlt: 'Otra billetera {{index}}',
    loading: 'Cargando'
  }
} as const satisfies BeaconLocaleMessages
