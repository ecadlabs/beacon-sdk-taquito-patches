import { BeaconErrorType } from '../../types/BeaconErrorType'
import { BeaconLocaleMessages } from '../schema'
import { walletConnectionHelpUrl } from '../wallet-connection-help'

export const arMessages = {
  meta: {
    locale: 'ar',
    name: 'العربية',
    direction: 'rtl',
    status: 'ai-draft'
  },
  errors: {
    [BeaconErrorType.BROADCAST_ERROR]: {
      title: 'خطأ في البث',
      description: 'تعذر بث المعاملة إلى الشبكة. يرجى المحاولة مرة أخرى.'
    },
    [BeaconErrorType.NETWORK_NOT_SUPPORTED]: {
      title: 'خطأ في الشبكة',
      description: 'المحفظة لا تدعم هذه الشبكة. يرجى اختيار شبكة أخرى.'
    },
    [BeaconErrorType.NO_ADDRESS_ERROR]: {
      title: 'لم يتم العثور على عنوان',
      description:
        'لم يتم العثور على حساب مطابق لهذه الشبكة. يرجى تبديل الشبكة أو الحساب في محفظتك والمحاولة مرة أخرى.'
    },
    [BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR]: {
      title: 'لم يتم العثور على المفتاح الخاص',
      description:
        'الحساب الذي تحاول التفاعل معه غير متاح. يرجى التأكد من إضافة الحساب إلى محفظتك والمحاولة مرة أخرى.'
    },
    [BeaconErrorType.NOT_GRANTED_ERROR]: {
      title: 'لم يتم منح الإذن',
      description:
        'ليست لديك الأذونات اللازمة لتنفيذ هذا الإجراء. يرجى بدء طلب إذن جديد ومنح الأذونات المطلوبة.'
    },
    [BeaconErrorType.PARAMETERS_INVALID_ERROR]: {
      title: 'معلمات غير صالحة',
      description:
        'بعض المعلمات المقدمة غير صالحة وتعذر إكمال الطلب. يرجى التحقق من المدخلات والمحاولة مرة أخرى.'
    },
    [BeaconErrorType.TOO_MANY_OPERATIONS]: {
      title: 'عمليات كثيرة جداً',
      description:
        'يحتوي الطلب على عدد كبير جداً من المعاملات. يرجى تضمين عدد أقل من العمليات والمحاولة مرة أخرى.'
    },
    [BeaconErrorType.TRANSACTION_INVALID_ERROR]: {
      title: 'معاملة غير صالحة',
      description: 'المعاملة غير صالحة ولم تقبلها العقدة.'
    },
    [BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED]: {
      title: 'نوع التوقيع غير مدعوم',
      description: 'المحفظة غير قادرة على توقيع بيانات من هذا النوع.'
    },
    [BeaconErrorType.ABORTED_ERROR]: {
      title: 'تم الإلغاء',
      description: 'تم إلغاء الإجراء بواسطة المستخدم.'
    },
    [BeaconErrorType.PEER_UNREACHABLE]: {
      title: 'لا توجد استجابة من المحفظة',
      description:
        'لم تستجب المحفظة في الوقت المحدد. قد يظل الطلب مفتوحاً في المحفظة ويمكن الموافقة عليه هناك. تحقق من المحفظة ونشاط حسابك الأخير قبل المحاولة مرة أخرى.'
    },
    [BeaconErrorType.UNKNOWN_ERROR]: {
      title: 'خطأ',
      description: 'حدث خطأ غير معروف. يرجى المحاولة مرة أخرى أو إبلاغ المطور.'
    }
  },
  dapp: {
    requestSent: 'تم إرسال الطلب إلى\u00A0 {{wallet}}',
    noAnswerFromWallet: 'لم يتم تلقي أي رد من محفظتك بعد. يرجى التأكد من أن المحفظة مفتوحة.',
    walletNotReceivingRequest: 'هل لا تتلقى المحفظة الطلب؟',
    resetConnection: 'إعادة تعيين الاتصال',
    awaitingConfirmation: 'في انتظار التأكيد في\u00A0 {{wallet}}',
    preparingRequestForWallet: 'جاري تحضير الطلب لـ\u00A0 {{wallet}}...',
    preparingRequest: 'جاري تحضير الطلب...',
    noPermissionTitle: 'لا يوجد إذن',
    noPermissionBody: 'يرجى السماح للمحفظة بمعالجة هذا النوع من الطلبات.',
    invalidStateTitle: 'أُعيد ضبط الاتصال بالمحفظة',
    invalidStateBody: 'أعد توصيل محفظتك للمتابعة.',
    errorTitle: 'خطأ',
    sessionExpiredBody: 'انتهت صلاحية جلستك. يرجى إقران محفظتك مرة أخرى.',
    pleaseTryAgain: 'يرجى المحاولة مرة أخرى.',
    walletReturnedError: 'أعادت {{wallet}}\u00A0 خطأً',
    walletDidNotRespond: 'لم تستجب {{wallet}}',
    walletRequestCancelled: 'تم إلغاء طلب {{wallet}}',
    walletRequestFailed: 'فشل طلب {{wallet}}',
    showDetails: 'عرض التفاصيل',
    rateLimitReachedBody: 'تم الوصول إلى الحد الأقصى للطلبات. يرجى التمهل',
    done: 'تم',
    relayerErrorBody:
      'فشل الاتصال بالمرحل. يرجى التحقق من مزامنة وقت النظام لديك مع الوقت الحالي وإعادة تحميل الصفحة.',
    lateBroadcastToast: 'قامت {{wallet}}\u00A0 ببث المعاملة بعد انتهاء مهلة الطلب',
    lateOperationToast: 'قامت {{wallet}}\u00A0 بإرسال العملية بعد انتهاء مهلة الطلب',
    copyToClipboard: 'نسخ إلى الحافظة',
    internalErrorTitle: 'خطأ داخلي',
    choosePreferredWallet: 'اختر محفظتك المفضلة',
    addressLabel: 'العنوان',
    networkLabel: 'الشبكة',
    permissionsLabel: 'الأذونات',
    permissionGrantedToast: 'منحت {{wallet}}\u00A0 الإذن',
    challengeAcceptedToast: 'قبلت {{wallet}}\u00A0 التحدي',
    challengeRefusedToast: 'رفضت {{wallet}}\u00A0 التحدي',
    payloadHashLabel: 'تجزئة الحمولة: {{payloadHash}}',
    operationListReturnedToast: 'أعادت {{wallet}}\u00A0 قائمة العمليات',
    operationListLabel: 'قائمة العمليات',
    errorMessageLabel: 'رسالة الخطأ',
    operationSubmittedToast: 'أرسلت {{wallet}}\u00A0 العملية بنجاح',
    openBlockexplorer: 'فتح مستكشف الكتل',
    payloadSignedToast: 'وقعت {{wallet}}\u00A0 الحمولة بنجاح',
    signatureLabel: 'التوقيع: {{signature}}',
    blockchainRequestExecutedToast: 'تم تنفيذ طلب {{wallet}}\u00A0 بنجاح',
    operationInjectedToast: 'حقنت {{wallet}}\u00A0 العملية بنجاح',
    unableToSendMessage:
      'تعذر إرسال الرسالة. إذا استمرت هذه المشكلة، يرجى إعادة تعيين الاتصال وإقران محفظتك مرة أخرى.',
    noActiveAccount: 'لا يوجد حساب نشط!',
    noActiveAccountSet: 'لم يتم تعيين حساب نشط!',
    operationDetailsRequired: 'يجب تقديم تفاصيل العملية',
    signedTransactionRequired: 'يجب تقديم المعاملة الموقعة',
    payloadRequired: 'يجب تقديم البيانات',
    beaconIdNotDefined: 'معرف Beacon غير محدد'
  },
  ui: {
    connectWallet: 'ربط المحفظة',
    otherWallets: 'محافظ أخرى',
    otherWalletsDescription: 'عرض المحافظ الأخرى التي يمكنك استخدامها للاتصال',
    showMore: 'عرض المزيد',
    showLess: 'عرض أقل',
    pairWalletOnAnotherDevice: 'إقران محفظة على جهاز آخر',
    showQrCode: 'عرض رمز QR',
    selectQrType: 'اختر نوع رمز QR',
    beaconQrOption: 'Beacon',
    walletConnectQrOption: 'WalletConnect',
    scanQrCode: 'مسح رمز QR',
    notConnected: 'غير متصل.',
    orScanToConnect: 'أو امسح الرمز للاتصال',
    openWalletAndScan: 'افتح محفظة {{wallet}} على هاتفك المحمول وامسح الرمز.',
    scanWithCompatibleWallet: 'امسح رمز QR باستخدام محفظة متوافقة مع {{standard}}.',
    preparingQrCode: 'جاري تحضير رمز QR لـ {{wallet}}...',
    defaultWalletName: 'المحفظة',
    copyToClipboard: 'نسخ إلى الحافظة',
    copied: 'تم النسخ!',
    openWallet: 'فتح المحفظة',
    connectWithBrowserExtension: 'الاتصال عبر إضافة المتصفح {{wallet}}',
    installWallet: 'تثبيت محفظة {{wallet}}',
    connectBrowserExtensionDescription:
      'يرجى الاتصال أدناه لاستخدام إضافة المتصفح لمحفظة {{wallet}}.',
    installBrowserExtensionDescription: 'لربط محفظة {{wallet}}، قم بتثبيت إضافة المتصفح.',
    useExtension: 'استخدام الإضافة',
    installExtension: 'تثبيت الإضافة',
    connectWithWeb: 'الاتصال عبر {{wallet}} ويب',
    connectWithWebDescription: '(سيتم فتح المحفظة في علامة تبويب جديدة)',
    useBrowser: 'استخدام المتصفح',
    connectWithDesktopApp: 'الاتصال عبر تطبيق سطح المكتب {{wallet}}',
    connectWithDesktopDescription: 'إذا لم يكن تطبيق سطح المكتب مثبتاً لديك، انقر أدناه لتنزيله.',
    openDesktopApp: 'فتح تطبيق سطح المكتب',
    downloadDesktopApp: 'تنزيل تطبيق سطح المكتب',
    connectWithMobile: 'الاتصال عبر تطبيق {{wallet}} للهاتف',
    connectWithMobileApp: 'الاتصال عبر {{wallet}} {{suffix}}',
    useApp: 'استخدام التطبيق',
    getKukaiMobile: 'احصل على Kukai Mobile >',
    noTitle: 'بدون عنوان',
    noDescription: 'بدون وصف',
    close: 'إغلاق',
    walletTypes: {
      desktopApp: 'تطبيق سطح المكتب',
      browserExtension: 'إضافة متصفح',
      mobileApp: 'تطبيق الهاتف',
      webApp: 'تطبيق ويب'
    },
    walletConnectErrors: {
      'relay-unreachable': {
        heading: 'حدث خطأ في الشبكة.',
        body: 'تعذر الوصول إلى خادم ترحيل WalletConnect. تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.',
        link: {
          label: 'عرض دليل استكشاف أخطاء الاتصال وإصلاحها',
          url: walletConnectionHelpUrl
        }
      },
      timeout: {
        heading: 'انتهت مهلة اتصال WalletConnect.',
        body: 'انتهت مهلة الاتصال أثناء تحضير طلب إقران WalletConnect. يرجى المحاولة مرة أخرى.'
      },
      'origin-not-allowed': {
        heading: 'النطاق غير مسموح به.',
        body: 'رفض مرحل WalletConnect هذا النطاق. إذا كنت مطور التطبيق اللامركزي، أضف هذا النطاق إلى القائمة المسموح بها في لوحة تحكم Reown (WalletConnect) Cloud.'
      },
      'initialization-unavailable': {
        heading: 'خدمة WalletConnect غير متاحة.',
        body: 'لا تزال خدمة WalletConnect تنهي تنظيف جلسة سابقة. يرجى الانتظار لحظة والمحاولة مرة أخرى.'
      },
      'client-replaced': {
        heading: 'تمت إعادة تعيين جلسة WalletConnect.',
        body: 'تم استبدال عميل WalletConnect أثناء تحضير رمز الإقران. يرجى محاولة الاتصال مرة أخرى.'
      },
      retired: {
        heading: 'تم إلغاء الإقران.',
        body: 'محاولة إقران WalletConnect هذه لم تعد نشطة. يرجى بدء اتصال جديد.'
      }
    }
  },
  aria: {
    closeModal: 'إغلاق',
    goBack: 'رجوع',
    closeToast: 'إغلاق الإشعار',
    showQrCode: 'عرض رمز QR',
    copyQrToClipboard: 'نسخ رمز الإقران إلى الحافظة',
    copiedToClipboard: 'تم النسخ إلى الحافظة',
    qrCodeAlt: 'رمز QR لربط {{wallet}} عبر {{standard}}',
    walletLogoAlt: 'شعار {{wallet}}',
    walletIconAlt: 'أيقونة {{wallet}}',
    otherWalletLogoAlt: 'محفظة أخرى {{index}}',
    loading: 'جاري التحميل'
  }
} as const satisfies BeaconLocaleMessages
